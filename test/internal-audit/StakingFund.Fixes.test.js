// Internal audit 16 Oct 2026: regression tests for the SRXStaking and StabilisationFund fixes.
// Each asserts the corrected behaviour, so it fails on the code the review was run against.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { allocationSource } = require("../helpers/allocationSource");

const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;
const Tier = { None: 0n, Slate: 1n, Onyx: 2n, Obsidian: 3n };

async function token() {
  const [admin] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
  await srx.connect(admin).genesis(admin.address);
  return srx;
}

async function stakingSuite() {
  const [admin, alice, bob, stranger] = await ethers.getSigners();
  const srx = await token();
  const staking = await (await ethers.getContractFactory("SRXStaking"))
    .deploy(await srx.getAddress(), admin.address, await allocationSource(srx));
  await srx.connect(admin).transfer(await staking.getAddress(), E(20_000_000));
  await staking.connect(admin).notifyRewardAmount(E(10_000_000));
  await staking.connect(admin).setRewardRate(E("0.25"));
  for (const u of [alice, bob]) {
    await srx.connect(admin).transfer(u.address, E(3_000_000));
    await srx.connect(u).approve(await staking.getAddress(), ethers.MaxUint256);
  }
  return { admin, alice, bob, stranger, srx, staking };
}

async function fundSuite() {
  const [admin, timelock, safe, alice, bob, stranger] = await ethers.getSigners();
  const srx = await token();
  const Fund = await ethers.getContractFactory("StabilisationFund");
  const fund = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000),
    await allocationSource(srx, E(1_500_000_000)));
  await fund.connect(admin).grantRole(await fund.GOVERNANCE_ROLE(), timelock.address);
  await fund.connect(admin).grantRole(await fund.WIND_DOWN_ROLE(), safe.address);
  await srx.connect(admin).transfer(await fund.getAddress(), E(20_000_000));
  for (const u of [alice, bob]) {
    await srx.connect(admin).transfer(u.address, E(2_000_000));
    await srx.connect(u).approve(await fund.getAddress(), ethers.MaxUint256);
  }
  return { admin, timelock, safe, alice, bob, stranger, srx, fund, Fund };
}

describe("Internal audit M1: a successor's reward backing cannot be pinned at 0", function () {
  it("fund: a stranger's early sync no longer matters; the release backs the successor's rewards", async function () {
    const { srx, fund, Fund, admin, timelock, safe, alice, bob, stranger } = await fundSuite();
    await fund.connect(alice).contribute(E(5_000));
    await fund.connect(timelock).notifyRewardAmount(E(1_000_000));
    await fund.connect(safe).startWindDown();
    const releasable = await fund.releasableRewardAllocation();
    const v2 = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), await fund.getAddress());
    await v2.connect(stranger).syncAllocation();                       // the griefing sync
    expect(await v2.rewardBacking()).to.equal(0n);
    await fund.connect(timelock).releaseRewardAllocation(await v2.getAddress(), releasable);
    await srx.connect(bob).approve(await v2.getAddress(), ethers.MaxUint256);
    await v2.connect(bob).contribute(E(1_000));
    await v2.connect(admin).notifyRewardAmount(releasable);            // registrable after all
    expect(await v2.rewardBacking()).to.equal(releasable);
    // ...and none of it is free SRX for the successor's governance to deploy.
    await expect(v2.connect(admin).deployLiquidity(stranger.address, await srx.getAddress(), 1n, "take it"))
      .to.be.revertedWithCustomError(v2, "InsufficientFreeBalance");
  });

  it("staking: a stranger's early sync no longer matters", async function () {
    const { admin, alice, srx, staking } = await stakingSuite();
    const [, , , stranger] = await ethers.getSigners();
    await staking.connect(alice).lock(E(1_000), 7 * DAY);
    await staking.connect(admin).startWindDown();
    const releasable = await staking.releasableRewardAllocation();
    const v2 = await (await ethers.getContractFactory("SRXStaking"))
      .deploy(await srx.getAddress(), admin.address, await staking.getAddress());
    await v2.connect(stranger).syncAllocation();
    await staking.connect(admin).releaseRewardAllocation(await v2.getAddress(), releasable);
    await v2.connect(admin).notifyRewardAmount(releasable);
    expect(await v2.rewardBacking()).to.equal(releasable);
  });
});

describe("Internal audit M5 and M6: new SRX in a position serves a full term", function () {
  it("M5: a top-up a day before a 180-day lock ends re-commits for 180 days", async function () {
    const { alice, staking } = await stakingSuite();
    await staking.connect(alice).lock(E(100), 180 * DAY);
    await time.increase(179 * DAY);
    await staking.connect(alice).addToPosition(E(500_000), 0);
    const p = await staking.positions(alice.address);
    expect(p.lockEnd).to.equal(BigInt(await time.latest()) + BigInt(180 * DAY));
    await time.increase(2 * DAY);
    await expect(staking.connect(alice).unlock()).to.be.revertedWithCustomError(staking, "LockNotExpired");
  });

  it("M6: SRX added to an expired lock is locked again before it counts for the fee tier", async function () {
    const { alice, staking } = await stakingSuite();
    await staking.connect(alice).lock(E(100), 7 * DAY);
    await time.increase(8 * DAY);
    await staking.connect(alice).addToPosition(E(1_000_000), 0);
    expect(await staking.getTier(alice.address)).to.equal(Tier.Obsidian);
    // ...but it cannot leave in the next transaction to serve a second address.
    await expect(staking.connect(alice).unlock()).to.be.revertedWithCustomError(staking, "LockNotExpired");
  });
});

describe("Internal audit L1: no function sends the reward pool to a wallet", function () {
  it("staking and the fund have no rescueStrandedPool; release to a wallet is refused", async function () {
    const { admin, staking } = await stakingSuite();
    const { fund, timelock, safe } = await fundSuite();
    for (const c of [staking, fund]) {
      expect(c.interface.fragments.filter((f) => f.name === "rescueStrandedPool")).to.have.length(0);
    }
    await staking.connect(admin).startWindDown();
    await fund.connect(safe).startWindDown();
    await expect(staking.connect(admin).releaseRewardAllocation(admin.address, 1n))
      .to.be.revertedWithCustomError(staking, "NotASuccessor");
    await expect(fund.connect(timelock).releaseRewardAllocation(timelock.address, 1n))
      .to.be.revertedWithCustomError(fund, "NotASuccessor");
  });
});

describe("Internal audit L2: a one-block break does not restart the 30-day wind-down clock", function () {
  it("staking: unpause and re-pause at day 29; a stranger may wind down at day 30", async function () {
    const { admin, stranger, staking } = await stakingSuite();
    await staking.connect(admin).pause();
    await time.increase(29 * DAY);
    await staking.connect(admin).unpause();
    await staking.connect(admin).pause();
    await time.increase(DAY);
    await expect(staking.connect(stranger).startWindDown()).to.emit(staking, "WindDownStarted");
  });

  it("fund: the same", async function () {
    const { admin, stranger, fund } = await fundSuite();
    await fund.connect(admin).pause();
    await time.increase(29 * DAY);
    await fund.connect(admin).unpause();
    await fund.connect(admin).pause();
    await time.increase(DAY);
    await expect(fund.connect(stranger).startWindDown()).to.emit(fund, "WindDownStarted");
  });
});

describe("Internal audit L3: the fund's withdrawal lock is bounded and never retroactive", function () {
  it("a later lock change does not reach an existing deposit; above 90 days is refused", async function () {
    const { timelock, alice, fund } = await fundSuite();
    await fund.connect(alice).contribute(E(5_000));
    await fund.connect(timelock).setWithdrawLockDuration(90 * DAY);
    await expect(fund.connect(timelock).setWithdrawLockDuration(91 * DAY))
      .to.be.revertedWithCustomError(fund, "InvalidDuration");
    await time.increase(31 * DAY);
    await fund.connect(alice).withdrawContribution(E(5_000));        // under its own 30-day lock
  });
});

describe("Internal audit L4: the fund has a minimum total for emission", function () {
  it("below the minimum, a lone position accrues nothing", async function () {
    const { timelock, alice, fund } = await fundSuite();
    await fund.connect(alice).contribute(E(100));
    await fund.connect(timelock).notifyRewardAmount(E(1_000_000));
    await fund.connect(timelock).setMinTotalForEmission(E(1_000_000));
    await fund.connect(timelock).setRewardRate(E(1));
    await time.increase(DAY);
    expect(await fund.earned(alice.address)).to.equal(0n);
  });
});

describe("Internal audit L11: earlyWithdraw keeps rewards pending while paused", function () {
  it("the principal leaves; the rewards wait for the pause to end", async function () {
    const { admin, alice, srx, staking } = await stakingSuite();
    await staking.connect(alice).lock(E(100_000), 30 * DAY);
    await time.increase(DAY);
    await staking.connect(admin).pause();
    const before = await srx.balanceOf(alice.address);
    await staking.connect(alice).earlyWithdraw();
    expect((await srx.balanceOf(alice.address)) - before).to.equal(E(90_000)); // principal less 10%
    const owed = await staking.pendingRewards(alice.address);
    expect(owed).to.be.gt(0n);
    await staking.connect(admin).unpause();
    await staking.connect(alice).claimRewards();
    expect(await staking.pendingRewards(alice.address)).to.equal(0n);
  });
});

describe("Internal audit L12: tier parameters cannot give everyone a discount", function () {
  it("Slate at 0, and a lower tier above a higher one's discount, are refused", async function () {
    const { admin, staking } = await stakingSuite();
    await expect(staking.connect(admin).updateTierParams(Tier.Slate, 0, 2_500))
      .to.be.revertedWithCustomError(staking, "InvalidBps");
    await expect(staking.connect(admin).updateTierParams(Tier.Slate, E(50_000), 7_000))
      .to.be.revertedWithCustomError(staking, "InvalidBps");
  });
});

describe("Internal audit L13: after wind-down a position counts only its principal for the tier", function () {
  it("500k on a 180-day lock is Obsidian before the switch and Onyx after it", async function () {
    const { admin, alice, staking } = await stakingSuite();
    await staking.connect(alice).lock(E(500_000), 180 * DAY);
    expect(await staking.getTier(alice.address)).to.equal(Tier.Obsidian);
    await staking.connect(admin).startWindDown();
    expect(await staking.getTier(alice.address)).to.equal(Tier.Onyx);
  });
});
