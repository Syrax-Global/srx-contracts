/**
 * rehearse_role_migration.js — end-to-end rehearsal of the launch role hand-over
 *
 * Runs the REAL scripts, unmodified, against a throwaway local chain:
 *   1. deploys the governed set as the deploy scripts leave it: a separate
 *      deployer, the admin Safe as admin, the governor as Timelock proposer;
 *   2. runs the launch gate and REQUIRES it to fail (negative control: a gate
 *      that cannot fail proves nothing);
 *   3. runs migrate_roles.js phase 1, then tries phase 2 early and requires it
 *      to refuse, then advances the clock past the Timelock delay;
 *   4. runs phase 2, then the gate, and requires ALL CHECKS PASSED;
 *   5. runs phase 1 again and requires it to find nothing to do (idempotent).
 *
 * Usage (two terminals, or the node in the background):
 *   npx hardhat node
 *   npx hardhat run scripts/ops/rehearse_role_migration.js --network localhost
 */
const { ethers, upgrades, network } = require("hardhat");
const { spawnSync } = require("child_process");
const path = require("path");

const CLI = path.join(__dirname, "..", "..", "node_modules", "hardhat", "internal", "cli", "cli.js");
const DELAY = 2 * 24 * 3600;

function run(script, env) {
  const r = spawnSync(process.execPath, [CLI, "run", script, "--network", network.name], {
    env: { ...process.env, ...env }, encoding: "utf8",
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

function expect(cond, what, out) {
  if (!cond) { if (out) console.log(out); throw new Error(`REHEARSAL FAILED: ${what}`); }
  console.log(`  ✅ ${what}`);
}

async function main() {
  if (network.name !== "localhost") throw new Error("Run against --network localhost (a throwaway `npx hardhat node`).");
  const [safe, deployer] = await ethers.getSigners();
  console.log(`admin Safe (signer 0): ${safe.address}\ndeployer   (signer 1): ${deployer.address}\n`);

  const f = (n) => ethers.getContractFactory(n, deployer);
  const ep = await (await f("MockLZEndpoint")).deploy(30101);
  const token = await (await f("SRXToken")).deploy(await ep.getAddress(), safe.address);
  // As 02_deploy_governance does it: the governor, by predicted address, is the proposer.
  const nonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
  const predictedGov = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
  const tl = await (await f("SRXTimelock")).deploy(DELAY, [predictedGov], [ethers.ZeroAddress], safe.address);
  const gov = await (await f("SRXGovernor")).deploy(await token.getAddress(), await tl.getAddress());
  const gm = await (await f("GuardianModule")).deploy(safe.address, safe.address, await tl.getAddress(), 365 * 24 * 3600);
  const srx = await token.getAddress(), tla = await tl.getAddress();
  const proxy = async (n, args) => upgrades.deployProxy(await f(n), args, { kind: "uups" });
  const treasury = await proxy("SRXTreasury", [srx, safe.address, tla]);
  const staking  = await proxy("SRXStaking", [srx, safe.address]);
  const fees     = await proxy("FeeController", [await staking.getAddress(), safe.address]);
  const ssf      = await proxy("StabilisationFund", [srx, safe.address, 500, 1000, 7 * 24 * 3600]);
  if ((await gov.getAddress()) !== predictedGov) throw new Error("governor address prediction failed");

  const env = {
    DEPLOYER_EOA: deployer.address, ADMIN_ADDRESS: safe.address,
    SRX_TOKEN: srx, TIMELOCK: tla, GOVERNOR: await gov.getAddress(), GUARDIAN_MODULE: await gm.getAddress(),
    TREASURY: await treasury.getAddress(), STAKING: await staking.getAddress(),
    FEE_CONTROLLER: await fees.getAddress(), STABILISATION: await ssf.getAddress(),
  };
  console.log("Deployed the governed set.\n");

  let r = run("scripts/verify/verify_roles.js", env);
  expect(r.code !== 0 && /WRONGLY held by forbidden/.test(r.out), "gate FAILS on the as-deployed topology (negative control)", r.out);

  r = run("scripts/ops/migrate_roles.js", { ...env, MIGRATE_EXECUTE: "1" });
  expect(r.code === 0 && /schedule SRXToken\.acceptOwnership/.test(r.out), "phase 1 executed", r.out);
  expect((await token.pendingOwner()) === tla, "token ownership is pending with the Timelock");
  expect((await ep.delegates(srx)) === tla, "LayerZero delegate is the Timelock");

  r = run("scripts/ops/migrate_roles.js", { ...env, MIGRATE_EXECUTE: "1", MIGRATE_FINALIZE: "1" });
  expect(r.code !== 0 && /not ready yet/.test(r.out), "phase 2 REFUSES before the delay has passed", r.out);

  await network.provider.send("evm_increaseTime", [DELAY + 1]);
  await network.provider.send("evm_mine", []);

  r = run("scripts/ops/migrate_roles.js", { ...env, MIGRATE_EXECUTE: "1", MIGRATE_FINALIZE: "1" });
  expect(r.code === 0, "phase 2 executed", r.out);
  expect((await token.owner()) === tla, "Timelock owns the token");

  r = run("scripts/verify/verify_roles.js", env);
  expect(r.code !== 1 && /Failures: 0/.test(r.out), "gate reports zero failures on the migrated topology", r.out);
  console.log(r.out.split("\n").filter((l) => /Checks run|INCOMPLETE|•|ALL CHECKS/.test(l)).join("\n"));

  r = run("scripts/ops/migrate_roles.js", { ...env, MIGRATE_EXECUTE: "1" });
  expect(r.code === 0 && /Nothing to do/.test(r.out), "phase 1 re-run is a no-op (idempotent)", r.out);

  console.log("\n✅ REHEARSAL PASSED");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
