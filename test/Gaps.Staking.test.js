// Gap-closing tests for SRXStaking.
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { allocationSource } = require("./helpers/allocationSource");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const e18 = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;
const LOCK_7D = 7 * DAY, LOCK_30D = 30 * DAY, LOCK_90D = 90 * DAY, LOCK_180D = 180 * DAY;
const Tier = { None: 0n, Slate: 1n, Onyx: 2n, Obsidian: 3n };

describe("Gaps: SRXStaking", function () {
  async function fixture() {
    const [admin, user1, user2, stranger] = await ethers.getSigners();
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    await token.connect(admin).genesis(admin.address);
    const staking = await (await ethers.getContractFactory("SRXStaking")).deploy(...[await token.getAddress(), admin.address, await allocationSource(token)]);
    const sAddr = await staking.getAddress();
    for (const u of [user1, user2]) {
      await token.connect(admin).transfer(u.address, e18(5_000_000));
      await token.connect(u).approve(sAddr, ethers.MaxUint256);
    }
    return { admin, user1, user2, stranger, token, staking, sAddr };
  }

  // ── S1 ─────────────────────────────────────────────────────────────────────
  describe("S1: weight of a 30-day lock", function () {
    it("lock(x, 30 days) gives weightedAmount == x * 1.25, in the position, the total and the event", async function () {
      const { staking, user1, user2 } = await loadFixture(fixture);
      const x = e18(1_000);
      await expect(staking.connect(user1).lock(x, LOCK_30D)).to.emit(staking, "Locked");
      const pos = await staking.positions(user1.address);
      expect(pos.weightedAmount).to.equal((x * 125n) / 100n);
      expect(pos.weightedAmount).to.equal(e18(1_250));
      expect(await staking.totalWeightedStake()).to.equal(e18(1_250));
      expect(await staking.totalLocked()).to.equal(x);

      // Controls: the other durations use their own multipliers (1.00, 1.50, 2.00).
      await staking.connect(user2).lock(x, LOCK_7D);
      expect((await staking.positions(user2.address)).weightedAmount).to.equal(x);
    });

    it("an odd amount rounds down: 1001 wei at 1.25x is 1251 wei", async function () {
      const { admin, staking, user1 } = await loadFixture(fixture);
      await staking.connect(admin).setMinStakeAmount(0);
      await staking.connect(user1).lock(1_001n, LOCK_30D);
      expect((await staking.positions(user1.address)).weightedAmount).to.equal(1_251n); // floor(1001*125/100)=1251
    });
  });

  // ── S2 ─────────────────────────────────────────────────────────────────────
  describe("S2: minTotalStakeForEmission", function () {
    const T = e18(2_000);
    const POOL = e18(10_000_000);
    const RATE = e18(10); // 10 SRX / second

    async function emissionFixture() {
      const ctx = await fixture();
      const { admin, token, staking, sAddr } = ctx;
      await token.connect(admin).transfer(sAddr, POOL);
      await staking.connect(admin).notifyRewardAmount(POOL);
      await staking.connect(admin).setRewardRate(RATE);
      await staking.connect(admin).setMinTotalStakeForEmission(T);
      return ctx;
    }

    it("the setter is governance-only and emits both values", async function () {
      const { admin, stranger, staking } = await loadFixture(fixture);
      const GOV = await staking.GOVERNANCE_ROLE();
      await expect(staking.connect(stranger).setMinTotalStakeForEmission(T))
        .to.be.revertedWithCustomError(staking, "AccessControlUnauthorizedAccount").withArgs(stranger.address, GOV);
      expect(await staking.minTotalStakeForEmission()).to.equal(0n);
      await expect(staking.connect(admin).setMinTotalStakeForEmission(T))
        .to.emit(staking, "MinTotalStakeForEmissionSet").withArgs(0n, T);
      expect(await staking.minTotalStakeForEmission()).to.equal(T);
    });

    it("below the threshold earned() does not advance; once stake crosses it accrual resumes and the paused interval is NOT paid retroactively", async function () {
      const { user1, user2, staking } = await loadFixture(emissionFixture);

      // A stakes 1,000 weighted (7-day lock), below T = 2,000.
      await staking.connect(user1).lock(e18(1_000), LOCK_7D);
      expect(await staking.totalWeightedStake()).to.equal(e18(1_000));
      await time.increase(1_000);
      expect(await staking.earned(user1.address)).to.equal(0n);   // no accrual under the threshold
      expect(await staking.rewardPerToken()).to.equal(await staking.rewardPerTokenStored());

      // B joins: total weighted 2,500 >= T. The lock settles the accumulator under the OLD (below-T) state first.
      await staking.connect(user2).lock(e18(1_500), LOCK_7D);
      expect(await staking.totalWeightedStake()).to.equal(e18(2_500));
      const t0 = BigInt(await time.latest());
      expect(await staking.lastUpdateTime()).to.equal(t0);          // the clock was moved to now, skipping the gap

      // 100 seconds later accrual has resumed: A holds 1000/2500 of RATE * 100.
      await time.setNextBlockTimestamp(t0 + 100n);
      await staking.pokeExpiredPosition(user1.address);             // permissionless; banks A's accrual at t0+100
      const earnedA = await staking.pendingRewards(user1.address);
      expect(earnedA).to.equal((RATE * 100n * e18(1_000)) / e18(2_500)); // exactly 400 SRX
      expect(earnedA).to.equal(e18(400));
      // If the 1,000 s paused interval had been paid retroactively A would hold >= 10,000 SRX more.
      expect(earnedA).to.be.lt(RATE * 1_000n);
    });

    it("control: with the threshold left at 0 the same single 1,000-weighted staker accrues the whole stream", async function () {
      const { admin, user1, staking } = await loadFixture(emissionFixture);
      await staking.connect(admin).setMinTotalStakeForEmission(0);
      await staking.connect(user1).lock(e18(1_000), LOCK_7D);
      const t0 = BigInt(await time.latest());
      await time.setNextBlockTimestamp(t0 + 100n);
      await staking.pokeExpiredPosition(user1.address);
      expect(await staking.pendingRewards(user1.address)).to.equal(RATE * 100n); // sole staker: 100%
    });
  });

  // ── S3 ─────────────────────────────────────────────────────────────────────
  describe("S3: addToPosition cannot shorten a live commitment", function () {
    it("on a live 180-day lock, a 7-day (or 90-day) duration reverts InvalidLockDuration; keeping or extending succeeds", async function () {
      const { user1, staking } = await loadFixture(fixture);
      await staking.connect(user1).lock(e18(1_000), LOCK_180D);
      const before = await staking.positions(user1.address);
      expect(before.weightedAmount).to.equal(e18(2_000));

      await expect(staking.connect(user1).addToPosition(e18(100), LOCK_7D))
        .to.be.revertedWithCustomError(staking, "InvalidLockDuration");
      await expect(staking.connect(user1).addToPosition(e18(100), LOCK_90D))
        .to.be.revertedWithCustomError(staking, "InvalidLockDuration");
      const unchanged = await staking.positions(user1.address);
      expect(unchanged.amount).to.equal(before.amount);
      expect(unchanged.lockEnd).to.equal(before.lockEnd);
      expect(unchanged.weightedAmount).to.equal(before.weightedAmount);

      // Controls: duration 0 (keep) and 180 days (same multiplier) are accepted, at the 2.00x weight.
      await staking.connect(user1).addToPosition(e18(100), 0);
      expect((await staking.positions(user1.address)).weightedAmount).to.equal(e18(2_200));
      await staking.connect(user1).addToPosition(e18(100), LOCK_180D);
      const after = await staking.positions(user1.address);
      expect(after.amount).to.equal(e18(1_200));
      expect(after.weightedAmount).to.equal(e18(2_400));
    });

    it("an invalid duration value (e.g. 8 days) also reverts InvalidLockDuration", async function () {
      const { user1, staking } = await loadFixture(fixture);
      await staking.connect(user1).lock(e18(1_000), LOCK_7D);
      await expect(staking.connect(user1).addToPosition(e18(100), 8 * DAY))
        .to.be.revertedWithCustomError(staking, "InvalidLockDuration");
      await expect(staking.connect(user1).addToPosition(e18(100), LOCK_30D)).to.not.be.reverted; // control
    });
  });

  // ── S4 ─────────────────────────────────────────────────────────────────────
  describe("S4: updateTierParams validation", function () {
    it("Tier.None reverts and discountBps > 10000 reverts (both as InvalidBps); a valid update, incl. exactly 10000 on the top tier, succeeds", async function () {
      const { admin, staking } = await loadFixture(fixture);
      await expect(staking.connect(admin).updateTierParams(Tier.None, e18(1), 100))
        .to.be.revertedWithCustomError(staking, "InvalidBps");
      await expect(staking.connect(admin).updateTierParams(Tier.None, 0, 0))
        .to.be.revertedWithCustomError(staking, "InvalidBps");
      await expect(staking.connect(admin).updateTierParams(Tier.Slate, e18(40_000), 10_001))
        .to.be.revertedWithCustomError(staking, "InvalidBps");
      expect((await staking.tierParams(Tier.Slate)).discountBps).to.equal(2_500n); // unchanged

      await expect(staking.connect(admin).updateTierParams(Tier.Slate, e18(40_000), 3_000))
        .to.emit(staking, "TierParamsUpdated").withArgs(Tier.Slate, e18(40_000), 3_000);
      // Internal audit L12 (16 Oct 2026): discounts must rise with the tier, so exactly 10000
      // is valid only where it does not exceed the next tier's: on Obsidian, the top tier.
      await expect(staking.connect(admin).updateTierParams(Tier.Obsidian, e18(1_000_000), 10_000)).to.not.be.reverted;
      const obsidian = await staking.tierParams(Tier.Obsidian);
      expect(obsidian.minSRX).to.equal(e18(1_000_000));
      expect(obsidian.discountBps).to.equal(10_000n);
      const slate = await staking.tierParams(Tier.Slate);
      expect(slate.minSRX).to.equal(e18(40_000));
      expect(slate.discountBps).to.equal(3_000n);
    });

    it("a discount above the next tier's, and a Slate threshold of 0, now revert InvalidBps (internal audit L12)", async function () {
      const { admin, staking } = await loadFixture(fixture);
      // Slate at 10000 would exceed Onyx's 6000 (defaults: Slate 2500, Onyx 6000, Obsidian 10000)
      await expect(staking.connect(admin).updateTierParams(Tier.Slate, e18(40_000), 10_000))
        .to.be.revertedWithCustomError(staking, "InvalidBps");
      // Slate at 0 minSRX would give every address a discount
      await expect(staking.connect(admin).updateTierParams(Tier.Slate, 0, 2_500))
        .to.be.revertedWithCustomError(staking, "InvalidBps");
      // Onyx below Slate's discount, or above Obsidian's, and Obsidian below Onyx's, are refused too
      await expect(staking.connect(admin).updateTierParams(Tier.Onyx, e18(250_000), 2_499))
        .to.be.revertedWithCustomError(staking, "InvalidBps");
      await expect(staking.connect(admin).updateTierParams(Tier.Obsidian, e18(1_000_000), 5_999))
        .to.be.revertedWithCustomError(staking, "InvalidBps");
      // Nothing changed
      const slate = await staking.tierParams(Tier.Slate);
      expect(slate.minSRX).to.equal(e18(50_000));
      expect(slate.discountBps).to.equal(2_500n);
    });
  });

  // ── S5 ─────────────────────────────────────────────────────────────────────
  describe("S5: governance setters and pause are role-gated", function () {
    it("setRewardRate, notifyRewardAmount, updateTierParams, setMinStakeAmount (GOVERNANCE_ROLE) and pause (PAUSER_ROLE) refuse a stranger; the right roles succeed", async function () {
      const { admin, stranger, token, staking, sAddr } = await loadFixture(fixture);
      const GOV = await staking.GOVERNANCE_ROLE();
      const PAUSER = await staking.PAUSER_ROLE();
      await token.connect(admin).transfer(sAddr, e18(1_000)); // something to register

      const calls = [
        ["setRewardRate", (s) => staking.connect(s).setRewardRate(1n), GOV],
        ["notifyRewardAmount", (s) => staking.connect(s).notifyRewardAmount(e18(1_000)), GOV],
        ["updateTierParams", (s) => staking.connect(s).updateTierParams(Tier.Slate, e18(40_000), 3_000), GOV],
        ["setMinStakeAmount", (s) => staking.connect(s).setMinStakeAmount(e18(5)), GOV],
        ["pause", (s) => staking.connect(s).pause(), PAUSER],
      ];
      for (const [name, call, role] of calls) {
        await expect(call(stranger), name)
          .to.be.revertedWithCustomError(staking, "AccessControlUnauthorizedAccount").withArgs(stranger.address, role);
      }
      expect(await staking.paused()).to.equal(false);
      expect(await staking.rewardRate()).to.equal(0n);
      expect(await staking.rewardPool()).to.equal(0n);
      expect(await staking.minStakeAmount()).to.equal(e18(100));

      // Controls: the admin (GOVERNANCE + PAUSER from initialize) succeeds with the same calls.
      for (const [name, call] of calls) await expect(call(admin), name).to.not.be.reverted;
      expect(await staking.paused()).to.equal(true);
      expect(await staking.rewardPool()).to.equal(e18(1_000));
      expect(await staking.rewardRate()).to.equal(1n);
      expect(await staking.minStakeAmount()).to.equal(e18(5));
    });

    it("a GOVERNANCE_ROLE-only account cannot pause, and a PAUSER_ROLE-only account cannot change governance parameters", async function () {
      const { admin, stranger, staking } = await loadFixture(fixture);
      const GOV = await staking.GOVERNANCE_ROLE(), PAUSER = await staking.PAUSER_ROLE();
      await staking.connect(admin).grantRole(GOV, stranger.address);
      await expect(staking.connect(stranger).pause())
        .to.be.revertedWithCustomError(staking, "AccessControlUnauthorizedAccount").withArgs(stranger.address, PAUSER);
      await staking.connect(stranger).setMinStakeAmount(e18(7)); // governance works
      await staking.connect(admin).revokeRole(GOV, stranger.address);
      await staking.connect(admin).grantRole(PAUSER, stranger.address);
      await expect(staking.connect(stranger).setMinStakeAmount(e18(8)))
        .to.be.revertedWithCustomError(staking, "AccessControlUnauthorizedAccount").withArgs(stranger.address, GOV);
      await staking.connect(stranger).pause(); // pausing works
      expect(await staking.paused()).to.equal(true);
    });
  });

  // ── S6 ─────────────────────────────────────────────────────────────────────
  // The bonus reward token was removed (REG-50 option C, 11 Oct 2026); its absence is
  // proved in test/REG50.FixedRewardPools.test.js.

  // ── S7 ─────────────────────────────────────────────────────────────────────
  describe("S7: notifyRewardAmount cannot register locked principal", function () {
    it("stake X, balance X + P: notify(P + 1) reverts, notify(P) succeeds, a second notify(P) reverts", async function () {
      const { admin, user1, token, staking, sAddr } = await loadFixture(fixture);
      const X = e18(1_000);
      const P = e18(300);
      await staking.connect(user1).lock(X, LOCK_30D);
      await token.connect(admin).transfer(sAddr, P);
      expect(await token.balanceOf(sAddr)).to.equal(X + P);

      await expect(staking.connect(admin).notifyRewardAmount(P + 1n))
        .to.be.revertedWithCustomError(staking, "PoolAmountExceedsAvailable").withArgs(P, P + 1n);
      expect(await staking.rewardPool()).to.equal(0n);

      await expect(staking.connect(admin).notifyRewardAmount(P))
        .to.emit(staking, "RewardPoolFunded").withArgs(P, P);
      expect(await staking.rewardPool()).to.equal(P);

      await expect(staking.connect(admin).notifyRewardAmount(P))
        .to.be.revertedWithCustomError(staking, "PoolAmountExceedsAvailable").withArgs(0n, P);
      await expect(staking.connect(admin).notifyRewardAmount(1n))
        .to.be.revertedWithCustomError(staking, "PoolAmountExceedsAvailable").withArgs(0n, 1n);

      // The staker's principal is still fully backed.
      expect((await token.balanceOf(sAddr)) - (await staking.rewardPool())).to.equal(await staking.totalLocked());
    });
  });

  // ── S8 ─────────────────────────────────────────────────────────────────────
  describe("S8: minStakeAmount", function () {
    it("defaults to 100 SRX; lock(min - 1) reverts BelowMinimumStake(min - 1, min); lock(min) succeeds", async function () {
      const { user1, user2, staking } = await loadFixture(fixture);
      const min = e18(100);
      expect(await staking.minStakeAmount()).to.equal(min);
      await expect(staking.connect(user1).lock(min - 1n, LOCK_7D))
        .to.be.revertedWithCustomError(staking, "BelowMinimumStake").withArgs(min - 1n, min);
      expect((await staking.positions(user1.address)).amount).to.equal(0n);
      await expect(staking.connect(user2).lock(min, LOCK_7D)).to.emit(staking, "Locked");
      expect((await staking.positions(user2.address)).amount).to.equal(min);
    });

    it("setMinStakeAmount is governance-only, emits MinStakeAmountSet(old, new), gates new entries and leaves existing positions alone", async function () {
      const { admin, stranger, user1, user2, staking } = await loadFixture(fixture);
      const GOV = await staking.GOVERNANCE_ROLE();
      await expect(staking.connect(stranger).setMinStakeAmount(e18(500)))
        .to.be.revertedWithCustomError(staking, "AccessControlUnauthorizedAccount").withArgs(stranger.address, GOV);
      expect(await staking.minStakeAmount()).to.equal(e18(100));

      await staking.connect(user1).lock(e18(100), LOCK_7D); // existing position at the old minimum
      await expect(staking.connect(admin).setMinStakeAmount(e18(500)))
        .to.emit(staking, "MinStakeAmountSet").withArgs(e18(100), e18(500));
      expect(await staking.minStakeAmount()).to.equal(e18(500));

      expect((await staking.positions(user1.address)).amount).to.equal(e18(100));      // unaffected
      await expect(staking.connect(user2).lock(e18(499), LOCK_7D))
        .to.be.revertedWithCustomError(staking, "BelowMinimumStake").withArgs(e18(499), e18(500));
      await expect(staking.connect(user2).lock(e18(500), LOCK_7D)).to.not.be.reverted;
    });
  });
});
