/**
 * Step 9 — Deploy ZkSyncMigrator
 *
 * ZkSyncMigrator is NOT upgradeable. It is a simple, auditable one-way gate
 * with a single job: burn SRX on the legacy chain so the oracle can mint
 * native SRX on the Syrax Chain. Simplicity and auditability are intentional.
 *
 * Deployment sequence:
 *  1. Deploy ZkSyncMigrator with SRXToken address + admin address.
 *  2. Grant GOVERNANCE_ROLE to the Timelock (so governance controls enable/close).
 *  4. Grant BURN_ROLE on SRXToken to the migrator — migrate() reverts without it.
 *  5. Revoke GOVERNANCE_ROLE from the deployment key, last.
 *  3. Grant ORACLE_ROLE to the Syrax oracle wallet (bridge confirmation service).
 *  4. *** DO NOT call enableMigration() here — only call it when Syrax Chain is live ***
 *
 * Deployment targets:
 *  - Ethereum mainnet (primary — where most SRX holders live)
 *  - BSC mainnet (optional — for holders bridged to BSC)
 *  - zkSync mainnet (optional — for bridged holders)
 *
 * Do NOT deploy to testnets for production use. The Migration.test.js suite
 * covers all behaviour without needing a live testnet deployment.
 *
 * Prerequisites:
 *  SRX_TOKEN_<NETWORK>   — from Step 1
 *  TIMELOCK_<NETWORK>    — from Step 2
 *  ORACLE_ADDRESS        — wallet operated by the Syrax oracle service
 *
 * Run: npx hardhat run scripts/deploy/09_deploy_migrator.js --network sepolia
 */

const { ethers, network } = require("hardhat");
const readline             = require("readline");
const { WALLETS }          = require("./00_config");
const { createAdminBatch } = require("./lib/adminTx");

function env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const NET        = network.name.toUpperCase();

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Deploying ZkSyncMigrator on ${network.name}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`${"─".repeat(60)}\n`);

  const srxTokenAddr = env(`SRX_TOKEN_${NET}`);
  const timelockAddr = env(`TIMELOCK_${NET}`);
  const oracleAddr   = process.env.ORACLE_ADDRESS || WALLETS.admin;

  console.log("Parameters:");
  console.log(`  SRXToken:  ${srxTokenAddr}`);
  console.log(`  Timelock:  ${timelockAddr}`);
  console.log(`  Oracle:    ${oracleAddr}`);
  console.log(`  Admin:     ${WALLETS.admin}\n`);

  console.log("⚠️  IMPORTANT: Migration must NOT be enabled until Syrax Chain is live.");
  console.log("   enableMigration() is called separately via a governance proposal.\n");

  const answer = await confirm("Confirm deployment? [yes/no]: ");
  if (answer !== "yes") {
    console.log("Deployment cancelled.");
    process.exit(0);
  }

  // ── 1. Deploy ZkSyncMigrator ─────────────────────────────────────────────

  console.log("\n[1/3] Deploying ZkSyncMigrator...");
  const ZkSyncMigrator = await ethers.getContractFactory("ZkSyncMigrator");
  const migrator = await ZkSyncMigrator.deploy(srxTokenAddr, WALLETS.admin);
  await migrator.waitForDeployment();
  const migratorAddr = await migrator.getAddress();
  console.log(`  ZkSyncMigrator: ${migratorAddr}`);

  // Every step below is gated by a role whose admin is WALLETS.admin (the admin
  // Safe on mainnet), never the deployer (SC-TRUST-002). adminTx routes each call
  // to whichever of those is actually loaded as the signer, so there is no longer
  // a "deployer cannot do this" branch to fall into — it either executes now or
  // is queued for the admin Safe to execute.
  const batch = createAdminBatch("09_migrator");

  // ── 2. Grant GOVERNANCE_ROLE to Timelock ────────────────────────────────

  console.log("\n[2/3] Granting GOVERNANCE_ROLE to Timelock...");
  const GOV_ROLE = await migrator.GOVERNANCE_ROLE();
  await batch.send(migrator, "grantRole", [GOV_ROLE, timelockAddr], `ZkSyncMigrator.grantRole(GOVERNANCE_ROLE, Timelock ${timelockAddr})`);

  // ── 3. Grant ORACLE_ROLE ────────────────────────────────────────────────

  console.log("\n[3/5] Granting ORACLE_ROLE to oracle wallet...");
  const ORACLE_ROLE = await migrator.ORACLE_ROLE();
  await batch.send(migrator, "grantRole", [ORACLE_ROLE, oracleAddr], `ZkSyncMigrator.grantRole(ORACLE_ROLE, Oracle ${oracleAddr})`);

  // ── 4. Grant BURN_ROLE on SRXToken to the migrator ───────────────────────
  //
  // ⛔ THIS STEP DID NOT EXIST, SO migrate() REVERTED ON EVERY FRESH DEPLOYMENT.
  //    migrate() burns via SRXToken.buyAndBurn(), which is BURN_ROLE-gated, and
  //    nothing here ever granted it. The contract header says the migrator "must
  //    hold BURN_ROLE on SRXToken" and then no script arranged it. Proven in
  //    test/audit-poc/migration-replay.test.js case 2.

  console.log("\n[4/5] Granting BURN_ROLE on SRXToken to the migrator...");
  const srxToken  = await ethers.getContractAt("SRXToken", srxTokenAddr);
  const BURN_ROLE = await srxToken.BURN_ROLE();

  if (await srxToken.hasRole(BURN_ROLE, migratorAddr)) {
    console.log(`  ✓ already held`);
  } else {
    await batch.send(srxToken, "grantRole", [BURN_ROLE, migratorAddr], `SRXToken.grantRole(BURN_ROLE, ZkSyncMigrator ${migratorAddr})`);
  }

  // ── 4b. Exempt the migrator from launch protection ───────────────────────
  //
  // ⛔ WITHOUT THIS, A STRANDED BALANCE BRICKS migrate() FOR EVERYONE. migrate()
  //    pulls the user's SRX into this contract before burning it, so the transfer
  //    is subject to maxWalletBalance on the RECIPIENT -- which is the migrator.
  //    Any balance left sitting here pushes it toward the cap, and once the cap
  //    is reached every migration reverts, for every user, permanently. Proven in
  //    test/audit-poc/migration-replay.test.js case 5.
  //
  // ⭐ Exempting the migrator is the right call rather than a workaround: it is a
  //    burn address in practice, never a holder, so a wallet cap has no meaning
  //    for it. Combined with rescueTokens() this closes both halves.

  console.log("\n[4b/5] Exempting the migrator from launch protection...");
  if (await srxToken.isExemptFromLimits(migratorAddr)) {
    console.log(`  ✓ already exempt`);
  } else {
    await batch.send(srxToken, "setExemptFromLimits", [migratorAddr, true], `SRXToken.setExemptFromLimits(ZkSyncMigrator ${migratorAddr}, true)`);
  }

  // ── 5. Hand governance to the Timelock alone ─────────────────────────────
  //
  // ⛔ THE REVOKE WAS SKIPPED IN EXACTLY THE CASE THAT MATTERS. The old condition
  //    was `hasRole(GOV_ROLE, deployer) && deployer !== WALLETS.admin`, and the
  //    constructor grants GOVERNANCE_ROLE to WALLETS.admin -- so whenever the
  //    deployer IS the admin, which is the configuration these scripts require,
  //    the revoke never ran and the admin EOA kept GOVERNANCE_ROLE beside the
  //    Timelock. The checklist below then claimed it was "held by Timelock only".
  //    Done LAST so the earlier steps still have the authority they need.
  //
  // ⭐ The deployer never appears in this set as a GRANT target above (only the
  //    Timelock and, via BURN_ROLE/exemption, the migrator itself do), so on a
  //    real deployment `deployer.address` here is never actually held — this
  //    loop is defensive, not a step that undoes something this script just did.

  console.log("\n[5/5] Revoking GOVERNANCE_ROLE from the deployment key...");
  for (const holder of new Set([deployer.address, WALLETS.admin])) {
    if (holder.toLowerCase() === timelockAddr.toLowerCase()) continue;
    if (await migrator.hasRole(GOV_ROLE, holder)) {
      await batch.send(migrator, "revokeRole", [GOV_ROLE, holder], `ZkSyncMigrator.revokeRole(GOVERNANCE_ROLE, ${holder})`);
    }
  }

  const wrote = await batch.flush();
  if (wrote) {
    console.log(`\n⏳ Role changes above are queued for the admin Safe (${wrote}).`);
    console.log(`   The final GOVERNANCE_ROLE check below cannot pass until the Safe executes it.`);
  } else if (!(await migrator.hasRole(GOV_ROLE, timelockAddr))) {
    console.error("  ✗ Timelock does NOT hold GOVERNANCE_ROLE — do not proceed.");
    process.exitCode = 1;
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ✅ ZkSyncMigrator deployed`);
  console.log(`${"─".repeat(60)}`);

  console.log(`\n📋 Save to .env:`);
  console.log(`MIGRATOR_${NET}=${migratorAddr}`);

  console.log(`\n📋 Post-deployment checklist:`);
  console.log(`  [ ] Verify ZkSyncMigrator on explorer:`);
  console.log(`        npx hardhat verify --network ${network.name} ${migratorAddr} ${srxTokenAddr} ${WALLETS.admin}`);
  console.log(`  [ ] Confirm ORACLE_ROLE holder is the correct oracle service wallet`);
  console.log(`  [ ] Confirm GOVERNANCE_ROLE is held by Timelock only`);
  console.log(`  [ ] Confirm BURN_ROLE on SRXToken is held by the migrator — migrate() reverts without it`);
  console.log(`  [ ] Confirm the migrator is exempt from launch protection — a stranded`);
  console.log(`      balance otherwise bricks migrate() for everyone once the cap is hit`);
  console.log(`  [ ] NOTE: DEFAULT_ADMIN_ROLE remains with ${WALLETS.admin}. No role's`);
  console.log(`      admin is set via _setRoleAdmin anywhere in this suite, so that`);
  console.log(`      address can re-grant GOVERNANCE_ROLE to itself at any time. The`);
  console.log(`      revoke above is a starting posture, not an on-chain guarantee.`);
  console.log(`  [ ] Update Syrax oracle service config with:`);
  console.log(`        MIGRATOR_ADDRESS=${migratorAddr}`);
  console.log(`        SRX_TOKEN_ADDRESS=${srxTokenAddr}`);
  console.log(`        CHAIN_ID=${(await ethers.provider.getNetwork()).chainId}`);
  console.log(`  [ ] *** enableMigration() is called ONLY via governance proposal`);
  console.log(`      when the Syrax Chain is confirmed live and stable. ***`);
  console.log(`  [ ] Announce migration window to community with at least 30 days notice`);
  console.log(`  [ ] Coordinate with CEX partners on their migration support timeline`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
