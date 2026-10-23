// C5 (review E, 22 Oct 2026): the Genesis vault batch was too big for one Ethereum transaction.
//
// 06b queues batchDeployVaults + batchTriggerTGE for GENESIS_VAULT_CHUNK buyers (default 20) in ONE Safe
// transaction. Each buyer costs about 961,000 gas (a VestingVault creation, its funding and declaration,
// and the trigger); Ethereum caps a transaction at 16,777,216 gas. Twenty buyers is about 19M: the batch
// could never be mined. These tests measure the real cost against the contracts and check the guard.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const {
  TX_GAS_CAP, CHUNK_GAS_LIMIT, PER_BUYER_GAS, DEFAULT_CHUNK,
  modelChunkGas, estimateChunkGas, assertChunkWithinLimit, maxChunk, chunkFromEnv,
} = require("../../scripts/deploy/lib/genesis_chunk");

const ROOT = path.join(__dirname, "..", "..");
const src = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const E = (n) => ethers.parseUnits(String(n), 18);
const USD8 = (n) => BigInt(n) * 10n ** 8n;

async function roundWith(buyers) {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const treasury = signers[1];
  const srx = await (await ethers.getContractFactory("MockERC20")).deploy("SRX", "SRX", 18);
  const Feed = await ethers.getContractFactory("MockChainlinkFeed");
  const round = await (await ethers.getContractFactory("PreSaleRound")).deploy(
    await srx.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
    await (await Feed.deploy(2_500n * 10n ** 8n)).getAddress(), await (await Feed.deploy(60_000n * 10n ** 8n)).getAddress(),
    admin.address, E(300_000_000), 1_250_000n, true, 5_000n, treasury.address);
  const people = Array.from({ length: buyers }, () => ethers.Wallet.createRandom().address);
  await round.connect(admin).setBuyerApprovals(people, people.map(() => USD8(100_000)), people.map((_, i) => ethers.id(`agreement ${i}`)));
  for (const p of people) await round.connect(admin).addInvestor(p, USD8(10_000));
  await srx.mint(await round.getAddress(), await round.pendingDeployment());
  return { admin, round, srx, people };
}

describe("C5: the Genesis vault batch fits in one Ethereum transaction", function () {
  this.timeout(300_000);

  it("the gate's model is not optimistic: measured gas per buyer (deploy + trigger) is within PER_BUYER_GAS", async function () {
    // Coverage instrumentation adds gas to every statement, so real gas cannot be measured there.
    if (require("hardhat").__SOLIDITY_COVERAGE_RUNNING) this.skip(); // set by solidity-coverage
    const n = 12;
    const { admin, round } = await roundWith(n);
    const d = await (await round.connect(admin).batchDeployVaults(0, n)).wait();
    const t = await (await round.connect(admin).batchTriggerTGE(0, n)).wait();
    const perBuyer = (d.gasUsed + t.gasUsed) / BigInt(n);
    console.log(`      measured: ${perBuyer} gas per buyer (model ${PER_BUYER_GAS}); 12 buyers = ${d.gasUsed + t.gasUsed}`);
    expect(perBuyer, "the model underestimates the real cost").to.be.lessThanOrEqual(PER_BUYER_GAS);
    expect(perBuyer, "the model is more than 20% too high, so the measurement is stale").to.be.greaterThan(PER_BUYER_GAS * 8n / 10n);
  });

  it("20 buyers (the old default) is over the per-transaction cap; 12 (the new default) is well under it", function () {
    expect(PER_BUYER_GAS * 20n).to.be.greaterThan(TX_GAS_CAP);
    expect(modelChunkGas(12)).to.be.lessThan(CHUNK_GAS_LIMIT);
    expect(modelChunkGas(12)).to.be.lessThan(TX_GAS_CAP);
    expect(DEFAULT_CHUNK).to.equal(12);
    expect(chunkFromEnv({})).to.equal(12);
    expect(chunkFromEnv({ GENESIS_VAULT_CHUNK: "" })).to.equal(12);
    expect(chunkFromEnv({ GENESIS_VAULT_CHUNK: "5" })).to.equal(5);
    for (const bad of ["0", "-1", "1.5", "many"]) expect(() => chunkFromEnv({ GENESIS_VAULT_CHUNK: bad }), bad).to.throw(/whole number of at least 1/);
  });

  it("refuses a chunk estimated above 15,000,000 gas, and names the largest chunk allowed", function () {
    expect(() => assertChunkWithinLimit({ chunk: 12, gas: modelChunkGas(12) })).to.not.throw();
    expect(() => assertChunkWithinLimit({ chunk: 20, gas: modelChunkGas(20) })).to.throw(/chunk of 20 Genesis buyers .* above the 15000000/);
    expect(() => assertChunkWithinLimit({ chunk: 20, gas: modelChunkGas(20) })).to.throw(new RegExp(`GENESIS_VAULT_CHUNK to ${maxChunk()} or fewer`));
    expect(maxChunk()).to.be.within(12, 14);
    expect(modelChunkGas(maxChunk())).to.be.lessThanOrEqual(CHUNK_GAS_LIMIT);
    expect(modelChunkGas(maxChunk() + 1)).to.be.greaterThan(CHUNK_GAS_LIMIT);
  });

  it("estimateChunkGas asks the node for the deploy call from the Safe, and plans for at least the model", async function () {
    const n = 4;
    const { admin, round } = await roundWith(n);
    const est = await estimateChunkGas({ round, from: admin.address, start: 0, end: n });
    expect(est.buyers).to.equal(n);
    expect(est.node, "the node's estimate was not used").to.be.greaterThan(0n);
    expect(est.gas).to.equal(est.node > est.model ? est.node : est.model);
    // and what the chunk then actually used is within the plan
    const d = await (await round.connect(admin).batchDeployVaults(0, n)).wait();
    const t = await (await round.connect(admin).batchTriggerTGE(0, n)).wait();
    expect(d.gasUsed + t.gasUsed).to.be.lessThanOrEqual(est.gas);
  });

  it("estimateChunkGas falls back to the model when the node will not estimate, and says why", async function () {
    const { round } = await roundWith(1);
    const refusing = { estimateGas: async () => { throw new Error("estimate refused"); } };
    const est = await estimateChunkGas({ round, provider: refusing, from: ethers.ZeroAddress, start: 0, end: 12 });
    expect(est.node).to.equal(0n);
    expect(est.nodeError).to.equal("estimate refused");
    expect(est.gas).to.equal(modelChunkGas(12));
  });

  it("06b_genesis_vaults.js uses the guard, and no longer defaults to 20; the text no longer says batches of 20-50", function () {
    const s = src("scripts/deploy/06b_genesis_vaults.js");
    expect(s).to.match(/chunkFromEnv\(\)/);
    expect(s).to.match(/assertChunkWithinLimit\(/);
    expect(s).to.match(/estimateChunkGas\(/);
    expect(s).to.not.match(/GENESIS_VAULT_CHUNK \|\| 20/);
    // the guard runs BEFORE the chunk is queued
    expect(s.indexOf("assertChunkWithinLimit(")).to.be.lessThan(s.indexOf('batch.send(round, "batchDeployVaults"'));
    expect(src("scripts/deploy/10_deploy_presale.js")).to.not.match(/batches of 20-50/);
    expect(src("TGE_DEPLOYMENT_RUNBOOK.md")).to.not.match(/per 20 buyers/);
  });
});
