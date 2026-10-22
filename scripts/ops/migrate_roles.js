/**
 * migrate_roles.js — Role-topology migration to the launch state (SC-TRUST-001/002, GOV-H1)
 *
 * ⭐ LAUNCH STATE = DELAY-ONLY (Jared, 23 Sep 2026; pre-external-audit sweep GOV-H1).
 *    Every administrative power sits behind the 48-hour Timelock. The admin Safe
 *    keeps no admin, governance, upgrade, spend, pause or burn role, is not the
 *    token's bridge owner or LayerZero delegate, and is neither admin nor proposer
 *    of the Timelock. Emergency pause stays fast through GuardianModule.
 *    `scripts/verify/verify_roles.js` enforces exactly this and blocks mainnet
 *    otherwise.
 *
 * ⛔ Previously the end state KEPT the Safe as DEFAULT_ADMIN_ROLE everywhere, and
 *    the gate required it. One Safe batch could then grant itself SPENDER_ROLE and
 *    withdraw the treasury, or use the StabilisationFund's
 *    GOVERNANCE_ROLE path to send all 1.5B SRX anywhere — none of it delayed.
 *
 * ── Two phases, because ownership of the token needs the Timelock to accept ──
 *   PHASE 1 (default) — before the irreversible phase 2. Most steps can still be undone
 *   while the Safe is admin, BUT revoking the Safe's SPENDER_ROLE
 *   cannot be: each of those roles administers itself, so the Safe cannot re-grant it
 *   and putting it back needs a Timelock operation:
 *     1. grant the Timelock DEFAULT_ADMIN / GOVERNANCE / SPENDER,
 *        GuardianModule PAUSER, the Governor PROPOSER + CANCELLER on the Timelock;
 *     2. revoke the Safe's GOVERNANCE / SPENDER / PAUSER / BURN (it keeps WIND_DOWN on staking and the fund);
 *     3. SRXToken: setDelegate(Timelock) and transferOwnership(Timelock) (two-step);
 *     4. grant the Safe PROPOSER on the Timelock TEMPORARILY and schedule
 *        SRXToken.acceptOwnership() through it.
 *   Wait at least the Timelock delay (48 h on mainnet).
 *   PHASE 2 (`--finalize`) — irreversible:
 *     5. execute the scheduled acceptOwnership() (execution is open to anyone);
 *        (First it lists any OTHER Timelock operation still pending, since those survive
 *        the revoke; needs TIMELOCK_DEPLOY_BLOCK_<NET>. Warns only, cancels nothing.)
 *     6. revoke the Safe's PROPOSER, then its DEFAULT_ADMIN on every contract and
 *        on the Timelock — the Safe's own admin rights go LAST.
 *
 * The Safe KEEPS the Timelock's CANCELLER_ROLE (granted in 02_deploy_governance):
 * a veto on a hostile proposal. It can stop an operation, never start one.
 *
 * ⚠️ Run this LAST, after every launch wiring step that needs an admin — genesis(),
 *    BURN_ROLE grants, LayerZero peers and DVN configuration. After phase 2 each of
 *    those is a Governor proposal with a 48-hour delay. That is the point.
 *
 * Output: a Gnosis Safe Transaction Builder JSON per phase (default), or direct
 * execution from the loaded signer with `--execute` (testnet and fork rehearsal only).
 *
 * Required .env (per network, e.g. _ETHEREUM): SRX_TOKEN, TREASURY, STAKING,
 *   FEE_CONTROLLER, STABILISATION, TIMELOCK, GOVERNOR, GUARDIAN_MODULE, and ADMIN_ADDRESS.
 *
 * Covers GuardianModule and ZkSyncMigrator since 30 Sep 2026 (both left the Safe as
 * DEFAULT_ADMIN). Optional env: MIGRATOR (its address, or "none").
 * It cannot fix an IMMUTABLE admin(): VestingVault, PreSaleRound and
 * TGEDistributor fix theirs at deployment — see verify_roles.js.
 *
 * Usage:
 *   npx hardhat run scripts/ops/migrate_roles.js --network ethereum            # phase 1 JSON
 *   MIGRATE_FINALIZE=1 npx hardhat run scripts/ops/migrate_roles.js --network ethereum
 *   MIGRATE_EXECUTE=1  npx hardhat run scripts/ops/migrate_roles.js --network sepolia
 * Then: npm run verify:roles -- --network <net>
 */
const { ethers, network, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { pendingTimelockOps, parseOpList, parseBlock } = require("../deploy/lib/gate_checks");

const NET  =network.name.toUpperCase();
const ARGS = process.argv.slice(2);
const EXECUTE  = ARGS.includes("--execute")  || process.env.MIGRATE_EXECUTE  === "1";
const FINALIZE = ARGS.includes("--finalize") || process.env.MIGRATE_FINALIZE === "1";

const ROLE = {
  DEFAULT_ADMIN_ROLE: ethers.ZeroHash,
  GOVERNANCE_ROLE: ethers.id("GOVERNANCE_ROLE"),
  WIND_DOWN_ROLE:  ethers.id("WIND_DOWN_ROLE"),
  PAUSER_ROLE:     ethers.id("PAUSER_ROLE"),
  SPENDER_ROLE:    ethers.id("SPENDER_ROLE"),
  BURN_ROLE:       ethers.id("BURN_ROLE"),
  PROPOSER_ROLE:   ethers.id("PROPOSER_ROLE"),
  CANCELLER_ROLE:  ethers.id("CANCELLER_ROLE"),
};

// Salt for the scheduled acceptOwnership — fixed, so phase 2 finds the same operation.
const ACCEPT_SALT = ethers.id("SRX:SRXToken.acceptOwnership:launch");

function envAddr(key, { required = true } = {}) {
  const v = process.env[`${key}_${NET}`] || process.env[key];
  if (!v && required) throw new Error(`Missing required address: ${key}_${NET} (or ${key}) in .env`);
  return v ? ethers.getAddress(v) : null;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const admin     = envAddr("ADMIN_ADDRESS");
  const timelock  = envAddr("TIMELOCK");
  const governor  = envAddr("GOVERNOR");
  const guardianM = envAddr("GUARDIAN_MODULE");
  const srxToken  = envAddr("SRX_TOKEN");

  const acAbi    = (await artifacts.readArtifact("SRXTreasury")).abi;   // grant/revoke/hasRole
  const tokenAbi = (await artifacts.readArtifact("SRXToken")).abi;
  const tlAbi    = (await artifacts.readArtifact("SRXTimelock")).abi;
  const token = new ethers.Contract(srxToken, tokenAbi, signer);
  const tl    = new ethers.Contract(timelock, tlAbi, signer);

  // Contracts whose roles move, and which roles each has.
  const targets = [
    { name: "SRXToken",          addr: srxToken,                  roles: ["GOVERNANCE_ROLE", "PAUSER_ROLE", "BURN_ROLE"] },
    { name: "SRXTreasury",       addr: envAddr("TREASURY"),       roles: ["GOVERNANCE_ROLE", "PAUSER_ROLE", "SPENDER_ROLE"] },
    { name: "SRXStaking",        addr: envAddr("STAKING"),        roles: ["GOVERNANCE_ROLE", "PAUSER_ROLE"] },
    { name: "FeeController",     addr: envAddr("FEE_CONTROLLER"), roles: ["GOVERNANCE_ROLE", "PAUSER_ROLE"] },
    { name: "StabilisationFund", addr: envAddr("STABILISATION"),  roles: ["GOVERNANCE_ROLE", "PAUSER_ROLE"] },
    // ⛔ 30 Sep 2026: GuardianModule was not handed over. 08 makes the Safe its
    //    DEFAULT_ADMIN, from which it could grant itself GOVERNANCE_ROLE and
    //    un-pause everything or reset a tripped circuit breaker with no delay. The
    //    Safe keeps GUARDIAN_ROLE (pause) via GUARDIAN_MULTISIG and nothing else.
    { name: "GuardianModule",    addr: guardianM,                  roles: ["GOVERNANCE_ROLE"] },
  ];
  // ZkSyncMigrator: the Safe is its constructor admin; since 30 Sep 2026 (Jared) it
  // is handed to the Timelock like the core contracts, when this network has one
  // (MIGRATOR_<NET>; "none" or unset means no migrator here). BuybackBurner,
  // SRXAirdrop and the spokes stay Safe-administered by design (MULTISIG_SPEC).
  const migratorAddr = (process.env[`MIGRATOR_${NET}`] || process.env.MIGRATOR || "").trim();
  if (migratorAddr && migratorAddr.toLowerCase() !== "none") {
    targets.push({ name: "ZkSyncMigrator", addr: ethers.getAddress(migratorAddr), roles: ["GOVERNANCE_ROLE"] });
  }
  // REG-53 (12 Oct 2026): no UPGRADER_ROLE exists any more (the contracts are not upgradeable).
  // The Safe KEEPS WIND_DOWN_ROLE on SRXStaking and StabilisationFund: the fast, one-way
  // exit-only switch (it is deliberately not in the revoked lists above).
  const HOLDER = { GOVERNANCE_ROLE: timelock, SPENDER_ROLE: timelock, PAUSER_ROLE: guardianM };

  const acceptData = token.interface.encodeFunctionData("acceptOwnership");
  const minDelay   = await tl.getMinDelay();
  const opId       = await tl.hashOperation(srxToken, 0, acceptData, ethers.ZeroHash, ACCEPT_SALT);

  const steps = []; // { label, to, data, check: async () => bool (true = already done) }
  const role = (addr, fn, r, who, label) => {
    const c = new ethers.Contract(addr, acAbi, signer);
    steps.push({
      label, to: addr, data: c.interface.encodeFunctionData(fn, [ROLE[r], who]),
      done: async () => (await c.hasRole(ROLE[r], who)) === (fn === "grantRole"),
    });
  };

  if (!FINALIZE) {
    console.log("\nPHASE 1 — grants, revocations and ownership transfer (the Safe's SPENDER revocation cannot be undone by the Safe)\n");
    // 1. grants
    for (const t of targets) {
      role(t.addr, "grantRole", "DEFAULT_ADMIN_ROLE", timelock, `${t.name}: grant DEFAULT_ADMIN → Timelock`);
      for (const r of t.roles) {
        // GuardianModule cannot hold PAUSER on itself; it has no PAUSER role.
        if (HOLDER[r] && !(r === "PAUSER_ROLE" && t.addr === guardianM)) {
          role(t.addr, "grantRole", r, HOLDER[r], `${t.name}: grant ${r} → ${r === "PAUSER_ROLE" ? "GuardianModule" : "Timelock"}`);
        }
      }
    }
    role(timelock, "grantRole", "PROPOSER_ROLE",  governor, "Timelock: grant PROPOSER → Governor");
    role(timelock, "grantRole", "CANCELLER_ROLE", governor, "Timelock: grant CANCELLER → Governor");
    role(timelock, "grantRole", "CANCELLER_ROLE", admin,    "Timelock: grant CANCELLER → Safe (veto only; kept at launch)");
    // 2. the Safe gives up every operational role. SPENDER_ROLE administers itself, so the
    //    Safe cannot undo that revocation; the rest it still could. (It keeps WIND_DOWN_ROLE.)
    for (const t of targets) for (const r of t.roles) role(t.addr, "revokeRole", r, admin, `${t.name}: revoke ${r} from the Safe`);
    // 3. bridge authority: delegate, then two-step ownership
    steps.push({
      label: "SRXToken: setDelegate(Timelock)", to: srxToken,
      data: token.interface.encodeFunctionData("setDelegate", [timelock]),
      done: async () => {
        const ep = new ethers.Contract(await token.endpoint(), ["function delegates(address) view returns (address)"], signer);
        return ethers.getAddress(await ep.delegates(srxToken)) === timelock;
      },
    });
    steps.push({
      label: "SRXToken: transferOwnership(Timelock) — pending until the Timelock accepts", to: srxToken,
      data: token.interface.encodeFunctionData("transferOwnership", [timelock]),
      done: async () => ethers.getAddress(await token.pendingOwner()) === timelock
                     || ethers.getAddress(await token.owner()) === timelock,
    });
    // 4. temporary proposer, and schedule the acceptance. Not needed once the
    //    acceptance is scheduled — and after phase 2 the Safe could not grant it.
    role(timelock, "grantRole", "PROPOSER_ROLE", admin, "Timelock: grant PROPOSER → Safe (TEMPORARY, revoked in phase 2)");
    { const s = steps[steps.length - 1], held = s.done; s.done = async () => (await tl.isOperation(opId)) || held(); }
    steps.push({
      label: `Timelock: schedule SRXToken.acceptOwnership() (ready after ${minDelay}s)`, to: timelock,
      data: tl.interface.encodeFunctionData("schedule", [srxToken, 0, acceptData, ethers.ZeroHash, ACCEPT_SALT, minDelay]),
      done: async () => await tl.isOperation(opId),
    });
  } else {
    console.log("\nPHASE 2 — IRREVERSIBLE: the Safe hands over its own admin rights\n");
    if (!(await tl.isOperationReady(opId)) && !(await tl.isOperationDone(opId))) {
      throw new Error("The scheduled acceptOwnership is not ready yet (or was never scheduled). Run phase 1, then wait the Timelock delay.");
    }
    // ⛔ Internal audit 16 Oct 2026, CONTROL-05: the Safe has been a PROPOSER since phase 1,
    //    and anything it scheduled in that window stays executable by anyone after the
    //    revoke below. List what is still pending BEFORE the Safe gives the role up, so
    //    it can be cancelled (CANCELLER_ROLE) while it is still a decision. The
    //    acceptOwnership scheduled by phase 1 is expected and is executed by step 5.
    //    This only warns: it never cancels anything.
    try {
      const fromBlock = parseBlock(process.env[`TIMELOCK_DEPLOY_BLOCK_${NET}`] || process.env.TIMELOCK_DEPLOY_BLOCK);
      const allowList = [opId, ...parseOpList(process.env[`TIMELOCK_ALLOWED_OPS_${NET}`] || process.env.TIMELOCK_ALLOWED_OPS)];
      const pendingOps = await pendingTimelockOps({ timelock: tl, fromBlock, allowList });
      if (pendingOps.length) {
        console.log(`   ⚠️  ${pendingOps.length} OTHER Timelock operation(s) are scheduled and still pending. They will stay executable by anyone after the Safe's PROPOSER is revoked:`);
        for (const id of pendingOps) console.log(`        • ${id}`);
        console.log("      Cancel any you do not recognise (CANCELLER_ROLE) BEFORE running this phase, or list the expected ones in TIMELOCK_ALLOWED_OPS_" + NET + ".\n");
      } else {
        console.log(`   ✓ No other Timelock operation is pending (read from block ${fromBlock}).\n`);
      }
    } catch (e) {
      console.log(`   ⚠️  COULD NOT LIST PENDING TIMELOCK OPERATIONS: ${e.message}`);
      console.log("      Anything the Safe scheduled as a temporary PROPOSER survives the revoke below. verify_roles.js fails until this can be read.\n");
    }
    // 5. execute the acceptance
    steps.push({
      label: "Timelock: execute SRXToken.acceptOwnership()", to: timelock,
      data: tl.interface.encodeFunctionData("execute", [srxToken, 0, acceptData, ethers.ZeroHash, ACCEPT_SALT]),
      done: async () => await tl.isOperationDone(opId),
    });
    // 6. the Safe's own rights, last
    role(timelock, "revokeRole", "PROPOSER_ROLE", admin, "Timelock: revoke the Safe's temporary PROPOSER");
    for (const t of targets) role(t.addr, "revokeRole", "DEFAULT_ADMIN_ROLE", admin, `${t.name}: revoke DEFAULT_ADMIN from the Safe`);
    role(timelock, "revokeRole", "DEFAULT_ADMIN_ROLE", admin, "Timelock: revoke the Safe as Timelock admin — LAST");
  }

  // Idempotent: keep only the steps whose on-chain state is not already right.
  const todo = [];
  for (const s of steps) {
    const done = await s.done();
    console.log(`   ${done ? "✓" : "→"} ${s.label}${done ? " (already done)" : ""}`);
    if (!done) todo.push(s);
  }
  if (todo.length === 0) { console.log("\n✅ Nothing to do for this phase."); return; }

  if (EXECUTE) {
    for (const s of todo) {
      const tx = await signer.sendTransaction({ to: s.to, data: s.data });
      await tx.wait();
      console.log(`   ✅ ${s.label}  ${tx.hash}`);
    }
  } else {
    const out = {
      version: "1.0",
      chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      createdAt: Math.floor(Date.now() / 1000),
      meta: {
        name: `SRX launch role migration — phase ${FINALIZE ? 2 : 1} (${network.name})`,
        description: FINALIZE
          ? "IRREVERSIBLE. Executes the Timelock's acceptance of token ownership, then removes the Safe's remaining admin rights. Review every transaction."
          : "Moves every operational role behind the Timelock and schedules the token ownership acceptance. Not freely reversible: revoking the Safe's SPENDER_ROLE cannot be undone by the Safe (it needs a Timelock operation). Review every transaction.",
        txBuilderVersion: "1.16.5",
      },
      transactions: todo.map((s) => ({ to: s.to, value: "0", data: s.data })),
    };
    const file = path.join(process.cwd(), `migrate_roles.phase${FINALIZE ? 2 : 1}.${network.name}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`\n📝 Wrote ${todo.length} transaction(s) to ${file}`);
    console.log("   Import at app.safe.global → New transaction → Transaction Builder → upload JSON.");
  }
  console.log(FINALIZE
    ? `\nNow run: npm run verify:roles -- --network ${network.name}  (must print ALL CHECKS PASSED)`
    : `\nWait ${minDelay}s after the schedule transaction, then run phase 2 with MIGRATE_FINALIZE=1.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
