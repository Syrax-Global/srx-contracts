// REG-54 (Jared, 12 Oct 2026): FeeController's 0.15% floor and 5% ceiling are constants.
//
// ⛔ WHY. setFeeLimits() let governance move the floor down to 0 and the ceiling up to
//    100% (Security's whitepaper review, bus 20261012T1624Z), which contradicted the
//    whitepaper's "a discount never takes a fee below 0.15%". Built to the claim (REG-36):
//    governance still sets the base rate and the crypto multiplier, but only between the
//    two limits, and NO role can move either limit.
//
// Proof, three ways: (1) no state-changing function exists beyond a pinned list, none of
// which writes a limit; (2) the limits have no storage slot, so nothing can write them;
// (3) whatever governance sets, every charged fee stays inside [15, 500] bps.
const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { allocationSource } = require("./helpers/allocationSource");

const PaymentType = { Fiat: 0, Crypto: 1, SRX: 2 };
const E = (n) => ethers.parseUnits(String(n), 18);

async function fx() {
  const [admin, slate, onyx, obsidian, stranger] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
  await token.connect(admin).genesis(admin.address);
  const staking = await (await ethers.getContractFactory("SRXStaking"))
    .deploy(await token.getAddress(), admin.address, await allocationSource(token));
  const fee = await (await ethers.getContractFactory("FeeController")).deploy(await staking.getAddress(), admin.address);
  for (const [u, amt] of [[slate, E(50_000)], [onyx, E(250_000)], [obsidian, E(1_000_000)]]) {
    await token.connect(admin).transfer(u.address, amt);
    await token.connect(u).approve(await staking.getAddress(), amt);
    await staking.connect(u).lock(amt, 7 * 86400);
  }
  return { admin, fee, payers: [stranger, slate, onyx, obsidian] };
}

describe("REG-54: the fee floor and ceiling are fixed in code", function () {
  it("the floor is 0.15% and the ceiling 5%, as constants, with the old getters kept", async function () {
    const { fee } = await loadFixture(fx);
    expect(await fee.MIN_FEE_BPS()).to.equal(15n);
    expect(await fee.MAX_FEE_BPS()).to.equal(500n);
    expect(await fee.minFeeBps()).to.equal(15n);
    expect(await fee.maxFeeBps()).to.equal(500n);
  });

  it("the only state-changing functions are the pinned list; none can write a limit", async function () {
    const { fee } = await loadFixture(fx);
    const writers = fee.interface.fragments
      .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f) => f.name).sort();
    // ⛔ Adding a function here means saying why it cannot move MIN_FEE_BPS or MAX_FEE_BPS.
    expect(writers).to.deep.equal([
      "commitFeeDistribution", "grantRole", "pause", "renounceRole", "revokeRole",
      "setBaseFeeRate", "setCryptoFeeMultiplier", "setFeeDestination", "setFeeDestinationActive",
      "setStakingContract", "unpause",
    ]);
    expect(fee.interface.getFunction("setFeeLimits")).to.equal(null);
  });

  it("the limits have no storage slot, so no call can ever write them", async function () {
    const info = await artifacts.getBuildInfo("contracts/staking/FeeController.sol:FeeController");
    const layout = info.output.contracts["contracts/staking/FeeController.sol"].FeeController.storageLayout.storage;
    const labels = layout.map((s) => s.label);
    expect(labels).to.include("baseFeeRateBps"); // the layout is really being read
    expect(labels.filter((l) => /min.?fee|max.?fee|fee.?limit/i.test(l))).to.deep.equal([]);
  });

  it("whatever governance sets, every non-SRX fee stays within [0.15%, 5%] for every tier", async function () {
    const { fee, admin, payers } = await loadFixture(fx);
    const seen = new Set();
    for (const base of [20n, 150n, 500n]) {
      for (const mult of [7_500n, 10_000n]) {
        // Set multiplier first when lowering the base would otherwise cross the floor.
        await fee.connect(admin).setCryptoFeeMultiplier(10_000n);
        await fee.connect(admin).setBaseFeeRate(base);
        await fee.connect(admin).setCryptoFeeMultiplier(mult);
        for (const p of payers) {
          for (const t of [PaymentType.Fiat, PaymentType.Crypto]) {
            const bps = await fee.calculateFee(p.address, t);
            expect(bps).to.be.gte(15n).and.lte(500n);
            seen.add(bps);
          }
          expect(await fee.calculateFee(p.address, PaymentType.SRX)).to.equal(0n);
        }
      }
    }
    expect(seen.has(15n), "the floor was actually reached (Obsidian)").to.equal(true);
    expect(seen.has(500n), "the ceiling was actually reached (base 500, no discount)").to.equal(true);
  });

  it("governance cannot push the base rate or the crypto base past either limit", async function () {
    const { fee, admin } = await loadFixture(fx);
    await expect(fee.connect(admin).setBaseFeeRate(501n)).to.be.revertedWithCustomError(fee, "InvalidBps");
    await expect(fee.connect(admin).setBaseFeeRate(19n)).to.be.revertedWithCustomError(fee, "InvalidBps"); // crypto base 14 < 15
    await expect(fee.connect(admin).setCryptoFeeMultiplier(999n)).to.be.revertedWithCustomError(fee, "InvalidBps"); // 150*999/1e4 = 14
    // Controls: the exact boundaries are accepted.
    await fee.connect(admin).setBaseFeeRate(500n);
    await fee.connect(admin).setBaseFeeRate(20n); // crypto base 15
    expect(await fee.baseFeeRateBps()).to.equal(20n);
  });
});
