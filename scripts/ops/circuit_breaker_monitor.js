/**
 * circuit_breaker_monitor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Off-chain monitor for the GuardianModule circuit breaker.
 *
 * Runs as a pm2 process on any VPS. No third-party automation platform needed.
 *
 * What it does:
 *  1. Polls the SRXToken contract for OFTSent (bridge) events on a configurable
 *     block interval.
 *  2. Reports each bridge transfer to GuardianModule.recordBridgeActivity().
 *     The contract accumulates volume on-chain and auto-trips the circuit
 *     breaker if the threshold is exceeded — no trip logic needed here.
 *  3. Posts a Discord alert whenever the circuit breaker trips or stays tripped.
 *  4. Persists the last processed block to .cb_monitor_state.json so restarts
 *     never double-count or miss blocks.
 *
 * Setup on your VPS:
 *  1. Copy this file to your server (or git pull it)
 *  2. Create .env in the same directory with the vars below
 *  3. npm install ethers dotenv node-fetch   (if not already installed globally)
 *  4. pm2 start circuit_breaker_monitor.js --name srx-cb-monitor
 *  5. pm2 save
 *
 * Environment variables (.env):
 *  RPC_URL                Ethereum node RPC — use your Alchemy key
 *  SRX_TOKEN_ADDRESS      Deployed SRXToken proxy address
 *  GUARDIAN_ADDRESS       Deployed GuardianModule address
 *  CIRCUIT_BREAKER_KEY    Private key of wallet holding CIRCUIT_BREAKER_ROLE
 *  DISCORD_WEBHOOK_URL    Discord channel webhook URL for alerts
 *  POLL_INTERVAL_MS       Polling interval. Default: 15000 (15 seconds)
 *  START_BLOCK            First block to scan. Default: latest - 1000 on first run
 *  BLOCKS_PER_SCAN        Max blocks per poll. Default: 500
 */

"use strict";

require("dotenv").config();
const { ethers } = require("ethers");
const fs         = require("fs");
const path       = require("path");

// ── ABIs (minimal) ────────────────────────────────────────────────────────────

const OFT_SENT_TOPIC = ethers.id("OFTSent(bytes32,uint32,address,uint256,uint256)");

const OFT_SENT_ABI = [
  "event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)",
];

const GUARDIAN_ABI = [
  "function recordBridgeActivity(bytes32 moduleId, uint256 amount) external",
  "function MODULE_BRIDGE() external view returns (bytes32)",
  "function getCircuitBreakerStatus(bytes32 moduleId) external view returns (bool tripped, uint256 volumeInWindow, uint256 volumeThreshold, uint256 windowEnd, uint256 tripCount)",
  "event CircuitBreakerTripped(bytes32 indexed moduleId, uint256 volumeInWindow, uint256 threshold, uint256 timestamp)",
];

// ── Config ────────────────────────────────────────────────────────────────────

const STATE_FILE      = path.join(__dirname, ".cb_monitor_state.json");
const POLL_INTERVAL   = parseInt(process.env.POLL_INTERVAL_MS  || "15000", 10);
const BLOCKS_PER_SCAN = parseInt(process.env.BLOCKS_PER_SCAN   || "500",   10);

// How often to log the circuit breaker status even if nothing happened (ms)
const STATUS_LOG_INTERVAL = 10 * 60 * 1000; // 10 minutes

// ── State persistence ─────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastBlock: null };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[monitor] Failed to save state:", err.message);
  }
}

// ── Discord alerts ────────────────────────────────────────────────────────────

async function sendDiscordAlert(message, isEmergency = false) {
  const tag   = isEmergency ? "🚨 @here" : "⚠️";
  const full  = `${tag} **SRX Circuit Breaker Monitor**\n${message}`;

  console.warn(`[ALERT] ${message}`);

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[monitor] DISCORD_WEBHOOK_URL not set — alert not sent");
    return;
  }

  try {
    // node-fetch v2 (CommonJS compatible)
    const fetch = (...args) =>
      import("node-fetch").then(({ default: f }) => f(...args));

    const res = await fetch(webhookUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ content: full }),
    });

    if (!res.ok) {
      console.error(`[monitor] Discord webhook error: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error("[monitor] Failed to send Discord alert:", err.message);
  }
}

// ── Core scan logic ───────────────────────────────────────────────────────────

async function scanBlocks(ctx, fromBlock, toBlock) {
  const { provider, tokenIface, guardian, MODULE_BRIDGE, tokenAddr } = ctx;

  const logs = await provider.getLogs({
    address:   tokenAddr,
    topics:    [OFT_SENT_TOPIC],
    fromBlock,
    toBlock,
  });

  if (logs.length === 0) return;

  console.log(
    `[monitor] ${logs.length} OFTSent event(s) in blocks ${fromBlock}–${toBlock}`
  );

  for (const log of logs) {
    let parsed;
    try {
      parsed = tokenIface.parseLog(log);
    } catch {
      continue;
    }

    const { amountSentLD, dstEid, fromAddress } = parsed.args;
    const amountFormatted = ethers.formatUnits(amountSentLD, 18);

    console.log(
      `[monitor] Bridge transfer: ${amountFormatted} SRX → EID ${dstEid} from ${fromAddress}`
    );

    try {
      const tx      = await guardian.recordBridgeActivity(MODULE_BRIDGE, amountSentLD);
      const receipt = await tx.wait();

      // Check if this tx tripped the circuit breaker
      const guardianIface = new ethers.Interface(GUARDIAN_ABI);
      const trippedLog = receipt.logs.find((l) => {
        try {
          return guardianIface.parseLog(l)?.name === "CircuitBreakerTripped";
        } catch { return false; }
      });

      if (trippedLog) {
        const ev = guardianIface.parseLog(trippedLog);
        await sendDiscordAlert(
          [
            `**BRIDGE CIRCUIT BREAKER TRIPPED**`,
            `Volume in window: **${ethers.formatUnits(ev.args.volumeInWindow, 18)} SRX**`,
            `Threshold: **${ethers.formatUnits(ev.args.threshold, 18)} SRX**`,
            `Tx: \`${receipt.hash}\``,
            ``,
            `**Action required:**`,
            `1. Investigate all recent bridge activity`,
            `2. Guardian or Governance must call \`resetCircuitBreaker(MODULE_BRIDGE)\``,
            `3. Followed by \`governanceUnpause(MODULE_BRIDGE, reason)\``,
          ].join("\n"),
          true // emergency — @here
        );
      } else {
        console.log(`[monitor] recordBridgeActivity ok: ${receipt.hash}`);
      }

    } catch (err) {
      if (err.message?.includes("CircuitBreakerAlreadyTripped")) {
        // Expected when breaker is tripped and monitor keeps running
        console.log("[monitor] Breaker already tripped — skipping report for this transfer");
      } else if (err.message?.includes("CircuitBreakerNotConfigured") ||
                 err.message?.includes("volumeThreshold == 0")) {
        // Circuit breaker not configured yet — ignore silently
      } else {
        console.error("[monitor] recordBridgeActivity error:", err.message);
      }
    }
  }
}

// ── Status check (periodic) ───────────────────────────────────────────────────

async function logStatus(ctx) {
  const { guardian, MODULE_BRIDGE } = ctx;

  try {
    const [tripped, volInWindow, threshold, windowEnd, tripCount] =
      await guardian.getCircuitBreakerStatus(MODULE_BRIDGE);

    const vol      = ethers.formatUnits(volInWindow, 18);
    const thresh   = ethers.formatUnits(threshold,   18);
    const winEnd   = new Date(Number(windowEnd) * 1000).toISOString();
    const pct      = threshold > 0n
      ? ((Number(volInWindow) / Number(threshold)) * 100).toFixed(1)
      : "N/A";

    console.log(
      `[monitor] Status: tripped=${tripped} ` +
      `vol=${vol} SRX (${pct}% of threshold) ` +
      `threshold=${thresh} SRX ` +
      `windowEnd=${winEnd} ` +
      `trips=${tripCount}`
    );

    if (tripped) {
      // Alert every status cycle while tripped (every 10 min)
      await sendDiscordAlert(
        [
          `**Circuit breaker is still TRIPPED**`,
          `Bridge remains paused. This is reminder #${Math.floor(Date.now() / STATUS_LOG_INTERVAL)}.`,
          `Governance must resolve this before bridge activity can resume.`,
        ].join("\n"),
        false
      );
    }
  } catch (err) {
    console.error("[monitor] Status check error:", err.message);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const rpcUrl       = process.env.RPC_URL;
  const tokenAddr    = process.env.SRX_TOKEN_ADDRESS;
  const guardianAddr = process.env.GUARDIAN_ADDRESS;
  const cbKey        = process.env.CIRCUIT_BREAKER_KEY;

  const missing = [
    !rpcUrl       && "RPC_URL",
    !tokenAddr    && "SRX_TOKEN_ADDRESS",
    !guardianAddr && "GUARDIAN_ADDRESS",
    !cbKey        && "CIRCUIT_BREAKER_KEY",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }

  const provider   = new ethers.JsonRpcProvider(rpcUrl);
  const cbWallet   = new ethers.Wallet(cbKey, provider);
  const tokenIface = new ethers.Interface(OFT_SENT_ABI);
  const guardian   = new ethers.Contract(guardianAddr, GUARDIAN_ABI, cbWallet);

  const MODULE_BRIDGE = await guardian.MODULE_BRIDGE();
  const network       = await provider.getNetwork();

  console.log(`[monitor] ─────────────────────────────────────`);
  console.log(`[monitor] SRX Circuit Breaker Monitor`);
  console.log(`[monitor] Network:  ${network.name} (chainId ${network.chainId})`);
  console.log(`[monitor] Wallet:   ${cbWallet.address}`);
  console.log(`[monitor] Token:    ${tokenAddr}`);
  console.log(`[monitor] Guardian: ${guardianAddr}`);
  console.log(`[monitor] Poll:     every ${POLL_INTERVAL / 1000}s, ${BLOCKS_PER_SCAN} blocks/scan`);
  console.log(`[monitor] ─────────────────────────────────────`);

  return { provider, cbWallet, tokenIface, guardian, MODULE_BRIDGE, tokenAddr };
}

// ── Main poll loop ────────────────────────────────────────────────────────────

async function main() {
  let ctx;
  try {
    ctx = await init();
  } catch (err) {
    console.error("[monitor] Startup failed:", err.message);
    process.exit(1);
  }

  let state         = loadState();
  let lastStatusLog = 0;

  console.log("[monitor] Entering poll loop...\n");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const latestBlock = await ctx.provider.getBlockNumber();

      const startBlock = state.lastBlock != null
        ? state.lastBlock + 1
        : parseInt(process.env.START_BLOCK || String(latestBlock - 1000), 10);

      if (startBlock <= latestBlock) {
        for (let from = startBlock; from <= latestBlock; from += BLOCKS_PER_SCAN) {
          const to = Math.min(from + BLOCKS_PER_SCAN - 1, latestBlock);
          await scanBlocks(ctx, from, to);
        }

        state.lastBlock = latestBlock;
        saveState(state);
      }

      // Periodic status log
      if (Date.now() - lastStatusLog >= STATUS_LOG_INTERVAL) {
        lastStatusLog = Date.now();
        await logStatus(ctx);
      }

    } catch (err) {
      // Network hiccups are common — log and retry next cycle
      console.error("[monitor] Poll error:", err.message);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

main();
