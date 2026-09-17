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

// ── Networks ──────────────────────────────────────────────────────────────────

/** Chains where a deployment is disposable. Everything else is treated as real. */
const TESTNET_CHAINS = new Set([
  "hardhat", "localhost", "sepolia", "bscTestnet", "zkSyncSepolia",
]);

/**
 * The network Hardhat is running against, or null outside Hardhat.
 * ⚠️ HARDHAT_NETWORK alone is not enough: Hardhat sets it for `run --network X`
 *    but not for the default network or for `hardhat test`, so the runtime's own
 *    answer comes first. Null means "unknown", which walletFor treats as real.
 */
function currentNetwork() {
  return global.hre?.network?.name || process.env.HARDHAT_NETWORK || null;
}

// ── Allocation wallet addresses ────────────────────────────────────────────────
//
// ⛔ EVERY ONE OF THESE USED TO FALL BACK TO A BUILT-IN ADDRESS WHEN ITS ENV VAR
//    WAS UNSET — ON ANY NETWORK. 06_execute_tge.js sends the 1.2B liquidity
//    allocation through WALLETS.liquidity, so a mainnet run with WALLET_LIQUIDITY
//    missing would have sent 12% of supply to a testnet wallet, and nothing would
//    have failed. The same fallback set every vault's beneficiary and the admin
//    of every contract.
//
// ⭐ The built-in addresses are now TESTNET DEFAULTS ONLY. On any other network:
//    - an unset variable is a hard error, never a fallback;
//    - a value equal to a built-in testnet address is a hard error too (a testnet
//      .env copied onto mainnet);
//    - the zero address and a bad checksum are hard errors.
//    Resolution happens when a field is READ, so the error names the variable at
//    the moment a script tries to use it.

const TESTNET_WALLET_DEFAULTS = Object.freeze({
  admin:          "0x5d4b444622FEde20cAdbB6F6Be52b7c0a33EB69b",
  founders:       "0x30f343E7dc7f01Ee4BFE6f7a0304A1cC763EaC75",
  coreTeam:       "0xbCdD052FF56a9137cCe3B05A8fD74e8E63cd7a79",
  seedInvestors:  "0xe517794BDE2a13b622D4952cDf0a837ef38B96e9",
  presale:        "0x15D4410F91705DBe3110Bb95aA6eaC565a3De409",
  liquidity:      "0x214f5719Ca2c406bbd4b221cEB4E58F3E7f17b1B",
  staking:        "0x0e5423b116B6212381bFb677529FA8535B2A0f99",
  ecosystem:      "0xE884394E16590edFd6fE532aF9A91C97b7098D86",
  treasury:       "0xed46B4e16e726a48C8fb81aBa45013DDbCC55A07",
  strategic:      "0xe8D4D3FFb63912C1845bc14e4Bb5cFa9c1Bf2bc2",
});

const WALLET_ENV = Object.freeze({
  admin:          "ADMIN_ADDRESS",
  founders:       "WALLET_FOUNDERS",
  coreTeam:       "WALLET_CORE_TEAM",
  seedInvestors:  "WALLET_SEED_INVESTORS",
  presale:        "WALLET_PRESALE",
  liquidity:      "WALLET_LIQUIDITY",
  staking:        "WALLET_STAKING",
  ecosystem:      "WALLET_ECOSYSTEM",
  treasury:       "WALLET_TREASURY",
  strategic:      "WALLET_STRATEGIC",
});

/**
 * Resolve one allocation wallet for a network. Throws rather than guess.
 * @param {string} key          a WALLETS field name, e.g. "liquidity"
 * @param {string|null} networkName  defaults to the network Hardhat is running on
 * @param {object} env          defaults to process.env (injectable for tests)
 */
function walletFor(key, networkName = currentNetwork(), env = process.env) {
  const { getAddress, ZeroAddress } = require("ethers");
  const envName = WALLET_ENV[key];
  if (!envName) throw new Error(`Unknown wallet "${key}"`);

  const isTestnet = networkName !== null && TESTNET_CHAINS.has(networkName);
  const raw = (env[envName] || "").trim();

  if (!raw) {
    if (isTestnet) return TESTNET_WALLET_DEFAULTS[key];
    throw new Error(
      `${envName} is not set, and "${networkName ?? "an unknown network"}" is not a testnet. ` +
      `Refusing to fall back to a built-in testnet address.`
    );
  }

  let addr;
  try { addr = getAddress(raw); }
  catch { throw new Error(`${envName} is not a valid checksummed address`); }

  if (!isTestnet) {
    if (addr === ZeroAddress) throw new Error(`${envName} is the zero address`);
    if (Object.values(TESTNET_WALLET_DEFAULTS).includes(addr)) {
      throw new Error(
        `${envName} on "${networkName ?? "an unknown network"}" is a built-in TESTNET address. ` +
        `A testnet .env must not be used for a real deployment.`
      );
    }
  }
  return addr;
}

const WALLETS = {};
for (const key of Object.keys(WALLET_ENV)) {
  Object.defineProperty(WALLETS, key, { enumerable: true, get: () => walletFor(key) });
}

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

// A short delay is acceptable only on TESTNET_CHAINS (defined above).
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

module.exports = {
  LZ_ENDPOINTS, LZ_EIDS, WALLETS, ALLOCATIONS, VESTING, GOVERNANCE, SSF,
  TESTNET_CHAINS, TESTNET_WALLET_DEFAULTS, WALLET_ENV, walletFor, currentNetwork,
};
