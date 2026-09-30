/**
 * rehearse_deploy_suite.js — end-to-end rehearsal of the REAL deploy scripts
 * (finding DEP-01), against a throwaway local chain.
 *
 * Every deploy script (scripts/deploy/01..10) routes admin-only calls through
 * scripts/deploy/lib/adminTx.js: executed immediately if the loaded signer IS
 * WALLETS.admin, otherwise encoded and queued as a Gnosis Safe Transaction
 * Builder JSON file for the admin Safe to execute. On `localhost`,
 * scripts/deploy/00_config.js resolves WALLETS.admin to a BUILT-IN TESTNET
 * ADDRESS that the deployer (hardhat account 0) does not control — the same
 * shape as mainnet, where the admin is a Safe the deployer key cannot sign for.
 * So every admin-gated call made while this rehearsal runs the real scripts is
 * queued, never executed directly — exactly as it would be on mainnet — and
 * this script plays the admin Safe's part: it reads each queued JSON file and
 * executes its transactions from an IMPERSONATED admin account
 * (hardhat_impersonateAccount + hardhat_setBalance), the same way a human would
 * click "Execute batch" in the Safe UI.
 *
 * Runs, unmodified:
 *   01 → 02 → 03 → 04 → 05 → 05b → 06 (twice — see below) → 08 → 09 → 10
 * 07_deploy_bridge.js is SKIPPED: it wires a second chain's SRXOFTNative to the
 * hub token, and a one-node rehearsal has only one chain.
 *
 * 06_execute_tge.js queues in two separate rounds and STOPS after each queue,
 * by design (see its header): round 1 queues setAllocations + genesis +
 * distribute + triggerTGE×5; only once that batch has executed does round 2
 * see phase A as done and queue notifyRewardAmount (registering the staking
 * incentive pool). This script therefore runs 06 exactly twice, executing the
 * batch written after each run. (A third run would recompute the same staking
 * balance and try to queue notifyRewardAmount again — SRXStaking.notifyRewardAmount
 * has no "already registered" guard the way genesis/distribute/triggerTGE do, so
 * that second call would revert on execution with PoolAmountExceedsAvailable.
 * The documented flow never calls it a third time, and neither does this script;
 * see the report for why this was left alone rather than patched.)
 *
 * Then the launch hand-over (scripts/ops/migrate_roles.js + verify_roles.js),
 * following the same pattern rehearse_role_migration.js already established:
 * negative control (the gate must FAIL on the as-deployed topology) → phase 1
 * (JSON, executed as the admin) → advance past the timelock delay → phase 2
 * (JSON, executed as the admin) → the gate must report zero failures.
 *
 * Usage (two terminals, or the node in the background):
 *   npx hardhat node
 *   npx hardhat run scripts/ops/rehearse_deploy_suite.js --network localhost
 */
const { ethers, network } = require("hardhat");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { WALLET_ENV } = require("../deploy/00_config");

// 00_config.js calls dotenv.config() on require, above, which — if this repo has
// a real .env for actual testnet/mainnet deploys — would make WALLETS.admin (and
// the other WALLETS.* getters) resolve to WHATEVER THAT .env SAYS rather than the
// built-in testnet default this rehearsal is documented to exercise (the deployer
// controlling neither address is what matters either way, but a rehearsal that
// silently depends on the *contents* of a gitignored .env is not reproducible).
// Clearing these here, before anything reads WALLETS.*, forces the built-in
// testnet defaults on every WALLETS getter. .env itself is never opened or
// printed by this script — only these specific process.env keys are cleared.
for (const envName of Object.values(WALLET_ENV)) delete process.env[envName];
const { WALLETS } = require("../deploy/00_config");

const ROOT = path.join(__dirname, "..", "..");
const CLI  = path.join(ROOT, "node_modules", "hardhat", "internal", "cli", "cli.js");

function expect(cond, what, out) {
  if (!cond) { if (out) console.log(out); throw new Error(`REHEARSAL FAILED: ${what}`); }
  console.log(`  ✅ ${what}`);
}

// Lines a deploy script prints like "SRX_TOKEN_LOCALHOST=0x..." or
// "CHAIN_ID=31337" — the exact "Save to .env" convention these scripts already
// use. Deliberately narrow (hex address or plain integer only) so incidental
// "WORD: value" log lines are never mistaken for an assignment.
const ASSIGN_RE = /^[ \t]*([A-Z][A-Z0-9_]{2,})=(0x[0-9a-fA-F]{40}|[0-9]+)[ \t]*$/gm;

function main() {
  return run();
}

async function run() {
  if (network.name !== "localhost") {
    throw new Error("Run against --network localhost (a throwaway `npx hardhat node`).");
  }

  const signers = await ethers.getSigners();
  const deployer          = signers[0]; // every deploy script's ethers.getSigners()[0]
  const guardianMultisig  = signers[2];
  const circuitBreaker    = signers[3];
  const oracle            = signers[4];
  const admin             = ethers.getAddress(WALLETS.admin); // built-in testnet default; deployer does NOT hold its key

  console.log(`deployer (hardhat account 0, runs every script): ${deployer.address}`);
  console.log(`admin Safe (built-in testnet default, NOT controlled by the deployer): ${admin}\n`);

  // ── Pre-req mocks: LayerZero endpoint + presale price feeds ────────────────
  // 00_config.js has no localhost LayerZero endpoint and 10_deploy_presale.js
  // has no localhost stablecoin/feed table — both read these from env instead
  // (see the comments added at each site). Deployed once, up front.

  const Endpoint = await ethers.getContractFactory("MockLZEndpoint", deployer);
  const ep = await Endpoint.deploy(30101);
  await ep.waitForDeployment();

  const Feed = await ethers.getContractFactory("MockChainlinkFeed", deployer);
  // localhost is not in 10_deploy_presale.js's isEthChain list, so it prices the
  // native asset as "BNB" — description must match exactly what requireFeed() checks.
  const nativeFeed = await Feed.deploy(300n * 10n ** 8n); // $300, inside BOUNDS.BNB
  await nativeFeed.waitForDeployment();
  await (await nativeFeed.setDescription("BNB / USD")).wait();
  const btcFeed = await Feed.deploy(60_000n * 10n ** 8n); // $60,000, inside BOUNDS.BTC
  await btcFeed.waitForDeployment();
  await (await btcFeed.setDescription("BTC / USD")).wait();

  console.log(`MockLZEndpoint:     ${await ep.getAddress()}`);
  console.log(`Native (BNB) feed:  ${await nativeFeed.getAddress()}`);
  console.log(`BTC feed:           ${await btcFeed.getAddress()}\n`);

  // ── Env accumulator for the deploy scripts (01–10) ──────────────────────────
  // Each script prints "Save to .env" lines for what it deployed; those are
  // parsed out of stdout and folded in here so the next script can read them,
  // exactly the way a human running these by hand would copy them into .env.
  const deployEnv = {
    ADMIN_ADDRESS:            admin,
    DEPLOYER_EOA:              deployer.address,
    GUARDIAN_MULTISIG:         guardianMultisig.address,
    CIRCUIT_BREAKER_ADDRESS:   circuitBreaker.address,
    ORACLE_ADDRESS:            oracle.address,
    LZ_ENDPOINT_LOCALHOST:     await ep.getAddress(),
    NATIVE_FEED_LOCALHOST:     await nativeFeed.getAddress(),
    BTC_FEED_LOCALHOST:        await btcFeed.getAddress(),
  };

  function runScript(script, extraEnv, envForRun) {
    const r = spawnSync(process.execPath, [CLI, "run", script, "--network", "localhost"], {
      cwd: ROOT,
      env: { ...process.env, ...envForRun, ...extraEnv },
      encoding: "utf8",
      input: "yes\n", // answers any readline confirm() prompt (08, 09)
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  }

  function parseAssignments(out, into) {
    const found = {};
    let m;
    ASSIGN_RE.lastIndex = 0;
    while ((m = ASSIGN_RE.exec(out))) { into[m[1]] = m[2]; found[m[1]] = m[2]; }
    return found;
  }

  // The localhost JSON-RPC HTTP connection intermittently drops with ECONNRESET
  // under Windows when the keep-alive socket is reused after a gap (observed
  // consistently on the first RPC call after a child process exits) — nothing to
  // do with chain state, which is unaffected. Retried rather than worked around
  // by weakening anything: the same call is repeated until it succeeds.
  async function withRetry(fn, tries = 5) {
    for (let i = 1; i <= tries; i++) {
      try { return await fn(); }
      catch (e) {
        const transient = /ECONNRESET|ETIMEDOUT|socket hang up/i.test(e.message || "");
        if (!transient || i === tries) throw e;
        console.log(`   ↻ transient RPC error (${e.message}), retry ${i}/${tries - 1}`);
        await new Promise((res) => setTimeout(res, 500 * i));
      }
    }
  }

  /** Executes and deletes a queued Safe-batch-style JSON file, if present. Returns tx count (0 if no file). */
  async function executeBatchIfPresent(filename) {
    const full = path.join(ROOT, filename);
    if (!fs.existsSync(full)) return 0;
    const batch = JSON.parse(fs.readFileSync(full, "utf8"));
    // Warm-up: absorb the stale-keep-alive-socket ECONNRESET on a harmless,
    // read-only, side-effect-free call before anything that sends a transaction —
    // a send is never blindly retried below, to avoid ever double-submitting one.
    await withRetry(() => network.provider.send("eth_chainId", []));
    await withRetry(() => network.provider.send("hardhat_setBalance", [admin, "0x" + (10n ** 24n).toString(16)]));
    const adminSigner = await withRetry(() => ethers.getImpersonatedSigner(admin));
    for (const t of batch.transactions) {
      const tx = await adminSigner.sendTransaction({ to: t.to, value: BigInt(t.value || "0"), data: t.data });
      const receipt = await withRetry(() => tx.wait()); // wait() only polls for the receipt — safe to retry
      if (receipt.status !== 1) throw new Error(`admin Safe tx failed in ${filename}: to=${t.to}`);
    }
    await withRetry(() => network.provider.send("hardhat_stopImpersonatingAccount", [admin]));
    fs.unlinkSync(full);
    return batch.transactions.length;
  }

  async function step(label, script, batchFile) {
    console.log(`\n── ${label} ──`);
    const r = runScript(script, {}, deployEnv);
    expect(r.code === 0, `${label} ran`, r.out);
    parseAssignments(r.out, deployEnv);
    if (batchFile) {
      const n = await executeBatchIfPresent(batchFile);
      expect(n > 0, `${label} admin batch executed as the admin Safe (${n} tx) and ${batchFile} removed`, r.out);
    }
    return r;
  }

  // ── Deploy sequence ──────────────────────────────────────────────────────
  // 01_deploy_token.js is the one script that does NOT print a "Save to .env"
  // KEY=VALUE line (it prints "Save this address to .env as SRX_TOKEN_<NET>" as
  // a sentence, and the address separately on "SRXToken deployed: 0x..."), so it
  // is parsed as a special case rather than by the generic ASSIGN_RE pass.
  {
    console.log(`\n── 01_deploy_token ──`);
    const r = runScript("scripts/deploy/01_deploy_token.js", {}, deployEnv);
    expect(r.code === 0, "01_deploy_token ran", r.out);
    const m = r.out.match(/SRXToken deployed:\s*(0x[0-9a-fA-F]{40})/);
    expect(!!m, "01_deploy_token printed its deployed address", r.out);
    deployEnv.SRX_TOKEN_LOCALHOST = m[1];
    console.log(`  → SRX_TOKEN_LOCALHOST=${m[1]}`);
  }
  await step("02_deploy_governance",     "scripts/deploy/02_deploy_governance.js",     null);
  await step("03_deploy_vesting",        "scripts/deploy/03_deploy_vesting.js",        "safe_batch.03_vesting.localhost.json");
  await step("04_deploy_staking",        "scripts/deploy/04_deploy_staking.js",        null);
  await step("05_deploy_treasury",       "scripts/deploy/05_deploy_treasury.js",       "safe_batch.05_treasury.localhost.json");
  await step("05b_deploy_stabilisation", "scripts/deploy/05b_deploy_stabilisation.js", "safe_batch.05b_stabilisation.localhost.json");

  console.log(`\n── 06_execute_tge (round 1 of 2 — see header note) ──`);
  {
    const r = runScript("scripts/deploy/06_execute_tge.js", {}, deployEnv);
    expect(r.code === 0, "06_execute_tge round 1 ran (queues setAllocations+genesis+distribute+triggerTGE on each vault)", r.out);
    parseAssignments(r.out, deployEnv);
    const n = await executeBatchIfPresent("safe_batch.06_tge.localhost.json");
    expect(n > 0, `06 round 1 admin batch executed (${n} tx)`, r.out);
  }
  console.log(`\n── 06_execute_tge (round 2 of 2 — registers the staking incentive pool) ──`);
  {
    const r = runScript("scripts/deploy/06_execute_tge.js", {}, deployEnv);
    expect(r.code === 0, "06_execute_tge round 2 ran (queues notifyRewardAmount)", r.out);
    parseAssignments(r.out, deployEnv);
    const n = await executeBatchIfPresent("safe_batch.06_tge.localhost.json");
    expect(n > 0, `06 round 2 admin batch executed (${n} tx)`, r.out);
  }
  console.log(`\n── 06_execute_tge (round 3 — a re-run after completion must be a no-op) ──`);
  {
    const r = runScript("scripts/deploy/06_execute_tge.js", {}, deployEnv);
    expect(r.code === 0 && /already done\) incentive pool holds/.test(r.out), "06_execute_tge re-run finds the incentive pool already registered", r.out);
    const n = await executeBatchIfPresent("safe_batch.06_tge.localhost.json");
    expect(n === 0, "06 re-run queued nothing for the Safe", r.out);
  }

  // ── The balances on chain, right after TGE ─────────────────────────────────
  // ⭐ The launch design (5% liquid, nothing new for 30 days, the reserve locked)
  //    is checked by reading real balances, not by trusting the configuration:
  //    verify_tge.js must pass, including the launch float from TGE_PLAN.
  console.log(`
── verify_tge.js — every balance and vault, and the launch float ──`);
  {
    const r = runScript("scripts/ops/verify_tge.js", {}, deployEnv);
    expect(r.code === 0 && /TGE VERIFICATION PASSED/.test(r.out) && /Launch float \(liquid rows\): 500000000\.0 SRX/.test(r.out),
      "verify_tge.js passes, and exactly 500,000,000 SRX is liquid at launch", r.out);
  }

  await step("08_deploy_guardian", "scripts/deploy/08_deploy_guardian.js", "safe_batch.08_guardian.localhost.json");
  await step("09_deploy_migrator", "scripts/deploy/09_deploy_migrator.js", "safe_batch.09_migrator.localhost.json");
  await step("10_deploy_presale",  "scripts/deploy/10_deploy_presale.js",  "presale_config.localhost.json");

  console.log(`\n✅ Deploy scripts 01–06, 08–10 rehearsed. 07_deploy_bridge.js skipped — needs a second chain.\n`);

  // ── Launch hand-over: migrate_roles.js + verify_roles.js ──────────────────
  // A DELIBERATELY NARROW env: migrate_roles.js/verify_roles.js use unsuffixed
  // keys (e.g. "STABILISATION", "GUARDIAN_MODULE") that don't match the suffixed
  // names the deploy scripts printed (e.g. "STABILISATION_FUND_LOCALHOST",
  // "GUARDIAN_LOCALHOST") — translated explicitly below. GUARDIAN_MULTISIG must
  // NOT be forwarded here: it means something different in this context (the
  // StabilisationFund's tiered GUARDIAN_ROLE, which this deploy sequence never
  // grants to anyone — see 05b's header). Forwarding the value used for
  // GuardianModule's own GUARDIAN_ROLE in step 08 would make verify_roles.js
  // check an SSF role that was never granted, and falsely fail.
  const need = {
    SRX_TOKEN_LOCALHOST:       deployEnv.SRX_TOKEN_LOCALHOST,
    TIMELOCK_LOCALHOST:        deployEnv.TIMELOCK_LOCALHOST,
    GOVERNOR_LOCALHOST:        deployEnv.GOVERNOR_LOCALHOST,
    TREASURY_LOCALHOST:        deployEnv.TREASURY_LOCALHOST,
    STAKING_LOCALHOST:         deployEnv.STAKING_LOCALHOST,
    FEE_CONTROLLER_LOCALHOST:  deployEnv.FEE_CONTROLLER_LOCALHOST,
    STABILISATION_LOCALHOST:   deployEnv.STABILISATION_FUND_LOCALHOST, // name translation
    GUARDIAN_MODULE_LOCALHOST: deployEnv.GUARDIAN_LOCALHOST,            // name translation
  };
  for (const [k, v] of Object.entries(need)) {
    if (!v) throw new Error(`REHEARSAL FAILED: missing ${k} — a deploy step above did not print the address it should have.`);
  }
  const roleEnv = { ...need, ADMIN_ADDRESS: admin, DEPLOYER_EOA: deployer.address };

  function runRole(script, extraEnv = {}) {
    const r = spawnSync(process.execPath, [CLI, "run", script, "--network", "localhost"], {
      cwd: ROOT, env: { ...process.env, ...roleEnv, ...extraEnv }, encoding: "utf8",
      input: "yes\n", maxBuffer: 32 * 1024 * 1024,
    });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  }

  console.log(`\n── Negative control: verify_roles.js on the as-deployed (unmigrated) topology ──`);
  let r = runRole("scripts/verify/verify_roles.js");
  expect(r.code !== 0 && /WRONGLY held by forbidden/.test(r.out), "gate FAILS on the as-deployed topology (negative control)", r.out);

  console.log(`\n── migrate_roles.js phase 1 (JSON mode) ──`);
  r = runRole("scripts/ops/migrate_roles.js");
  expect(r.code === 0 && /schedule SRXToken\.acceptOwnership/.test(r.out), "phase 1 JSON written", r.out);
  let n = await executeBatchIfPresent("migrate_roles.phase1.localhost.json");
  expect(n > 0, `phase 1 admin batch executed (${n} tx) as the admin Safe`, r.out);

  console.log(`\n── advancing past the Timelock delay ──`);
  await withRetry(() => network.provider.send("eth_chainId", [])); // warm-up, see executeBatchIfPresent
  const tl = await ethers.getContractAt("SRXTimelock", need.TIMELOCK_LOCALHOST);
  const minDelay = await withRetry(() => tl.getMinDelay());
  await withRetry(() => network.provider.send("evm_increaseTime", [Number(minDelay) + 1]));
  await withRetry(() => network.provider.send("evm_mine", []));
  console.log(`  ✅ advanced ${minDelay}s + 1`);

  console.log(`\n── migrate_roles.js phase 2 (JSON mode, MIGRATE_FINALIZE=1) — IRREVERSIBLE ──`);
  r = runRole("scripts/ops/migrate_roles.js", { MIGRATE_FINALIZE: "1" });
  expect(r.code === 0, "phase 2 JSON written", r.out);
  n = await executeBatchIfPresent("migrate_roles.phase2.localhost.json");
  expect(n > 0, `phase 2 admin batch executed (${n} tx) as the admin Safe`, r.out);

  console.log(`\n── verify_roles.js on the migrated topology ──`);
  r = runRole("scripts/verify/verify_roles.js");
  expect(r.code !== 1 && /Failures: 0/.test(r.out), "gate reports zero failures on the migrated topology", r.out);
  console.log(r.out.split("\n").filter((l) => /Checks run|INCOMPLETE|•|ALL CHECKS/.test(l)).join("\n"));

  console.log("\n✅ DEPLOY REHEARSAL PASSED");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
