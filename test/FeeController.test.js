const { expect }  = require("chai");
const { ethers, upgrades } = require("hardhat");
const { allocationSource } = require("./helpers/allocationSource");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/**
 * FeeController tests.
 *
 * The FeeController is a pure view contract — the gateway calls calculateFee()
 * via eth_call at zero gas cost. Tests verify:
 *  - Correct fee for each payment type (Fiat / Crypto / SRX)
 *  - Staking tier discounts applied correctly
 *  - Fee clamping to [minFeeBps, maxFeeBps]
 *  - Governance parameter updates
 *  - Pause behaviour
 *  - feeBreakdown() human-readable output
 */
describe("FeeController", function () {

  const BPS = 10_000n;
  const PaymentType = { Fiat: 0, Crypto: 1, SRX: 2 };

  async function deployFixture() {
    const [admin, governance, gateway, user, bronze, silver, gold, stranger] =
      await ethers.getSigners();

    // ── Deploy SRXToken (needed for staking) ──────────────────────────────
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    // ── Deploy SRXStaking (UUPS) ──────────────────────────────────────────
    const SRXStaking = await ethers.getContractFactory("SRXStaking");
    const staking = await SRXStaking.deploy(...[await token.getAddress(), admin.address, await allocationSource(token)]);
    await staking.waitForDeployment();

    // ── Deploy FeeController (UUPS) ───────────────────────────────────────
    const FeeController = await ethers.getContractFactory("FeeController");
    const fee = await FeeController.deploy(...[await staking.getAddress(), admin.address]);
    await fee.waitForDeployment();

    // ── Grant GOVERNANCE_ROLE to governance signer ────────────────────────
    const GOV_ROLE = await fee.GOVERNANCE_ROLE();
    await fee.connect(admin).grantRole(GOV_ROLE, governance.address);
    const STAKING_GOV = await staking.GOVERNANCE_ROLE();
    await staking.connect(admin).grantRole(STAKING_GOV, governance.address);

    // ── Seed staking users ────────────────────────────────────────────────
    // Slate: 50,000 SRX, Onyx: 250,000 SRX, Obsidian: 1,000,000 SRX
    const BRONZE_AMT = ethers.parseUnits("50000",    18);
    const SILVER_AMT = ethers.parseUnits("250000",   18);
    const GOLD_AMT   = ethers.parseUnits("1000000",  18);

    for (const [holder, amount] of [[bronze, BRONZE_AMT], [silver, SILVER_AMT], [gold, GOLD_AMT]]) {
      await token.connect(admin).transfer(holder.address, amount);
      await token.connect(holder).approve(await staking.getAddress(), amount);
      await staking.connect(holder).lock(amount, 30 * 86400); // 30-day lock
    }

    return {
      fee, staking, token,
      admin, governance, gateway, user, bronze, silver, gold, stranger,
      BRONZE_AMT, SILVER_AMT, GOLD_AMT,
    };
  }

  // ── Deployment ─────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets default baseFeeRateBps to 150 (1.50%)", async function () {
      const { fee } = await loadFixture(deployFixture);
      expect(await fee.baseFeeRateBps()).to.equal(150n);
    });

    it("sets cryptoFeeMultiplierBps to 7500 (75%)", async function () {
      const { fee } = await loadFixture(deployFixture);
      expect(await fee.cryptoFeeMultiplierBps()).to.equal(7_500n);
    });

    it("sets maxFeeBps to 500 (5.00%)", async function () {
      const { fee } = await loadFixture(deployFixture);
      expect(await fee.maxFeeBps()).to.equal(500n);
    });

    it("sets minFeeBps to 15 (0.15% floor -- Obsidian tier is never literally free)", async function () {
      const { fee } = await loadFixture(deployFixture);
      expect(await fee.minFeeBps()).to.equal(15n);
    });

    it("is not paused at deployment", async function () {
      const { fee } = await loadFixture(deployFixture);
      expect(await fee.paused()).to.be.false;
    });
  });

  // ── SRX payment — always zero ──────────────────────────────────────────────

  describe("SRX payment (always 0% fee)", function () {
    it("returns 0 for SRX payment regardless of staking tier — no staker", async function () {
      const { fee, stranger } = await loadFixture(deployFixture);
      expect(await fee.calculateFee(stranger.address, PaymentType.SRX)).to.equal(0n);
    });

    it("returns 0 for SRX payment — bronze staker", async function () {
      const { fee, bronze } = await loadFixture(deployFixture);
      expect(await fee.calculateFee(bronze.address, PaymentType.SRX)).to.equal(0n);
    });

    it("returns 0 for SRX payment — gold staker", async function () {
      const { fee, gold } = await loadFixture(deployFixture);
      expect(await fee.calculateFee(gold.address, PaymentType.SRX)).to.equal(0n);
    });
  });

  // ── Fiat payment ───────────────────────────────────────────────────────────

  describe("Fiat payment fees", function () {
    it("charges full base fee (150 bps) with no staking tier", async function () {
      const { fee, stranger } = await loadFixture(deployFixture);
      expect(await fee.calculateFee(stranger.address, PaymentType.Fiat)).to.equal(150n);
    });

    it("applies 25% bronze discount: 150 × 0.75 = 112 bps", async function () {
      const { fee, bronze } = await loadFixture(deployFixture);
      // 150 * (10000 - 2500) / 10000 = 150 * 7500 / 10000 = 112.5 → 112 (floor)
      expect(await fee.calculateFee(bronze.address, PaymentType.Fiat)).to.equal(112n);
    });

    it("applies 60% silver discount: 150 × 0.40 = 60 bps", async function () {
      const { fee, silver } = await loadFixture(deployFixture);
      // 150 * (10000 - 6000) / 10000 = 150 * 4000 / 10000 = 60
      expect(await fee.calculateFee(silver.address, PaymentType.Fiat)).to.equal(60n);
    });

    it("applies 100% gold discount: clamped to the 15 bps floor, not 0", async function () {
      const { fee, gold } = await loadFixture(deployFixture);
      // 150 * (10000 - 10000) / 10000 = 0, then clamped up to minFeeBps = 15
      expect(await fee.calculateFee(gold.address, PaymentType.Fiat)).to.equal(15n);
    });
  });

  // ── Crypto payment ─────────────────────────────────────────────────────────

  describe("Crypto payment fees", function () {
    it("charges 75% of base fee (112 bps) with no staking tier", async function () {
      const { fee, stranger } = await loadFixture(deployFixture);
      // 150 * 7500 / 10000 = 112.5 → 112 (floor)
      expect(await fee.calculateFee(stranger.address, PaymentType.Crypto)).to.equal(112n);
    });

    it("applies bronze discount on crypto base: 112 × 0.75 = 84 bps", async function () {
      const { fee, bronze } = await loadFixture(deployFixture);
      // base=112, discount=2500, effective = 112*(10000-2500)/10000 = 112*7500/10000 = 84
      expect(await fee.calculateFee(bronze.address, PaymentType.Crypto)).to.equal(84n);
    });

    it("applies silver discount on crypto base: 150 × 0.75 × 0.40 = 45 bps, rounded once", async function () {
      const { fee, silver } = await loadFixture(deployFixture);
      // ⛔ This asserted 44: the crypto base was rounded to 112 first (112.5 → 112), then
      //    112 × 0.40 = 44.8 → 44, losing a basis point. The exact figure is
      //    150 × 7500 × 4000 / 10^8 = 45 (Slither divide-before-multiply, 7 Oct 2026).
      expect(await fee.calculateFee(silver.address, PaymentType.Crypto)).to.equal(45n);
      const [, , shown] = await fee.feeBreakdown(silver.address, PaymentType.Crypto);
      expect(shown).to.equal(45n); // the breakdown shows the fee actually charged
    });

    it("applies 100% gold discount: clamped to the 15 bps floor, not 0", async function () {
      const { fee, gold } = await loadFixture(deployFixture);
      // 112 * (10000 - 10000) / 10000 = 0, then clamped up to minFeeBps = 15
      expect(await fee.calculateFee(gold.address, PaymentType.Crypto)).to.equal(15n);
    });
  });

  // ── Fee clamping ───────────────────────────────────────────────────────────

  describe("Fee clamping", function () {
    it("a 100% discount pays the fixed 0.15% floor, not zero (REG-54)", async function () {
      const { fee, gold } = await loadFixture(deployFixture);
      // gold's tier discount takes the computed fee to 0; the constant floor clamps it to 15.
      expect(await fee.calculateFee(gold.address, PaymentType.Fiat)).to.equal(15n);
    });

    it("the base rate can reach the fixed 5% ceiling, and no further (REG-54)", async function () {
      const { fee, governance, stranger } = await loadFixture(deployFixture);
      await fee.connect(governance).setBaseFeeRate(500);
      expect(await fee.calculateFee(stranger.address, PaymentType.Fiat)).to.equal(500n);
      await expect(fee.connect(governance).setBaseFeeRate(501))
        .to.be.revertedWithCustomError(fee, "InvalidBps");
    });
  });

  // ── Governance parameter updates ───────────────────────────────────────────

  describe("Governance parameter updates", function () {
    it("setBaseFeeRate updates base fee and emits BaseFeeUpdated", async function () {
      const { fee, governance } = await loadFixture(deployFixture);

      await expect(fee.connect(governance).setBaseFeeRate(200))
        .to.emit(fee, "BaseFeeUpdated")
        .withArgs(150n, 200n);

      expect(await fee.baseFeeRateBps()).to.equal(200n);
    });

    it("setBaseFeeRate reverts if above maxFeeBps", async function () {
      const { fee, governance } = await loadFixture(deployFixture);
      // maxFeeBps = 500, try setting 501
      await expect(fee.connect(governance).setBaseFeeRate(501))
        .to.be.revertedWithCustomError(fee, "InvalidBps");
    });

    it("setCryptoFeeMultiplier updates multiplier and emits event", async function () {
      const { fee, governance, stranger } = await loadFixture(deployFixture);

      await expect(fee.connect(governance).setCryptoFeeMultiplier(5_000))
        .to.emit(fee, "CryptoMultiplierUpdated")
        .withArgs(7_500n, 5_000n);

      // New crypto fee: 150 * 5000 / 10000 = 75 bps
      expect(await fee.calculateFee(stranger.address, PaymentType.Crypto)).to.equal(75n);
    });

    it("setCryptoFeeMultiplier reverts if above BPS_DENOMINATOR", async function () {
      const { fee, governance } = await loadFixture(deployFixture);
      await expect(fee.connect(governance).setCryptoFeeMultiplier(10_001))
        .to.be.revertedWithCustomError(fee, "InvalidBps");
    });

    it("there is no setFeeLimits: the floor and ceiling are constants (REG-54, supersedes A4-M-01)", async function () {
      const { fee } = await loadFixture(deployFixture);
      expect(fee.interface.getFunction("setFeeLimits")).to.equal(null);
    });

    it("setStakingContract updates address and emits event", async function () {
      const { fee, governance, staking } = await loadFixture(deployFixture);
      const newAddr = await staking.getAddress();

      await expect(fee.connect(governance).setStakingContract(newAddr))
        .to.emit(fee, "StakingContractUpdated");
    });

    it("setStakingContract reverts with zero address", async function () {
      const { fee, governance } = await loadFixture(deployFixture);
      await expect(fee.connect(governance).setStakingContract(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(fee, "ZeroAddress");
    });

    it("non-governance cannot call setBaseFeeRate", async function () {
      const { fee, stranger } = await loadFixture(deployFixture);
      await expect(fee.connect(stranger).setBaseFeeRate(100)).to.be.reverted;
    });
  });

  // ── Staking contract failure handling ─────────────────────────────────────

  describe("Staking contract unreachable", function () {
    it("returns base fee (no discount) when staking contract is unavailable", async function () {
      const { fee, governance, stranger } = await loadFixture(deployFixture);

      // Point to a non-existent contract — _getDiscount catches the revert and returns 0
      await fee.connect(governance).setStakingContract(ethers.Wallet.createRandom().address);
      // Should not revert; returns base fee
      expect(await fee.calculateFee(stranger.address, PaymentType.Fiat)).to.equal(150n);
    });
  });

  // ── Pause ──────────────────────────────────────────────────────────────────

  describe("Pause behaviour", function () {
    it("calculateFee and feeBreakdown still answer while paused (external report, 22 Oct 2026)", async function () {
      const { fee, admin, stranger } = await loadFixture(deployFixture);

      await fee.connect(admin).pause();
      expect(await fee.paused()).to.equal(true);
      expect(await fee.calculateFee(stranger.address, PaymentType.Fiat)).to.equal(150n);
      expect(await fee.calculateFee(stranger.address, PaymentType.SRX)).to.equal(0n);
      const b = await fee.feeBreakdown(stranger.address, PaymentType.SRX);
      expect(b.effectiveBps).to.equal(0n);
      expect(b.tierName).to.equal("SRX");
      expect((await fee.feeBreakdown(stranger.address, PaymentType.Fiat)).effectiveBps).to.equal(150n);
    });

    it("unpause restores fee calculation", async function () {
      const { fee, admin, stranger } = await loadFixture(deployFixture);

      await fee.connect(admin).pause();
      await fee.connect(admin).unpause();
      expect(await fee.calculateFee(stranger.address, PaymentType.Fiat)).to.equal(150n);
    });

    it("non-pauser cannot pause", async function () {
      const { fee, stranger } = await loadFixture(deployFixture);
      await expect(fee.connect(stranger).pause()).to.be.reverted;
    });
  });

  // ── feeBreakdown ───────────────────────────────────────────────────────────

  describe("feeBreakdown()", function () {
    it("returns correct breakdown for fiat payment — no tier", async function () {
      const { fee, stranger } = await loadFixture(deployFixture);

      const [baseBps, discountBps, effectiveBps, tierName] =
        await fee.feeBreakdown(stranger.address, PaymentType.Fiat);

      expect(baseBps).to.equal(150n);
      expect(discountBps).to.equal(0n);
      expect(effectiveBps).to.equal(150n);
      expect(tierName).to.equal("None");
    });

    it("returns correct breakdown for fiat payment — silver tier", async function () {
      const { fee, silver } = await loadFixture(deployFixture);

      const [baseBps, discountBps, effectiveBps, tierName] =
        await fee.feeBreakdown(silver.address, PaymentType.Fiat);

      expect(baseBps).to.equal(150n);
      expect(discountBps).to.equal(6_000n);
      expect(effectiveBps).to.equal(60n);
      expect(tierName).to.equal("Onyx");
    });

    it("returns correct breakdown for crypto payment — bronze tier", async function () {
      const { fee, bronze } = await loadFixture(deployFixture);

      const [baseBps, discountBps, effectiveBps, tierName] =
        await fee.feeBreakdown(bronze.address, PaymentType.Crypto);

      expect(baseBps).to.equal(112n); // 150 * 7500 / 10000
      expect(discountBps).to.equal(2_500n);
      expect(effectiveBps).to.equal(84n);
      expect(tierName).to.equal("Slate");
    });

    it("returns SRX breakdown with zero fee and 10000 discount", async function () {
      const { fee, stranger } = await loadFixture(deployFixture);

      const [baseBps, discountBps, effectiveBps, tierName] =
        await fee.feeBreakdown(stranger.address, PaymentType.SRX);

      expect(baseBps).to.equal(0n);
      expect(discountBps).to.equal(10_000n);
      expect(effectiveBps).to.equal(0n);
      expect(tierName).to.equal("SRX");
    });

    it("returns Obsidian tier name for gold staker", async function () {
      const { fee, gold } = await loadFixture(deployFixture);
      const [,,,tierName] = await fee.feeBreakdown(gold.address, PaymentType.Fiat);
      expect(tierName).to.equal("Obsidian");
    });
  });

  // ── Fee distribution routing table ────────────────────────────────────────

  describe("Fee distribution routing table", function () {

    // bytes32-encode a label string the same way Solidity does
    function label(str) {
      return ethers.encodeBytes32String(str);
    }

    it("feeDestinationCount is 0 at deployment", async function () {
      const { fee } = await loadFixture(deployFixture);
      expect(await fee.feeDestinationCount()).to.equal(0n);
    });

    it("getFeeDistribution returns empty array before any destinations are set", async function () {
      const { fee } = await loadFixture(deployFixture);
      const dist = await fee.getFeeDistribution();
      expect(dist.length).to.equal(0);
    });

    it("validateFeeDistribution returns (false, 0) when no destinations configured", async function () {
      const { fee } = await loadFixture(deployFixture);
      const [valid, total] = await fee.validateFeeDistribution();
      expect(valid).to.be.false;
      expect(total).to.equal(0n);
    });

    it("setFeeDestination appends a new destination and emits event", async function () {
      const { fee, governance, admin } = await loadFixture(deployFixture);

      await expect(
        fee.connect(governance).setFeeDestination(0, admin.address, 10_000, true, label("Treasury"))
      )
        .to.emit(fee, "FeeDestinationUpdated")
        .withArgs(0n, admin.address, 10_000n, true, label("Treasury"));

      expect(await fee.feeDestinationCount()).to.equal(1n);
    });

    it("single active destination at 10000 bps makes validateFeeDistribution return (true, 10000)", async function () {
      const { fee, governance, admin } = await loadFixture(deployFixture);

      await fee.connect(governance).setFeeDestination(0, admin.address, 10_000, true, label("Treasury"));
      const [valid, total] = await fee.validateFeeDistribution();
      expect(valid).to.be.true;
      expect(total).to.equal(10_000n);
    });

    it("three destinations summing to 10000 bps validate correctly", async function () {
      const { fee, governance, admin, gateway, user } = await loadFixture(deployFixture);

      await fee.connect(governance).setFeeDestination(0, admin.address,   7_000, true, label("Treasury"));
      await fee.connect(governance).setFeeDestination(1, gateway.address, 2_000, true, label("RealYield"));
      await fee.connect(governance).setFeeDestination(2, user.address,    1_000, true, label("AutoBurn"));

      expect(await fee.feeDestinationCount()).to.equal(3n);

      const [valid, total] = await fee.validateFeeDistribution();
      expect(valid).to.be.true;
      expect(total).to.equal(10_000n);
    });

    it("three destinations summing to 9000 bps fail validation", async function () {
      const { fee, governance, admin, gateway, user } = await loadFixture(deployFixture);

      await fee.connect(governance).setFeeDestination(0, admin.address,   6_000, true, label("Treasury"));
      await fee.connect(governance).setFeeDestination(1, gateway.address, 2_000, true, label("RealYield"));
      await fee.connect(governance).setFeeDestination(2, user.address,    1_000, true, label("AutoBurn"));

      const [valid, total] = await fee.validateFeeDistribution();
      expect(valid).to.be.false;
      expect(total).to.equal(9_000n);
    });

    it("inactive destinations are excluded from validation sum", async function () {
      const { fee, governance, admin, gateway, user } = await loadFixture(deployFixture);

      await fee.connect(governance).setFeeDestination(0, admin.address,   7_000, true,  label("Treasury"));
      await fee.connect(governance).setFeeDestination(1, gateway.address, 2_000, false, label("RealYield")); // inactive
      await fee.connect(governance).setFeeDestination(2, user.address,    1_000, true,  label("AutoBurn"));

      // active sum = 7000 + 1000 = 8000, not 10000
      const [valid, total] = await fee.validateFeeDistribution();
      expect(valid).to.be.false;
      expect(total).to.equal(8_000n);
    });

    it("setFeeDestinationActive toggles active flag and emits event", async function () {
      const { fee, governance, admin } = await loadFixture(deployFixture);

      await fee.connect(governance).setFeeDestination(0, admin.address, 10_000, true, label("Treasury"));

      await expect(fee.connect(governance).setFeeDestinationActive(0, false))
        .to.emit(fee, "FeeDestinationUpdated");

      // Now inactive, so validation should fail (0 bps active)
      const [valid] = await fee.validateFeeDistribution();
      expect(valid).to.be.false;
    });

    it("updating an existing destination changes its parameters", async function () {
      const { fee, governance, admin, user } = await loadFixture(deployFixture);

      await fee.connect(governance).setFeeDestination(0, admin.address, 10_000, true, label("Treasury"));
      // Update: change recipient and share
      await fee.connect(governance).setFeeDestination(0, user.address, 9_000, true, label("Treasury2"));

      const dest = await fee.feeDestinations(0);
      expect(dest.recipient).to.equal(user.address);
      expect(dest.shareBps).to.equal(9_000n);

      expect(await fee.feeDestinationCount()).to.equal(1n); // count unchanged
    });

    it("getFeeDistribution returns all destinations including inactive", async function () {
      const { fee, governance, admin, gateway } = await loadFixture(deployFixture);

      await fee.connect(governance).setFeeDestination(0, admin.address,   8_000, true,  label("Treasury"));
      await fee.connect(governance).setFeeDestination(1, gateway.address, 2_000, false, label("Paused"));

      const dist = await fee.getFeeDistribution();
      expect(dist.length).to.equal(2);
      expect(dist[1].active).to.be.false;
    });

    it("reverts if index skips ahead (gap not allowed)", async function () {
      const { fee, governance, admin } = await loadFixture(deployFixture);

      await expect(
        fee.connect(governance).setFeeDestination(1, admin.address, 5_000, true, label("Gap"))
      ).to.be.revertedWithCustomError(fee, "DestinationIndexOutOfBounds");
    });

    it("reverts with zero address recipient", async function () {
      const { fee, governance } = await loadFixture(deployFixture);
      await expect(
        fee.connect(governance).setFeeDestination(0, ethers.ZeroAddress, 10_000, true, label("Bad"))
      ).to.be.revertedWithCustomError(fee, "ZeroAddress");
    });

    it("reverts if shareBps exceeds BPS_DENOMINATOR", async function () {
      const { fee, governance, admin } = await loadFixture(deployFixture);
      await expect(
        fee.connect(governance).setFeeDestination(0, admin.address, 10_001, true, label("Over"))
      ).to.be.revertedWithCustomError(fee, "InvalidBps");
    });

    it("reverts when MAX_FEE_DESTINATIONS (8) exceeded", async function () {
      const { fee, governance, admin } = await loadFixture(deployFixture);
      const signers = await ethers.getSigners();

      // Fill all 8 slots
      for (let i = 0; i < 8; i++) {
        await fee.connect(governance).setFeeDestination(
          i,
          signers[i % signers.length].address,
          1_000,
          true,
          label(`Dest${i}`)
        );
      }

      // 9th should revert
      await expect(
        fee.connect(governance).setFeeDestination(8, admin.address, 1_000, true, label("Overflow"))
      ).to.be.revertedWithCustomError(fee, "TooManyDestinations");
    });

    it("non-governance cannot set fee destination", async function () {
      const { fee, stranger, admin } = await loadFixture(deployFixture);
      await expect(
        fee.connect(stranger).setFeeDestination(0, admin.address, 10_000, true, label("Hack"))
      ).to.be.reverted;
    });

    it("setFeeDestinationActive reverts for out-of-bounds index", async function () {
      const { fee, governance } = await loadFixture(deployFixture);
      await expect(
        fee.connect(governance).setFeeDestinationActive(0, false)
      ).to.be.revertedWithCustomError(fee, "DestinationIndexOutOfBounds");
    });
  });

  // ── commitFeeDistribution() ────────────────────────────────────────────────

  describe("commitFeeDistribution()", function () {
    it("succeeds when active destinations sum to 10000 bps and emits event", async function () {
      const { fee, governance, admin } = await loadFixture(deployFixture);
      await fee.connect(governance).setFeeDestination(0, admin.address, 10_000, true, ethers.encodeBytes32String("Treasury"));

      const tx   = await fee.connect(governance).commitFeeDistribution();
      const rcpt = await tx.wait();
      // Confirm FeeDistributionCommitted was emitted with the correct bps.
      // Timestamp is block-dependent so we verify it is > 0 rather than predicting it.
      const parsed = fee.interface.parseLog(
        rcpt.logs.find(l => { try { return fee.interface.parseLog(l)?.name === "FeeDistributionCommitted"; } catch { return false; } })
      );
      expect(parsed.args[0]).to.equal(10_000n);
      expect(parsed.args[1]).to.be.gt(0n);
    });

    it("reverts with FeeDistributionInvalid when sum is not 10000", async function () {
      const { fee, governance, admin, gateway } = await loadFixture(deployFixture);
      await fee.connect(governance).setFeeDestination(0, admin.address,   7_000, true, ethers.encodeBytes32String("Treasury"));
      await fee.connect(governance).setFeeDestination(1, gateway.address, 2_000, true, ethers.encodeBytes32String("RealYield"));
      // Sum is 9000, not 10000

      await expect(fee.connect(governance).commitFeeDistribution())
        .to.be.revertedWithCustomError(fee, "FeeDistributionInvalid")
        .withArgs(9_000n);
    });

    it("reverts when no destinations configured", async function () {
      const { fee, governance } = await loadFixture(deployFixture);
      await expect(fee.connect(governance).commitFeeDistribution())
        .to.be.revertedWithCustomError(fee, "FeeDistributionInvalid")
        .withArgs(0n);
    });

    it("reverts if called by non-governance", async function () {
      const { fee, stranger } = await loadFixture(deployFixture);
      await expect(fee.connect(stranger).commitFeeDistribution()).to.be.reverted;
    });
  });
});
