/**
 * verify_roles.js — Post-deployment role-topology gate (SC-TRUST-001 / SC-TRUST-002)
 *
 * This script is the on-chain enforcement teeth for the Round 4 audit findings.
 * It asserts that, AFTER the role-migration runbook has been executed, the
 * privileged-role topology matches the intended end state:
 *
 *   • The deployer EOA holds NO roles on any contract this gate covers (see the
 *     matrix below; a role outside it is not checked).
 *   • REG-53: SRXStaking, FeeController, StabilisationFund and SRXTreasury are NOT
 *     upgradeable. The gate checks that none of them is a proxy (no EIP-1967
 *     implementation) and that none answers proxiableUUID().
 *   • WIND_DOWN_ROLE (staking, fund) is held by the admin Safe: the fast, one-way
 *     exit-only switch. Never the deployer.
 *   • SRXToken lists staking and the fund as wind-down exits, so a token pause never
 *     blocks an exit-only withdrawal; the GuardianModule's sunset is within 180 days
 *     (Security ruling, 12 Oct 2026).
 *   • GOVERNANCE_ROLE is held by the Timelock (never deployer).
 *   • PAUSER_ROLE is held by the GuardianModule (never deployer).
 *   • SPENDER_ROLE (Treasury) is held by the Timelock (never deployer).
 *   • DEFAULT_ADMIN_ROLE is held by the Timelock — NOT the admin Safe.
 *   • The GuardianModule has all six modules registered to the right contract and the
 *     bridge circuit breaker configured (internal audit 16 Oct 2026, CONTROL-10).
 *   • No Timelock operation is scheduled and still pending, other than ones named in
 *     TIMELOCK_ALLOWED_OPS_<NET>. The Safe is a temporary PROPOSER during setup, and what
 *     it scheduled then outlives the revoke (CONTROL-05). A missing
 *     TIMELOCK_DEPLOY_BLOCK_<NET> is a FAILURE: an absence check that cannot look is not a pass.
 *   • Every launch vault's `revokeRecipient()`, the Genesis contract's `vaultRevokeRecipient()`
 *     and each Genesis buyer vault's `revokeRecipient()` is the SRXTreasury CONTRACT
 *     (TREASURY_<NET>). All are immutable, so a wallet there is permanent (E-02).
 *   • Every peer the hub has is on a DECLARED chain (lib/bridgeEnv.js) at exactly that chain's declared
 *     SRXOFTNative (SRX_OFT_NATIVE_<CHAIN>), and each passes the DVN check. The peers are LISTED from the
 *     hub's PeerSet events from SRX_TOKEN_DEPLOY_BLOCK_<NET> (REQUIRED), not read from a fixed list (E-05).
 *   • The admin Safe HOLDS the two powers it keeps: GuardianModule GUARDIAN_ROLE (emergency pause)
 *     and Timelock CANCELLER_ROLE (the veto); and, once the bridge circuit breaker is configured,
 *     CIRCUIT_BREAKER_ADDRESS_<NET> is set and holds CIRCUIT_BREAKER_ROLE (E-04).
 *   • The Governor is a contract wired to this Timelock and this token, and the Timelock's
 *     PROPOSER holders are exactly the Governor; its CANCELLER holders are the Governor and the
 *     admin Safe; its DEFAULT_ADMIN holder is the Timelock itself. They are LISTED from the
 *     Timelock's RoleGranted / RoleRevoked events from TIMELOCK_DEPLOY_BLOCK_<NET> (E-03).
 *   • The admin Safe holds NO admin, governance, upgrade, spend, pause or burn
 *     role on the CORE contracts, is not the token's bridge owner or LayerZero
 *     delegate, and is neither admin nor proposer of the Timelock. It does
 *     administer the operational contracts (BuybackBurner, SRXAirdrop, PreSaleRound)
 *     by design, and this gate requires that: MULTISIG_SPEC.md lists them.
 *
 * ⛔ DELAY-ONLY AT LAUNCH (Jared, 23 Sep 2026; pre-external-audit sweep GOV-H1).
 *    This gate used to REQUIRE the admin Safe to hold DEFAULT_ADMIN_ROLE. From
 *    there one Safe batch could grant itself SPENDER_ROLE and empty the treasury,
 *    or use GOVERNANCE_ROLE on the
 *    StabilisationFund to send all 1.5B SRX anywhere — all without the 48-hour
 *    delay the documentation promises. And as Timelock admin it could make itself
 *    proposer and schedule updateDelay(0). Every power now sits behind the delay;
 *    the Safe keeps only what GuardianModule gives it (emergency pause).
 *
 * It exits with code 1 (failing CI / the deploy pipeline) if ANY assertion fails.
 * Running this and seeing "ALL CHECKS PASSED" is a BLOCKING mainnet gate.
 *
 * NOTE: The SRX contracts use plain OZ AccessControl (not AccessControlEnumerable),
 * so on-chain member enumeration is unavailable. This script therefore verifies:
 *   (a) each EXPECTED holder returns hasRole == true, and
 *   (b) each FORBIDDEN holder returns hasRole == false.
 * For exhaustive enumeration, cross-reference an off-chain event index of
 * RoleGranted/RoleRevoked logs.
 *
 * Required .env (per network, e.g. _ETHEREUM):
 *   SRX_TOKEN_<NET>, TREASURY_<NET>, STAKING_<NET>, FEE_CONTROLLER_<NET>,
 *   STABILISATION_FUND_<NET>, TIMELOCK_<NET>, GUARDIAN_MODULE_<NET> (the names 05b and 08 print;
 *   the older STABILISATION_<NET> and GUARDIAN_<NET> are still read, E-08)
 *   ADMIN_ADDRESS (the admin Safe), and optionally SSF_GUARDIAN_MULTISIG_<NET> (the StabilisationFund's
 *   GUARDIAN_ROLE; ⛔ not GuardianModule's guardian, which is PAUSE_GUARDIAN in 08) and
 *   DEPLOYER_MULTISIG_<NET> for the fund's tiered roles. GUARDIAN_MULTISIG is retired (E-06) and fails the gate.
 *   SRX_TOKEN_DEPLOY_BLOCK_<NET> (REQUIRED: the block the hub SRXToken was deployed in) and
 *   TIMELOCK_DEPLOY_BLOCK_<NET> (REQUIRED: the block the Timelock was deployed in) and
 *   TIMELOCK_ALLOWED_OPS_<NET> (optional: comma-separated operation ids expected to be pending).
 *
 * Run: npx hardhat run scripts/verify/verify_roles.js --network ethereum
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { TGE_PLAN, TESTNET_CHAINS, GOVERNANCE, LZ_EIDS } = require("../deploy/00_config");
const { checkDvnConfig, checkEnforcedOptions, ENDPOINT_ABI } = require("../deploy/lib/dvnCheck");
const { declaredSpokes } = require("../deploy/lib/bridgeEnv");
const { retiredGuardianVariable, retiredGuardianMessage, lookupEnv } = require("../deploy/lib/launch_order");
const { checkGuardianWiring, checkNoPendingTimelockOps, parseOpList, parseBlock, checkRevokeRecipients,
  checkTimelockRoleHolders, checkGovernorWiring, checkSafePowers, checkCircuitBreakerMonitor, checkHubPeers } = require("../deploy/lib/gate_checks");

const NET = network.name.toUpperCase();
const ZERO = "0x0000000000000000000000000000000000000000";

// DEFAULT_ADMIN_ROLE is bytes32(0); all others are keccak256 of the name.
const ROLE = {
  DEFAULT_ADMIN_ROLE: "0x0000000000000000000000000000000000000000000000000000000000000000",
  GOVERNANCE_ROLE: ethers.id("GOVERNANCE_ROLE"),
  WIND_DOWN_ROLE: ethers.id("WIND_DOWN_ROLE"),
  PAUSER_ROLE: ethers.id("PAUSER_ROLE"),
  SPENDER_ROLE: ethers.id("SPENDER_ROLE"),
  GUARDIAN_ROLE: ethers.id("GUARDIAN_ROLE"),
  DEPLOYER_ROLE: ethers.id("DEPLOYER_ROLE"),
  ORACLE_REPORTER_ROLE: ethers.id("ORACLE_REPORTER_ROLE"),
  GATEWAY_ROLE: ethers.id("GATEWAY_ROLE"),
  BURN_ROLE: ethers.id("BURN_ROLE"),
  PROPOSER_ROLE: ethers.id("PROPOSER_ROLE"),
  CANCELLER_ROLE: ethers.id("CANCELLER_ROLE"),
  CIRCUIT_BREAKER_ROLE: ethers.id("CIRCUIT_BREAKER_ROLE"),
  ORACLE_ROLE: ethers.id("ORACLE_ROLE"),
  EXECUTOR_ROLE: ethers.id("EXECUTOR_ROLE"),
};

/**
 * A contract no deploy script creates must be DECLARED for this network: its
 * address, or the literal "none". ⛔ An undeclared one is a failure, never a skip —
 * "not configured" and "not deployed" must never look the same to a blocking gate.
 * Returns { state: "address", addr } | { state: "none" } | { state: "undeclared" }.
 */
function declared(key) {
  const v = (process.env[`${key}_${NET}`] || process.env[key] || "").trim();
  if (!v) return { state: "undeclared" };
  if (v.toLowerCase() === "none") return { state: "none" };
  return { state: "address", addr: ethers.getAddress(v) };
}

function envAddr(key, { required = true } = {}) {
  // E-08: the canonical name first, then the older spelling (STABILISATION, GUARDIAN), each as <NAME>_<NET> then bare.
  const found = lookupEnv(key, network.name);
  if (!found && required) throw new Error(`Missing required address: ${key}_${NET} (or ${key}) in .env`);
  return found ? ethers.getAddress(found.value) : null;
}

async function main() {
  // ⛔ THE DEPLOYER ADDRESS MUST BE STATED, NOT INFERRED FROM THE LOADED KEY.
  //    This previously read `const [deployer] = await ethers.getSigners()`, so
  //    "the deployer EOA holds no roles" was asserted against whichever key
  //    hardhat happened to load. Run the gate with any other key and every
  //    mustNotHold assertion passes trivially — including SC-TRUST-002, the
  //    core requirement this script exists to enforce. A check that passes
  //    because it is looking at the wrong address is worse than no check.
  const signers = await ethers.getSigners();
  const loadedAddr = signers.length ? ethers.getAddress(await signers[0].getAddress()) : null;
  const statedDeployer = process.env[`DEPLOYER_EOA_${NET}`] || process.env.DEPLOYER_EOA;
  const deployerAddr = statedDeployer ? ethers.getAddress(statedDeployer) : loadedAddr;

  const advisories = [];
  let failures = 0;
  let checks = 0;
  let skipped = 0;
  if (!statedDeployer) {
    advisories.push(
      "DEPLOYER_EOA is not set, so the 'deployer holds no roles' assertion was made against the " +
      "currently-loaded signer (" + loadedAddr + ") rather than the address that actually deployed. " +
      "If those differ, SC-TRUST-002 passed vacuously.");
  } else if (loadedAddr && loadedAddr !== deployerAddr) {
    console.log(`   note: checking stated deployer ${deployerAddr}, loaded signer is ${loadedAddr}`);
  }

  // ── Resolve the topology ───────────────────────────────────────────────────
  const admin     = envAddr("ADMIN_ADDRESS");            // admin Safe
  const timelock  = envAddr("TIMELOCK");                 // SRXTimelock
  const governor  = envAddr("GOVERNOR");                 // SRXGovernor
  const srxToken  = envAddr("SRX_TOKEN");                // SRXToken (Ethereum hub)
  const guardianM = envAddr("GUARDIAN_MODULE");          // GuardianModule (PAUSER holder)
  const guardianMS = envAddr("SSF_GUARDIAN_MULTISIG", { required: false }); // StabilisationFund GUARDIAN_ROLE (70% fast path)
  // ⛔ E-06: GUARDIAN_MULTISIG named two roles (08: GuardianModule's guardian; here: the fund's).
  //    It is no longer read by either; a leftover value is a failure, never a guess.
  {
    const retired = retiredGuardianVariable(process.env, network.name);
    if (retired) { failures++; console.log(`❌ ${retiredGuardianMessage(retired)}`); }
  }
  const deployerMS = envAddr("DEPLOYER_MULTISIG", { required: false }); // SSF DEPLOYER_ROLE
  const reporter   = envAddr("ORACLE_REPORTER", { required: false });   // SSF ORACLE_REPORTER_ROLE (the monitor)

  const contracts = {
    SRXToken:          { addr: srxToken,                 artifact: "SRXToken" },
    SRXTimelock:       { addr: timelock,                 artifact: "SRXTimelock" },
    SRXTreasury:       { addr: envAddr("TREASURY"),      artifact: "SRXTreasury" },
    SRXStaking:        { addr: envAddr("STAKING"),       artifact: "SRXStaking" },
    FeeController:     { addr: envAddr("FEE_CONTROLLER"), artifact: "FeeController" },
    StabilisationFund: { addr: envAddr("STABILISATION_FUND"), artifact: "StabilisationFund" },
  };

  // ── Expectation matrix: [role, mustHold[], mustNotHold[]] ───────────────────
  // mustNotHold ALWAYS includes the deployer EOA (SC-TRUST-002 core requirement).
  const baseForbidden = [deployerAddr];
  const noSafe = [deployerAddr, admin];

  const expectations = {
    SRXToken: [
      ["DEFAULT_ADMIN_ROLE", [timelock], noSafe],
      ["GOVERNANCE_ROLE",    [timelock], noSafe],
      ["PAUSER_ROLE",        [guardianM],noSafe],
      ["BURN_ROLE",          [],         noSafe],
    ],
    SRXTimelock: [
      // OZ v5 TimelockController: DEFAULT_ADMIN_ROLE is the timelock admin. Only
      // the timelock itself may hold it, or its own delay is not a delay.
      ["DEFAULT_ADMIN_ROLE", [timelock], noSafe],
      ["PROPOSER_ROLE",      [governor], noSafe],
      // The Safe MAY keep CANCELLER (set in 02_deploy_governance): a veto on a
      // hostile proposal. It can stop an operation, never start one.
      ["CANCELLER_ROLE",     [governor], baseForbidden],
    ],
    SRXTreasury: [
      ["DEFAULT_ADMIN_ROLE", [timelock], noSafe],
      ["GOVERNANCE_ROLE",    [timelock], noSafe],
      ["PAUSER_ROLE",        [guardianM],noSafe],
      ["SPENDER_ROLE",       [timelock], noSafe],
    ],
    SRXStaking: [
      ["DEFAULT_ADMIN_ROLE", [timelock], noSafe],
      ["WIND_DOWN_ROLE",     [admin],    baseForbidden],
      ["GOVERNANCE_ROLE",    [timelock], noSafe],
      ["PAUSER_ROLE",        [guardianM],noSafe],
    ],
    FeeController: [
      ["DEFAULT_ADMIN_ROLE", [timelock], noSafe],
      ["GOVERNANCE_ROLE",    [timelock], noSafe],
      ["PAUSER_ROLE",        [guardianM],noSafe],
      // GATEWAY_ROLE gates no function today (internal review, 7 Oct 2026); the
      // deployer key must still not hold it, so a future use starts clean.
      ["GATEWAY_ROLE",       [],         baseForbidden],
    ],
    StabilisationFund: [
      ["DEFAULT_ADMIN_ROLE", [timelock], noSafe],
      ["WIND_DOWN_ROLE",     [admin],    baseForbidden],
      // ⛔ The Safe held GOVERNANCE_ROLE here from initialize() and nothing forbade
      //    it: deployLiquidity's governance path has no stress, cap or allowlist.
      ["GOVERNANCE_ROLE",    [timelock], noSafe],
      ["PAUSER_ROLE",        [guardianM],noSafe],
      // SSF tiered roles: distinct multisigs, never the same address (SC-TRUST checks)
      // ⛔ These two were SPREAD OUT OF THE MATRIX when their optional env vars
      //    were unset — no skip message, no warning — and the script still
      //    printed ALL CHECKS PASSED. They are now recorded as advisories so an
      //    incomplete run cannot read as a clean one.
      ...(deployerMS ? [["DEPLOYER_ROLE", [deployerMS], [...baseForbidden]]] : []),
      ...(guardianMS ? [["GUARDIAN_ROLE", [guardianMS], [...baseForbidden]]] : []),
      // ⛔ Internal review, 7 Oct 2026: this role was outside the gate. It declares a
      //    stress event, which opens the guardian's and deployer's capped fast paths.
      //    The deployer key must never hold it; the monitor's address must, when stated.
      ["ORACLE_REPORTER_ROLE", reporter ? [reporter] : [], baseForbidden],
    ],
  };

  if (!deployerMS) advisories.push("DEPLOYER_MULTISIG unset — the StabilisationFund DEPLOYER_ROLE check did not run.");
  if (!reporter) advisories.push("ORACLE_REPORTER unset — only 'the deployer does not hold ORACLE_REPORTER_ROLE' was checked, not who does.");
  if (!guardianMS) advisories.push("SSF_GUARDIAN_MULTISIG unset — the StabilisationFund GUARDIAN_ROLE check did not run.");

  // ── GuardianModule (30 Sep 2026: it was outside this gate) ─────────────────
  // ⛔ 08_deploy_guardian gives the admin Safe DEFAULT_ADMIN_ROLE here and nothing
  //    removed it. From it the Safe could grant itself GOVERNANCE_ROLE and, with
  //    no delay, call emergencyUnpauseAll / governanceUnpause /
  //    resetCircuitBreaker / updateModuleTarget — re-opening a tripped circuit
  //    breaker, which GOV-H1 and MULTISIG_SPEC say the Safe can never do. The Safe
  //    keeps GUARDIAN_ROLE (pause) through PAUSE_GUARDIAN, nothing more.
  contracts.GuardianModule = { addr: guardianM, artifact: "GuardianModule" };
  expectations.GuardianModule = [
    ["DEFAULT_ADMIN_ROLE",   [timelock], noSafe],
    ["GOVERNANCE_ROLE",      [timelock], noSafe],
    ["GUARDIAN_ROLE",        [],         baseForbidden],
    ["CIRCUIT_BREAKER_ROLE", [],         baseForbidden],
  ];

  // ── Operational contracts (MULTISIG_SPEC "Safe-administered by design") ────
  // Each is declared for the network: an address, or "none". Their administrator
  // is the Safe BY DESIGN, with the trust disclosed in MULTISIG_SPEC — a 48-hour
  // delay would stop day-to-day operation. What the gate enforces is the spec:
  // the Safe is the administrator, the deployer key never is, and where the spec
  // puts a role behind the Timelock it is there.
  // ⛔ ZkSyncMigrator is RETIRED (CH-13, Jared, 22 Oct 2026): SRX moves onto Syrax Chain
  //    through the chain's own bridge, and no migrator may hold BURN_ROLE on the token.
  //    A network that declares one fails the gate; leave MIGRATOR_<NET> unset or "none".
  {
    const m = declared("MIGRATOR");
    if (m.state === "address") {
      failures++;
      console.log(`❌ ZkSyncMigrator ${m.addr} is declared, but it is retired (CH-13): nothing may deploy or wire it. Remove MIGRATOR_${NET}.`);
    }
  }
  const optional = {
    BuybackBurner: { key: "BUYBACK_BURNER", artifact: "BuybackBurner", roles: [
      ["DEFAULT_ADMIN_ROLE", [admin],    baseForbidden],
      ["EXECUTOR_ROLE",      [],         baseForbidden],
    ] },
    SRXAirdrop: { key: "AIRDROP", artifact: "SRXAirdrop", roles: [
      ["DEFAULT_ADMIN_ROLE", [admin],    baseForbidden],
    ] },
    SRXOFTNative: { key: "SRX_OFT_NATIVE", artifact: "SRXOFTNative", roles: [
      ["DEFAULT_ADMIN_ROLE", [admin],    baseForbidden],
    ], owner: "admin" },
  };
  const declaredNone = [];
  for (const [name, spec] of Object.entries(optional)) {
    const d = declared(spec.key);
    if (d.state === "undeclared") {
      failures++;
      console.log(`❌ ${name}: not declared — set ${spec.key}_${NET} to its address, or to "none" if this network has none`);
    } else if (d.state === "none") {
      declaredNone.push(name);
    } else {
      contracts[name] = { addr: d.addr, artifact: spec.artifact, owner: spec.owner };
      expectations[name] = spec.roles;
    }
  }

  // ── Contracts whose admin is fixed at deployment (immutable admin()) ───────
  // Not roles: an address written into the contract that can never change. It
  // must never be the deployer key.
  // ⭐ LAUNCH VAULTS: THE ADMIN MUST BE THE TIMELOCK (Jared, 30 Sep 2026). A
  //    VestingVault's admin can revoke() it at any moment and send the whole
  //    unvested remainder to ANY address. With the Safe as admin that was an
  //    instant power over every locked launch allocation — the "locked 12 months"
  //    liquidity reserve included. Anything but the Timelock is a failure.
  //    (Presale buyer vaults are admin'd by PreSaleRound — disclosed, SC-TRUST-004.)
  const fixedAdmin = [];
  const tgeDist = declared("TGE_DISTRIBUTOR");
  if (tgeDist.state === "address") fixedAdmin.push({ name: "TGEDistributor", addr: tgeDist.addr, revokes: false });
  else if (tgeDist.state === "undeclared") { failures++; console.log(`❌ TGEDistributor: not declared (TGE_DISTRIBUTOR_${NET})`); }
  const presale = declared("PRESALE_ROUND");
  // PreSaleRound's Safe admin (incl. revokeVault) is disclosed trust, SC-TRUST-004.
  if (presale.state === "address") fixedAdmin.push({ name: "PreSaleRound", addr: presale.addr, revokes: false });
  else if (presale.state === "undeclared") { failures++; console.log(`❌ PreSaleRound: not declared (PRESALE_ROUND_${NET}, or "none")`); }
  for (const row of TGE_PLAN.filter((r) => r.kind === "vault")) {
    const v = declared(row.vaultEnv);
    if (v.state === "address") fixedAdmin.push({ name: `VestingVault ${row.label}`, addr: v.addr, mustBe: timelock });
    else { failures++; console.log(`❌ VestingVault ${row.label}: not declared (${row.vaultEnv}_${NET})`); }
  }

  // ── The deployer, pinned on a real network ─────────────────────────────────
  // On a real network the deployer comes from the reviewed manifest, not only from
  // an env var: deploy/addresses.<net>.json roles.deployer must exist and agree.
  if (!TESTNET_CHAINS.has(network.name)) {
    const mf = path.join(__dirname, "..", "..", "deploy", `addresses.${network.name}.json`);
    const pinned = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, "utf8"))?.roles?.deployer : null;
    if (!pinned || pinned === ZERO) {
      failures++;
      console.log(`❌ deploy/addresses.${network.name}.json has no roles.deployer — the deployer must be pinned in the reviewed manifest`);
    } else if (ethers.getAddress(pinned) !== deployerAddr) {
      failures++;
      console.log(`❌ DEPLOYER_EOA ${deployerAddr} disagrees with the manifest's roles.deployer ${ethers.getAddress(pinned)}`);
    }
  }

  console.log(`\n🔐 SRX role-topology verification — network: ${network.name}`);
  console.log(`   deployer EOA (must hold NO roles): ${deployerAddr}`);
  console.log(`   admin Safe:    ${admin}`);
  console.log(`   timelock:      ${timelock}`);
  console.log(`   guardianModule:${guardianM}\n`);

  for (const [name, meta] of Object.entries(contracts)) {
    const c = await ethers.getContractAt(meta.artifact, meta.addr);
    console.log(`── ${name} @ ${meta.addr}`);

    for (const [roleName, mustHold, mustNotHold] of expectations[name]) {
      const role = ROLE[roleName];

      for (const holder of mustHold) {
        // ⛔ Was a bare `continue` — an unresolved address silently removed the
        //    check from the run and from the count.
        if (!holder || holder === ZERO) { skipped++; advisories.push(`${name}.${roleName}: expected holder unresolved, check skipped.`); continue; }
        checks++;
        const ok = await c.hasRole(role, holder);
        if (ok) {
          console.log(`   ✅ ${roleName} held by ${holder}`);
        } else {
          failures++;
          console.log(`   ❌ ${roleName} NOT held by expected ${holder}`);
        }
      }

      for (const holder of mustNotHold) {
        if (!holder || holder === ZERO) { skipped++; advisories.push(`${name}.${roleName}: forbidden address unresolved, check skipped.`); continue; }
        checks++;
        const has = await c.hasRole(role, holder);
        if (!has) {
          console.log(`   ✅ ${roleName} correctly NOT held by ${holder}`);
        } else {
          failures++;
          console.log(`   ❌ ${roleName} WRONGLY held by forbidden ${holder}`);
        }
      }
    }
    if (meta.owner) {
      // ⛔ SPOKE-01 closed (disclosure A, 7 Oct 2026): a spoke's owner() is its OWN
      //    Timelock, never the Safe. This used to REQUIRE the Safe. The full spoke check
      //    (delegate, delay, proposer, the fixed hub peer) is scripts/verify/verify_spoke.js.
      checks++;
      const owner = ethers.getAddress(await c.owner());
      const spokeTl = process.env[`SPOKE_TIMELOCK_${NET}`];
      if (spokeTl && owner === ethers.getAddress(spokeTl)) console.log(`   ✅ owner() is the spoke Timelock`);
      else { failures++; console.log(`   ❌ owner() is ${owner}, expected the spoke Timelock (SPOKE_TIMELOCK_${NET}); run 07 HANDOVER and FINALIZE`); }
    }
    console.log("");
  }

  // ── The Timelock's delay, and roles that administer themselves ─────────────
  // ⛔ Internal review, 7 Oct 2026: the gate checked who HOLDS each role, but not
  //    the Timelock's delay (the "48 hours, no bypass" claim) or that upgrade and
  //    spending rights administer themselves (SC-TRUST-001 in code). Both are now
  //    gated, so a deployment that drifted from either fails here.
  {
    const required = BigInt(GOVERNANCE.timelockDelayFor(network.name));
    const tl = new ethers.Contract(timelock, [
      "function getMinDelay() view returns (uint256)",
      "function minDelayFloor() view returns (uint256)",
    ], ethers.provider);
    const delay = await tl.getMinDelay();
    let floor = 0n;
    try { floor = await tl.minDelayFloor(); } catch { /* an older Timelock has no floor */ }
    checks++;
    if (delay < required) { failures++; console.log(`❌ SRXTimelock delay ${delay}s is below the required ${required}s`); }
    else console.log(`✅ SRXTimelock delay ${delay}s (required ${required}s)`);
    checks++;
    if (floor < required) { failures++; console.log(`❌ SRXTimelock floor ${floor}s is below ${required}s: a proposal could lower the delay`); }
    else console.log(`✅ SRXTimelock floor ${floor}s: the delay cannot be lowered below it`);

    const selfAdministered = [
      ["SRXTreasury", "SPENDER_ROLE"],
    ];
    for (const [name, roleName] of selfAdministered) {
      const c = new ethers.Contract(contracts[name].addr, ["function getRoleAdmin(bytes32) view returns (bytes32)"], ethers.provider);
      const role = ethers.id(roleName);
      checks++;
      if ((await c.getRoleAdmin(role)) === role) console.log(`✅ ${name}: ${roleName} administers itself (DEFAULT_ADMIN cannot grant it)`);
      else { failures++; console.log(`❌ ${name}: ${roleName} is administered by another role, so its holder can hand it out`); }
    }
    console.log("");
  }

  // ── REG-53: the staking and fee-path contracts are not proxies ─────────────
  {
    const { upgrades } = require("hardhat");
    for (const name of ["SRXTreasury", "SRXStaking", "FeeController", "StabilisationFund"]) {
      const addr = contracts[name].addr;
      checks++;
      let impl = null;
      try { impl = await upgrades.erc1967.getImplementationAddress(addr); } catch { /* not a proxy: expected */ }
      if (impl && BigInt(impl) !== 0n) { failures++; console.log(`❌ ${name}: is an EIP-1967 proxy (implementation ${impl}); REG-53 requires a plain contract`); continue; }
      let answers = false;
      try { await new ethers.Contract(addr, ["function proxiableUUID() view returns (bytes32)"], ethers.provider).proxiableUUID(); answers = true; } catch { /* expected */ }
      if (answers) { failures++; console.log(`❌ ${name}: answers proxiableUUID() — it can be upgraded`); continue; }
      console.log(`✅ ${name}: not a proxy and not upgradeable (REG-53)`);
    }
    console.log("");
  }

  // ── Security ruling, 12 Oct 2026: a token pause never blocks an exit ───────
  // ⛔ Unlisted, a token pause would block exit-only withdrawals again: the exemption
  //    is opt-in on the token. The guardian's sunset is bounded in its constructor.
  {
    const token = await ethers.getContractAt("SRXToken", srxToken);
    for (const name of ["SRXStaking", "StabilisationFund"]) {
      checks++;
      if (await token.isWindDownExit(contracts[name].addr)) console.log(`✅ SRXToken lists ${name} as a wind-down exit`);
      else { failures++; console.log(`❌ SRXToken does not list ${name} as a wind-down exit: a token pause would block its exit-only withdrawals`); }
    }
    checks++;
    const gm = await ethers.getContractAt("GuardianModule", guardianM);
    const life = (await gm.MAXIMUM_SUNSET()) - BigInt((await ethers.provider.getBlock("latest")).timestamp);
    if (life <= await gm.MAX_SUNSET_DURATION()) console.log("✅ GuardianModule: sunset within the 180-day cap");
    else { failures++; console.log(`❌ GuardianModule: MAXIMUM_SUNSET is ${life}s away, beyond the 180-day cap`); }
    console.log("");
  }

  // ── GuardianModule registry and bridge breaker (internal audit 16 Oct 2026, CONTROL-10) ──
  // ⛔ The roles above can all be right while a module was never registered, was registered
  //    to the wrong contract, or the bridge breaker was never configured (reports then do
  //    nothing, so it can never trip). Each is a failure.
  {
    const gm = await ethers.getContractAt("GuardianModule", guardianM);
    const wiring = await checkGuardianWiring({ guardian: gm, expected: {
      token: srxToken, staking: contracts.SRXStaking.addr, fee: contracts.FeeController.addr,
      treasury: contracts.SRXTreasury.addr, ssf: contracts.StabilisationFund.addr,
    } });
    checks++;
    if (wiring.length === 0) console.log("✅ GuardianModule: all six modules registered to the right contracts, bridge circuit breaker configured");
    for (const f of wiring) { failures++; console.log(`❌ ${f}`); }
    console.log("");
  }

  // ── Holders the topology REQUIRES: the Safe's pause and veto, and the breaker's monitor (E-04) ──
  // ⛔ The matrix names who must NOT hold a role. MULTISIG_SPEC says the Safe KEEPS emergency pause
  //    (GuardianModule GUARDIAN_ROLE) and the veto (Timelock CANCELLER_ROLE), and a configured
  //    circuit breaker is only as good as the address that reports to it. None was required.
  {
    const gm = await ethers.getContractAt("GuardianModule", guardianM);
    const tlc = await ethers.getContractAt("SRXTimelock", timelock);
    const powers = await checkSafePowers({ timelock: tlc, guardian: gm, admin });
    checks += powers.checked;
    if (powers.failures.length === 0) console.log("✅ the admin Safe holds GuardianModule GUARDIAN_ROLE (emergency pause) and Timelock CANCELLER_ROLE (veto)");
    for (const f of powers.failures) { failures++; console.log(`❌ ${f}`); }

    const monitor = envAddr("CIRCUIT_BREAKER_ADDRESS", { required: false });
    const mon = await checkCircuitBreakerMonitor({ guardian: gm, monitor });
    checks += mon.checked;
    if (mon.failures.length === 0 && mon.checked > 0) console.log(`✅ circuit-breaker monitor ${monitor} holds CIRCUIT_BREAKER_ROLE`);
    for (const f of mon.failures) { failures++; console.log(`❌ ${f}`); }
    console.log("");
  }

  // ── Pending Timelock operations (internal audit 16 Oct 2026, CONTROL-05) ───
  // ⛔ hasRole() cannot see an operation the Safe scheduled while it was a temporary
  //    PROPOSER: it stays executable by anyone once the Safe is revoked. Read the
  //    Timelock's own events from its deployment block. No start block means the check
  //    cannot look, and that is a failure, never a skip.
  {
    let allowList = [];
    let listError = null;
    try { allowList = parseOpList(process.env[`TIMELOCK_ALLOWED_OPS_${NET}`] || process.env.TIMELOCK_ALLOWED_OPS); }
    catch (e) { listError = e.message; }
    checks++;
    if (listError) { failures++; console.log(`❌ TIMELOCK_ALLOWED_OPS_${NET} is malformed: ${listError}`); }
    else {
      const tlc = await ethers.getContractAt("SRXTimelock", timelock);
      const fromBlock = parseBlock(process.env[`TIMELOCK_DEPLOY_BLOCK_${NET}`] || process.env.TIMELOCK_DEPLOY_BLOCK);
      const pendingOps = await checkNoPendingTimelockOps({ timelock: tlc, fromBlock, allowList });
      if (pendingOps.length === 0) console.log(`✅ Timelock: no scheduled operation is still pending (read from block ${fromBlock}; ${allowList.length} allow-listed)`);
      for (const f of pendingOps) { failures++; console.log(`❌ ${f}`); }
    }
    console.log("");
  }

  // ── The Governor, and everyone who can propose to or cancel on the Timelock (E-03) ──
  // ⛔ The matrix above checks that the Governor holds PROPOSER and that the deployer and the
  //    Safe do not. It cannot see ANY OTHER holder, and it takes GOVERNOR_<NET> on trust. A
  //    single key with PROPOSER (or a "Governor" that is not one) passed as "Governor only".
  //    So: the Governor must be a contract wired to this Timelock and token, and the holders
  //    of PROPOSER / CANCELLER / DEFAULT_ADMIN are listed from the Timelock's own events.
  {
    const gov = await checkGovernorWiring({ provider: ethers.provider, governor, timelock, token: srxToken });
    checks += gov.checked;
    if (gov.failures.length === 0) console.log(`✅ Governor ${governor} is a contract wired to this Timelock and this token`);
    for (const f of gov.failures) { failures++; console.log(`❌ ${f}`); }

    const tlc = await ethers.getContractAt("SRXTimelock", timelock);
    const fromBlock = parseBlock(process.env[`TIMELOCK_DEPLOY_BLOCK_${NET}`] || process.env.TIMELOCK_DEPLOY_BLOCK);
    const roles = await checkTimelockRoleHolders({ timelock: tlc, fromBlock, governor, admin });
    checks += roles.checked;
    if (roles.failures.length === 0) {
      const show = (n) => (roles.holders[n] || []).map((a) => (a === governor ? "the Governor" : a === admin ? "the admin Safe" : a === timelock ? "the Timelock" : a)).join(", ") || "nobody";
      console.log(`✅ Timelock holders (read from block ${fromBlock}): PROPOSER: ${show("PROPOSER_ROLE")} · CANCELLER: ${show("CANCELLER_ROLE")} · DEFAULT_ADMIN: ${show("DEFAULT_ADMIN_ROLE")}`);
    }
    for (const f of roles.failures) { failures++; console.log(`❌ ${f}`); }
    console.log("");
  }

  // ── Immutable admin() ──────────────────────────────────────────────────────
  for (const f of fixedAdmin) {
    const c = new ethers.Contract(f.addr, ["function admin() view returns (address)"], ethers.provider);
    let a;
    try { a = ethers.getAddress(await c.admin()); } catch { failures++; console.log(`❌ ${f.name} @ ${f.addr}: admin() did not answer`); continue; }
    checks++;
    if (a === deployerAddr) { failures++; console.log(`❌ ${f.name}: admin() is the deployer key ${a}`); continue; }
    console.log(`✅ ${f.name}: admin() is not the deployer (${a === admin ? "the admin Safe" : a === timelock ? "the Timelock" : a})`);
    if (f.mustBe && a !== f.mustBe) {
      failures++;
      console.log(`❌ ${f.name}: admin() must be the Timelock ${f.mustBe} — whoever holds it can revoke() the vault and send its locked SRX anywhere`);
    }
  }
  if (fixedAdmin.length) console.log("");

  // ── E-02: where a revoked vault's unvested SRX goes ────────────────────────
  // ⛔ All of these recipients are immutable and the documents say they are the SRXTreasury.
  //    The deploy scripts used to fall back to a wallet and nothing here read the result.
  {
    const vaults = TGE_PLAN.filter((r) => r.kind === "vault")
      .map((r) => ({ row: r, d: declared(r.vaultEnv) }))
      .filter((x) => x.d.state === "address")
      .map((x) => ({ label: `VestingVault ${x.row.label}`, address: x.d.addr }));
    const rr = await checkRevokeRecipients({
      provider: ethers.provider, treasury: contracts.SRXTreasury.addr, tokenAddress: srxToken,
      vaults, genesisRound: presale.state === "address" ? presale.addr : null,
    });
    checks += rr.checked;
    if (rr.failures.length === 0) console.log(`✅ revokeRecipient: ${vaults.length} launch vaults${presale.state === "address" ? ", the Genesis contract and its buyers' vaults" : ""} all name the SRXTreasury ${contracts.SRXTreasury.addr} (${rr.checked} checks)`);
    for (const f of rr.failures) { failures++; console.log(`❌ ${f}`); }
    console.log("");
  }

  // ── Bridge authority (N-02): the OApp owner and the LayerZero delegate ─────
  // They control peers, enforced options, the message inspector and the DVN /
  // library configuration — the bridge's real authority, outside AccessControl.
  {
    const token = await ethers.getContractAt("SRXToken", srxToken);
    const owner = ethers.getAddress(await token.owner());
    checks++;
    if (owner === timelock) console.log(`✅ SRXToken.owner() is the Timelock`);
    else { failures++; console.log(`❌ SRXToken.owner() is ${owner}, expected the Timelock ${timelock}`); }
    const pending = ethers.getAddress(await token.pendingOwner());
    if (pending !== ZERO) { failures++; console.log(`❌ SRXToken has a pending owner ${pending} — finish or cancel the transfer`); }
    const endpoint = new ethers.Contract(await token.endpoint(),
      ["function delegates(address) view returns (address)"], ethers.provider);
    const delegate = ethers.getAddress(await endpoint.delegates(srxToken));
    checks++;
    if (delegate === timelock) console.log(`✅ LayerZero delegate is the Timelock`);
    else { failures++; console.log(`❌ LayerZero delegate is ${delegate}, expected the Timelock ${timelock}`); }

    // Every chain the hub has a peer on (E-05). ⛔ This used to walk the fixed LZ_EIDS list: a peer
    // on any OTHER endpoint id was never looked at. The hub's peers are now LISTED from its own
    // PeerSet events (SRX_TOKEN_DEPLOY_BLOCK_<NET>, required); each must be on a declared chain
    // (lib/bridgeEnv.js), at exactly that chain's declared SRXOFTNative, and every one gets the
    // DVN check (lib/dvnCheck.js), whatever its endpoint id.
    const local = network.name === "hardhat" || network.name === "localhost";
    const lz = new ethers.Contract(await token.endpoint(), ENDPOINT_ABI, ethers.provider);
    const chainName = (eid) => Object.entries(LZ_EIDS).find(([, v]) => v === eid)?.[0] || `EID ${eid}`;
    const dvnCheck = async ({ eid, label }) => {
      let dvn;
      try { dvn = await checkDvnConfig({ endpoint: lz, oapp: srxToken, remoteEid: eid, label }); }
      catch (e) {
        if (local) { skipped++; advisories.push(`DVN configuration for ${chainName(eid)} not checked: the local endpoint is a mock.`); return []; }
        return [`${label}: the endpoint did not answer the DVN configuration read (${e.shortMessage || e.message})`];
      }
      dvn.push(...await checkEnforcedOptions({ oapp: token, remoteEid: eid, label: label.replace("<->", "->") }));
      if (dvn.length === 0) console.log(`✅ ${label}: own libraries, at least 2 DVNs each way, delivery gas enforced`);
      return dvn;
    };
    const hubFrom = parseBlock(process.env[`SRX_TOKEN_DEPLOY_BLOCK_${NET}`] || process.env.SRX_TOKEN_DEPLOY_BLOCK);
    const hub = await checkHubPeers({
      token, fromBlock: hubFrom, declared: declaredSpokes(network.name), extraEids: Object.values(LZ_EIDS), dvnCheck,
      envName: `SRX_TOKEN_DEPLOY_BLOCK_${NET}`,
    });
    checks += hub.checked;
    if (hub.failures.length === 0) {
      console.log(`✅ hub peers (read from block ${hubFrom}): ${hub.peers.length === 0 ? "none set" : hub.peers.map((p) => `${chainName(p.eid)} ${ethers.getAddress(ethers.dataSlice(p.peer, 12))}`).join(", ") + ", each a declared chain at its declared contract"}`);
    }
    for (const f of hub.failures) { failures++; console.log(`❌ ${f}`); }
    console.log("");
  }

  // ── SSF role-separation invariant: DEPLOYER != GUARDIAN ─────────────────────
  if (deployerMS && guardianMS && deployerMS === guardianMS) {
    failures++;
    console.log(`❌ SSF DEPLOYER_MULTISIG == SSF_GUARDIAN_MULTISIG (${deployerMS}) — roles must be distinct`);
  }

  console.log("──────────────────────────────────────────────");
  console.log(`Checks run: ${checks} | Failures: ${failures} | Skipped: ${skipped}`);
  console.log(`Role-checked: ${Object.keys(contracts).join(", ")}`);
  console.log(`Fixed admin checked: ${fixedAdmin.map((f) => f.name).join(", ") || "none"}`);
  if (declaredNone.length) console.log(`Declared "none" on ${network.name}: ${declaredNone.join(", ")}`);

  if (advisories.length) {
    console.log("\n⚠️  This run was INCOMPLETE:");
    for (const a of advisories) console.log(`     • ${a}`);
  }

  if (failures > 0) {
    console.log("\n❌ ROLE TOPOLOGY INVALID — mainnet deployment is BLOCKED.");
    process.exit(1);
  }

  // ⛔ For a BLOCKING gate, incomplete must not read as clean. Previously an
  //    absent env var removed a check and the script still printed ALL CHECKS
  //    PASSED, which is the failure mode this whole file exists to prevent.
  if (advisories.length || skipped > 0) {
    console.log("\n⚠️  NOT A FULL PASS — checks were skipped or made against an unstated address.");
    console.log("    Resolve the advisories above and re-run before treating this gate as satisfied.");
    process.exit(2);
  }

  console.log("\n✅ ALL CHECKS PASSED — role topology matches the intended end state.");
  console.log(`   (${Object.keys(contracts).length} role-checked contracts, ${fixedAdmin.length} fixed-admin contracts, ${declaredNone.length} declared absent.)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
