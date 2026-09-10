// R7-01 regression — the duration multiplier must expire with the lock.
//
// The tier multiplier prices an ACTIVE commitment. Before this fix getTier() read
// weightedAmount unconditionally, so one finite lock bought a PERMANENT multiplied
// tier at full liquidity: 500,000 SRX locked once for 180 days held Obsidian forever,
// halving the capital cost of the top tier and leaking platform fee revenue.
//
// Thresholds: Slate 50k, Onyx 250k, Obsidian 1M (weighted while locked, raw after).
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("SRXStaking — tier expiry (R7-01)", function () {
  const GOLD   = ethers.parseUnits("1000000", 18);
  const SILVER = ethers.parseUnits("250000", 18);
  const LOCK_7D   = 7 * 86400;
  const LOCK_180D = 180 * 86400;

  const TIER_NONE = 0n, TIER_SILVER = 2n, TIER_GOLD = 3n;

  async function fx() {
    const [admin, user1, user2] = await ethers.getSigners();
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const ep = await MockLZEndpoint.deploy(40161);
    await ep.waitForDeployment();
    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await ep.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    const SRXStaking = await ethers.getContractFactory("SRXStaking");
    const staking = await upgrades.deployProxy(
      SRXStaking, [await token.getAddress(), admin.address], { kind: "uups" }
    );
    await staking.waitForDeployment();

    for (const u of [user1, user2]) {
      await token.connect(admin).transfer(u.address, GOLD * 2n);
      await token.connect(u).approve(await staking.getAddress(), ethers.MaxUint256);
    }
    return { staking, token, admin, user1, user2 };
  }

  it("grants the multiplied tier while the lock is ACTIVE", async function () {
    const { staking, user1 } = await loadFixture(fx);
    await staking.connect(user1).lock(GOLD / 2n, LOCK_180D); // 500k × 2.0 = 1M weighted
    expect(await staking.getTier(user1.address)).to.equal(TIER_GOLD);
  });

  it("does not decay mid-lock (weighting is stable until expiry)", async function () {
    const { staking, user1 } = await loadFixture(fx);
    await staking.connect(user1).lock(GOLD / 2n, LOCK_180D);
    await time.increase(179 * 86400); // one day before expiry
    expect(await staking.getTier(user1.address)).to.equal(TIER_GOLD);
  });

  it("REGRESSION: multiplier expires with the lock — falls back to raw principal", async function () {
    const { staking, user1 } = await loadFixture(fx);
    await staking.connect(user1).lock(GOLD / 2n, LOCK_180D);
    expect(await staking.getTier(user1.address)).to.equal(TIER_GOLD);

    await time.increase(LOCK_180D + 86400); // past expiry — full liquidity, no commitment

    // 500k raw clears Onyx (250k) but not Obsidian (1M). The multiplier is gone.
    expect(await staking.getTier(user1.address)).to.equal(TIER_SILVER);

    // ...and stays that way indefinitely.
    await time.increase(365 * 86400);
    expect(await staking.getTier(user1.address)).to.equal(TIER_SILVER);
  });

  it("a staker who posted the FULL threshold keeps their tier after expiry", async function () {
    const { staking, user2 } = await loadFixture(fx);
    await staking.connect(user2).lock(GOLD, LOCK_7D); // full 1M, no multiplier needed
    expect(await staking.getTier(user2.address)).to.equal(TIER_GOLD);

    await time.increase(LOCK_7D + 86400);
    // Raw principal alone earns Obsidian, so nothing is lost. Only the *multiplier* expires.
    expect(await staking.getTier(user2.address)).to.equal(TIER_GOLD);
  });

  it("re-committing via addToPosition restores the multiplier", async function () {
    const { staking, user1 } = await loadFixture(fx);
    await staking.connect(user1).lock(GOLD / 2n, LOCK_180D);
    await time.increase(LOCK_180D + 86400);
    expect(await staking.getTier(user1.address)).to.equal(TIER_SILVER); // expired

    // Re-commit for another 180 days — multiplier applies again.
    await staking.connect(user1).addToPosition(1n, LOCK_180D);
    expect(await staking.getTier(user1.address)).to.equal(TIER_GOLD);
  });

  it("unlocking clears the tier entirely", async function () {
    const { staking, user1 } = await loadFixture(fx);
    await staking.connect(user1).lock(GOLD / 2n, LOCK_180D);
    await time.increase(LOCK_180D + 86400);
    await staking.connect(user1).unlock();
    expect(await staking.getTier(user1.address)).to.equal(TIER_NONE);
  });

  it("an address with no position is Tier.None (lockEnd == 0 edge case)", async function () {
    const { staking, user2 } = await loadFixture(fx);
    expect(await staking.getTier(user2.address)).to.equal(TIER_NONE);
  });
});
