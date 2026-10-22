// SRXStaking: rewards already earned are never lost (internal review, 7 Oct 2026).
//  - the reward allocation that can leave (releaseRewardAllocation(), after wind-down, to a
//    successor) never includes what is owed; rescueStrandedPool() itself is gone (internal
//    audit L1, 16 Oct 2026), it sent the unaccrued pool to any wallet;
//  - an exited staker can claim a remainder left by a pool shortfall without staking again.
// A shortfall is not reachable through the schedule (it is bounded by the unaccrued pool),
// so the tests force one by writing rewardPool's storage slot directly.
const { expect } = require("chai");
const { ethers, upgrades, artifacts, network } = require("hardhat");
const { allocationSource } = require("./helpers/allocationSource");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (n) => ethers.parseUnits(String(n), 18);
const LOCK_7D = 7 * 86400;

async function slotOf(label) {
  const info = await artifacts.getBuildInfo("contracts/staking/SRXStaking.sol:SRXStaking");
  const layout = info.output.contracts["contracts/staking/SRXStaking.sol"].SRXStaking.storageLayout.storage;
  const v = layout.find((x) => x.label === label);
  if (!v) throw new Error(`no storage slot for ${label}`);
  return BigInt(v.slot);
}

describe("SRXStaking — earned rewards are never lost", function () {
  async function fixture() {
    const [admin, user, other] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await token.connect(admin).genesis(admin.address);
    const staking = await (await ethers.getContractFactory("SRXStaking")).deploy(...[await token.getAddress(), admin.address, await allocationSource(token)]);
    await token.connect(admin).transfer(await staking.getAddress(), E(1_000_000));
    await staking.connect(admin).notifyRewardAmount(E(1_000_000));
    await staking.connect(admin).setRewardRate(E(1));
    await token.connect(admin).transfer(user.address, E(10_000));
    await token.connect(user).approve(await staking.getAddress(), ethers.MaxUint256);
    return { admin, user, other, token, staking };
  }

  async function setRewardPool(staking, value) {
    await network.provider.send("hardhat_setStorageAt", [
      await staking.getAddress(), ethers.toBeHex(await slotOf("rewardPool")), ethers.zeroPadValue(ethers.toBeHex(value), 32)]);
  }

  // Stake, earn, force a shortfall, exit: the exited user is left owed a remainder.
  async function exitedWithRemainder() {
    const ctx = await loadFixture(fixture);
    const { user, staking } = ctx;
    await staking.connect(user).lock(E(1_000), LOCK_7D);
    await time.increase(LOCK_7D + 1);
    const owed = await staking.earned(user.address);
    await setRewardPool(staking, owed / 2n);          // the pool cannot cover it all
    await staking.connect(user).unlock();             // pays half, keeps the rest pending
    const remainder = await staking.pendingRewards(user.address);
    expect(remainder).to.be.gt(0n);
    return { ...ctx, remainder };
  }

  it("an exited staker claims the remainder once the pool is refunded, without staking again", async function () {
    const { user, token, staking, remainder } = await exitedWithRemainder();
    await setRewardPool(staking, remainder);          // the pool is refunded
    const before = await token.balanceOf(user.address);
    await staking.connect(user).claimRewards();
    expect((await token.balanceOf(user.address)) - before).to.equal(remainder);
    expect(await staking.pendingRewards(user.address)).to.equal(0n);
  });

  // A successor is a contract deployed with THIS one as its allocation source.
  const successorOf = async (staking, token, admin) =>
    (await ethers.getContractFactory("SRXStaking")).deploy(await token.getAddress(), admin.address, await staking.getAddress());

  it("what a release can take never includes what is owed, leaving the remainder reserved and claimable", async function () {
    const { admin, user, token, staking, remainder } = await exitedWithRemainder();
    const extra = E(500);
    await setRewardPool(staking, remainder + extra);
    // The rescue that used to sweep the pool to any wallet no longer exists.
    expect(staking.interface.fragments.filter(f => f.name === "rescueStrandedPool")).to.have.length(0);
    expect(staking.rescueStrandedPool).to.equal(undefined);

    await staking.connect(admin).startWindDown();
    const v2 = await successorOf(staking, token, admin);
    const releasable = await staking.releasableRewardAllocation();
    // Never more than the SRX held beyond what is owed
    const held = await token.balanceOf(await staking.getAddress());
    expect(releasable).to.be.gt(0n);
    expect(releasable + remainder).to.be.lte(held);
    await expect(staking.connect(admin).releaseRewardAllocation(await v2.getAddress(), releasable + 1n))
      .to.be.revertedWithCustomError(staking, "ReleaseExceedsUnusedAllocation");
    await staking.connect(admin).releaseRewardAllocation(await v2.getAddress(), releasable);
    expect(await token.balanceOf(await v2.getAddress())).to.equal(releasable);
    // ...and the owed remainder is still there for the user.
    expect(await token.balanceOf(await staking.getAddress())).to.be.gte(remainder);
    const before = await token.balanceOf(user.address);
    await staking.connect(user).claimRewards();
    expect((await token.balanceOf(user.address)) - before).to.equal(remainder);
    expect(await staking.pendingRewards(user.address)).to.equal(0n);
  });

  it("with only owed rewards in the pool, a full release leaves exactly the owed remainder behind", async function () {
    const { admin, user, token, staking, remainder } = await exitedWithRemainder();
    await setRewardPool(staking, remainder);
    await staking.connect(admin).startWindDown();
    const v2 = await successorOf(staking, token, admin);
    // The unaccrued part of the pool is zero; nothing owed is releasable.
    await staking.connect(admin).releaseRewardAllocation(await v2.getAddress(), await staking.releasableRewardAllocation());
    expect(await staking.releasableRewardAllocation()).to.equal(0n);
    expect(await token.balanceOf(await staking.getAddress())).to.equal(remainder);
    await expect(staking.connect(admin).releaseRewardAllocation(await v2.getAddress(), 1n))
      .to.be.revertedWithCustomError(staking, "ReleaseExceedsUnusedAllocation");
    await staking.connect(user).claimRewards();
    expect(await staking.pendingRewards(user.address)).to.equal(0n);
  });
});
