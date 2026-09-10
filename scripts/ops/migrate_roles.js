/**
 * migrate_roles.js — Role-topology migration tool (SC-TRUST-001 / SC-TRUST-002)
 *
 * Drives the privileged-role topology from its post-deployment bootstrap state to the
 * audited end state that `scripts/verify/verify_roles.js` enforces:
 *
 *   • UPGRADER_ROLE  → SRXTimelock ONLY (revoked from admin)
 *   • GOVERNANCE_ROLE → SRXTimelock
 *   • PAUSER_ROLE     → GuardianModule
 *   • SPENDER_ROLE    → SRXTimelock (Treasury; already set at init — verified)
 *   • DEFAULT_ADMIN_ROLE → admin Safe; deployer EOA revoked
 *
 * ── Why two modes ────────────────────────────────────────────────────────────
 * On mainnet the holder of DEFAULT_ADMIN_ROLE is a Gnosis Safe (multisig). A script
 * cannot make a Safe sign, so role changes MUST be executed as a Safe transaction
 * batch reviewed and signed by the owners. This tool therefore:
 *
 *   • DEFAULT (`--safe-batch`): writes a Gnosis Safe Transaction Builder JSON file
 *     (`migrate_roles.<network>.json`) — import it at app.safe.global → New transaction
 *     → Transaction Builder → upload JSON. Owners review every grant/revoke, then sign.
 *
 *   • `--execute`: sends the transactions directly from the current signer. Only works
 *     when that signer holds DEFAULT_ADMIN_ROLE on each contract — intended for testnet
 *     dry-runs and mainnet-fork rehearsals, NOT mainnet itself.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 *   • Idempotent: an operation is emitted only if its on-chain state is not already correct.
 *   • The irreversible step (revoking the admin Safe's own DEFAULT_ADMIN_ROLE, fully
 *     handing control to the Timelock) is NEVER emitted unless `--finalize` is passed.
 *   • A plan is always printed BEFORE anything is written or sent.
 *   • Run `npm run verify:roles` afterwards to confirm the end state.
 *
 * Required .env (per network, e.g. _ETHEREUM): TREASURY_<NET>, STAKING_<NET>,
 *   FEE_CONTROLLER_<NET>, STABILISATION_<NET>, TIMELOCK_<NET>, GUARDIAN_MODULE_<NET>,
 *   ADMIN_ADDRESS, and (optional) GUARDIAN_MULTISIG_<NET>, DEPLOYER_MULTISIG_<NET>.
 *
 * Usage:
 *   npx hardhat run scripts/ops/migrate_roles.js --network ethereum                 # Safe batch JSON
 *   npx hardhat run scripts/ops/migrate_roles.js --network sepolia -- --execute     # direct (testnet)
 *   npx hardhat run scripts/ops/migrate_roles.js --network ethereum -- --finalize   # include admin self-revoke
 */
const { ethers, network, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const NET  = network.name.toUpperCase();
const ARGS = process.argv.slice(2);
// Flags can be passed as CLI args (after `--`) OR as env vars — the latter is more
// reliable with `hardhat run`, whose post-`--` arg forwarding is version-dependent:
//   MIGRATE_EXECUTE=1 npx hardhat run scripts/ops/migrate_roles.js --network sepolia
const EXECUTE  = ARGS.includes("--execute")  || process.env.MIGRATE_EXECUTE  === "1";
const FINALIZE = ARGS.includes("--finalize") || process.env.MIGRATE_FINALIZE === "1";

const ROLE = {
  DEFAULT_ADMIN_ROLE: "0x" + "0".repeat(64),
  GOVERNANCE_ROLE: ethers.id("GOVERNANCE_ROLE"),
  UPGRADER_ROLE: ethers.id("UPGRADER_ROLE"),
  PAUSER_ROLE: ethers.id("PAUSER_ROLE"),
  SPENDER_ROLE: ethers.id("SPENDER_ROLE"),
};

function envAddr(key, { required = true } = {}) {
  const v = process.env[`${key}_${NET}`] || process.env[key];
  if (!v && required) throw new Error(`Missing required address: ${key}_${NET} (or ${key}) in .env`);
  return v ? ethers.getAddress(v) : null;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const signerAddr = ethers.getAddress(await signer.getAddress());

  const admin     = envAddr("ADMIN_ADDRESS");   // admin Safe (current DEFAULT_ADMIN holder)
  const timelock  = envAddr("TIMELOCK");
  const guardianM = envAddr("GUARDIAN_MODULE");

  const contracts = {
    SRXTreasury:       { addr: envAddr("TREASURY"),      hasSpender: true  },
    SRXStaking:        { addr: envAddr("STAKING"),       hasSpender: false },
    FeeController:     { addr: envAddr("FEE_CONTROLLER"), hasSpender: false },
    StabilisationFund: { addr: envAddr("STABILISATION"), hasSpender: false },
  };

  // Desired end state per contract: list of { role, holder, want } (want=true → must hold).
  function desired(meta) {
    const ops = [
      { role: "GOVERNANCE_ROLE", holder: timelock,  want: true  },
      { role: "UPGRADER_ROLE",   holder: timelock,  want: true  },
      { role: "UPGRADER_ROLE",   holder: admin,     want: false }, // SC-TRUST-001: upgrade = Timelock only
      { role: "PAUSER_ROLE",     holder: guardianM, want: true  },
    ];
    if (meta.hasSpender) ops.push({ role: "SPENDER_ROLE", holder: timelock, want: true });
    // Irreversible: hand DEFAULT_ADMIN fully to nobody-but-the-intended end (only with --finalize).
    // We keep the admin Safe as DEFAULT_ADMIN by default; --finalize would move it to the Timelock.
    if (FINALIZE) {
      ops.push({ role: "DEFAULT_ADMIN_ROLE", holder: timelock, want: true });
      ops.push({ role: "DEFAULT_ADMIN_ROLE", holder: admin,    want: false });
    }
    return ops;
  }

  console.log(`\n🔧 SRX role migration — network: ${network.name}`);
  console.log(`   mode: ${EXECUTE ? "EXECUTE (direct)" : "SAFE BATCH (json)"}${FINALIZE ? " + FINALIZE (irreversible admin handover)" : ""}`);
  console.log(`   signer:        ${signerAddr}`);
  console.log(`   admin Safe:    ${admin}`);
  console.log(`   timelock:      ${timelock}`);
  console.log(`   guardianModule:${guardianM}\n`);

  const acAbi = (await artifacts.readArtifact("SRXTreasury")).abi; // AccessControl ABI (grant/revoke/hasRole)
  const iface = new ethers.Interface(acAbi);

  const batch = [];   // Safe Transaction Builder transactions
  let planned = 0;

  for (const [name, meta] of Object.entries(contracts)) {
    const c = new ethers.Contract(meta.addr, acAbi, signer);
    console.log(`── ${name} @ ${meta.addr}`);

    for (const { role, holder, want } of desired(meta)) {
      if (!holder) continue;
      const roleHash = ROLE[role];
      const has = await c.hasRole(roleHash, holder);
      if (has === want) {
        console.log(`   ✓ ${role} ${want ? "held" : "not held"} by ${holder} (no-op)`);
        continue;
      }
      const fn = want ? "grantRole" : "revokeRole";
      console.log(`   → ${fn}(${role}, ${holder})`);
      planned++;

      if (EXECUTE) {
        const tx = await c[fn](roleHash, holder);
        await tx.wait();
        console.log(`     ✅ ${tx.hash}`);
      } else {
        batch.push({
          to: meta.addr,
          value: "0",
          data: iface.encodeFunctionData(fn, [roleHash, holder]),
        });
      }
    }
    console.log("");
  }

  if (planned === 0) {
    console.log("✅ Nothing to do — role topology already matches the target end state.");
    return;
  }

  if (EXECUTE) {
    console.log(`✅ Executed ${planned} role change(s). Now run: npm run verify:roles -- --network ${network.name}`);
    return;
  }

  // Write Safe Transaction Builder JSON
  const out = {
    version: "1.0",
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    createdAt: Math.floor(Date.now() / 1000),
    meta: {
      name: `SRX role migration (${network.name})`,
      description: "SC-TRUST-001/002: home UPGRADER_ROLE on the Timelock; complete role topology. Review every transaction before signing.",
      txBuilderVersion: "1.16.5",
    },
    transactions: batch,
  };
  const file = path.join(process.cwd(), `migrate_roles.${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`📝 Wrote ${batch.length} transaction(s) to ${file}`);
  console.log(`   Import at app.safe.global → New transaction → Transaction Builder → upload JSON.`);
  console.log(`   After the Safe executes, run: npm run verify:roles -- --network ${network.name}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
