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
 *   01 → 02 → 05 → 10 → 03 → 04 → 05b → 06 (twice — see below) → 06b → 08
 * (the documented launch order: the SRXTreasury, Step 5, runs right after Step 2 because
 * Steps 10 and 03 fix it as every revoked vault's recipient, immutably — E-02. Both refuse
 * without it, and this script proves that before deploying it.)
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
const { WALLETS, TGE_PLAN } = require("../deploy/00_config");

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
    PAUSE_GUARDIAN:            admin, // GuardianModule's GUARDIAN_ROLE: the admin Safe keeps the emergency pause (E-04, E-06)
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

  // ── E-02: the SRXTreasury comes before the Genesis round and the vesting vaults ──
  // Both fix their revoke recipient for good, so each must REFUSE without a treasury (no
  // fallback to WALLET_TREASURY), refuse a wallet in its place, and deploy nothing.
  {
    console.log(`\n── Negative controls: Steps 10 and 03 without the SRXTreasury ──`);
    const plain = signers[7].address; // a key, no code
    for (const [script, label, leftovers] of [
      ["scripts/deploy/10_deploy_presale.js", "10", ["presale_config.localhost.json"]],
      ["scripts/deploy/03_deploy_vesting.js", "03", ["safe_batch.03_vesting.localhost.json"]],
    ]) {
      let r = runScript(script, {}, deployEnv);
      expect(r.code !== 0 && /TREASURY_LOCALHOST is not set/.test(r.out), `${label} REFUSES with no TREASURY_LOCALHOST (no wallet fallback)`, r.out);
      r = runScript(script, { TREASURY_LOCALHOST: plain }, deployEnv);
      expect(r.code !== 0 && /no contract at/.test(r.out), `${label} REFUSES a plain wallet as the treasury`, r.out);
      expect(!/(deployed|vault|TGEDistributor):\s+0x/i.test(r.out) && leftovers.every((x) => !fs.existsSync(path.join(ROOT, x))), `the refused ${label} deployed and queued nothing`, r.out);
    }
  }
  await step("05_deploy_treasury",       "scripts/deploy/05_deploy_treasury.js",       "safe_batch.05_treasury.localhost.json");
  expect(!!deployEnv.TREASURY_LOCALHOST, "05_deploy_treasury printed the SRXTreasury address", "");

  // ── The Genesis round, before launch (funded from the seed allocation) ──────
  // Jared, 10 and 30 Sep 2026: the seed allocation funds the Genesis round. The round
  // runs against the launch token BEFORE launch and is closed before Step 3, which
  // splits the seed allocation by what it sold (scripts/deploy/lib/genesis_seed.js).
  await step("10_deploy_presale (the Genesis round)", "scripts/deploy/10_deploy_presale.js", "presale_config.localhost.json");
  expect(!!deployEnv.PRESALE_ROUND_LOCALHOST, "10_deploy_presale printed the Genesis contract address", "");
  const buyers = [signers[5].address, signers[6].address];
  async function asAdmin(contract, fn, args) {
    await withRetry(() => network.provider.send("eth_chainId", []));
    await withRetry(() => network.provider.send("hardhat_setBalance", [admin, "0x" + (10n ** 24n).toString(16)]));
    const s = await withRetry(() => ethers.getImpersonatedSigner(admin));
    const tx = await contract.connect(s)[fn](...args);
    const receipt = await withRetry(() => tx.wait());
    if (receipt.status !== 1) throw new Error(`REHEARSAL FAILED: admin ${fn} reverted`);
    await withRetry(() => network.provider.send("hardhat_stopImpersonatingAccount", [admin]));
  }
  const round = await ethers.getContractAt("PreSaleRound", deployEnv.PRESALE_ROUND_LOCALHOST);
  const USD8 = (n) => BigInt(n) * 10n ** 8n;
  await asAdmin(round, "setBuyerApprovals", [buyers, [USD8(100_000), USD8(40_000)], [ethers.id("rehearsal agreement 1"), ethers.id("rehearsal agreement 2")]]);
  await asAdmin(round, "addInvestor", [buyers[0], USD8(100_000)]); // 12,000,000 SRX with the +50% bonus
  await asAdmin(round, "addInvestor", [buyers[1], USD8(40_000)]);  //  4,800,000 SRX
  const sold = await withRetry(() => round.totalAllocated());
  expect(sold === ethers.parseUnits("16800000", 18), `two Genesis buyers recorded: ${ethers.formatUnits(sold, 18)} SRX sold`, "");

  // Negative control: Step 3 refuses while the Genesis round is still open, and
  // sends nothing (the seed vault's grant would not be final).
  {
    console.log(`\n── Negative control: 03_deploy_vesting with the Genesis round still open ──`);
    const r = runScript("scripts/deploy/03_deploy_vesting.js", {}, deployEnv);
    expect(r.code !== 0 && /still open/.test(r.out), "03 REFUSES while the Genesis round is open (negative control)", r.out);
    expect(!/vault:\s+0x/.test(r.out), "the refused 03 deployed no vault", r.out);
    expect(!fs.existsSync(path.join(ROOT, "safe_batch.03_vesting.localhost.json")), "the refused 03 queued nothing for the Safe", r.out);
  }
  await asAdmin(round, "finalize", []);
  console.log("  ✅ Genesis round closed (finalize)");

  await step("03_deploy_vesting",        "scripts/deploy/03_deploy_vesting.js",        "safe_batch.03_vesting.localhost.json");
  await step("04_deploy_staking",        "scripts/deploy/04_deploy_staking.js",        null);
  await step("05b_deploy_stabilisation", "scripts/deploy/05b_deploy_stabilisation.js", "safe_batch.05b_stabilisation.localhost.json");

  // ── E-01: staking and the fund fix the distributor, so Step 3 must not run again ──
  {
    console.log(`\n── Negative control: 03_deploy_vesting re-run after 04 and 05b ──`);
    const r = runScript("scripts/deploy/03_deploy_vesting.js", {}, deployEnv);
    expect(r.code !== 0 && /already declared/.test(r.out) && /STAKING_LOCALHOST/.test(r.out) && /STABILISATION_FUND_LOCALHOST/.test(r.out),
      "03 REFUSES to re-run once staking and the fund are deployed (E-01)", r.out);
    expect(!/(vault|TGEDistributor):\s+0x/.test(r.out) && !fs.existsSync(path.join(ROOT, "safe_batch.03_vesting.localhost.json")),
      "the refused 03 deployed no new distributor and queued nothing", r.out);
  }

  // The vaults' admin is the Timelock (30 Sep 2026): 03 SCHEDULED the vault setup
  // (declare grants, start clocks) and 06 EXECUTES it, which the Timelock allows
  // only after its delay — exactly the wait a real launch has between the two.
  {
    await withRetry(() => network.provider.send("eth_chainId", []));
    const tlc = await ethers.getContractAt("SRXTimelock", deployEnv.TIMELOCK_LOCALHOST);
    const d = await withRetry(() => tlc.getMinDelay());
    await withRetry(() => network.provider.send("evm_increaseTime", [Number(d) + 1]));
    await withRetry(() => network.provider.send("evm_mine", []));
    console.log(`\n── waited the Timelock delay (${d}s) for the scheduled vault setup ──`);
  }
  console.log(`\n── 06_execute_tge (round 1 of 2 — see header note) ──`);
  {
    const r = runScript("scripts/deploy/06_execute_tge.js", {}, deployEnv);
    expect(r.code === 0, "06_execute_tge round 1 ran (queues setAllocations+genesis+distribute+triggerTGE on each vault)", r.out);
    expect(/revoke recipient: 6 launch vaults, the Genesis contract and every existing Genesis buyer vault all name the SRXTreasury 0x[0-9a-fA-F]{40} \(\d+ checks\)/.test(r.out),
      "06's destination controls ran the revoke-recipient check and it passed", r.out);
    expect(/distributor: SRXStaking and the StabilisationFund both name 0x[0-9a-fA-F]{40}, the TGEDistributor that launches/.test(r.out),
      "06's destination controls confirmed staking and the fund name the distributor that launches (E-01)", r.out);
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
    // Security ruling 23 Oct 2026: the launch reward rate is set in this batch, from the plan,
    // and cannot promise more than the pool holds (the period ends when the pool runs out).
    const staking = await ethers.getContractAt("SRXStaking", deployEnv.STAKING_LOCALHOST);
    const { rewardRatesFor } = require("../deploy/00_config");
    const rate = await withRetry(() => staking.rewardRate());
    expect(rate === rewardRatesFor("localhost").staking, `06 set the staking reward rate to the plan (${ethers.formatUnits(rate, 18)} SRX/s)`, r.out);
    const pool = await withRetry(() => staking.rewardPool());
    const finish = await withRetry(() => staking.periodFinish());
    const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    expect(rate > 0n && finish <= now + pool / rate + 1n, `the reward period ends by the time the pool runs out (finish ${finish} <= now + pool / rate)`, "");
    expect(/OPEN: no StabilisationFund reward rate in the plan/.test(r.out), "06 said plainly that the fund's rate is not set at launch (plan null)", r.out);
  }
  console.log(`\n── 06_execute_tge (round 3 — a re-run after completion must be a no-op) ──`);
  {
    const r = runScript("scripts/deploy/06_execute_tge.js", {}, deployEnv);
    expect(r.code === 0 && /already done\) incentive pool holds/.test(r.out), "06_execute_tge re-run finds the incentive pool already registered", r.out);
    expect(/already done\) staking reward rate/.test(r.out), "06_execute_tge re-run finds the staking reward rate already set", r.out);
    const n = await executeBatchIfPresent("safe_batch.06_tge.localhost.json");
    expect(n === 0, "06 re-run queued nothing for the Safe", r.out);
  }

  // ── Genesis buyers' vaults, straight after launch ──────────────────────────
  {
    const token = await ethers.getContractAt("SRXToken", deployEnv.SRX_TOKEN_LOCALHOST);
    const held = await withRetry(() => token.balanceOf(deployEnv.PRESALE_ROUND_LOCALHOST));
    expect(held === sold, `launch sent the Genesis contract exactly what it sold (${ethers.formatUnits(held, 18)} SRX), not its 300M cap`, "");
    const seedVault = await withRetry(() => token.balanceOf(deployEnv.VESTING_SEED_LOCALHOST));
    expect(seedVault === ethers.parseUnits("400000000", 18) - sold, `the seed vault holds the rest of the seed allocation (${ethers.formatUnits(seedVault, 18)} SRX)`, "");
  }
  const r06b = await step("06b_genesis_vaults", "scripts/deploy/06b_genesis_vaults.js", "safe_batch.06b_genesis_vaults.localhost.json");
  // C5: the chunk is estimated against the per-transaction gas cap before it is queued.
  expect(/chunk 0–1: 2 buyers, estimated \d+ gas \(model \d+, node \d+\); limit 15000000 of the 16777216 a transaction may use/.test(r06b.out),
    "06b estimated the Genesis vault chunk against the 15,000,000 limit before queuing it (C5)", r06b.out);
  {
    const r = runScript("scripts/deploy/06b_genesis_vaults.js", {}, deployEnv);
    expect(r.code === 0 && /GENESIS VAULTS COMPLETE — 2 vaults running on the seed schedule, 16800000\.0 SRX locked, 0 left/.test(r.out),
      "06b re-run confirms both Genesis vaults running on the seed schedule and nothing left in the Genesis contract", r.out);
    expect(/revoke recipient: the Genesis contract and all 2 buyer vaults name the SRXTreasury/.test(r.out),
      "06b checked that the Genesis contract and both buyers' vaults revoke to the SRXTreasury", r.out);
    const n = await executeBatchIfPresent("safe_batch.06b_genesis_vaults.localhost.json");
    expect(n === 0, "06b re-run queued nothing for the Safe", r.out);
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
    expect(/2 buyers' vaults: 16800000\.0 SRX  ✅/.test(r.out) && /Owed to buyers without a vault: none  ✅/.test(r.out),
      "verify_tge.js checked the Genesis buyers' vaults and that no buyer is still owed SRX", r.out);
  }

  await step("08_deploy_guardian", "scripts/deploy/08_deploy_guardian.js", "safe_batch.08_guardian.localhost.json");
  // Step 09 (ZkSyncMigrator) is retired by CH-13: not deployed.

  console.log(`\n✅ Deploy scripts 01–06b, 08–10 rehearsed (10, the Genesis round, before launch). 07_deploy_bridge.js skipped — needs a second chain.\n`);

  // ── Launch hand-over: migrate_roles.js + verify_roles.js ──────────────────
  // A DELIBERATELY NARROW env. The names the deploy scripts PRINTED are passed on as they
  // are (STABILISATION_FUND_LOCALHOST, GUARDIAN_MODULE_LOCALHOST): the role scripts used to
  // read other names (STABILISATION_, GUARDIAN_MODULE_) and this script translated by hand,
  // which hid that an operator pasting what 05b and 08 printed would fail the gate (E-08).
  // PAUSE_GUARDIAN (the value 08 gave GuardianModule) is not forwarded as SSF_GUARDIAN_MULTISIG: the two
  // names are different roles (E-06), and the StabilisationFund's tiered
  // GUARDIAN_ROLE is never granted by this deploy sequence (see 05b's header), so
  // stating it would make verify_roles.js check a role that was never granted.
  const need = {
    SRX_TOKEN_LOCALHOST:       deployEnv.SRX_TOKEN_LOCALHOST,
    TIMELOCK_LOCALHOST:        deployEnv.TIMELOCK_LOCALHOST,
    GOVERNOR_LOCALHOST:        deployEnv.GOVERNOR_LOCALHOST,
    TREASURY_LOCALHOST:        deployEnv.TREASURY_LOCALHOST,
    STAKING_LOCALHOST:         deployEnv.STAKING_LOCALHOST,
    FEE_CONTROLLER_LOCALHOST:  deployEnv.FEE_CONTROLLER_LOCALHOST,
    STABILISATION_FUND_LOCALHOST: deployEnv.STABILISATION_FUND_LOCALHOST, // as 05b printed it
    GUARDIAN_MODULE_LOCALHOST: deployEnv.GUARDIAN_MODULE_LOCALHOST,       // as 08 printed it
  };
  // 30 Sep 2026: the gate now covers every privileged contract. The migrator and
  // the fixed-admin contracts (distributor, presale, each vesting vault) are
  // checked, and contracts this suite does not deploy are DECLARED absent — an
  // undeclared one fails the gate rather than being skipped.
  need.TGE_DISTRIBUTOR_LOCALHOST = deployEnv.TGE_DISTRIBUTOR_LOCALHOST;
  need.PRESALE_ROUND_LOCALHOST   = deployEnv.PRESALE_ROUND_LOCALHOST;
  for (const row of TGE_PLAN.filter((r) => r.kind === "vault")) need[`${row.vaultEnv}_LOCALHOST`] = deployEnv[`${row.vaultEnv}_LOCALHOST`];
  for (const [k, v] of Object.entries(need)) {
    if (!v) throw new Error(`REHEARSAL FAILED: missing ${k} — a deploy step above did not print the address it should have.`);
  }
  // A contract's deployment block, for the gate's event reads (internal audit CONTROL-05; E-03,
  // E-05): the first block at which it has code, by binary search.
  async function deployBlockOf(address) {
    let lo = 0, hi = await withRetry(() => ethers.provider.getBlockNumber());
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const code = await withRetry(() => ethers.provider.getCode(address, mid));
      if (code === "0x") lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  const roleEnv = {
    ...need, ADMIN_ADDRESS: admin, DEPLOYER_EOA: deployer.address,
    TIMELOCK_DEPLOY_BLOCK_LOCALHOST: String(await deployBlockOf(need.TIMELOCK_LOCALHOST)),
    SRX_TOKEN_DEPLOY_BLOCK_LOCALHOST: String(await deployBlockOf(need.SRX_TOKEN_LOCALHOST)),
    CIRCUIT_BREAKER_ADDRESS: circuitBreaker.address, // the monitor 08 granted CIRCUIT_BREAKER_ROLE (E-04)
    BUYBACK_BURNER_LOCALHOST: "none", AIRDROP_LOCALHOST: "none", SRX_OFT_NATIVE_LOCALHOST: "none",
  };

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
  expect(/revokeRecipient: 6 launch vaults, the Genesis contract and its buyers' vaults all name the SRXTreasury 0x[0-9a-fA-F]{40} \(\d+ checks\)/.test(r.out),
    "verify_roles ran the revoke-recipient check and it passed", r.out);
  // ⛔ "not exit 1" is not a pass: exit 2 means advisories, and only KNOWN ones are
  //    acceptable here — the two unset SSF multisigs. Anything else fails.
  {
    const adv = (r.out.split("This run was INCOMPLETE:")[1] || "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("•"));
    // ORACLE_REPORTER: the monitor is not deployed locally; the "deployer never holds it" half still runs.
    const known = [/DEPLOYER_MULTISIG unset/, /SSF_GUARDIAN_MULTISIG unset/, /ORACLE_REPORTER unset/];
    const unknown = adv.filter((l) => !known.some((re) => re.test(l)));
    expect(unknown.length === 0, `the gate's only advisories are the known ones (${adv.length} advisories)`, r.out);
    expect(/Role-checked: .*GuardianModule/.test(r.out), "GuardianModule is role-checked (ZkSyncMigrator is retired, CH-13)", r.out);
  }
  console.log(r.out.split("\n").filter((l) => /Checks run|INCOMPLETE|•|ALL CHECKS/.test(l)).join("\n"));

  // ═══════════════════════════════════════════════════════════════════════════
  // Mutation checks (review E, 22 Oct 2026): the gate that just passed must FAIL on each bad
  // state below. Each is built on the passing deployment by impersonating the Timelock (as if a
  // scheduled operation had executed), the gate is re-run, and the state is reverted.
  // ═══════════════════════════════════════════════════════════════════════════
  const gatePassOut = r.out;
  const checksOf = (out) => Number((out.match(/Checks run: (\d+)/) || [])[1]);
  console.log(`\n── Mutation checks on the passing gate (${checksOf(gatePassOut)} checks) ──`);
  const timelockAddr = ethers.getAddress(need.TIMELOCK_LOCALHOST);
  const tlc = await ethers.getContractAt("SRXTimelock", timelockAddr);
  const outsider = ethers.Wallet.createRandom().address; // a single key nobody listed
  async function as(addr, fn) {
    await withRetry(() => network.provider.send("eth_chainId", []));
    await withRetry(() => network.provider.send("hardhat_setBalance", [addr, "0x" + (10n ** 24n).toString(16)]));
    const s = await withRetry(() => ethers.getImpersonatedSigner(addr));
    await fn(s);
    await withRetry(() => network.provider.send("hardhat_stopImpersonatingAccount", [addr]));
  }
  const asTimelock = (fn) => as(timelockAddr, fn);
  /** Apply `setup` (may be null), run the gate, require it to FAIL with `pattern`, and revert the chain. */
  async function mutate(label, setup, pattern, extraEnv = {}) {
    await withRetry(() => network.provider.send("eth_chainId", []));
    const snap = await withRetry(() => network.provider.send("evm_snapshot", []));
    try {
      if (setup) await setup();
      const g = runRole("scripts/verify/verify_roles.js", extraEnv);
      expect(g.code === 1 && pattern.test(g.out), `the gate FAILS when ${label}`, g.out);
    } finally { await withRetry(() => network.provider.send("evm_revert", [snap])); }
  }

  // E-03: who can propose to the Timelock, and what the "Governor" is.
  expect(/Governor 0x[0-9a-fA-F]{40} is a contract wired to this Timelock and this token/.test(gatePassOut)
    && /Timelock holders \(read from block \d+\): PROPOSER: the Governor · CANCELLER: [^·]*the admin Safe[^·]* · DEFAULT_ADMIN: the Timelock/.test(gatePassOut),
    "verify_roles listed the Timelock's holders: PROPOSER = the Governor only, CANCELLER includes the Safe's veto, admin = the Timelock", gatePassOut);
  await mutate("a single key is a Timelock PROPOSER beside the Governor",
    () => asTimelock((s) => tlc.connect(s).grantRole(ethers.id("PROPOSER_ROLE"), outsider).then((t) => t.wait())),
    /PROPOSER_ROLE is also held by/);
  await mutate("a single key is a Timelock CANCELLER",
    () => asTimelock((s) => tlc.connect(s).grantRole(ethers.id("CANCELLER_ROLE"), outsider).then((t) => t.wait())),
    /CANCELLER_ROLE is also held by/);
  await mutate("GOVERNOR_<NET> names a single key instead of an SRXGovernor", null,
    /has no code: the Timelock's proposer is not a Governor contract/, { GOVERNOR_LOCALHOST: outsider });

  // E-06: one value names one role. The retired name is refused, not guessed at.
  await mutate("the retired GUARDIAN_MULTISIG is still set (it named two different roles)", null,
    /GUARDIAN_MULTISIG is retired[\s\S]*PAUSE_GUARDIAN[\s\S]*SSF_GUARDIAN_MULTISIG/, { GUARDIAN_MULTISIG: deployEnv.PAUSE_GUARDIAN });
  {
    // ... and the fund's GUARDIAN_ROLE is asked of the fund, under its own name, whatever 08 used.
    const g = runRole("scripts/verify/verify_roles.js", { SSF_GUARDIAN_MULTISIG: deployEnv.PAUSE_GUARDIAN });
    expect(g.code === 1 && /GUARDIAN_ROLE NOT held by expected/.test(g.out) && !/GUARDIAN_MULTISIG is retired/.test(g.out),
      "SSF_GUARDIAN_MULTISIG is checked against the StabilisationFund's own GUARDIAN_ROLE, not GuardianModule's", g.out);
  }

  // E-04: the holders the topology REQUIRES. The Safe keeps the emergency pause and the veto; the
  // circuit-breaker monitor holds its role. Each is removed in turn and the gate must fail.
  expect(/the admin Safe holds GuardianModule GUARDIAN_ROLE \(emergency pause\) and Timelock CANCELLER_ROLE \(veto\)/.test(gatePassOut)
    && /circuit-breaker monitor 0x[0-9a-fA-F]{40} holds CIRCUIT_BREAKER_ROLE/.test(gatePassOut),
    "verify_roles confirmed the Safe holds its pause and veto, and the monitor holds CIRCUIT_BREAKER_ROLE", gatePassOut);
  const gmod = await ethers.getContractAt("GuardianModule", need.GUARDIAN_MODULE_LOCALHOST);
  await mutate("the Safe has lost its veto (CANCELLER_ROLE on the Timelock)",
    () => asTimelock((s) => tlc.connect(s).revokeRole(ethers.id("CANCELLER_ROLE"), admin).then((t) => t.wait())),
    /admin Safe .* does not hold Timelock CANCELLER_ROLE/);
  await mutate("the Safe is not the guardian (GUARDIAN_ROLE on GuardianModule)",
    () => asTimelock((s) => gmod.connect(s).revokeRole(ethers.id("GUARDIAN_ROLE"), admin).then((t) => t.wait())),
    /admin Safe .* does not hold GuardianModule GUARDIAN_ROLE/);
  await mutate("nobody can report bridge volume (CIRCUIT_BREAKER_ROLE revoked from the monitor)",
    () => asTimelock((s) => gmod.connect(s).revokeRole(ethers.id("CIRCUIT_BREAKER_ROLE"), circuitBreaker.address).then((t) => t.wait())),
    /does not hold CIRCUIT_BREAKER_ROLE: nobody can report bridge volume/);
  await mutate("the breaker is configured but CIRCUIT_BREAKER_ADDRESS is not stated", null,
    /CIRCUIT_BREAKER_ADDRESS is not set while the bridge circuit breaker is configured/, { CIRCUIT_BREAKER_ADDRESS: "" });
  {
    // 08 itself refuses to default either holder to the Safe.
    for (const unset of ["PAUSE_GUARDIAN", "CIRCUIT_BREAKER_ADDRESS"]) {
      const g = runScript("scripts/deploy/08_deploy_guardian.js", { [unset]: "" }, deployEnv);
      expect(g.code !== 0 && new RegExp(`${unset} is not set[\\s\\S]*no default`).test(g.out) && !fs.existsSync(path.join(ROOT, "safe_batch.08_guardian.localhost.json")),
        `08 REFUSES to default ${unset} to the admin Safe`, g.out);
    }
  }

  // E-05: every peer the hub has is on a declared chain, at the declared contract.
  expect(/hub peers \(read from block \d+\): none set/.test(gatePassOut), "verify_roles listed the hub's peers from its own events (this rehearsal has none)", gatePassOut);
  const hubToken = await ethers.getContractAt("SRXToken", need.SRX_TOKEN_LOCALHOST);
  const toBytes32 = (a) => ethers.zeroPadValue(a, 32);
  await mutate("the hub trusts a peer on a chain nobody declared (EID 30110), on default libraries and one DVN",
    () => asTimelock((s) => hubToken.connect(s).setPeer(30110, toBytes32(outsider)).then((t) => t.wait())),
    /the hub trusts a peer on EID 30110 \(0x[0-9a-fA-F]{40}\), a chain that is not declared/);
  await mutate("the hub trusts a peer on a chain in LZ_EIDS that this environment does not declare (BNB mainnet, EID 30102)",
    () => asTimelock((s) => hubToken.connect(s).setPeer(30102, toBytes32(outsider)).then((t) => t.wait())),
    /the hub trusts a peer on EID 30102/);
  {
    // A peer that was set and then removed is not a peer: the gate passes.
    await withRetry(() => network.provider.send("eth_chainId", []));
    const snap = await withRetry(() => network.provider.send("evm_snapshot", []));
    try {
      await asTimelock(async (s) => {
        await (await hubToken.connect(s).setPeer(30110, toBytes32(outsider))).wait();
        await (await hubToken.connect(s).setPeer(30110, ethers.ZeroHash)).wait();
      });
      const g = runRole("scripts/verify/verify_roles.js");
      expect(g.code !== 1 && /Failures: 0/.test(g.out), "a hub peer that was set and then removed does not fail the gate", g.out);
    } finally { await withRetry(() => network.provider.send("evm_revert", [snap])); }
  }
  await mutate("SRX_TOKEN_DEPLOY_BLOCK is not stated (the peers cannot be listed)", null,
    /the hub's peers could not be listed: the deployment block .* was not provided/, { SRX_TOKEN_DEPLOY_BLOCK_LOCALHOST: "" });

  // E-08: the names the deploy scripts print are the names the gate reads; the old spellings still work.
  expect(!!deployEnv.GUARDIAN_MODULE_LOCALHOST && !deployEnv.GUARDIAN_LOCALHOST,
    "08 prints GUARDIAN_MODULE_<NET> (not GUARDIAN_<NET>), the name verify_roles and migrate_roles read", "");
  {
    const legacy = {
      STABILISATION_FUND_LOCALHOST: "", GUARDIAN_MODULE_LOCALHOST: "",
      STABILISATION_LOCALHOST: need.STABILISATION_FUND_LOCALHOST, GUARDIAN_LOCALHOST: need.GUARDIAN_MODULE_LOCALHOST,
    };
    const g = runRole("scripts/verify/verify_roles.js", legacy);
    expect(g.code !== 1 && /Failures: 0/.test(g.out) && checksOf(g.out) === checksOf(gatePassOut),
      "the gate still accepts the older names STABILISATION_<NET> and GUARDIAN_<NET> and runs the same checks", g.out);
  }

  console.log("\n✅ DEPLOY REHEARSAL PASSED");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
