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
  // Local rehearsal only (finding DEP-01) — scripts/ops/rehearse_deploy_suite.js
  // deploys a MockLZEndpoint on the throwaway `hardhat node` chain and passes its
  // address here. No real LayerZero endpoint exists on localhost, so this is
  // read from env rather than hardcoded, and is undefined unless the rehearsal
  // sets it.
  localhost:      process.env.LZ_ENDPOINT_LOCALHOST,
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
  // keccak256("SYRAX TESTNET PLACEHOLDER: MARKET MAKER — no key exists")[12:] — nobody holds a key
  marketMaker:    "0x308E8e31140F65BeC1706A36127107D99bb0209b",
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
  marketMaker:    "WALLET_MARKET_MAKER",
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
/** Addresses that must never appear in a mainnet deployment (Security ruling, 12 Oct 2026). */
const NEVER_ON_MAINNET = ["0x049fea6abBbc88487Ca14A7910d37E1feCdb9236"];

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
    // ⛔ Security ruling, 12 Oct 2026 (DEPLOYMENT_SECURITY.md D2-2): the testnet deployer is
    //    never a mainnet owner, admin or allocation wallet.
    if (NEVER_ON_MAINNET.includes(addr)) {
      throw new Error(`${envName} on "${networkName ?? "an unknown network"}" is the TESTNET DEPLOYER, which is never a mainnet key.`);
    }
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

//
// ⭐ THE LAUNCH DESIGN (Jared, 28 Sep 2026): 5% of supply — 500,000,000 SRX — is
//    liquid at launch, and nothing else is: the 50M pool paired with $1M at $0.02,
//    200M market-maker inventory, and the 250M presale launch tranche. Seed,
//    founders and team are 0% at launch. Nothing new unlocks for the first 30 days.
//
// ⛔ THIS USED TO RELEASE 1.55B (15.5%) AT LAUNCH: the whole 1.2B "liquidity"
//    bucket went unlocked to a single-key wallet, plus 25% of the 1.4B presale —
//    while every document said "12% unlocked … multi-sig" and promised a 12-month
//    pool lock nothing enforced. The presale (14%) and liquidity (12%) totals are
//    unchanged; they are split so the launch-day float is exactly 5%.
//
// Every published figure is GENERATED from this file (scripts/docs/tokenomics.js
// → docs/TOKENOMICS.md), and a test fails if the two drift. Change numbers here only.
const ALLOCATIONS = {
  founders:         parseUnits("1000000000", 18), // 10%
  coreTeam:         parseUnits("600000000",  18), // 6%
  seedInvestors:    parseUnits("400000000",  18), // 4%
  presaleLaunch:    parseUnits("250000000",  18), // 2.5%  presale: claimable at launch
  presale:          parseUnits("1150000000", 18), // 11.5% presale: vesting (presale 14% in total)
  liquidityPool:    parseUnits("50000000",   18), // 0.5%  paired with $1M in the official pool
  marketMaker:      parseUnits("200000000",  18), // 2%    contracted market-maker inventory
  liquidityReserve: parseUnits("950000000",  18), // 9.5%  locked (liquidity 12% in total)
  staking:          parseUnits("1700000000", 18), // 17%
  ecosystem:        parseUnits("1300000000", 18), // 13%
  treasury:         parseUnits("900000000",  18), // 9%
  strategic:        parseUnits("1500000000", 18), // 15%
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
  // The presale's launch tranche is the separate presaleLaunch allocation; this
  // vault holds the rest. 30 days held, so nothing new is liquid in month one.
  presale: {
    cliffDuration:   30n * DAY,   // nothing new unlocks in the first 30 days
    vestingDuration: 180n * DAY,  // then 6 months linear
    tgeUnlockBps:    0n,
  },
  ecosystem: {
    cliffDuration:   30n * DAY,   // nothing new unlocks in the first 30 days
    vestingDuration: 1460n * DAY, // then 48 months linear (the end moves 30 days later)
    tgeUnlockBps:    0n,
  },
  // The part of the liquidity allocation not in the pool or with the market maker.
  liquidityReserve: {
    cliffDuration:   365n * DAY,  // locked 12 months, matching the 12-month pool lock
    vestingDuration: 730n * DAY,  // then 24 months linear
    tgeUnlockBps:    0n,
  },
};

// ── The TGE plan: every bucket, where it goes, and how ────────────────────────
//
// ⭐ THE ONE LIST. The deploy scripts, the TGE gate, the verifiers, the tests and
//    the generated tokenomics document all read this, so none of them can drift.
//    kind:
//      "vault"    a VestingVault paying `beneficiary` on VESTING[schedule]; its
//                 address is read from `${vaultEnv}_<NETWORK>` once deployed
//      "wallet"   straight to WALLETS[wallet] — on any real network this must be a
//                 multi-signature wallet (a contract); a single-key wallet is refused
//      "contract" straight to the contract at `${env}_<NETWORK>`
//    liquid: true only for what is freely transferable the moment TGE runs.
const TGE_PLAN = Object.freeze([
  { label: "Founders",          allocation: "founders",         kind: "vault",    schedule: "founders",         beneficiary: "founders",      vaultEnv: "VESTING_FOUNDERS" },
  { label: "CoreTeam",          allocation: "coreTeam",         kind: "vault",    schedule: "coreTeam",         beneficiary: "coreTeam",      vaultEnv: "VESTING_CORE_TEAM" },
  { label: "SeedInvestors",     allocation: "seedInvestors",    kind: "vault",    schedule: "seedInvestors",    beneficiary: "seedInvestors", vaultEnv: "VESTING_SEED" },
  { label: "PresaleLaunch",     allocation: "presaleLaunch",    kind: "wallet",   wallet: "presale",            liquid: true },
  { label: "Presale",           allocation: "presale",          kind: "vault",    schedule: "presale",          beneficiary: "presale",       vaultEnv: "VESTING_PRESALE" },
  { label: "EcosystemDAO",      allocation: "ecosystem",        kind: "vault",    schedule: "ecosystem",        beneficiary: "ecosystem",     vaultEnv: "VESTING_ECOSYSTEM" },
  { label: "LiquidityPool",     allocation: "liquidityPool",    kind: "wallet",   wallet: "liquidity",          liquid: true },
  { label: "MarketMaker",       allocation: "marketMaker",      kind: "wallet",   wallet: "marketMaker",        liquid: true },
  { label: "LiquidityReserve",  allocation: "liquidityReserve", kind: "vault",    schedule: "liquidityReserve", beneficiary: "liquidity",     vaultEnv: "VESTING_LIQUIDITY_RESERVE" },
  { label: "Staking",           allocation: "staking",          kind: "contract", env: "STAKING" },
  { label: "Treasury",          allocation: "treasury",         kind: "contract", env: "TREASURY" },
  { label: "StabilisationFund", allocation: "strategic",        kind: "contract", env: "STABILISATION_FUND" },
].map(Object.freeze));

/** SRX freely transferable the moment TGE runs: liquid rows plus any vault's TGE unlock. */
function launchFloat(plan = TGE_PLAN, allocations = ALLOCATIONS, vesting = VESTING) {
  let float = 0n;
  for (const row of plan) {
    const amount = allocations[row.allocation];
    if (row.liquid) float += amount;
    else if (row.kind === "vault") float += (amount * vesting[row.schedule].tgeUnlockBps) / 10_000n;
  }
  return float;
}

/** SRX released by vaults (beyond the launch float) the given number of days after TGE — the unlock calendar. */
function vestedByDay(days, plan = TGE_PLAN, allocations = ALLOCATIONS, vesting = VESTING) {
  const t = BigInt(days) * DAY;
  let out = 0n;
  for (const row of plan) {
    if (row.kind !== "vault") continue;
    const total = allocations[row.allocation];
    const v = vesting[row.schedule];
    const atTge = (total * v.tgeUnlockBps) / 10_000n;
    const rest = total - atTge;
    if (t < v.cliffDuration) continue;
    const elapsed = t - v.cliffDuration;
    out += v.vestingDuration === 0n || elapsed >= v.vestingDuration ? rest : (rest * elapsed) / v.vestingDuration;
  }
  return out;
}

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
// implements a three-tier emergency response architecture (see the contract).
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
  // REG-50 (11 Oct 2026): the most SRX depositor rewards can EVER total, set once at
  // deployment (StabilisationFund.rewardAllocation) and never changeable. Fees never
  // feed it. ⛔ mainnet is null on purpose: the size is Jared's decision, taken before
  // mainnet after modelling (11 Oct). 05b refuses to deploy on mainnet until it is set.
  //    The testnet figure is a PLACEHOLDER for testing only, not a proposal.
  REWARD_ALLOCATION: {
    testnet: parseUnits("100000000", 18), // placeholder: 100M test SRX
    mainnet: null,
  },
};

/** The SSF reward allocation for a network: the testnet placeholder, or the mainnet
 *  figure, which must have been decided (null throws rather than guessing). */
function ssfRewardAllocation(networkName = currentNetwork()) {
  const isTestnet = networkName !== null && TESTNET_CHAINS.has(networkName);
  const value = isTestnet ? SSF.REWARD_ALLOCATION.testnet : SSF.REWARD_ALLOCATION.mainnet;
  if (value === null || value === undefined) {
    throw new Error(`No StabilisationFund reward allocation is set for ${networkName} (SSF.REWARD_ALLOCATION.mainnet). ` +
      "It is fixed for the life of the contract, so it is Jared's decision (REG-50); record it in 00_config.js.");
  }
  return value;
}

// ── Bridge: the most each spoke may return to Ethereum (disclosure A) ──────────
//    A draining bucket: at most this much in flight, refilling at this amount per day.
//
// ⭐ SRXToken refuses returns from a spoke above this per 24 hours, and refuses ALL
//    returns from a spoke with no limit. It bounds what a compromised spoke can take
//    before the guardian freezes it (GuardianModule.freezeBridgeInbound). 07 step B
//    sets it on the hub for every spoke; governance changes it afterwards.
// ⛔ mainnet is null on purpose: the figure trades how fast honest holders can bring
//    SRX home against how much a compromised chain could take in a day. That is
//    Jared's decision. Until it is recorded here, the hub accepts no returns on mainnet.
const BRIDGE = {
  inboundLimitPerDay: {
    testnet: parseUnits("50000000", 18), // 50M test SRX per spoke per day
    mainnet: null,
  },
  // The guardian's bridge circuit breaker (08 configures it in the Safe's batch while it
  // still holds GOVERNANCE_ROLE on the GuardianModule). Bridge volume reported in EITHER
  // direction (circuit_breaker_monitor.js) fills a draining bucket; reaching `threshold`
  // stops the bridge until governance resets it. ⛔ Internal audit CONTROL-10 (16 Oct
  // 2026): it was left for a later governance proposal, which at launch cannot reach
  // quorum, so an unconfigured breaker would never trip; verify_roles now refuses that.
  // ⛔ mainnet is null on purpose, like inboundLimitPerDay: Jared's decision.
  circuitBreaker: {
    testnet: { threshold: parseUnits("100000000", 18), windowSeconds: 24 * 3600 },
    mainnet: null,
  },
  // Gas the destination executor is paid to deliver a transfer, set as the OApp's
  // enforced option for every pathway (07 SET_PEERS). ⛔ Without it every send with
  // empty options reverts at the quote (found on the Sepolia proof, 7 Oct 2026).
  // Measured 7 Oct: a hub return ~135k gas with base costs, a spoke credit ~77k; voting
  // checkpoints for a delegated recipient add more. 200k covers both with margin.
  lzReceiveGas: 500000, // 7 Oct: 200k was too low — a hub return measured 327k on Sepolia (token alone), so the executor failed
  // Which messages each chain believes (07 SET_DVNS=true, checked by lib/dvnCheck.js).
  // ⛔ The LayerZero defaults are one DVN (LayerZero Labs) and are not accepted. Every
  //    chain lists the SAME operators, at that chain's addresses, so both ends of a
  //    pathway agree. `confirmations` is this chain's OUTBOUND block confirmations; the
  //    receiving chain uses the sender's value. Testnet addresses: LayerZero's published
  //    metadata (metadata.layerzero-api.com/v1/metadata), read 7 Oct 2026; the libraries
  //    are the endpoint's current SendUln302 / ReceiveUln302.
  //    Mainnet operators are Jared's decision: null until chosen.
  dvns: {
    sepolia: {
      sendLib: "0xcc1ae8Cf5D3904Cef3360A9532B477529b177cCE",
      receiveLib: "0xdAf00F5eE2158dD58E0d3857851c432E34A3A851",
      confirmations: 2,
      operators: {
        "LayerZero Labs": "0x8eebf8b423B73bFCa51a1Db4B7354AA0bFCA9193",
        "Nethermind":     "0x68802e01D6321D5159208478f297d7007A7516Ed",
      },
    },
    bscTestnet: {
      sendLib: "0x55f16c442907e86D764AFdc2a07C2de3BdAc8BB7",
      receiveLib: "0x188d4bbCeD671A7aA2b5055937F79510A32e9683",
      confirmations: 5,
      operators: {
        "LayerZero Labs": "0x0eE552262f7B562eFcED6DD4A7e2878AB897d405",
        "Nethermind":     "0x6334290B7b4a365F3c0E79c85B1b42F078db78E4",
      },
    },
    ethereum: null, bsc: null, zkSync: null,
  },
};

// ── Launch reward rates (Security ruling, 23 Oct 2026) ─────────────────────────
// After the role hand-over a rate change is a governance vote, and governance can pass nothing
// until holders have delegated 400M SRX (launch delegation, option 1). So the launch rates are
// set ONCE, in the 06 Safe batch, from this published plan; every later change is a vote. The
// signed-off manifest (deploy/addresses.<network>.json, rewardRates) must state the same values,
// byte for byte, or 06 refuses to run. Units: SRX wei per second.
//   staking: 13.5 SRX/s, about 4 years for the 1.7B allocation (the published schedule).
//   stabilisationFund: ⛔ null until Jared confirms the fund's rate in writing; 06 then leaves
//   it unset and says so (the fund pays nothing until a rate is set).
// A rate cannot promise more than the funded pool: setRewardRate ends the period when the pool
// runs out (_recomputePeriodFinish, SC-ECON-001), so a wrong number only shortens the period.
const REWARD_RATES = {
  staking:           { testnet: parseUnits("13.5", 18), mainnet: parseUnits("13.5", 18) },
  stabilisationFund: { testnet: null, mainnet: null },
};

/** The launch reward rates for a network ({ staking, stabilisationFund }, bigint or null). */
function rewardRatesFor(networkName = currentNetwork()) {
  const key = TESTNET_CHAINS.has(networkName) ? "testnet" : "mainnet";
  return { staking: REWARD_RATES.staking[key], stabilisationFund: REWARD_RATES.stabilisationFund[key] };
}

module.exports = {
  REWARD_RATES, rewardRatesFor,
  LZ_ENDPOINTS, LZ_EIDS, WALLETS, ALLOCATIONS, VESTING, GOVERNANCE, SSF, ssfRewardAllocation, BRIDGE,
  TESTNET_CHAINS, TESTNET_WALLET_DEFAULTS, WALLET_ENV, walletFor, currentNetwork, NEVER_ON_MAINNET,
  TGE_PLAN, launchFloat, vestedByDay,
};
