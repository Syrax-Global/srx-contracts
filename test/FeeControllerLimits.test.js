// R7-03 regression — the fee floor must never exceed the lowest achievable base fee.
//
// minFeeBps clamps UPWARD. If it ever exceeds the base fee, every tier — including
// undiscounted Tier.None — pays minFeeBps, the tier discounts collapse to one identical
// fee, and a "discount" becomes a fee INCREASE. The crypto base is the lowest base
// (crypto multiplier <= 100%), so that is the binding constraint.
//
// Defaults at init: base 150, cryptoMult 7500 → lowest base = 112 bps; min 15, max 500.
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("FeeController — fee-limit invariant (R7-03)", function () {
  async function fx() {
    const [admin, staking, other] = await ethers.getSigners();
    const FeeController = await ethers.getContractFactory("FeeController");
    const fee = await upgrades.deployProxy(
      FeeController, [staking.address, admin.address], { kind: "uups" }
    );
    await fee.waitForDeployment();
    return { fee, admin, other };
  }

  it("initialises with the invariant satisfied (min 15 <= lowest base 112)", async function () {
    const { fee } = await loadFixture(fx);
    expect(await fee.minFeeBps()).to.equal(15n);
    const lowest = (await fee.baseFeeRateBps()) * (await fee.cryptoFeeMultiplierBps()) / 10_000n;
    expect(await fee.minFeeBps()).to.be.lessThanOrEqual(lowest);
  });

  it("REGRESSION: rejects a floor above the lowest base fee", async function () {
    const { fee, admin } = await loadFixture(fx);
    // 200 > 112 (crypto base) — would clamp every tier upward.
    await expect(fee.connect(admin).setFeeLimits(200, 500))
      .to.be.revertedWithCustomError(fee, "InvalidBps");
  });

  it("accepts a floor at or below the lowest base fee", async function () {
    const { fee, admin } = await loadFixture(fx);
    await fee.connect(admin).setFeeLimits(100, 500);
    expect(await fee.minFeeBps()).to.equal(100n);
  });

  it("REGRESSION: rejects a base rate cut that would fall under the floor", async function () {
    const { fee, admin } = await loadFixture(fx);
    // base 10 → crypto base 7 < min 15.
    await expect(fee.connect(admin).setBaseFeeRate(10))
      .to.be.revertedWithCustomError(fee, "InvalidBps");
  });

  it("REGRESSION: rejects a crypto multiplier cut that would fall under the floor", async function () {
    const { fee, admin } = await loadFixture(fx);
    // 150 * 500/10000 = 7 < min 15.
    await expect(fee.connect(admin).setCryptoFeeMultiplier(500))
      .to.be.revertedWithCustomError(fee, "InvalidBps");
  });

  it("legitimate governance changes still work (no false positives)", async function () {
    const { fee, admin } = await loadFixture(fx);
    await fee.connect(admin).setBaseFeeRate(300);          // raise base
    expect(await fee.baseFeeRateBps()).to.equal(300n);
    await fee.connect(admin).setFeeLimits(200, 500);       // now 200 <= 225 lowest base
    expect(await fee.minFeeBps()).to.equal(200n);
    await fee.connect(admin).setCryptoFeeMultiplier(9_000);
    expect(await fee.cryptoFeeMultiplierBps()).to.equal(9_000n);
  });

  it("raise-both ordering: base first, then floor", async function () {
    const { fee, admin } = await loadFixture(fx);
    // Floor-first fails...
    await expect(fee.connect(admin).setFeeLimits(400, 500))
      .to.be.revertedWithCustomError(fee, "InvalidBps");
    // ...base-first succeeds.
    await fee.connect(admin).setBaseFeeRate(500);          // lowest base = 375
    await fee.connect(admin).setFeeLimits(300, 500);
    expect(await fee.minFeeBps()).to.equal(300n);
  });
});
