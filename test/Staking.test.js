const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("SRXStaking + FeeController", function () {

  const BRONZE_THRESHOLD = ethers.parseUnits("50000",    18);
  const SILVER_THRESHOLD = ethers.parseUnits("250000",   18);
  const GOLD_THRESHOLD   = ethers.parseUnits("1000000",  18);
  const LOCK_7D  = 7  * 86400;
  const LOCK_30D = 30 * 86400;

  async function deployFixture() {
    const [admin, user1, user2, user3, gateway] = await ethers.getSigners();

    // ── Deploy token ─────────────────────────────────────────────────────────
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    // Fund test users
    await token.connect(admin).transfer(user1.address, GOLD_THRESHOLD * 2n);
    await token.connect(admin).transfer(user2.address, SILVER_THRESHOLD * 2n);
    await token.connect(admin).transfer(user3.address, BRONZE_THRESHOLD * 2n);

    // ── Deploy Staking (UUPS) ─────────────────────────────────────────────────
    const SRXStaking = await ethers.getContractFactory("SRXStaking");
    const staking = await upgrades.deployProxy(
      SRXStaking,
      [await token.getAddress(), admin.address],
      { kind: "uups" }
    );
    await staking.waitForDeployment();

    // ── Deploy FeeController (UUPS) ───────────────────────────────────────────
    const FeeController = await ethers.getContractFactory("FeeController");
    const feeCtrl = await upgrades.deployProxy(
      FeeController,
      [await staking.getAddress(), admin.address],
      { kind: "uups" }
    );
    await feeCtrl.waitForDeployment();

    // Approve staking contract for all users
    const stakingAddress = await staking.getAddress();
    await token.connect(user1).approve(stakingAddress, ethers.MaxUint256);
    await token.connect(user2).approve(stakingAddress, ethers.MaxUint256);
    await token.connect(user3).approve(stakingAddress, ethers.MaxUint256);

    return { token, staking, feeCtrl, admin, user1, user2, user3, gateway };
  }

  // ── Locking ────────────────────────────────────────────────────────────────

  describe("lock()", function () {
    it("creates a position and transfers tokens", async function () {
      const { staking, token, user1 } = await loadFixture(deployFixture);
      await staking.connect(user1).lock(GOLD_THRESHOLD, LOCK_30D);

      const pos = await staking.getPosition(user1.address);
      expect(pos.amount).to.equal(GOLD_THRESHOLD);
      expect(await token.balanceOf(await staking.getAddress())).to.equal(GOLD_THRESHOLD);
    });

    it("returns Obsidian tier for 1M+ SRX locked", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      await staking.connect(user1).lock(GOLD_THRESHOLD, LOCK_30D);
      expect(await staking.getTier(user1.address)).to.equal(3n); // Tier.Obsidian = 3
    });

    it("returns Onyx tier for 250K SRX locked", async function () {
      const { staking, user2 } = await loadFixture(deployFixture);
      await staking.connect(user2).lock(SILVER_THRESHOLD, LOCK_30D);
      expect(await staking.getTier(user2.address)).to.equal(2n);
    });

    it("returns Slate tier for 50K SRX locked", async function () {
      const { staking, user3 } = await loadFixture(deployFixture);
      await staking.connect(user3).lock(BRONZE_THRESHOLD, LOCK_30D);
      expect(await staking.getTier(user3.address)).to.equal(1n);
    });

    it("returns None tier for 0 SRX locked", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      expect(await staking.getTier(user1.address)).to.equal(0n);
    });

    it("reverts with invalid lock duration", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      await expect(
        staking.connect(user1).lock(BRONZE_THRESHOLD, 99999)
      ).to.be.revertedWithCustomError(staking, "InvalidLockDuration");
    });

    it("reverts if position already exists", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      await staking.connect(user1).lock(BRONZE_THRESHOLD, LOCK_30D);
      await expect(
        staking.connect(user1).lock(BRONZE_THRESHOLD, LOCK_30D)
      ).to.be.revertedWithCustomError(staking, "PositionExists");
    });

    it("reverts with zero amount", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      await expect(
        staking.connect(user1).lock(0n, LOCK_30D)
      ).to.be.revertedWithCustomError(staking, "ZeroAmount");
    });

    it("emits Locked event", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      await expect(staking.connect(user1).lock(GOLD_THRESHOLD, LOCK_30D))
        .to.emit(staking, "Locked");
    });
  });

  // ── Unlocking ──────────────────────────────────────────────────────────────

  describe("unlock()", function () {
    it("returns tokens after lock expiry", async function () {
      const { staking, token, user1 } = await loadFixture(deployFixture);
      const before = await token.balanceOf(user1.address);

      await staking.connect(user1).lock(GOLD_THRESHOLD, LOCK_7D);
      await time.increase(LOCK_7D + 1);
      await staking.connect(user1).unlock();

      expect(await token.balanceOf(user1.address)).to.equal(before);
    });

    it("reverts before lock expiry", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      await staking.connect(user1).lock(GOLD_THRESHOLD, LOCK_7D);

      await expect(staking.connect(user1).unlock())
        .to.be.revertedWithCustomError(staking, "LockNotExpired");
    });

    it("reverts if no position", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      await expect(staking.connect(user1).unlock())
        .to.be.revertedWithCustomError(staking, "NoPosition");
    });

    it("tier returns None after unlock", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      await staking.connect(user1).lock(GOLD_THRESHOLD, LOCK_7D);
      await time.increase(LOCK_7D + 1);
      await staking.connect(user1).unlock();

      expect(await staking.getTier(user1.address)).to.equal(0n);
    });
  });

  // ── Early withdrawal ────────────────────────────────────────────────────────

  describe("earlyWithdraw()", function () {
    it("returns 90% of locked amount", async function () {
      const { staking, token, user1 } = await loadFixture(deployFixture);
      const lockAmount = GOLD_THRESHOLD;
      const before = await token.balanceOf(user1.address);

      await staking.connect(user1).lock(lockAmount, LOCK_30D);
      await staking.connect(user1).earlyWithdraw();

      const expected = before - (lockAmount * 1000n / 10000n); // 90% returned
      expect(await token.balanceOf(user1.address)).to.equal(expected);
    });

    it("10% penalty goes to dead address", async function () {
      const { staking, token, user1 } = await loadFixture(deployFixture);
      const DEAD = "0x000000000000000000000000000000000000dEaD";

      await staking.connect(user1).lock(GOLD_THRESHOLD, LOCK_30D);
      const penalty = GOLD_THRESHOLD * 1000n / 10000n;
      await staking.connect(user1).earlyWithdraw();

      expect(await token.balanceOf(DEAD)).to.equal(penalty);
    });

    it("emits EarlyWithdrawal event", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      await staking.connect(user1).lock(GOLD_THRESHOLD, LOCK_30D);

      await expect(staking.connect(user1).earlyWithdraw())
        .to.emit(staking, "EarlyWithdrawal");
    });
  });

  // ── FeeController ──────────────────────────────────────────────────────────

  describe("FeeController", function () {
    const PaymentType = { Fiat: 0, Crypto: 1, SRX: 2 };

    it("SRX payments are always 0% fee", async function () {
      const { feeCtrl, user1 } = await loadFixture(deployFixture);
      expect(await feeCtrl.calculateFee(user1.address, PaymentType.SRX)).to.equal(0n);
    });

    it("no-stake user pays full base fee for fiat", async function () {
      const { feeCtrl, user1 } = await loadFixture(deployFixture);
      const fee = await feeCtrl.calculateFee(user1.address, PaymentType.Fiat);
      expect(fee).to.equal(150n); // 1.5% = 150 bps
    });

    it("no-stake user pays reduced fee for crypto (75% of base)", async function () {
      const { feeCtrl, user1 } = await loadFixture(deployFixture);
      const fee = await feeCtrl.calculateFee(user1.address, PaymentType.Crypto);
      expect(fee).to.equal(112n); // 1.5% * 75% = 1.125% → 112 bps (truncated)
    });

    it("Slate tier applies 25% discount on fiat", async function () {
      const { staking, feeCtrl, user3 } = await loadFixture(deployFixture);
      await staking.connect(user3).lock(BRONZE_THRESHOLD, LOCK_30D);

      const fee = await feeCtrl.calculateFee(user3.address, PaymentType.Fiat);
      // base 150bps * (1 - 0.25) = 112bps
      expect(fee).to.equal(112n);
    });

    it("Onyx tier applies 60% discount on fiat", async function () {
      const { staking, feeCtrl, user2 } = await loadFixture(deployFixture);
      await staking.connect(user2).lock(SILVER_THRESHOLD, LOCK_30D);

      const fee = await feeCtrl.calculateFee(user2.address, PaymentType.Fiat);
      // base 150bps * (1 - 0.60) = 60bps
      expect(fee).to.equal(60n);
    });

    it("Obsidian tier pays the 15 bps floor fee on fiat, not literally 0", async function () {
      const { staking, feeCtrl, user1 } = await loadFixture(deployFixture);
      await staking.connect(user1).lock(GOLD_THRESHOLD, LOCK_30D);

      const fee = await feeCtrl.calculateFee(user1.address, PaymentType.Fiat);
      expect(fee).to.equal(15n); // 100% discount clamped up to the minFeeBps floor
    });

    it("feeBreakdown returns correct tier name", async function () {
      const { staking, feeCtrl, user1 } = await loadFixture(deployFixture);
      await staking.connect(user1).lock(GOLD_THRESHOLD, LOCK_30D);

      const breakdown = await feeCtrl.feeBreakdown(user1.address, PaymentType.Fiat);
      expect(breakdown.tierName).to.equal("Obsidian");
    });

    it("governance can update base fee", async function () {
      const { feeCtrl, admin, user1 } = await loadFixture(deployFixture);
      const GOVERNANCE_ROLE = await feeCtrl.GOVERNANCE_ROLE();

      await feeCtrl.connect(admin).setBaseFeeRate(200n); // change to 2%
      const fee = await feeCtrl.calculateFee(user1.address, PaymentType.Fiat);
      expect(fee).to.equal(200n);
    });
  });

  // ── Discount persistence across lock/unlock ────────────────────────────────

  // ── Tier parameter governance ──────────────────────────────────────────────

  describe("updateTierParams()", function () {
    it("governance can update Slate minSRX within valid range", async function () {
      const { staking, admin } = await loadFixture(deployFixture);
      // Slate default: 50k. Onyx default: 250k. Valid new Slate: 100k (< 250k)
      const newMin = ethers.parseUnits("100000", 18);
      await expect(staking.connect(admin).updateTierParams(1n, newMin, 2500n))
        .to.emit(staking, "TierParamsUpdated");
    });

    it("reverts if Slate minSRX >= Onyx minSRX (A5-H-01: tier monotonicity)", async function () {
      const { staking, admin } = await loadFixture(deployFixture);
      // Onyx default is 250k. Setting Slate to 250k would break ordering.
      const badMin = ethers.parseUnits("250000", 18);
      await expect(staking.connect(admin).updateTierParams(1n, badMin, 2500n))
        .to.be.revertedWithCustomError(staking, "InvalidBps");
    });

    it("reverts if Onyx minSRX <= Slate minSRX (A5-H-01)", async function () {
      const { staking, admin } = await loadFixture(deployFixture);
      // Slate default is 50k. Setting Onyx to 50k would break ordering.
      const badMin = ethers.parseUnits("50000", 18);
      await expect(staking.connect(admin).updateTierParams(2n, badMin, 6000n))
        .to.be.revertedWithCustomError(staking, "InvalidBps");
    });

    it("reverts if Onyx minSRX >= Obsidian minSRX (A5-H-01)", async function () {
      const { staking, admin } = await loadFixture(deployFixture);
      // Obsidian default is 1M. Setting Onyx to 1M would break ordering.
      const badMin = ethers.parseUnits("1000000", 18);
      await expect(staking.connect(admin).updateTierParams(2n, badMin, 6000n))
        .to.be.revertedWithCustomError(staking, "InvalidBps");
    });

    it("reverts if Obsidian minSRX <= Onyx minSRX (A5-H-01)", async function () {
      const { staking, admin } = await loadFixture(deployFixture);
      // Onyx default is 250k. Setting Obsidian to 250k would break ordering.
      const badMin = ethers.parseUnits("250000", 18);
      await expect(staking.connect(admin).updateTierParams(3n, badMin, 10000n))
        .to.be.revertedWithCustomError(staking, "InvalidBps");
    });
  });

  describe("Tier lifecycle", function () {
    it("discount applies while locked, gone after unlock", async function () {
      const { staking, feeCtrl, user1 } = await loadFixture(deployFixture);
      const PaymentType = { Fiat: 0 };

      await staking.connect(user1).lock(GOLD_THRESHOLD, LOCK_7D);

      const feeDuringLock = await feeCtrl.calculateFee(user1.address, PaymentType.Fiat);
      expect(feeDuringLock).to.equal(15n); // Obsidian = 100% discount, clamped to the 15 bps floor

      await time.increase(LOCK_7D + 1);
      await staking.connect(user1).unlock();

      const feeAfterUnlock = await feeCtrl.calculateFee(user1.address, PaymentType.Fiat);
      expect(feeAfterUnlock).to.equal(150n); // Back to full fee
    });
  });

  // ── Tier is keyed off WEIGHTED stake, not raw principal ────────────────────
  // A longer lock lowers the raw SRX needed to reach a tier, since tier lookup
  // uses positions[user].weightedAmount (principal x duration multiplier) —
  // the same figure already used for incentive-pool weighting. This closes the
  // "rotate a 7-day lock forever, reach Obsidian with zero real commitment" gap:
  // getting the *cheapest* route to a tier requires actually locking longer.
  describe("Tier is duration-weighted, not principal-only", function () {
    const LOCK_90D  = 90  * 86400;
    const LOCK_180D = 180 * 86400;

    it("a 7-day lock needs the FULL raw threshold to reach Obsidian", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      // 1.00x multiplier at 7 days -> weighted == raw. Exactly at threshold reaches Obsidian.
      await staking.connect(user1).lock(GOLD_THRESHOLD, LOCK_7D);
      expect(await staking.getTier(user1.address)).to.equal(3n); // Obsidian

      const pos = await staking.getPosition(user1.address);
      expect(pos.weightedAmount).to.equal(GOLD_THRESHOLD);
    });

    it("a 7-day lock ONE UNIT below the raw threshold does NOT reach Obsidian", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      await staking.connect(user1).lock(GOLD_THRESHOLD - 1n, LOCK_7D);
      expect(await staking.getTier(user1.address)).to.equal(2n); // Onyx, not Obsidian
    });

    it("a 180-day lock reaches Obsidian with HALF the raw SRX (2.00x multiplier)", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      const halfThreshold = GOLD_THRESHOLD / 2n;
      await staking.connect(user1).lock(halfThreshold, LOCK_180D);

      const pos = await staking.getPosition(user1.address);
      expect(pos.weightedAmount).to.equal(GOLD_THRESHOLD); // 500k * 2.00x == 1M weighted

      expect(await staking.getTier(user1.address)).to.equal(3n); // Obsidian
    });

    it("the same half-threshold amount at a 7-day lock does NOT reach Obsidian", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      const halfThreshold = GOLD_THRESHOLD / 2n;
      // Same raw SRX as the 180-day case above, but shortest lock -> 1.00x, no discount on the threshold.
      await staking.connect(user1).lock(halfThreshold, LOCK_7D);
      expect(await staking.getTier(user1.address)).to.equal(2n); // Onyx only
    });

    it("a 90-day lock reaches Obsidian at 1/1.5x the raw SRX (1.50x multiplier)", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      // Smallest amount whose weighted value (amount * 150/100) >= GOLD_THRESHOLD, rounded up.
      const ninetyDayAmt = (GOLD_THRESHOLD * 100n + 149n) / 150n;
      await staking.connect(user1).lock(ninetyDayAmt, LOCK_90D);
      expect(await staking.getTier(user1.address)).to.equal(3n); // Obsidian
    });

    it("weightedAmount (and therefore tier) does not decay as a lock approaches expiry", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      const halfThreshold = GOLD_THRESHOLD / 2n;
      await staking.connect(user1).lock(halfThreshold, LOCK_180D);
      expect(await staking.getTier(user1.address)).to.equal(3n); // Obsidian from day 1

      await time.increase(179 * 86400); // one day before expiry
      expect(await staking.getTier(user1.address)).to.equal(3n); // still Obsidian, no decay
    });
  });

  // ── Ecosystem participation incentives ─────────────────────────────────────
  //
  // These tests use a separate fixture that funds the reward pool and sets a
  // non-zero emission rate. The base fixture has rewardRate=0 so existing tests
  // are unaffected.

  describe("Ecosystem incentives (rewards)", function () {

    // 100 SRX per second makes the arithmetic easy to verify
    const REWARD_RATE     = ethers.parseUnits("100", 18);
    const REWARD_POOL     = ethers.parseUnits("10000000", 18); // 10M SRX — well above test needs
    const STAKE_AMOUNT    = ethers.parseUnits("100000", 18);   // 100K SRX (Slate tier)
    const LOCK_90D        = 90 * 86400;
    const LOCK_180D       = 180 * 86400;

    async function deployRewardsFixture() {
      const base = await loadFixture(deployFixture);
      const { token, staking, admin } = base;
      const stakingAddr = await staking.getAddress();

      // Fund the reward pool: transfer tokens to the contract, then register them
      await token.connect(admin).transfer(stakingAddr, REWARD_POOL);
      await staking.connect(admin).notifyRewardAmount(REWARD_POOL);

      // Turn on emissions
      await staking.connect(admin).setRewardRate(REWARD_RATE);

      // Give users enough to stake
      await token.connect(admin).transfer(base.user1.address, STAKE_AMOUNT * 2n);
      await token.connect(admin).transfer(base.user2.address, STAKE_AMOUNT * 2n);
      await token.connect(base.user1).approve(stakingAddr, ethers.MaxUint256);
      await token.connect(base.user2).approve(stakingAddr, ethers.MaxUint256);

      return { ...base, stakingAddr };
    }

    it("notifyRewardAmount registers pool correctly", async function () {
      const { staking } = await loadFixture(deployRewardsFixture);
      expect(await staking.rewardPool()).to.equal(REWARD_POOL);
    });

    it("rewardRate is set correctly", async function () {
      const { staking } = await loadFixture(deployRewardsFixture);
      expect(await staking.rewardRate()).to.equal(REWARD_RATE);
    });

    it("single staker earns full emission over time", async function () {
      const { staking, user1 } = await loadFixture(deployRewardsFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      await time.increase(100); // 100 seconds

      // Single staker gets all emissions: 100 SRX/sec × 100 sec = 10,000 SRX
      const expected = ethers.parseUnits("10000", 18);
      const tolerance = ethers.parseUnits("1", 18); // 1 SRX tolerance for timing
      expect(await staking.earned(user1.address)).to.be.closeTo(expected, tolerance);
    });

    it("two stakers with same amount and duration split rewards equally", async function () {
      const { staking, user1, user2 } = await loadFixture(deployRewardsFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      await staking.connect(user2).lock(STAKE_AMOUNT, LOCK_7D);
      await time.increase(200); // 200 seconds

      // Total = 100 × 200 = 20,000 SRX, each gets ~10,000.
      // Allow 200 SRX tolerance: user1 may have earned up to 2 blocks as sole staker.
      const earned1 = await staking.earned(user1.address);
      const earned2 = await staking.earned(user2.address);
      const tolerance = ethers.parseUnits("200", 18);
      expect(earned1).to.be.closeTo(earned2, tolerance);
    });

    it("180-day lock earns 2x the incentives of a 7-day lock (same amount)", async function () {
      const { staking, user1, user2 } = await loadFixture(deployRewardsFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);   // 1.0× weighted
      await staking.connect(user2).lock(STAKE_AMOUNT, LOCK_180D); // 2.0× weighted

      await time.increase(300);

      // user2 weighted = 2 × user1 weighted → user2 earns 2× user1
      const earned1 = await staking.earned(user1.address);
      const earned2 = await staking.earned(user2.address);

      // earned2 / earned1 ≈ 2.0
      // total = 100 × 300 = 30,000 SRX
      // user1 share = 1/(1+2) = 10,000, user2 share = 2/(1+2) = 20,000
      const expected1 = ethers.parseUnits("10000", 18);
      const expected2 = ethers.parseUnits("20000", 18);
      const tolerance = ethers.parseUnits("200", 18);
      expect(earned1).to.be.closeTo(expected1, tolerance);
      expect(earned2).to.be.closeTo(expected2, tolerance);
    });

    it("90-day lock earns 1.5x the incentives of a 7-day lock", async function () {
      const { staking, user1, user2 } = await loadFixture(deployRewardsFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);  // weight 100
      await staking.connect(user2).lock(STAKE_AMOUNT, LOCK_90D); // weight 150

      await time.increase(250);

      // total weighted = 250, user1 = 100/250 = 40%, user2 = 150/250 = 60%
      // total = 100 × 250 = 25,000; user1 = 10,000; user2 = 15,000
      const expected1 = ethers.parseUnits("10000", 18);
      const expected2 = ethers.parseUnits("15000", 18);
      const tolerance = ethers.parseUnits("200", 18);
      expect(await staking.earned(user1.address)).to.be.closeTo(expected1, tolerance);
      expect(await staking.earned(user2.address)).to.be.closeTo(expected2, tolerance);
    });

    it("claimRewards transfers earned incentives and resets to zero", async function () {
      const { staking, token, user1, stakingAddr } = await loadFixture(deployRewardsFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      await time.increase(100);

      const balBefore = await token.balanceOf(user1.address);
      const earnedAmt = await staking.earned(user1.address);
      await staking.connect(user1).claimRewards();

      expect(await staking.earned(user1.address)).to.equal(0n);
      // Allow 200 SRX: one extra block accrues between earnedAmt snapshot and claimRewards tx
      expect(await token.balanceOf(user1.address)).to.be.closeTo(
        balBefore + earnedAmt,
        ethers.parseUnits("200", 18)
      );
    });

    it("rewards auto-paid on normal unlock", async function () {
      const { staking, token, user1 } = await loadFixture(deployRewardsFixture);

      const before = await token.balanceOf(user1.address);
      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);

      await time.increase(LOCK_7D + 1);
      await staking.connect(user1).unlock();

      const received = (await token.balanceOf(user1.address)) - before;
      // Received = principal + incentives. Incentives > 0.
      expect(received).to.be.gt(STAKE_AMOUNT);
    });

    it("rewards auto-paid on earlyWithdraw despite principal penalty", async function () {
      const { staking, token, user1 } = await loadFixture(deployRewardsFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_30D);
      await time.increase(1000); // accrue some incentives

      const earnedBefore = await staking.earned(user1.address);
      expect(earnedBefore).to.be.gt(0n); // sanity: something was earned

      const tokenBefore = await token.balanceOf(user1.address);
      await staking.connect(user1).earlyWithdraw();

      const penalty  = (STAKE_AMOUNT * 1000n) / 10000n;
      const received = (await token.balanceOf(user1.address)) - tokenBefore;

      // Received = (principal - penalty) + earned incentives
      expect(received).to.be.gte(STAKE_AMOUNT - penalty); // at minimum the net principal
      expect(received).to.be.gt(STAKE_AMOUNT - penalty);  // incentives pushed it higher
    });

    it("rewardPool decrements as rewards are claimed", async function () {
      const { staking, user1 } = await loadFixture(deployRewardsFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      await time.increase(100);

      const poolBefore = await staking.rewardPool();
      await staking.connect(user1).claimRewards();
      const poolAfter = await staking.rewardPool();

      expect(poolAfter).to.be.lt(poolBefore);
    });

    it("setRewardRate(0) pauses all incentive accrual", async function () {
      const { staking, admin, user1 } = await loadFixture(deployRewardsFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      await time.increase(100);

      const earnedBeforePause = await staking.earned(user1.address);

      await staking.connect(admin).setRewardRate(0n);
      await time.increase(1000); // time passes but rate is 0

      const earnedAfterPause = await staking.earned(user1.address);

      // Allow 200 SRX: setRewardRate tx itself mines one block, accruing at old rate
      expect(earnedAfterPause).to.be.closeTo(earnedBeforePause, ethers.parseUnits("200", 18));
    });

    it("addToPosition with longer duration upgrades multiplier", async function () {
      const { staking, user1, stakingAddr } = await loadFixture(deployRewardsFixture);

      // Start with 7-day lock (1.0× multiplier)
      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      const weightBefore = (await staking.positions(user1.address)).weightedAmount;

      // Add tokens and upgrade to 180-day (2.0× multiplier)
      await staking.connect(user1).addToPosition(STAKE_AMOUNT, LOCK_180D);
      const weightAfter = (await staking.positions(user1.address)).weightedAmount;

      // New total amount = 2 × STAKE_AMOUNT at 2.0× = 4 × STAKE_AMOUNT weighted
      const expected = (STAKE_AMOUNT * 2n * 200n) / 100n;
      expect(weightAfter).to.equal(expected);
      expect(weightAfter).to.be.gt(weightBefore);
    });

    it("notifyRewardAmount reverts if amount exceeds unallocated balance", async function () {
      const { staking, admin, token, stakingAddr } = await loadFixture(deployRewardsFixture);

      // Lock some SRX (so totalLocked > 0)
      await staking.connect(admin).lock
        ? await token.connect(admin).transfer(stakingAddr, ethers.parseUnits("1", 18))
        : null;

      // Try to register more than (balance - totalLocked)
      const overAmount = (await staking.rewardPool()) + ethers.parseUnits("999999999", 18);
      await expect(
        staking.connect(admin).notifyRewardAmount(overAmount)
      ).to.be.revertedWithCustomError(staking, "PoolAmountExceedsAvailable");
    });

    it("claimRewards reverts if no position", async function () {
      const { staking, user1 } = await loadFixture(deployRewardsFixture);
      await expect(
        staking.connect(user1).claimRewards()
      ).to.be.revertedWithCustomError(staking, "NoPosition");
    });

    it("claimRewards reverts if nothing earned yet", async function () {
      const { staking, admin, user1 } = await loadFixture(deployRewardsFixture);
      // Pause emissions so no rewards accrue regardless of block timing
      await staking.connect(admin).setRewardRate(0n);
      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      await expect(
        staking.connect(user1).claimRewards()
      ).to.be.revertedWithCustomError(staking, "NothingToClaim");
    });
  });

  // ── Bonus reward token (real yield / USDC) ─────────────────────────────────
  //
  // Tests the secondary reward accumulator that runs in parallel with SRX
  // incentives. This is the expansion port for real yield from gateway fees.

  describe("Bonus reward token (real yield)", function () {

    const BONUS_RATE   = ethers.parseUnits("1", 6);       // 1 USDC per second
    const BONUS_POOL   = ethers.parseUnits("1000000", 6); // 1M USDC pool
    const STAKE_AMOUNT = ethers.parseUnits("100000", 18); // 100K SRX stake
    const LOCK_7D      = 7 * 86400;
    const LOCK_180D    = 180 * 86400;

    async function deployBonusFixture() {
      const base = await loadFixture(deployFixture);
      const { token, staking, admin } = base;
      const stakingAddr = await staking.getAddress();

      // Deploy mock USDC (6 decimals)
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
      await usdc.waitForDeployment();

      // Configure bonus reward token
      await staking.connect(admin).setBonusRewardToken(await usdc.getAddress());

      // Fund staking contract with USDC and register pool
      await usdc.mint(stakingAddr, BONUS_POOL);
      await staking.connect(admin).notifyBonusRewardAmount(BONUS_POOL);

      // Turn on bonus emissions
      await staking.connect(admin).setBonusRewardRate(BONUS_RATE);

      // Fund test users with SRX
      await token.connect(admin).transfer(base.user1.address, STAKE_AMOUNT * 2n);
      await token.connect(admin).transfer(base.user2.address, STAKE_AMOUNT * 2n);
      await token.connect(base.user1).approve(stakingAddr, ethers.MaxUint256);
      await token.connect(base.user2).approve(stakingAddr, ethers.MaxUint256);

      return { ...base, usdc, stakingAddr };
    }

    it("setBonusRewardToken sets the token and emits event", async function () {
      const { staking, admin } = await loadFixture(deployFixture);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
      await usdc.waitForDeployment();

      await expect(staking.connect(admin).setBonusRewardToken(await usdc.getAddress()))
        .to.emit(staking, "BonusRewardTokenSet")
        .withArgs(await usdc.getAddress());

      expect(await staking.bonusRewardToken()).to.equal(await usdc.getAddress());
    });

    it("setBonusRewardToken reverts if called a second time", async function () {
      const { staking } = await loadFixture(deployBonusFixture);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc2 = await MockERC20.deploy("USD Coin 2", "USDC2", 6);
      await usdc2.waitForDeployment();

      await expect(
        staking.connect((await ethers.getSigners())[0]).setBonusRewardToken(await usdc2.getAddress())
      ).to.be.revertedWithCustomError(staking, "BonusTokenAlreadySet");
    });

    it("setBonusRewardToken reverts with zero address", async function () {
      const { staking, admin } = await loadFixture(deployFixture);
      await expect(
        staking.connect(admin).setBonusRewardToken(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(staking, "ZeroAddress");
    });

    it("notifyBonusRewardAmount registers pool and emits event", async function () {
      const { staking } = await loadFixture(deployBonusFixture);
      expect(await staking.bonusRewardPool()).to.equal(BONUS_POOL);
    });

    it("notifyBonusRewardAmount reverts if bonus token not set", async function () {
      const { staking, admin } = await loadFixture(deployFixture);
      await expect(
        staking.connect(admin).notifyBonusRewardAmount(1_000_000n)
      ).to.be.revertedWithCustomError(staking, "BonusTokenNotSet");
    });

    it("setBonusRewardRate sets rate and emits event", async function () {
      const { staking } = await loadFixture(deployBonusFixture);
      expect(await staking.bonusRewardRate()).to.equal(BONUS_RATE);
    });

    it("setBonusRewardRate reverts if bonus token not set", async function () {
      const { staking, admin } = await loadFixture(deployFixture);
      await expect(
        staking.connect(admin).setBonusRewardRate(1_000n)
      ).to.be.revertedWithCustomError(staking, "BonusTokenNotSet");
    });

    it("single staker earns full bonus emission over time", async function () {
      const { staking, user1 } = await loadFixture(deployBonusFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      await time.increase(100); // 100 seconds at 1 USDC/sec = 100 USDC

      const expected  = 100n * BONUS_RATE;
      const tolerance = BONUS_RATE * 3n; // 3 seconds timing tolerance
      expect(await staking.earnedBonus(user1.address)).to.be.closeTo(expected, tolerance);
    });

    it("two stakers split bonus rewards proportionally to weighted stake", async function () {
      const { staking, user1, user2 } = await loadFixture(deployBonusFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);   // 1× weight
      await staking.connect(user2).lock(STAKE_AMOUNT, LOCK_180D); // 2× weight

      await time.increase(300); // 300 USDC total

      // user1: 1/3 = 100 USDC, user2: 2/3 = 200 USDC
      const earned1 = await staking.earnedBonus(user1.address);
      const earned2 = await staking.earnedBonus(user2.address);

      const tolerance = BONUS_RATE * 5n;
      expect(earned1).to.be.closeTo(100n * BONUS_RATE, tolerance);
      expect(earned2).to.be.closeTo(200n * BONUS_RATE, tolerance);
    });

    it("claimBonusRewards transfers USDC and resets earnedBonus to zero", async function () {
      const { staking, usdc, user1 } = await loadFixture(deployBonusFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      await time.increase(100);

      const balBefore  = await usdc.balanceOf(user1.address);
      const earnedAmt  = await staking.earnedBonus(user1.address);
      await staking.connect(user1).claimBonusRewards();

      expect(await staking.earnedBonus(user1.address)).to.equal(0n);
      expect(await usdc.balanceOf(user1.address)).to.be.closeTo(
        balBefore + earnedAmt,
        BONUS_RATE * 3n
      );
    });

    it("bonus rewards auto-paid on normal unlock", async function () {
      const { staking, usdc, user1 } = await loadFixture(deployBonusFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      await time.increase(LOCK_7D + 1);
      await staking.connect(user1).unlock();

      // USDC balance should be > 0 — rewards were paid out
      expect(await usdc.balanceOf(user1.address)).to.be.gt(0n);
    });

    it("bonus rewards auto-paid on earlyWithdraw", async function () {
      const { staking, usdc, user1 } = await loadFixture(deployBonusFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      await time.increase(1000);
      await staking.connect(user1).earlyWithdraw();

      expect(await usdc.balanceOf(user1.address)).to.be.gt(0n);
    });

    it("bonusRewardPool decrements as bonus rewards are claimed", async function () {
      const { staking, user1 } = await loadFixture(deployBonusFixture);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      await time.increase(100);

      const poolBefore = await staking.bonusRewardPool();
      await staking.connect(user1).claimBonusRewards();
      expect(await staking.bonusRewardPool()).to.be.lt(poolBefore);
    });

    it("claimBonusRewards reverts if bonus token not set", async function () {
      const { staking, user1, admin } = await loadFixture(deployFixture);
      const stakingAddr = await staking.getAddress();
      const tok = await ethers.getContractFactory("SRXToken");

      // Lock some SRX using the base fixture token
      const MockLZ = await ethers.getContractFactory("MockLZEndpoint");
      const ep = await MockLZ.deploy(40161);
      const SRXToken = await ethers.getContractFactory("SRXToken");
      const t = await SRXToken.deploy(await ep.getAddress(), admin.address);
      await t.connect(admin).genesis(admin.address);
      await t.connect(admin).transfer(user1.address, ethers.parseUnits("100000", 18));
      await t.connect(user1).approve(stakingAddr, ethers.MaxUint256);

      await expect(
        staking.connect(user1).claimBonusRewards()
      ).to.be.revertedWithCustomError(staking, "BonusTokenNotSet");
    });

    it("claimBonusRewards reverts with NoPosition if user has no stake", async function () {
      const { staking, user1 } = await loadFixture(deployBonusFixture);
      await expect(
        staking.connect(user1).claimBonusRewards()
      ).to.be.revertedWithCustomError(staking, "NoPosition");
    });

    it("claimBonusRewards reverts with NothingToClaim when rate is zero", async function () {
      const { staking, admin, user1 } = await loadFixture(deployBonusFixture);

      await staking.connect(admin).setBonusRewardRate(0n);
      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);

      await expect(
        staking.connect(user1).claimBonusRewards()
      ).to.be.revertedWithCustomError(staking, "NothingToClaim");
    });

    it("earnedBonus is zero before any stake or rate is configured", async function () {
      const { staking, user1 } = await loadFixture(deployBonusFixture);
      expect(await staking.earnedBonus(user1.address)).to.equal(0n);
    });

    it("SRX incentives and bonus rewards accrue independently", async function () {
      const { token, staking, usdc, admin, user1, stakingAddr } = await loadFixture(deployBonusFixture);

      // Also fund SRX reward pool
      const SRX_POOL = ethers.parseUnits("1000000", 18);
      const SRX_RATE = ethers.parseUnits("10", 18); // 10 SRX/sec
      await token.connect(admin).transfer(stakingAddr, SRX_POOL);
      await staking.connect(admin).notifyRewardAmount(SRX_POOL);
      await staking.connect(admin).setRewardRate(SRX_RATE);

      await staking.connect(user1).lock(STAKE_AMOUNT, LOCK_7D);
      await time.increase(100);

      const srxEarned   = await staking.earned(user1.address);
      const bonusEarned = await staking.earnedBonus(user1.address);

      // Both should be > 0 and independent
      expect(srxEarned).to.be.gt(0n);
      expect(bonusEarned).to.be.gt(0n);

      // SRX earned ≈ 10 SRX/s × 100s = 1000 SRX
      expect(srxEarned).to.be.closeTo(
        ethers.parseUnits("1000", 18),
        ethers.parseUnits("20", 18)
      );

      // USDC earned ≈ 1 USDC/s × 100s = 100 USDC
      expect(bonusEarned).to.be.closeTo(
        100n * BONUS_RATE,
        BONUS_RATE * 5n
      );
    });
  });

  // ── Round 5: stranded pool rescue (R5-01) ─────────────────────────────────
  //    Parity with StabilisationFund.rescueStrandedPool (A5-M-02). When all
  //    stakers exit, the accumulator freezes and the remaining pool would be
  //    permanently stranded without these functions.

  describe("Stranded pool rescue (R5-01)", function () {
    const POOL  = ethers.parseUnits("1000000", 18); // 1M SRX
    const RATE  = ethers.parseUnits("1", 18);       // 1 SRX/s → 7d emission = 604,800 SRX

    it("governance rescues SRX stranded after all stakers exit", async function () {
      const { staking, token, admin, user1 } = await loadFixture(deployFixture);
      const stakingAddr = await staking.getAddress();

      await staking.connect(user1).lock(BRONZE_THRESHOLD, LOCK_7D);
      await token.connect(admin).transfer(stakingAddr, POOL);
      await staking.connect(admin).notifyRewardAmount(POOL);
      await staking.connect(admin).setRewardRate(RATE);

      // Lock expires → sole staker exits (their accrued share auto-claims on unlock)
      await time.increase(LOCK_7D + 1);
      await staking.connect(user1).unlock();
      expect(await staking.totalWeightedStake()).to.equal(0n);

      const stranded = await staking.rewardPool();
      expect(stranded).to.be.gt(0n); // 1M funded > ~604.8K emitted

      const before = await token.balanceOf(admin.address);
      await expect(staking.connect(admin).rescueStrandedPool(admin.address))
        .to.emit(staking, "RewardPoolReset")
        .withArgs(admin.address, stranded);

      expect(await token.balanceOf(admin.address)).to.equal(before + stranded);
      expect(await staking.rewardPool()).to.equal(0n);
      expect(await staking.rewardRate()).to.equal(0n);
    });

    it("rescues stranded bonus pool after all stakers exit", async function () {
      const { staking, token, admin, user1 } = await loadFixture(deployFixture);
      const stakingAddr = await staking.getAddress();

      // Configure bonus token (mock USDC) + fund + emit
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
      await usdc.waitForDeployment();
      const BONUS_POOL = 1_000_000_000n; // 1,000 USDC (6-dec)
      await staking.connect(admin).setBonusRewardToken(await usdc.getAddress());
      await usdc.mint(stakingAddr, BONUS_POOL);
      await staking.connect(admin).notifyBonusRewardAmount(BONUS_POOL);
      await staking.connect(admin).setBonusRewardRate(1_000n); // slow drip

      await staking.connect(user1).lock(BRONZE_THRESHOLD, LOCK_7D);
      await time.increase(LOCK_7D + 1);
      await staking.connect(user1).unlock();
      expect(await staking.totalWeightedStake()).to.equal(0n);

      const stranded = await staking.bonusRewardPool();
      expect(stranded).to.be.gt(0n);

      await expect(staking.connect(admin).rescueStrandedBonusPool(admin.address))
        .to.emit(staking, "BonusRewardPoolReset")
        .withArgs(admin.address, stranded);

      expect(await usdc.balanceOf(admin.address)).to.equal(stranded);
      expect(await staking.bonusRewardPool()).to.equal(0n);
      expect(await staking.bonusRewardRate()).to.equal(0n);
    });

    it("reverts NoStrandedPool while a staker is still active", async function () {
      const { staking, token, admin, user1 } = await loadFixture(deployFixture);
      await staking.connect(user1).lock(BRONZE_THRESHOLD, LOCK_7D);
      await token.connect(admin).transfer(await staking.getAddress(), POOL);
      await staking.connect(admin).notifyRewardAmount(POOL);

      await expect(staking.connect(admin).rescueStrandedPool(admin.address))
        .to.be.revertedWithCustomError(staking, "NoStrandedPool");
    });

    it("reverts NoStrandedPool when the pool is empty", async function () {
      const { staking, admin } = await loadFixture(deployFixture);
      await expect(staking.connect(admin).rescueStrandedPool(admin.address))
        .to.be.revertedWithCustomError(staking, "NoStrandedPool");
    });

    it("reverts for non-governance caller", async function () {
      const { staking, user1 } = await loadFixture(deployFixture);
      await expect(staking.connect(user1).rescueStrandedPool(user1.address))
        .to.be.reverted; // AccessControl: missing GOVERNANCE_ROLE
    });
  });
});
