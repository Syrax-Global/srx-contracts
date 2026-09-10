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
 *   • DEFAULT_ADMIN_ROLE is held by the admin Safe (never the deployer EOA).
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
  const guardianM = envAddr("GUARDIAN_MODULE");          // GuardianModule (PAUSER holder)
  const guardianMS = envAddr("GUARDIAN_MULTISIG", { required: false }); // SSF GUARDIAN_ROLE
  const deployerMS = envAddr("DEPLOYER_MULTISIG", { required: false }); // SSF DEPLOYER_ROLE

  const contracts = {
    SRXTreasury:       { addr: envAddr("TREASURY"),      artifact: "SRXTreasury" },
    SRXStaking:        { addr: envAddr("STAKING"),       artifact: "SRXStaking" },
    FeeController:     { addr: envAddr("FEE_CONTROLLER"), artifact: "FeeController" },
    StabilisationFund: { addr: envAddr("STABILISATION"), artifact: "StabilisationFund" },
  };

  // ── Expectation matrix: [role, mustHold[], mustNotHold[]] ───────────────────
  // mustNotHold ALWAYS includes the deployer EOA (SC-TRUST-002 core requirement).
  const baseForbidden = [deployerAddr];

  const expectations = {
    SRXTreasury: [
      ["DEFAULT_ADMIN_ROLE", [admin],    [...baseForbidden]],
      ["UPGRADER_ROLE",      [timelock], [...baseForbidden, admin]],
      ["GOVERNANCE_ROLE",    [timelock], [...baseForbidden]],
      ["PAUSER_ROLE",        [guardianM],[...baseForbidden]],
      ["SPENDER_ROLE",       [timelock], [...baseForbidden]],
    ],
    SRXStaking: [
      ["DEFAULT_ADMIN_ROLE", [admin],    [...baseForbidden]],
      ["UPGRADER_ROLE",      [timelock], [...baseForbidden, admin]],
      ["GOVERNANCE_ROLE",    [timelock], [...baseForbidden]],
      ["PAUSER_ROLE",        [guardianM],[...baseForbidden]],
    ],
    FeeController: [
      ["DEFAULT_ADMIN_ROLE", [admin],    [...baseForbidden]],
      ["UPGRADER_ROLE",      [timelock], [...baseForbidden, admin]],
      ["GOVERNANCE_ROLE",    [timelock], [...baseForbidden]],
      ["PAUSER_ROLE",        [guardianM],[...baseForbidden]],
    ],
    StabilisationFund: [
      ["DEFAULT_ADMIN_ROLE", [admin],    [...baseForbidden]],
      ["UPGRADER_ROLE",      [timelock], [...baseForbidden, admin]],
      ["GOVERNANCE_ROLE",    [timelock], [...baseForbidden]],
      ["PAUSER_ROLE",        [guardianM],[...baseForbidden]],
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
  const UNCOVERED = ["SRXToken", "GuardianModule", "VestingVault", "BuybackBurner",
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
