/**
 * Shared deployment configuration.
 * All deploy scripts import from here to ensure consistency.
 */
require("dotenv").config();

// ── LayerZero V2 Endpoint addresses ───────────────────────────────────────────
const LZ_ENDPOINTS = {
  // Testnets
  sepolia:        "0x6EDCE65403992e310A62460808c4b910D972f10f",
  bscTestnet:     "0x6EDCE65403992e310A62460808c4b910D972f10f",
  zkSyncSepolia:  "0x6EDCE65403992e310A62460808c4b910D972f10f",
  // Mainnets
  ethereum:       "0x1a44076050125825900e736c501f859c50fE728c",
  bsc:            "0x1a44076050125825900e736c501f859c50fE728c",
  zkSync:         "0x1a44076050125825900e736c501f859c50fE728c",
};

// ── LayerZero Endpoint IDs (EIDs) ─────────────────────────────────────────────
const LZ_EIDS = {
  ethereum:       30101,
  bsc:            30102,
  zkSync:         30165,
  sepolia:        40161,
  bscTestnet:     40102,
  zkSyncSepolia:  40305,
};

// ── Allocation wallet addresses ────────────────────────────────────────────────
const WALLETS = {
  admin:          process.env.ADMIN_ADDRESS          || "0x5d4b444622FEde20cAdbB6F6Be52b7c0a33EB69b",
  founders:       process.env.WALLET_FOUNDERS        || "0x30f343E7dc7f01Ee4BFE6f7a0304A1cC763EaC75",
  coreTeam:       process.env.WALLET_CORE_TEAM       || "0xbCdD052FF56a9137cCe3B05A8fD74e8E63cd7a79",
  seedInvestors:  process.env.WALLET_SEED_INVESTORS  || "0xe517794BDE2a13b622D4952cDf0a837ef38B96e9",
  presale:        process.env.WALLET_PRESALE         || "0x15D4410F91705DBe3110Bb95aA6eaC565a3De409",
  liquidity:      process.env.WALLET_LIQUIDITY       || "0x214f5719Ca2c406bbd4b221cEB4E58F3E7f17b1B",
  staking:        process.env.WALLET_STAKING         || "0x0e5423b116B6212381bFb677529FA8535B2A0f99",
  ecosystem:      process.env.WALLET_ECOSYSTEM       || "0xE884394E16590edFd6fE532aF9A91C97b7098D86",
  treasury:       process.env.WALLET_TREASURY        || "0xed46B4e16e726a48C8fb81aBa45013DDbCC55A07",
  strategic:      process.env.WALLET_STRATEGIC       || "0xe8D4D3FFb63912C1845bc14e4Bb5cFa9c1Bf2bc2",
};

// ── Token allocations (in SRX with 18 decimals) ───────────────────────────────
const { parseUnits } = require("ethers");

const ALLOCATIONS = {
  founders:      parseUnits("1000000000", 18), // 10%
  coreTeam:      parseUnits("600000000",  18), // 6%
  seedInvestors: parseUnits("400000000",  18), // 4%
  presale:       parseUnits("1400000000", 18), // 14%
  liquidity:     parseUnits("1200000000", 18), // 12%
  staking:       parseUnits("1700000000", 18), // 17%
  ecosystem:     parseUnits("1300000000", 18), // 13%
  treasury:      parseUnits("900000000",  18), // 9%
  strategic:     parseUnits("1500000000", 18), // 15%
};

// ── Vesting parameters ────────────────────────────────────────────────────────
const DAY = 86400n;

const VESTING = {
  founders: {
    cliffDuration:   365n * DAY,  // 12 months
    vestingDuration: 1095n * DAY, // 36 months
    tgeUnlockBps:    0n,
  },
  coreTeam: {
    cliffDuration:   182n * DAY,  // 6 months
    vestingDuration: 730n * DAY,  // 24 months
    tgeUnlockBps:    0n,
  },
  seedInvestors: {
    cliffDuration:   273n * DAY,  // 9 months
    vestingDuration: 730n * DAY,  // 24 months
    tgeUnlockBps:    0n,
  },
  presale: {
    cliffDuration:   0n,
    vestingDuration: 180n * DAY,  // 6 months (linear, claimable monthly)
    tgeUnlockBps:    2500n,       // 25% at TGE
  },
  ecosystem: {
    cliffDuration:   0n,
    vestingDuration: 1460n * DAY, // 48 months
    tgeUnlockBps:    0n,
  },
};

// ── Governance parameters ─────────────────────────────────────────────────────
//
// ⛔ THE DELAY WAS A CONSTANT OF 60 SECONDS GUARDED ONLY BY A COMMENT SAYING TO
//    CHANGE IT. The word "mainnet" appeared exactly once in this file, inside
//    that comment. Meanwhile the security documentation represents governance as
//    "48-hour timelock, no bypass" — so a mainnet deploy that forgot the manual
//    edit would have shipped a SIXTY SECOND delay under a 48-hour claim, and
//    nothing anywhere would have failed.
//
// ⭐ It is now DERIVED from the network and a short delay on a non-testnet chain
//    is a hard error. A comment is not a control: the only reason the bad outcome
//    had not happened is that hardhat.config.js defines no mainnet network, which
//    is an accident of incompleteness rather than a safeguard.

const MAINNET_TIMELOCK_DELAY = 172800; // 48 hours — the documented representation
const TESTNET_TIMELOCK_DELAY = 60;     // fast iteration on throwaway chains only

/** Chains where a short delay is acceptable because the deployment is disposable. */
const TESTNET_CHAINS = new Set([
  "hardhat", "localhost", "sepolia", "bscTestnet", "zkSyncSepolia",
]);

function timelockDelayFor(networkName) {
  if (TESTNET_CHAINS.has(networkName)) return TESTNET_TIMELOCK_DELAY;

  // Anything not explicitly a testnet is treated as real. Fail loudly rather than
  // guessing, because guessing wrong here is a governance bypass.
  const override = process.env.TIMELOCK_DELAY_SECONDS
    ? Number(process.env.TIMELOCK_DELAY_SECONDS)
    : MAINNET_TIMELOCK_DELAY;

  if (!Number.isFinite(override) || override < MAINNET_TIMELOCK_DELAY) {
    throw new Error(
      `Refusing to deploy to "${networkName}" with a timelock delay of ${override}s. ` +
      `The security documentation represents a 48-hour (${MAINNET_TIMELOCK_DELAY}s) ` +
      `timelock with no bypass. Raise the delay, or change the public claim first — ` +
      `do not ship the two disagreeing.`
    );
  }
  return override;
}

const GOVERNANCE = {
  MAINNET_TIMELOCK_DELAY,
  TESTNET_TIMELOCK_DELAY,
  TESTNET_CHAINS,
  timelockDelayFor,

  /**
   * @deprecated Kept so existing imports keep working. Prefer
   *             timelockDelayFor(network.name), which cannot silently be wrong.
   */
  timelockDelay: TESTNET_TIMELOCK_DELAY,
};

// ── Stabilisation Fund parameters ─────────────────────────────────────────────
//
// The Strategic Reserve (15% = 1,500,000,000 SRX) is sent to the
// StabilisationFund contract at TGE — NOT to a plain wallet. The SSF
// implements the three-tier emergency response architecture described in
// the Syrax Liquidity Resilience Whitepaper.
//
// Three-tier deployment authority during a declared stress event:
//   Tier 1 — DEPLOYER_ROLE (treasurer multi-sig): instant, up to MAX_DEPLOYER_BPS
//   Tier 2 — GUARDIAN_ROLE (4-of-7 multi-sig):   instant, combined cap MAX_GUARDIAN_BPS
//   Tier 3 — GOVERNANCE_ROLE (Timelock, 48 h):   any amount, any time, no on-chain cap
//
// Only GOVERNANCE_ROLE can resolve a stress event (close the fast-path window).
const SSF = {
  MAX_DEPLOYER_BPS:       3_000,          // 30%  — Tier 1 individual cap
  MAX_GUARDIAN_BPS:       7_000,          // 70%  — Tier 2 combined cap (deployer + guardian)
  WITHDRAW_LOCK_DURATION: 30 * 24 * 3600, // 30 days — contributor withdrawal lock
};

module.exports = { LZ_ENDPOINTS, LZ_EIDS, WALLETS, ALLOCATIONS, VESTING, GOVERNANCE, SSF };
