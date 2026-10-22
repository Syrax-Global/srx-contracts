/**
 * gate_checks.js — launch-gate checks that verify_roles.js and migrate_roles.js share
 * (internal audit 16 Oct 2026, CONTROL-10 and CONTROL-05).
 *
 * verify_roles.js asked "who holds each role" and nothing else. Two things it could not
 * see, both of which let a blocking gate pass on a deployment that was not safe:
 *
 *  • CONTROL-10: the GuardianModule's registry and circuit breaker. Roles can all be
 *    right while a module was never registered (the guardian cannot pause it) or was
 *    registered to the wrong contract (a pause lands on the wrong place), or while the
 *    bridge breaker was never configured (recordBridgeActivity returns silently when
 *    volumeThreshold is 0, so the monitor "works" and nothing ever trips).
 *  • CONTROL-05: Timelock operations that survive the hand-over. During setup the Safe is
 *    briefly a Timelock PROPOSER; anything it scheduled then stays executable by anyone
 *    after the Safe's proposer role is revoked, and hasRole() cannot show it.
 *
 * Both are pure of the process environment: they take contracts and plain values and
 * return failure strings (empty = pass), so they can be unit tested against contracts
 * deployed in-process (test/deploy/LaunchGate.InternalAudit.test.js).
 */
const { ethers } = require("ethers");

// The six module ids, computed from their names rather than read from the contract
// under test: a gate that asks the contract what to expect agrees with whatever it finds.
// test/deploy/LaunchGate.InternalAudit.test.js proves these equal GuardianModule's constants.
const GUARDIAN_MODULES = [
  { label: "MODULE_TOKEN",    id: ethers.id("TOKEN"),              expects: "token" },
  { label: "MODULE_BRIDGE",   id: ethers.id("BRIDGE"),             expects: "token" },   // the bridge is the token's OFT send
  { label: "MODULE_STAKING",  id: ethers.id("STAKING"),            expects: "staking" },
  { label: "MODULE_FEE",      id: ethers.id("FEE_CONTROLLER"),     expects: "fee" },
  { label: "MODULE_TREASURY", id: ethers.id("TREASURY"),           expects: "treasury" },
  { label: "MODULE_SSF",      id: ethers.id("STABILISATION_FUND"), expects: "ssf" },
];
const MODULE_BRIDGE = GUARDIAN_MODULES[1].id;

/**
 * CONTROL-10. Every module is registered to exactly the contract it should pause, and
 * the bridge circuit breaker is configured.
 *
 * @param guardian  a GuardianModule contract (ethers v6)
 * @param expected  { token, staking, fee, treasury, ssf } addresses
 * @returns string[] — one entry per problem; empty means the wiring is right
 */
async function checkGuardianWiring({ guardian, expected }) {
  const failures = [];

  for (const m of GUARDIAN_MODULES) {
    const want = expected[m.expects];
    if (!want) { failures.push(`${m.label}: no expected target was given (${m.expects}), so it cannot be checked`); continue; }
    let cfg;
    try { cfg = await guardian.modules(m.id); }
    catch (e) { failures.push(`${m.label}: the GuardianModule did not answer modules() (${e.shortMessage || e.message})`); continue; }
    // ModuleConfig { target, registered, paused, ... } — read by name, not position.
    if (!cfg.registered) {
      failures.push(`${m.label} is not registered: the guardian cannot pause ${want}, and pauseAll() skips it silently`);
    } else if (ethers.getAddress(cfg.target) !== ethers.getAddress(want)) {
      failures.push(`${m.label} is registered to ${cfg.target}, expected ${ethers.getAddress(want)}: a guardian pause would land on the wrong contract`);
    }
  }

  // Unconfigured, recordBridgeActivity() returns without doing anything, so the monitor
  // reports every transfer and the breaker never trips.
  try {
    const cb = await guardian.circuitBreakers(MODULE_BRIDGE);
    if (cb.volumeThreshold === 0n) failures.push("MODULE_BRIDGE circuit breaker is not configured (volumeThreshold is 0): it can never trip; governance must call configureCircuitBreaker");
    if (cb.windowDuration === 0n) failures.push("MODULE_BRIDGE circuit breaker is not configured (windowDuration is 0): its volume can never drain; governance must call configureCircuitBreaker");
  } catch (e) {
    failures.push(`MODULE_BRIDGE: the GuardianModule did not answer circuitBreakers() (${e.shortMessage || e.message})`);
  }
  return failures;
}

// ── Timelock: operations that outlive the hand-over ──────────────────────────

const OP_ID = /^0x[0-9a-fA-F]{64}$/;

/** "id1, id2" -> ["0x..", "0x.."] (lower case). Throws on a malformed entry: a typo must be loud. */
function parseOpList(raw) {
  const out = [];
  for (const part of String(raw || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!OP_ID.test(part)) throw new Error(`"${part}" is not a Timelock operation id (expected 0x + 64 hex characters)`);
    out.push(part.toLowerCase());
  }
  return out;
}

/** A block number from the environment, or null when it is absent or not a whole number. */
function parseBlock(raw) {
  const s = String(raw ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/**
 * Every operation id that is still pending on the Timelock and is not on the allow-list.
 *
 * It reads CallScheduled from fromBlock to find the ids ever scheduled (one id can have
 * several events, one per call index), then asks isOperationPending(id) for each. That
 * call is the source of truth: it is false once the operation is executed or cancelled,
 * and true again if a cancelled id is scheduled afresh, which replaying
 * CallScheduled/CallExecuted/Cancelled by hand gets wrong.
 *
 * ⛔ fromBlock MUST be the Timelock's deployment block (or earlier). An absence check
 *    that cannot look is not a pass, so a missing fromBlock throws, and so does one that
 *    is later than the deployment (the Timelock already had code the block before it).
 *
 * @returns string[] operation ids (lower case), in the order they were first scheduled
 */
async function pendingTimelockOps({ timelock, fromBlock, allowList = [] }) {
  if (fromBlock === undefined || fromBlock === null || !Number.isInteger(Number(fromBlock)) || Number(fromBlock) < 0) {
    throw new Error("fromBlock (the Timelock's deployment block) was not provided, so pending operations cannot be listed: set TIMELOCK_DEPLOY_BLOCK_<NET>");
  }
  const from = Number(fromBlock);
  const provider = timelock.runner.provider || timelock.runner;
  if (from > 0 && (await provider.getCode(await timelock.getAddress(), from - 1)) !== "0x") {
    throw new Error(`fromBlock ${from} is after the Timelock was deployed (it already has code at block ${from - 1}); operations scheduled before it would be missed. Use the deployment block`);
  }

  const allowed = new Set(allowList.map((id) => id.toLowerCase()));
  const events = await timelock.queryFilter(timelock.filters.CallScheduled(), from);
  const seen = new Set();
  const pending = [];
  for (const ev of events) {
    const id = ev.args.id.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    if (allowed.has(id)) continue;
    if (await timelock.isOperationPending(id)) pending.push(id);
  }
  return pending;
}

/**
 * CONTROL-05 as a gate: failure strings, one per pending operation, or one if the check
 * could not look at all.
 */
async function checkNoPendingTimelockOps({ timelock, fromBlock, allowList = [] }) {
  let pending;
  try { pending = await pendingTimelockOps({ timelock, fromBlock, allowList }); }
  catch (e) { return [`Timelock pending operations could not be checked: ${e.shortMessage || e.message}`]; }
  const out = [];
  for (const id of pending) {
    let ready = "";
    try { ready = ` (executable by anyone from timestamp ${await timelock.getTimestamp(id)})`; } catch { /* the id alone is enough */ }
    out.push(`Timelock operation ${id} is scheduled and still pending${ready}: it survives the Safe losing PROPOSER. Cancel it (CANCELLER_ROLE) or, if it is expected, list it in TIMELOCK_ALLOWED_OPS_<NET>`);
  }
  return out;
}

module.exports = {
  GUARDIAN_MODULES, MODULE_BRIDGE,
  checkGuardianWiring, pendingTimelockOps, checkNoPendingTimelockOps, parseOpList, parseBlock,
};
