// SSF-L1 and the rest of the 20 Sep 2026 StabilisationFund report (ibnu76).
//
// ⛔ SSF-L1 was recorded as "accepted": a 1-wei contribution kept totalContributions
//    above zero, which blocked rescueStrandedPool() (since removed, internal audit L1,
//    16 Oct 2026; the pool now leaves only by releaseRewardAllocation to a successor
//    after wind-down), and a dust position sat on the
//    whole reward stream with no capital at risk. Jared, 30 Sep: fix it, as staking's
//    minStakeAmount does. A position is now either 0 or at least minContribution.
//
// The report's third finding (a rescue taking contributors' accrued rewards) was fixed
// by 48d9f00 (SSF-H2); the last test here proves the reporter's scenario directly, now
// through releaseRewardAllocation, the only way reward SRX leaves.
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { allocationSource } = require("./helpers/allocationSource");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (n) => ethers.parseUnits(String(n), 18);

// A successor fund: deployed with the given fund as its allocation source (docs/MIGRATION.md).
async function successorOf(ssf, srx, admin) {
  return (await ethers.getContractFactory("StabilisationFund")).deploy(
    await srx.getAddress(), admin.address, 3_000, 7_000, 30 * 24 * 3600, E(10_000_000), await ssf.getAddress());
}

describe("StabilisationFund — minimum position (SSF-L1, reported by ibnu76)", function () {
  async function fixture() {
    const [admin, timelock, alice, attacker, stranger] = await ethers.getSigners();
    const endpoint = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await endpoint.getAddress(), admin.address);
    await srx.connect(admin).genesis(admin.address);
    const ssf = await (await ethers.getContractFactory("StabilisationFund")).deploy(...[await srx.getAddress(), admin.address, 3_000, 7_000, 30 * 24 * 3600, ethers.parseUnits("10000000", 18), await allocationSource(srx, ethers.parseUnits("1500000000", 18))]);
    await ssf.connect(admin).grantRole(await ssf.GOVERNANCE_ROLE(), timelock.address);
    await srx.connect(admin).transfer(await ssf.getAddress(), E(1_500_000_000));
    for (const u of [alice, attacker]) {
      await srx.connect(admin).transfer(u.address, E(1_000_000));
      await srx.connect(u).approve(await ssf.getAddress(), ethers.MaxUint256);
    }
    return { ssf, srx, admin, timelock, alice, attacker, stranger };
  }

  it("defaults to 100 SRX, the same as staking's minStakeAmount", async function () {
    const { ssf } = await loadFixture(fixture);
    expect(await ssf.minContribution()).to.equal(E(100));
  });

  it("the reporter's dust PoC: a 1-wei contribution reverts", async function () {
    const { ssf, attacker } = await loadFixture(fixture);
    await expect(ssf.connect(attacker).contribute(1n))
      .to.be.revertedWithCustomError(ssf, "BelowMinimumContribution").withArgs(1n, E(100));
    await expect(ssf.connect(attacker).contribute(E(100) - 1n))
      .to.be.revertedWithCustomError(ssf, "BelowMinimumContribution");
    await expect(ssf.connect(attacker).contribute(E(100))).to.not.be.reverted;
  });

  it("a top-up may be small once the position is at least the minimum", async function () {
    const { ssf, alice } = await loadFixture(fixture);
    await ssf.connect(alice).contribute(E(100));
    await expect(ssf.connect(alice).contribute(1n)).to.not.be.reverted;
    expect((await ssf.contributions(alice.address)).srxAmount).to.equal(E(100) + 1n);
  });

  it("a partial withdrawal cannot leave a dust position behind; a full one can", async function () {
    const { ssf, alice } = await loadFixture(fixture);
    await ssf.connect(alice).contribute(E(1_000));
    await time.increase(30 * 24 * 3600 + 1);
    await expect(ssf.connect(alice).withdrawContribution(E(1_000) - 1n))
      .to.be.revertedWithCustomError(ssf, "BelowMinimumContribution").withArgs(1n, E(100));
    await expect(ssf.connect(alice).withdrawContribution(E(900))).to.not.be.reverted; // leaves exactly 100
    await expect(ssf.connect(alice).withdrawContribution(E(100))).to.not.be.reverted; // leaves 0
    expect(await ssf.totalContributions()).to.equal(0n);
  });

  it("a full withdrawal is always allowed, even after the minimum is raised above the position", async function () {
    const { ssf, srx, timelock, alice } = await loadFixture(fixture);
    await ssf.connect(alice).contribute(E(150));
    await ssf.connect(timelock).setMinContribution(E(1_000));
    await time.increase(30 * 24 * 3600 + 1);
    const before = await srx.balanceOf(alice.address);
    await expect(ssf.connect(alice).withdrawContribution(E(150))).to.not.be.reverted;
    expect((await srx.balanceOf(alice.address)) - before).to.equal(E(150));
  });

  it("a minimum of 0 removes it (governance's choice)", async function () {
    const { ssf, timelock, attacker } = await loadFixture(fixture);
    await ssf.connect(timelock).setMinContribution(0n);
    await expect(ssf.connect(attacker).contribute(1n)).to.not.be.reverted;
  });

  it("dust can no longer hold an empty-contributor pool hostage: after wind-down the release goes through", async function () {
    const { ssf, srx, admin, timelock, alice, attacker } = await loadFixture(fixture);
    await ssf.connect(alice).contribute(E(1_000));
    await ssf.connect(timelock).notifyRewardAmount(E(100_000));
    await time.increase(30 * 24 * 3600 + 1);
    await ssf.connect(alice).withdrawContribution(E(1_000));

    // The attack that used to block the rescue now fails.
    await expect(ssf.connect(attacker).contribute(1n)).to.be.revertedWithCustomError(ssf, "BelowMinimumContribution");
    expect(await ssf.totalContributions()).to.equal(0n);

    // Nothing is stuck: after wind-down the unused allocation moves to a successor.
    await ssf.connect(timelock).startWindDown();
    const v2 = await successorOf(ssf, srx, admin);
    const releasable = await ssf.releasableRewardAllocation();
    expect(releasable).to.be.gt(0n);
    await ssf.connect(timelock).releaseRewardAllocation(await v2.getAddress(), releasable);
    expect(await srx.balanceOf(await v2.getAddress())).to.equal(releasable);
  });

  it("only governance can change the minimum, and the change is recorded", async function () {
    const { ssf, timelock, stranger } = await loadFixture(fixture);
    await expect(ssf.connect(stranger).setMinContribution(E(1))).to.be.reverted;
    await expect(ssf.connect(timelock).setMinContribution(E(250)))
      .to.emit(ssf, "MinContributionSet").withArgs(E(100), E(250));
    expect(await ssf.minContribution()).to.equal(E(250));
  });

  it("the report's third finding: a release never takes rewards a contributor has already earned", async function () {
    const { ssf, srx, admin, timelock, alice } = await loadFixture(fixture);
    await ssf.connect(alice).contribute(E(1_000));
    await ssf.connect(timelock).notifyRewardAmount(E(1_000_000));
    await ssf.connect(timelock).setRewardRate(ethers.parseUnits("0.1", 18)); // ~260k of the 1M earned over the lock: the rest is unaccrued
    await time.increase(1_000);

    // Earn, then withdraw all principal WITHOUT claiming.
    await time.increase(30 * 24 * 3600);
    await ssf.connect(alice).withdrawContribution(E(1_000));
    const owed = await ssf.earned(alice.address);
    expect(owed).to.be.gt(0n);

    // rescueStrandedPool is gone: the only way out is a release to a successor after wind-down.
    expect(ssf.interface.fragments.filter(f => f.name === "rescueStrandedPool")).to.have.length(0);
    await ssf.connect(timelock).startWindDown();
    const v2 = await successorOf(ssf, srx, admin);

    // Governance releases everything releasable: it takes ONLY what nobody is owed (the
    // launch SRX never registered plus the unearned part of the pool), and the earned
    // rewards stay reserved in rewardPool. (Checking only that the contributor is paid is
    // not enough: the fund also holds the 1.5B strategic reserve, so a release that took
    // the earned rewards would still let them be paid, out of the reserve.)
    const poolBefore = await ssf.rewardPool();
    const unregistered = (await ssf.rewardBacking()) - (await ssf.totalRewardsRegistered());
    const releasable = await ssf.releasableRewardAllocation();
    expect(releasable).to.equal(unregistered + poolBefore - owed);
    await expect(ssf.connect(timelock).releaseRewardAllocation(await v2.getAddress(), releasable + 1n))
      .to.be.revertedWithCustomError(ssf, "ReleaseExceedsUnusedAllocation");
    await ssf.connect(timelock).releaseRewardAllocation(await v2.getAddress(), releasable);
    expect(await srx.balanceOf(await v2.getAddress())).to.equal(releasable);
    expect(await ssf.rewardPool()).to.equal(owed);
    expect(await ssf.releasableRewardAllocation()).to.equal(0n);

    // ...and the contributor still claims everything they earned, from that reservation.
    const before = await srx.balanceOf(alice.address);
    await ssf.connect(alice).claimRewards();
    expect((await srx.balanceOf(alice.address)) - before).to.equal(owed);
    expect(await ssf.earned(alice.address)).to.equal(0n);
    expect(await ssf.rewardPool()).to.equal(0n);
  });
});
