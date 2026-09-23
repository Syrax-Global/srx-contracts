/**
 * verify_roles.js — Post-deployment role-topology gate (SC-TRUST-001 / SC-TRUST-002)
 *
 * This script is the on-chain enforcement teeth for the Round 4 audit findings.
 * It asserts that, AFTER the role-migration runbook has been executed, the
 * privileged-role topology matches the intended end state:
 *
 *   • The deployer EOA holds NO roles on ANY contract.
 *   • UPGRADER_ROLE is held ONLY by the Timelock (never admin, never deployer).
 *   • GOVERNANCE_ROLE is held by the Timelock (never deployer).
 *   • PAUSER_ROLE is held by the GuardianModule (never deployer).
 *   • SPENDER_ROLE (Treasury) is held by the Timelock (never deployer).
 *   • DEFAULT_ADMIN_ROLE is held by the Timelock — NOT the admin Safe.
 *   • The admin Safe holds NO admin, governance, upgrade, spend, pause or burn
 *     role anywhere, is not the token's bridge owner or LayerZero delegate, and
 *     is neither admin nor proposer of the Timelock.
 *
 * ⛔ DELAY-ONLY AT LAUNCH (Jared, 23 Sep 2026; pre-external-audit sweep GOV-H1).
 *    This gate used to REQUIRE the admin Safe to hold DEFAULT_ADMIN_ROLE. From
 *    there one Safe batch could grant itself SPENDER_ROLE and empty the treasury,
 *    re-grant UPGRADER_ROLE and upgrade anything, or use GOVERNANCE_ROLE on the
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
 *   STABILISATION_<NET>, TIMELOCK_<NET>, GUARDIAN_MODULE_<NET>
 *   ADMIN_ADDRESS (the admin Safe), and optionally GUARDIAN_MULTISIG_<NET>,
 *   DEPLOYER_MULTISIG_<NET> for SSF tiered roles.
 *
 * Run: npx hardhat run scripts/verify/verify_roles.js --network ethereum
 */
const { ethers, network } = require("hardhat");
require("dotenv").config();

const NET = network.name.toUpperCase();
const ZERO = "0x0000000000000000000000000000000000000000";

// DEFAULT_ADMIN_ROLE is bytes32(0); all others are keccak256 of the name.
const ROLE = {
  DEFAULT_ADMIN_ROLE: "0x0000000000000000000000000000000000000000000000000000000000000000",
  GOVERNANCE_ROLE: ethers.id("GOVERNANCE_ROLE"),
  UPGRADER_ROLE: ethers.id("UPGRADER_ROLE"),
  PAUSER_ROLE: ethers.id("PAUSER_ROLE"),
  SPENDER_ROLE: ethers.id("SPENDER_ROLE"),
  GUARDIAN_ROLE: ethers.id("GUARDIAN_ROLE"),
  DEPLOYER_ROLE: ethers.id("DEPLOYER_ROLE"),
  ORACLE_REPORTER_ROLE: ethers.id("ORACLE_REPORTER_ROLE"),
  BURN_ROLE: ethers.id("BURN_ROLE"),
  PROPOSER_ROLE: ethers.id("PROPOSER_ROLE"),
  CANCELLER_ROLE: ethers.id("CANCELLER_ROLE"),
};

function envAddr(key, { required = true } = {}) {
  const v = process.env[`${key}_${NET}`] || process.env[key];
  if (!v && required) throw new Error(`Missing required address: ${key}_${NET} (or ${key}) in .env`);
  return v ? ethers.getAddress(v) : null;
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
  const guardianMS = envAddr("GUARDIAN_MULTISIG", { required: false }); // SSF GUARDIAN_ROLE
  const deployerMS = envAddr("DEPLOYER_MULTISIG", { required: false }); // SSF DEPLOYER_ROLE

  const contracts = {
    SRXToken:          { addr: srxToken,                 artifact: "SRXToken" },
    SRXTimelock:       { addr: timelock,                 artifact: "SRXTimelock" },
    SRXTreasury:       { addr: envAddr("TREASURY"),      artifact: "SRXTreasury" },
    SRXStaking:        { addr: envAddr("STAKING"),       artifact: "SRXStaking" },
    FeeController:     { addr: envAddr("FEE_CONTROLLER"), artifact: "FeeController" },
    StabilisationFund: { addr: envAddr("STABILISATION"), artifact: "StabilisationFund" },
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
      ["UPGRADER_ROLE",      [timelock], noSafe],
      ["GOVERNANCE_ROLE",    [timelock], noSafe],
      ["PAUSER_ROLE",        [guardianM],noSafe],
      ["SPENDER_ROLE",       [timelock], noSafe],
    ],
    SRXStaking: [
      ["DEFAULT_ADMIN_ROLE", [timelock], noSafe],
      ["UPGRADER_ROLE",      [timelock], noSafe],
      ["GOVERNANCE_ROLE",    [timelock], noSafe],
      ["PAUSER_ROLE",        [guardianM],noSafe],
    ],
    FeeController: [
      ["DEFAULT_ADMIN_ROLE", [timelock], noSafe],
      ["UPGRADER_ROLE",      [timelock], noSafe],
      ["GOVERNANCE_ROLE",    [timelock], noSafe],
      ["PAUSER_ROLE",        [guardianM],noSafe],
    ],
    StabilisationFund: [
      ["DEFAULT_ADMIN_ROLE", [timelock], noSafe],
      ["UPGRADER_ROLE",      [timelock], noSafe],
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
    ],
  };

  if (!deployerMS) advisories.push("DEPLOYER_MULTISIG unset — the StabilisationFund DEPLOYER_ROLE check did not run.");
  if (!guardianMS) advisories.push("GUARDIAN_MULTISIG unset — the StabilisationFund GUARDIAN_ROLE check did not run.");

  // ⚠️ Coverage is 4 of 11 privileged contracts. The omitted ones hold mint,
  //    burn and bridge authority, so this gate says nothing about them. Stated
  //    every run rather than left as a silence a reader must notice.
  const UNCOVERED = ["GuardianModule", "VestingVault", "BuybackBurner",
                     "PreSaleRound", "SRXOFTNative", "ZkSyncMigrator", "SRXAirdrop"];

  console.log(`\n🔐 SRX role-topology verification — network: ${network.name}`);
  console.log(`   deployer EOA (must hold NO roles): ${deployerAddr}`);
  console.log(`   admin Safe:    ${admin}`);
  console.log(`   timelock:      ${timelock}`);
  console.log(`   guardianModule:${guardianM}\n`);

  let failures = 0;
  let checks = 0;
  let skipped = 0;

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
    console.log("");
  }

  // ── SSF role-separation invariant: DEPLOYER != GUARDIAN ─────────────────────
  if (deployerMS && guardianMS && deployerMS === guardianMS) {
    failures++;
    console.log(`❌ SSF DEPLOYER_MULTISIG == GUARDIAN_MULTISIG (${deployerMS}) — roles must be distinct`);
  }

  console.log("──────────────────────────────────────────────");
  console.log(`Checks run: ${checks} | Failures: ${failures} | Skipped: ${skipped}`);
  console.log(`Contracts NOT covered by this gate (${UNCOVERED.length}): ${UNCOVERED.join(", ")}`);

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
  console.log(`   (Coverage is ${Object.keys(contracts).length} contracts; the ${UNCOVERED.length} listed above are out of scope for this gate.)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
