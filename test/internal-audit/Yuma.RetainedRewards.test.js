// Yuma's differential case (external report; Security work order A3, 22 Oct 2026), pinned as a
// regression test. Rewards are owed (retained pending) while nobody is staked any more; the
// only way reward SRX can leave (a release to a successor after wind-down; the stranded-pool
// rescue is gone, internal audit L1) must leave that liability backed, and an exited staker
// claims the retained amount without staking again. Reached naturally: no storage writes.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { allocationSource } = require("../helpers/allocationSource");

const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;

async function token() {
  const [admin] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
  await srx.connect(admin).genesis(admin.address);
  return srx;
}

describe("Yuma: retained rewards with no stakers stay backed and claimable", function () {
  it("staking: after wind-down and every exit, a full release leaves what is owed; each staker claims it", async function () {
    const [admin, alice, bob] = await ethers.getSigners();
    const srx = await token();
    const staking = await (await ethers.getContractFactory("SRXStaking"))
      .deploy(await srx.getAddress(), admin.address, await allocationSource(srx));
    await srx.connect(admin).transfer(await staking.getAddress(), E(10_000_000));
    await staking.connect(admin).notifyRewardAmount(E(1_000_000));
    await staking.connect(admin).setRewardRate(E(1));
    for (const u of [alice, bob]) {
      await srx.connect(admin).transfer(u.address, E(10_000));
      await srx.connect(u).approve(await staking.getAddress(), ethers.MaxUint256);
      await staking.connect(u).lock(E(10_000), 30 * DAY);
    }
    await time.increase(5 * DAY);
    await staking.connect(admin).startWindDown();
    await staking.connect(alice).exitAfterWindDown();
    await staking.connect(bob).exitAfterWindDown();
    expect(await staking.totalWeightedStake()).to.equal(0n);           // nobody staked
    const owedA = await staking.pendingRewards(alice.address);
    const owedB = await staking.pendingRewards(bob.address);
    expect(owedA).to.be.gt(0n);

    const v2 = await (await ethers.getContractFactory("SRXStaking"))
      .deploy(await srx.getAddress(), admin.address, await staking.getAddress());
    const releasable = await staking.releasableRewardAllocation();
    await expect(staking.connect(admin).releaseRewardAllocation(await v2.getAddress(), releasable + 1n))
      .to.be.revertedWithCustomError(staking, "ReleaseExceedsUnusedAllocation");
    await staking.connect(admin).releaseRewardAllocation(await v2.getAddress(), releasable);
    // The liability is still backed after the release...
    expect(await srx.balanceOf(await staking.getAddress())).to.be.gte(await staking.totalPendingRewards());
    // ...and each exited staker claims exactly what was retained, without staking again.
    for (const [u, owed] of [[alice, owedA], [bob, owedB]]) {
      const before = await srx.balanceOf(u.address);
      await staking.connect(u).claimRewards();
      expect((await srx.balanceOf(u.address)) - before).to.equal(owed);
    }
  });

  it("fund: the same, for depositors", async function () {
    const [admin, alice] = await ethers.getSigners();
    const srx = await token();
    const Fund = await ethers.getContractFactory("StabilisationFund");
    const fund = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000),
      await allocationSource(srx, E(1_500_000_000)));
    await srx.connect(admin).transfer(await fund.getAddress(), E(20_000_000));
    await srx.connect(admin).transfer(alice.address, E(10_000));
    await srx.connect(alice).approve(await fund.getAddress(), ethers.MaxUint256);
    await fund.connect(alice).contribute(E(10_000));
    await fund.connect(admin).notifyRewardAmount(E(1_000_000));
    await fund.connect(admin).setRewardRate(E(1));
    await time.increase(5 * DAY);
    await fund.connect(admin).startWindDown();
    await fund.connect(alice).exitAfterWindDown();
    expect(await fund.totalContributions()).to.equal(0n);
    const owed = await fund.pendingRewards(alice.address);
    expect(owed).to.be.gt(0n);
    const v2 = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), await fund.getAddress());
    await fund.connect(admin).releaseRewardAllocation(await v2.getAddress(), await fund.releasableRewardAllocation());
    expect(await srx.balanceOf(await fund.getAddress())).to.be.gte(await fund.totalPendingRewards());
    const before = await srx.balanceOf(alice.address);
    await fund.connect(alice).claimRewards();
    expect((await srx.balanceOf(alice.address)) - before).to.equal(owed);
  });
});
