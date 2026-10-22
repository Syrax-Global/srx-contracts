/**
 * recover_deploy_state.js — rebuild a test-network deploy's progress file from the
 * chain, when the run that made it stopped before writing it.
 *
 *   FROM_BLOCK=<block before the run> npx hardhat run scripts/ops/recover_deploy_state.js --network sepolia
 *
 * READ-ONLY. It sends nothing. It starts from deploy/addresses.<network>.json (the
 * TGE manifest the run wrote before step 06: every vault, wallet and contract that
 * received tokens), then finds the rest by asking the chain:
 *   - the token        — what every vault pays out (vault.token());
 *   - the distributor  — where genesis minted the supply (Transfer from address 0);
 *   - the governor     — a contract the deployer created in this run whose token() is SRX;
 *   - the timelock     — governor.timelock();
 *   - the fee controller — a contract created in this run whose stakingContract() is the staking proxy.
 * It then writes deployments/<network>.state.json with steps 01–06 marked done, which
 * scripts/ops/deploy_testnet_suite.js resumes from.
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { TGE_PLAN } = require("../deploy/00_config");

const ROOT = path.join(__dirname, "..", "..");

async function tryCall(address, abi, fn, args = []) {
  try { return await new ethers.Contract(address, abi, ethers.provider)[fn](...args); } catch { return null; }
}

async function main() {
  const net = network.name;
  const NET = net.toUpperCase();
  const fromBlock = Number(process.env.FROM_BLOCK);
  if (!Number.isInteger(fromBlock) || fromBlock <= 0) throw new Error("set FROM_BLOCK to a block before the run began");
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "deploy", `addresses.${net}.json`), "utf8"));
  const dest = (label) => ethers.getAddress(manifest.tgeAllocations[label].destination);

  const env = {};
  for (const row of TGE_PLAN.filter((r) => r.kind === "vault")) env[`${row.vaultEnv}_${NET}`] = dest(row.label);
  env[`STAKING_${NET}`] = dest("Staking");
  env[`TREASURY_${NET}`] = dest("Treasury");
  env[`STABILISATION_FUND_${NET}`] = dest("StabilisationFund");

  const token = ethers.getAddress(await tryCall(env[`VESTING_FOUNDERS_${NET}`], ["function token() view returns (address)"], "token"));
  env[`SRX_TOKEN_${NET}`] = token;

  const zeroTopic = ethers.zeroPadValue(ethers.ZeroAddress, 32);
  const mints = await ethers.provider.getLogs({
    address: token, fromBlock, toBlock: "latest",
    topics: [ethers.id("Transfer(address,address,uint256)"), zeroTopic],
  });
  if (mints.length !== 1) throw new Error(`expected one genesis mint, found ${mints.length}`);
  env[`TGE_DISTRIBUTOR_${NET}`] = ethers.getAddress(ethers.dataSlice(mints[0].topics[2], 12));

  // Contracts the deployer created during this run.
  const nonceStart = await ethers.provider.getTransactionCount(deployer.address, fromBlock);
  const nonceEnd = await ethers.provider.getTransactionCount(deployer.address, "latest");
  const created = [];
  for (let n = nonceStart; n < nonceEnd; n++) {
    const a = ethers.getCreateAddress({ from: deployer.address, nonce: n });
    if ((await ethers.provider.getCode(a)) !== "0x") created.push(a);
  }
  const staking = env[`STAKING_${NET}`];
  for (const a of created) {
    const t = await tryCall(a, ["function token() view returns (address)"], "token");
    const vp = await tryCall(a, ["function votingPeriod() view returns (uint256)"], "votingPeriod");
    if (t && vp !== null && ethers.getAddress(t) === token) {
      env[`GOVERNOR_${NET}`] = a;
      env[`TIMELOCK_${NET}`] = ethers.getAddress(await tryCall(a, ["function timelock() view returns (address)"], "timelock"));
    }
    const sc = await tryCall(a, ["function stakingContract() view returns (address)"], "stakingContract");
    if (sc && ethers.getAddress(sc) === staking) env[`FEE_CONTROLLER_${NET}`] = a;
  }
  for (const k of ["GOVERNOR", "TIMELOCK", "FEE_CONTROLLER"]) {
    if (!env[`${k}_${NET}`]) throw new Error(`could not identify ${k} among ${created.length} contracts created since block ${fromBlock}`);
  }

  const state = {
    network: net, chainId, deployer: deployer.address, fromBlock,
    recoveredAt: new Date().toISOString(),
    done: ["01 token", "02 governance", "03 vesting + distributor", "04 staking", "05 treasury",
      "05b stabilisation fund", "manifest", "06 TGE"],
    env,
  };
  const out = path.join(ROOT, "deployments", `${net}.state.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(state, null, 2) + "\n");
  console.log(`scanned nonces ${nonceStart}–${nonceEnd - 1} (${created.length} contracts); wrote deployments/${net}.state.json`);
  for (const [k, v] of Object.entries(env)) console.log(`  ${k}=${v}`);
}

main().catch((e) => {
  const msg = String(e.message || e).split("\n")[0];
  console.error(`❌ ${/:\/\//.test(msg) ? "(error text withheld: it contains a URL)" : msg}`);
  process.exit(1);
});
