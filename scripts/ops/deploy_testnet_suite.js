/**
 * deploy_testnet_suite.js — deploy the WHOLE current suite to a public TEST network,
 * the same way scripts/ops/rehearse_deploy_suite.js rehearses it locally.
 *
 *   npx hardhat run scripts/ops/deploy_testnet_suite.js --network sepolia
 *
 * ⭐ Why it exists: the Sepolia contracts dated from 13–21 May and no longer matched the
 *    code (tier names, buyer approvals, refunds, the 5% launch plan…), so anything
 *    reading them — the SRX hub on the platform — read an interface that no longer exists.
 *
 * What it does:
 *   - refuses any network that is not a test network;
 *   - clears every <NAME>_<NETWORK> address variable the deploy scripts read, AND its
 *     <NAME>_<NETWORK>_TGE twin, so an old address left in .env can never be mixed into
 *     the new deployment (.env is never opened or printed: only these keys are set to
 *     empty in the child environment);
 *   - runs 01 → 02 → 05 → 03 → 04 → 05b → 06 (until the staking pool is registered)
 *     → verify_tge → 08 → 10, passing each script the addresses the earlier ones
 *     printed (the SRXTreasury, 05, runs right after 02: 03 and 10 require it);
 *   - before 06, writes deploy/addresses.<network>.json (gitignored) from the list the
 *     TGE gate itself builds, because 06 refuses to run on a public network without it;
 *   - verify_tge must pass (every balance, every vault, the 5% launch float);
 *   - writes deployments/<network>.json: the public addresses, for readers such as the
 *     platform's SRX hub. Addresses only — no key, no secret.
 *
 * ⭐ RESUMABLE. Progress is saved to deployments/<network>.state.json after every step,
 *    and a re-run skips the steps already done. The first Sepolia run (29 Sep 2026)
 *    stopped at verify_tge with every address held only in memory; they had to be
 *    recovered from the chain (scripts/ops/recover_deploy_state.js). Start a fresh
 *    deployment by moving the state file aside — never by editing it.
 *
 * The admin must be the deployer (ADMIN_ADDRESS = the deploying wallet) so admin steps run
 * directly; on a real network the admin is a Safe and this script refuses to run at all.
 */
const { ethers, network } = require("hardhat");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { TESTNET_CHAINS, TGE_PLAN, walletFor } = require("../deploy/00_config");
const { buildTgeAllocations } = require("../deploy/lib/tge_targets");

const ROOT = path.join(__dirname, "..", "..");
const CLI = path.join(ROOT, "node_modules", "hardhat", "internal", "cli", "cli.js");
const ASSIGN_RE = /^[ \t]*([A-Z][A-Z0-9_]{2,})=(0x[0-9a-fA-F]{40}|[0-9]+)[ \t]*$/gm;

async function main() {
  const net = network.name;
  if (!TESTNET_CHAINS.has(net) || net === "hardhat" || net === "localhost") {
    throw new Error(`Refusing "${net}": this deploys to a public TEST network only (e.g. --network sepolia).`);
  }
  const NET = net.toUpperCase();
  const [deployer] = await ethers.getSigners();
  const admin = walletFor("admin", net);
  if (admin.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`ADMIN_ADDRESS (${admin}) is not the deployer (${deployer.address}); admin steps would queue for a Safe instead of running.`);
  }
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  // ── Progress: resume if there is a state file for this network ─────────────
  const statePath = path.join(ROOT, "deployments", `${net}.state.json`);
  let state;
  if (fs.existsSync(statePath)) {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (state.chainId !== chainId || state.deployer.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(`deployments/${net}.state.json is for chain ${state.chainId} / ${state.deployer}; move it aside to start fresh`);
    }
    console.log(`Resuming the ${net} deployment (done: ${state.done.join(", ")})`);
  } else {
    // Readers scan events from here, not from block 0.
    state = { network: net, chainId, deployer: deployer.address, fromBlock: await ethers.provider.getBlockNumber(), done: [], env: {} };
    console.log(`Deploying the current suite to ${net} (chain ${chainId}) from ${deployer.address}`);
  }
  const save = () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  };
  console.log(`  balance before: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  // Every address variable a deploy script or the TGE gate reads for this network —
  // cleared, with its _TGE twin (verify_tge switches to the _TGE set if one is present).
  const names = [
    "SRX_TOKEN", "TIMELOCK", "GOVERNOR", "TGE_DISTRIBUTOR", "STAKING", "FEE_CONTROLLER",
    "TREASURY", "STABILISATION_FUND", "GUARDIAN", "GUARDIAN_MODULE", "MIGRATOR", "SRX_OFT_NATIVE",
    "PRESALE_ROUND",
    ...TGE_PLAN.filter((r) => r.kind === "vault").map((r) => r.vaultEnv),
  ];
  const env = {};
  for (const n of names) { env[`${n}_${NET}`] = ""; env[`${n}_${NET}_TGE`] = ""; }
  Object.assign(env, {
    // A test-network launch runs WITHOUT a funded Genesis round: the round (step 10)
    // is deployed afterwards, for the platform to read. The funded path — round
    // closed before step 3, launch sends it what it sold, 06b creates the buyers'
    // vaults — is proven by scripts/ops/rehearse_deploy_suite.js. An old round left
    // in .env would otherwise be read as this launch's Genesis round.
    [`PRESALE_ROUND_${NET}`]: "none",
    DEPLOYER_EOA: deployer.address,
    // Test-network role holders: the deployer. On a real network these are Safes.
    PAUSE_GUARDIAN: deployer.address,
    CIRCUIT_BREAKER_ADDRESS: deployer.address,
    ORACLE_ADDRESS: deployer.address,
  }, state.env);

  function run(script) {
    const r = spawnSync(process.execPath, [CLI, "run", script, "--network", net], {
      cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", input: "yes\n", maxBuffer: 64 * 1024 * 1024,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    let m; ASSIGN_RE.lastIndex = 0;
    while ((m = ASSIGN_RE.exec(out))) { env[m[1]] = m[2]; state.env[m[1]] = m[2]; }
    return { code: r.status, out };
  }
  // A failing network call can quote the RPC URL, which carries the provider's access
  // key. So a failure prints only lines with no URL and no 32-byte hex string at all —
  // whole lines are dropped, nothing is "redacted" inside a line.
  const safeTail = (out) => out.split(/\r?\n/)
    .filter((l) => !/:\/\/|[0-9a-fA-F]{64}|api[_-]?key|private/i.test(l))
    .slice(-60).join("\n");
  function step(label, script, after) {
    if (state.done.includes(label)) { console.log(`── ${label} (already done)`); return null; }
    console.log(`── ${label}`);
    const r = run(script);
    if (r.code !== 0) { save(); console.log(safeTail(r.out)); throw new Error(`${label} failed (exit ${r.code})`); }
    if (after) after(r);
    state.done.push(label);
    save();
    return r;
  }
  const setEnv = (k, v) => { env[k] = v; state.env[k] = v; };

  step("01 token", "scripts/deploy/01_deploy_token.js", (r) => {
    const m = r.out.match(/SRXToken deployed:\s*(0x[0-9a-fA-F]{40})/);
    if (!m) throw new Error("01 did not print the token address");
    setEnv(`SRX_TOKEN_${NET}`, m[1]);
  });
  step("02 governance", "scripts/deploy/02_deploy_governance.js");
  // E-02: the SRXTreasury before Steps 3 and 10, which fix it as every revoked vault's recipient.
  step("05 treasury", "scripts/deploy/05_deploy_treasury.js");
  step("03 vesting + distributor", "scripts/deploy/03_deploy_vesting.js");
  step("04 staking", "scripts/deploy/04_deploy_staking.js");
  step("05b stabilisation fund", "scripts/deploy/05b_deploy_stabilisation.js");

  // The manifest 06 checks against, built from the gate's own list.
  if (!state.done.includes("manifest")) {
    const manifestPath = path.join(ROOT, "deploy", `addresses.${net}.json`);
    if (fs.existsSync(manifestPath)) {
      const keep = `${manifestPath}.before-${new Date().toISOString().slice(0, 10)}`;
      fs.renameSync(manifestPath, keep);
      console.log(`  (kept the previous manifest as ${path.basename(keep)})`);
    }
    const allocations = buildTgeAllocations({ networkName: net, env: { ...process.env, ...env } });
    const tgeAllocations = {};
    for (const a of allocations) {
      tgeAllocations[a.label] = {
        destination: a.destination,
        amountSRX: ethers.formatUnits(a.amount, 18).replace(/\.0$/, ""),
        isVestingVault: a.isVestingVault,
      };
    }
    fs.writeFileSync(manifestPath, JSON.stringify({ network: net, chainId, roles: {}, tgeAllocations }, null, 2));
    console.log(`  wrote ${path.relative(ROOT, manifestPath)} (gitignored)`);
    state.done.push("manifest");
    save();
  }

  // 06 is re-runnable: each run does what is not yet done. It is finished when a run
  // finds the staking incentive pool already registered.
  if (!state.done.includes("06 TGE")) {
    let tgeDone = false;
    for (let round = 1; round <= 3 && !tgeDone; round++) {
      console.log(`── 06 TGE (round ${round})`);
      const r = run("scripts/deploy/06_execute_tge.js");
      if (r.code !== 0) { save(); console.log(safeTail(r.out)); throw new Error(`06 round ${round} failed (exit ${r.code})`); }
      tgeDone = /already done\) incentive pool holds/.test(r.out);
    }
    if (!tgeDone) throw new Error("06 ran three times and the staking incentive pool is still not registered");
    state.done.push("06 TGE");
    save();
  }
  step("verify_tge", "scripts/ops/verify_tge.js", (r) => {
    if (!/TGE VERIFICATION PASSED/.test(r.out) || !/Launch float \(liquid rows\): 500000000\.0 SRX/.test(r.out)) {
      console.log(safeTail(r.out));
      throw new Error("verify_tge did not pass, or the launch float is not exactly 500,000,000 SRX");
    }
    console.log("  ✅ every balance and vault checked, and the 5% launch float");
  });
  step("08 guardian", "scripts/deploy/08_deploy_guardian.js");
  // Step 09 (ZkSyncMigrator) is retired by CH-13 and refuses to run.
  step("10 presale", "scripts/deploy/10_deploy_presale.js", (r) => {
    const pm = r.out.match(/PreSaleRound deployed:\s*(0x[0-9a-fA-F]{40})/);
    if (!pm) throw new Error("10 did not print the PreSaleRound address");
    setEnv(`PRESALE_ROUND_${NET}`, pm[1]);
  });

  // Public addresses for readers (the platform's SRX hub). Addresses only.
  const pick = (n) => env[`${n}_${NET}`] || null;
  const out = {
    network: net,
    chainId,
    deployedAt: state.deployedAt || new Date().toISOString(),
    fromBlock: state.fromBlock,
    deployer: deployer.address,
    // The source the contracts were built from (docs/ADDRESSES.md prints it).
    commit: spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim() || undefined,
    contracts: {
      SRXToken: pick("SRX_TOKEN"), TGEDistributor: pick("TGE_DISTRIBUTOR"),
      SRXTimelock: pick("TIMELOCK"), SRXGovernor: pick("GOVERNOR"),
      SRXStaking: pick("STAKING"), FeeController: pick("FEE_CONTROLLER"),
      SRXTreasury: pick("TREASURY"), StabilisationFund: pick("STABILISATION_FUND"),
      GuardianModule: pick("GUARDIAN_MODULE") || pick("GUARDIAN"), ZkSyncMigrator: pick("MIGRATOR"),
      PreSaleRound: pick("PRESALE_ROUND"),
    },
    vaults: Object.fromEntries(TGE_PLAN.filter((r) => r.kind === "vault").map((r) => [r.label, pick(r.vaultEnv)])),
    wallets: Object.fromEntries(TGE_PLAN.filter((r) => r.kind === "wallet").map((r) => [r.label, walletFor(r.wallet, net)])),
  };
  state.deployedAt = out.deployedAt;
  save();
  fs.writeFileSync(path.join(ROOT, "deployments", `${net}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n✅ ${net} suite deployed — deployments/${net}.json`);
  // The build that produced this deployment, pinned by sha256 (scripts/deploy/lib/build_record.js).
  try {
    const rec = await require("../deploy/lib/build_record").buildRecord(require("hardhat"), out.contracts);
    fs.writeFileSync(path.join(ROOT, "deployments", `${net}.builds.json`), JSON.stringify({ network: net, chainId, deploymentCommit: out.commit, ...rec }, null, 2) + "\n");
    console.log(`  build record: deployments/${net}.builds.json`);
  } catch (e) { console.warn(`  ⚠️  build record not written (${String(e.message).split("\n")[0]}); run scripts/ops/record_build.js`); }
  try { console.log(`  balance after: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`); } catch { /* the deploy is complete; only this read failed */ }
}

main().catch((e) => {
  const msg = String(e.message || e).split("\n")[0];
  console.error(`\n❌ ${/:\/\//.test(msg) ? "(error text withheld: it contains a URL)" : msg}`);
  process.exit(1);
});
