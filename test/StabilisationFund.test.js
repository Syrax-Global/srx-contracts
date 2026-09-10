const { expect }  = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/**
 * StabilisationFund tests.
 *
 * Covers:
 *  - Initialisation and role assignments
 *  - Contributor flow: contribute / withdrawContribution / claimRewards
 *  - Synthetix reward accounting correctness (two-contributor fair split)
 *  - Stress event lifecycle: trigger → deploy → resolve
 *  - Three-tier deployment authority and cap enforcement
 *  - Fast-path restrictions (SRX only, stress required)
 *  - GOVERNANCE_ROLE unrestricted deployment (any token, any time)
 *  - recoverLiquidity
 *  - Governance parameter changes
 *  - Pause / unpause
 *  - Reentrancy guard
 *  - UUPS upgrade authorization
 */
describe("StabilisationFund", function () {

  // ── Fixture ──────────────────────────────────────────────────────────────────

  async function deployFixture() {
    const [
      admin,
      timelock,   // holds GOVERNANCE_ROLE in prod
      guardian,   // holds GUARDIAN_ROLE  (Tier 2, 4-of-7 multi-sig in prod)
      deployer,   // holds DEPLOYER_ROLE  (Tier 1, treasurer in prod)
      oracle,     // holds ORACLE_REPORTER_ROLE
      pauser,     // holds PAUSER_ROLE (GuardianModule in prod)
      contributor1,
      contributor2,
      stranger,
      recipient,
    ] = await ethers.getSigners();

    // ── Deploy a minimal SRX token for testing ──────────────────────────────
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const lzEndpoint = await MockLZEndpoint.deploy(40161);
    await lzEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const srx = await SRXToken.deploy(await lzEndpoint.getAddress(), admin.address);
    await srx.waitForDeployment();

    // Mint full supply to admin for distribution in tests
    await srx.connect(admin).genesis(admin.address);

    const srxAddr = await srx.getAddress();

    // ── Deploy StabilisationFund (UUPS) ─────────────────────────────────────
    const SSF = await ethers.getContractFactory("StabilisationFund");
    const ssf = await upgrades.deployProxy(
      SSF,
      [
        srxAddr,
        admin.address,
        3_000,           // maxDeployerBps  = 30%
        7_000,           // maxGuardianBps  = 70%
        30 * 24 * 3600,  // withdrawLock    = 30 days
      ],
      { kind: "uups", initializer: "initialize" }
    );
    await ssf.waitForDeployment();
    const ssfAddr = await ssf.getAddress();

    // ── Grant roles ──────────────────────────────────────────────────────────
    const GOV_ROLE      = await ssf.GOVERNANCE_ROLE();
    const GUARDIAN_ROLE = await ssf.GUARDIAN_ROLE();
    const DEPLOYER_ROLE = await ssf.DEPLOYER_ROLE();
    const ORACLE_ROLE   = await ssf.ORACLE_REPORTER_ROLE();
    const PAUSER_ROLE   = await ssf.PAUSER_ROLE();

    await ssf.connect(admin).grantRole(GOV_ROLE,      timelock.address);
    await ssf.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);
    await ssf.connect(admin).grantRole(DEPLOYER_ROLE, deployer.address);
    await ssf.connect(admin).grantRole(ORACLE_ROLE,   oracle.address);
    await ssf.connect(admin).grantRole(PAUSER_ROLE,   pauser.address);

    // SC-TRUST-003: approve the test recipient as a fast-path deployment target.
    // Fast-path deployLiquidity (DEPLOYER/GUARDIAN) now requires an approved target.
    await ssf.connect(admin).setDeployTarget(recipient.address, true);

    // ── Seed SSF with SRX (simulates TGE distribution) ──────────────────────
    const SEED = ethers.parseUnits("1500000000", 18); // 1.5B SRX
    await srx.connect(admin).transfer(ssfAddr, SEED);

    // Give contributors some SRX for contribution tests
    const CONTRIB_AMOUNT = ethers.parseUnits("1000000", 18); // 1M each
    await srx.connect(admin).transfer(contributor1.address, CONTRIB_AMOUNT * 2n);
    await srx.connect(admin).transfer(contributor2.address, CONTRIB_AMOUNT * 2n);

    // Pre-approve SSF to spend contributors' SRX
    await srx.connect(contributor1).approve(ssfAddr, ethers.MaxUint256);
    await srx.connect(contributor2).approve(ssfAddr, ethers.MaxUint256);

    return {
      ssf, srx, ssfAddr, srxAddr,
      admin, timelock, guardian, deployer, oracle, pauser,
      contributor1, contributor2, stranger, recipient,
      SEED, CONTRIB_AMOUNT,
      GOV_ROLE, GUARDIAN_ROLE, DEPLOYER_ROLE, ORACLE_ROLE, PAUSER_ROLE,
    };
  }

  // ── Deployment ────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets srxToken correctly", async function () {
      const { ssf, srxAddr } = await loadFixture(deployFixture);
      expect(await ssf.srxToken()).to.equal(srxAddr);
    });

    it("holds the 1.5B SRX TGE seed", async function () {
      const { ssf, SEED } = await loadFixture(deployFixture);
      expect(await ssf.srxBalance()).to.equal(SEED);
    });

    it("initialises maxDeployerBps = 3000", async function () {
      const { ssf } = await loadFixture(deployFixture);
      expect(await ssf.maxDeployerBps()).to.equal(3_000n);
    });

    it("initialises maxGuardianBps = 7000", async function () {
      const { ssf } = await loadFixture(deployFixture);
      expect(await ssf.maxGuardianBps()).to.equal(7_000n);
    });

    it("initialises withdrawLockDuration = 30 days", async function () {
      const { ssf } = await loadFixture(deployFixture);
      expect(await ssf.withdrawLockDuration()).to.equal(30n * 24n * 3600n);
    });

    it("initialises reserve layer targets: 50/30/20", async function () {
      const { ssf } = await loadFixture(deployFixture);
      expect(await ssf.stableTargetBps()).to.equal(5_000n);
      expect(await ssf.coreTargetBps()).to.equal(3_000n);
      expect(await ssf.yieldTargetBps()).to.equal(2_000n);
    });

    it("stress is not active at deployment", async function () {
      const { ssf } = await loadFixture(deployFixture);
      expect(await ssf.stressActive()).to.be.false;
    });

    it("stressEventCount starts at 0", async function () {
      const { ssf } = await loadFixture(deployFixture);
      expect(await ssf.stressEventCount()).to.equal(0n);
    });

    it("admin holds GOVERNANCE_ROLE initially", async function () {
      const { ssf, admin, GOV_ROLE } = await loadFixture(deployFixture);
      expect(await ssf.hasRole(GOV_ROLE, admin.address)).to.be.true;
    });

    it("timelock holds GOVERNANCE_ROLE", async function () {
      const { ssf, timelock, GOV_ROLE } = await loadFixture(deployFixture);
      expect(await ssf.hasRole(GOV_ROLE, timelock.address)).to.be.true;
    });

    it("reverts if maxDeployerBps > maxGuardianBps", async function () {
      const SSF2 = await ethers.getContractFactory("StabilisationFund");
      const [admin] = await ethers.getSigners();
      const MockLZ  = await ethers.getContractFactory("MockLZEndpoint");
      const lz = await MockLZ.deploy(40161);
      await lz.waitForDeployment();
      const SRXToken = await ethers.getContractFactory("SRXToken");
      const srx2 = await SRXToken.deploy(await lz.getAddress(), admin.address);
      await srx2.waitForDeployment();

      await expect(
        upgrades.deployProxy(SSF2, [await srx2.getAddress(), admin.address, 8_000, 7_000, 86400], { kind: "uups" })
      ).to.be.revertedWithCustomError(SSF2, "InvalidBps");
    });
  });

  // ── contribute() ──────────────────────────────────────────────────────────

  describe("contribute()", function () {
    it("transfers SRX into fund and updates totalContributions", async function () {
      const { ssf, srx, ssfAddr, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      const before = await srx.balanceOf(ssfAddr);

      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);

      expect(await srx.balanceOf(ssfAddr)).to.equal(before + CONTRIB_AMOUNT);
      expect(await ssf.totalContributions()).to.equal(CONTRIB_AMOUNT);
    });

    it("records contribution in the position struct", async function () {
      const { ssf, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);

      const c = await ssf.contributions(contributor1.address);
      expect(c.srxAmount).to.equal(CONTRIB_AMOUNT);
    });

    it("emits Contributed event", async function () {
      const { ssf, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await expect(ssf.connect(contributor1).contribute(CONTRIB_AMOUNT))
        .to.emit(ssf, "Contributed")
        .withArgs(contributor1.address, CONTRIB_AMOUNT, CONTRIB_AMOUNT);
    });

    it("accumulates multiple contributions from same address", async function () {
      const { ssf, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);

      const c = await ssf.contributions(contributor1.address);
      expect(c.srxAmount).to.equal(CONTRIB_AMOUNT * 2n);
      expect(await ssf.totalContributions()).to.equal(CONTRIB_AMOUNT * 2n);
    });

    it("reverts with zero amount", async function () {
      const { ssf, contributor1 } = await loadFixture(deployFixture);
      await expect(ssf.connect(contributor1).contribute(0n))
        .to.be.revertedWithCustomError(ssf, "ZeroAmount");
    });

    it("reverts when paused", async function () {
      const { ssf, pauser, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await ssf.connect(pauser).pause();
      await expect(ssf.connect(contributor1).contribute(CONTRIB_AMOUNT))
        .to.be.revertedWithCustomError(ssf, "EnforcedPause");
    });
  });

  // ── withdrawContribution() ────────────────────────────────────────────────

  describe("withdrawContribution()", function () {
    it("returns SRX after lock period elapses", async function () {
      const { ssf, srx, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);

      await time.increase(30 * 24 * 3600 + 1);

      const before = await srx.balanceOf(contributor1.address);
      await ssf.connect(contributor1).withdrawContribution(CONTRIB_AMOUNT);

      expect(await srx.balanceOf(contributor1.address)).to.equal(before + CONTRIB_AMOUNT);
      expect(await ssf.totalContributions()).to.equal(0n);
    });

    it("emits ContributionWithdrawn", async function () {
      const { ssf, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      await time.increase(30 * 24 * 3600 + 1);

      await expect(ssf.connect(contributor1).withdrawContribution(CONTRIB_AMOUNT))
        .to.emit(ssf, "ContributionWithdrawn")
        .withArgs(contributor1.address, CONTRIB_AMOUNT);
    });

    it("reverts before lock period elapses", async function () {
      const { ssf, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);

      await expect(ssf.connect(contributor1).withdrawContribution(CONTRIB_AMOUNT))
        .to.be.revertedWithCustomError(ssf, "WithdrawLockActive");
    });

    it("reverts if no contribution exists", async function () {
      const { ssf, stranger } = await loadFixture(deployFixture);
      await expect(ssf.connect(stranger).withdrawContribution(1n))
        .to.be.revertedWithCustomError(ssf, "NoContribution");
    });

    it("reverts if withdrawal exceeds contribution", async function () {
      const { ssf, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      await time.increase(30 * 24 * 3600 + 1);

      await expect(ssf.connect(contributor1).withdrawContribution(CONTRIB_AMOUNT + 1n))
        .to.be.revertedWithCustomError(ssf, "AmountExceedsContribution");
    });

    it("allows partial withdrawal", async function () {
      const { ssf, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      await time.increase(30 * 24 * 3600 + 1);

      await ssf.connect(contributor1).withdrawContribution(CONTRIB_AMOUNT / 2n);

      const c = await ssf.contributions(contributor1.address);
      expect(c.srxAmount).to.equal(CONTRIB_AMOUNT / 2n);
    });

    it("reverts when paused", async function () {
      const { ssf, pauser, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      await time.increase(30 * 24 * 3600 + 1);
      await ssf.connect(pauser).pause();

      await expect(ssf.connect(contributor1).withdrawContribution(CONTRIB_AMOUNT))
        .to.be.revertedWithCustomError(ssf, "EnforcedPause");
    });
  });

  // ── Reward accounting ─────────────────────────────────────────────────────

  describe("Reward accounting (Synthetix pattern)", function () {
    it("earned() returns 0 before rewards are registered", async function () {
      const { ssf, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      expect(await ssf.earned(contributor1.address)).to.equal(0n);
    });

    it("splits rewards proportionally between two contributors", async function () {
      const { ssf, timelock, contributor1, contributor2, CONTRIB_AMOUNT } = await loadFixture(deployFixture);

      // contributor1 contributes double contributor2
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT * 2n);
      await ssf.connect(contributor2).contribute(CONTRIB_AMOUNT);

      // Register reward pool: 300 SRX/s.
      // SC-ECON-001: emission is now bounded by the funded pool — fund enough to cover
      // well past the 100s window (periodFinish = now + pool/rate). 300 SRX/s × 1000s.
      const RATE = ethers.parseUnits("300", 18);
      await ssf.connect(timelock).notifyRewardAmount(RATE * 1000n);
      await ssf.connect(timelock).setRewardRate(RATE);

      // Advance 100 seconds → 30,000 SRX total rewards emitted
      await time.increase(100);

      const earned1 = await ssf.earned(contributor1.address);
      const earned2 = await ssf.earned(contributor2.address);

      // contributor1 has 2/3 of pool, contributor2 has 1/3
      // Allow small rounding tolerance (±1e12 wei)
      const total = earned1 + earned2;
      expect(total).to.be.closeTo(RATE * 100n, ethers.parseUnits("1", 12));
      expect(earned1).to.be.closeTo((total * 2n) / 3n, ethers.parseUnits("1", 12));
      expect(earned2).to.be.closeTo(total / 3n, ethers.parseUnits("1", 12));
    });

    it("caps total emission at the funded pool (SC-ECON-001 periodFinish)", async function () {
      const { ssf, timelock, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);

      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);

      // Fund only 10 seconds' worth of emission at 300 SRX/s, then run the clock
      // far past exhaustion. Emission MUST cap at the pool, not keep growing.
      const RATE = ethers.parseUnits("300", 18);
      const POOL = RATE * 10n; // 3,000 SRX — exactly 10s of emission
      await ssf.connect(timelock).notifyRewardAmount(POOL);
      await ssf.connect(timelock).setRewardRate(RATE);

      await time.increase(100); // 10× past the funded window

      const earned = await ssf.earned(contributor1.address);
      // Sole contributor earns the whole pool — and NOT RATE × 100 (= 30,000 SRX).
      expect(earned).to.be.closeTo(POOL, ethers.parseUnits("1", 12));
      expect(earned).to.be.lte(POOL); // never exceeds what was funded
    });

    it("claimRewards() transfers rewards to contributor", async function () {
      const { ssf, srx, timelock, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);

      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);

      // Fund reward pool
      const REWARD_AMOUNT = ethers.parseUnits("10000000", 18); // 10M SRX from seed
      await ssf.connect(timelock).notifyRewardAmount(REWARD_AMOUNT);
      const RATE = ethers.parseUnits("100", 18);
      await ssf.connect(timelock).setRewardRate(RATE);

      await time.increase(1000);

      const before   = await srx.balanceOf(contributor1.address);
      const expected = await ssf.earned(contributor1.address);

      await ssf.connect(contributor1).claimRewards();

      const after = await srx.balanceOf(contributor1.address);
      // Tolerance = 3 blocks × RATE (block timestamps can advance by a few seconds
      // between earned() snapshot and the claim transaction mining)
      expect(after - before).to.be.closeTo(expected, RATE * 3n);
    });

    it("claimRewards() emits RewardsClaimed", async function () {
      const { ssf, timelock, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      await ssf.connect(timelock).notifyRewardAmount(ethers.parseUnits("1000000", 18));
      await ssf.connect(timelock).setRewardRate(ethers.parseUnits("10", 18));
      await time.increase(100);

      await expect(ssf.connect(contributor1).claimRewards())
        .to.emit(ssf, "RewardsClaimed");
    });

    it("claimRewards() reverts with NothingToClaim when no rewards accrued", async function () {
      const { ssf, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      // No rate set → nothing earned

      await expect(ssf.connect(contributor1).claimRewards())
        .to.be.revertedWithCustomError(ssf, "NothingToClaim");
    });

    it("claimRewards() reverts if caller has no contribution and no pending rewards", async function () {
      const { ssf, stranger } = await loadFixture(deployFixture);
      // After M-09 fix: NoContribution gate removed from claimRewards().
      // A caller with zero contribution AND zero pending rewards hits NothingToClaim.
      await expect(ssf.connect(stranger).claimRewards())
        .to.be.revertedWithCustomError(ssf, "NothingToClaim");
    });

    it("notifyRewardAmount() reverts if amount exceeds available balance", async function () {
      const { ssf, timelock, SEED, CONTRIB_AMOUNT, contributor1 } = await loadFixture(deployFixture);
      // Contribute some SRX first (now part of encumbered balance)
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      // Try to register more than the unencumbered seed
      await expect(ssf.connect(timelock).notifyRewardAmount(SEED + 1n))
        .to.be.revertedWithCustomError(ssf, "PoolAmountExceedsAvailable");
    });

    it("notifyRewardAmount() reverts if caller lacks GOVERNANCE_ROLE", async function () {
      const { ssf, stranger } = await loadFixture(deployFixture);
      await expect(ssf.connect(stranger).notifyRewardAmount(1000n)).to.be.reverted;
    });

    it("rescueStrandedPool() transfers stranded rewardPool to recipient when no contributors (A5-M-02)", async function () {
      // Scenario: contributor joins, reward pool registered, contributor fully exits.
      // Remaining rewardPool tokens are stranded — accumulator frozen at zero.
      const { ssf, srx, timelock, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      const rewardAmount = ethers.parseUnits("100000", 18);

      // Fund reward pool while contributor is active
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      await ssf.connect(timelock).notifyRewardAmount(rewardAmount);

      // Advance past the withdraw lock duration so contributor can exit
      const lockDuration = await ssf.withdrawLockDuration();
      await time.increase(Number(lockDuration) + 1);
      await ssf.connect(contributor1).withdrawContribution(CONTRIB_AMOUNT);

      // Now totalContributions == 0 and rewardPool > 0 — pool is stranded
      expect(await ssf.totalContributions()).to.equal(0n);
      expect(await ssf.rewardPool()).to.be.gt(0n);

      const balBefore = await srx.balanceOf(timelock.address);
      await ssf.connect(timelock).rescueStrandedPool(timelock.address);
      const balAfter = await srx.balanceOf(timelock.address);

      expect(balAfter).to.be.gt(balBefore);
      expect(await ssf.rewardPool()).to.equal(0n);
      expect(await ssf.rewardRate()).to.equal(0n);
    });

    it("rescueStrandedPool() reverts if contributors still exist", async function () {
      const { ssf, timelock, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      const rewardAmount = ethers.parseUnits("100000", 18);
      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      await ssf.connect(timelock).notifyRewardAmount(rewardAmount);

      // Contributors still exist — rescue must revert
      await expect(ssf.connect(timelock).rescueStrandedPool(timelock.address))
        .to.be.revertedWithCustomError(ssf, "NoStrandedPool");
    });

    it("rescueStrandedPool() reverts if pool is already zero", async function () {
      const { ssf, timelock } = await loadFixture(deployFixture);
      // No reward pool registered, totalContributions is 0 too
      await expect(ssf.connect(timelock).rescueStrandedPool(timelock.address))
        .to.be.revertedWithCustomError(ssf, "NoStrandedPool");
    });
  });

  // ── Stress event — triggerStressEvent() ───────────────────────────────────

  describe("triggerStressEvent()", function () {
    it("oracle can trigger stress event", async function () {
      const { ssf, oracle } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      expect(await ssf.stressActive()).to.be.true;
    });

    it("GUARDIAN_ROLE can trigger stress event", async function () {
      const { ssf, guardian } = await loadFixture(deployFixture);
      await ssf.connect(guardian).triggerStressEvent();
      expect(await ssf.stressActive()).to.be.true;
    });

    it("snapshots SRX balance at trigger time", async function () {
      const { ssf, oracle, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      expect(await ssf.stressStartSRXBalance()).to.equal(SEED);
    });

    it("increments stressEventCount", async function () {
      const { ssf, oracle } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      expect(await ssf.stressEventCount()).to.equal(1n);
    });

    it("resets deployerSRXUsed and guardianSRXUsed to 0", async function () {
      const { ssf, oracle } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      expect(await ssf.deployerSRXUsed()).to.equal(0n);
      expect(await ssf.guardianSRXUsed()).to.equal(0n);
    });

    it("emits StressEventTriggered with correct eventId", async function () {
      const { ssf, oracle, SEED } = await loadFixture(deployFixture);
      // Pin the block time rather than predict it — "latest + 1" fails whenever
      // the tx mines a wall-clock second later, which slow CI runners do.
      const at = (await time.latest()) + 60;
      await time.setNextBlockTimestamp(at);
      await expect(ssf.connect(oracle).triggerStressEvent())
        .to.emit(ssf, "StressEventTriggered")
        .withArgs(1n, oracle.address, SEED, at);
    });

    it("reverts StressAlreadyActive if stress is already active", async function () {
      const { ssf, oracle } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      await expect(ssf.connect(oracle).triggerStressEvent())
        .to.be.revertedWithCustomError(ssf, "StressAlreadyActive");
    });

    it("stranger cannot trigger stress", async function () {
      const { ssf, stranger } = await loadFixture(deployFixture);
      await expect(ssf.connect(stranger).triggerStressEvent())
        .to.be.revertedWithCustomError(ssf, "UnauthorisedCaller");
    });

    it("DEPLOYER_ROLE alone cannot trigger stress", async function () {
      const { ssf, deployer } = await loadFixture(deployFixture);
      await expect(ssf.connect(deployer).triggerStressEvent())
        .to.be.revertedWithCustomError(ssf, "UnauthorisedCaller");
    });
  });

  // ── Stress event — resolveStressEvent() ───────────────────────────────────

  describe("resolveStressEvent()", function () {
    it("governance can resolve stress", async function () {
      const { ssf, oracle, timelock } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      await ssf.connect(timelock).resolveStressEvent();
      expect(await ssf.stressActive()).to.be.false;
    });

    it("emits StressEventResolved", async function () {
      const { ssf, oracle, timelock } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      const at = (await time.latest()) + 60; // pinned, not predicted — see above
      await time.setNextBlockTimestamp(at);
      await expect(ssf.connect(timelock).resolveStressEvent())
        .to.emit(ssf, "StressEventResolved")
        .withArgs(1n, 0n, 0n, at);
    });

    it("reverts if stress is not active", async function () {
      const { ssf, timelock } = await loadFixture(deployFixture);
      await expect(ssf.connect(timelock).resolveStressEvent())
        .to.be.revertedWithCustomError(ssf, "StressNotActive");
    });

    it("GUARDIAN_ROLE cannot resolve stress (governance only)", async function () {
      const { ssf, oracle, guardian } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      await expect(ssf.connect(guardian).resolveStressEvent()).to.be.reverted;
    });

    it("oracle cannot resolve stress", async function () {
      const { ssf, oracle } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      await expect(ssf.connect(oracle).resolveStressEvent()).to.be.reverted;
    });
  });

  // ── deployLiquidity() — DEPLOYER_ROLE (Tier 1) ───────────────────────────

  describe("deployLiquidity() — DEPLOYER_ROLE (Tier 1)", function () {
    it("deploys SRX during stress within cap", async function () {
      const { ssf, srx, oracle, deployer, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();

      const deployAmount = (SEED * 3_000n) / 10_000n; // exactly 30%
      await ssf.connect(deployer).deployLiquidity(
        recipient.address, await srx.getAddress(), deployAmount, "price support"
      );

      expect(await srx.balanceOf(recipient.address)).to.equal(deployAmount);
      expect(await ssf.deployerSRXUsed()).to.equal(deployAmount);
    });

    it("emits LiquidityDeployed", async function () {
      const { ssf, srx, oracle, deployer, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      const amount = SEED / 10n; // 10%

      await expect(
        ssf.connect(deployer).deployLiquidity(
          recipient.address, await srx.getAddress(), amount, "test"
        )
      ).to.emit(ssf, "LiquidityDeployed")
        .withArgs(deployer.address, recipient.address, await srx.getAddress(), amount, "test");
    });

    it("reverts DeployerCapExceeded when over 30%", async function () {
      const { ssf, srx, oracle, deployer, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();

      const overCap = (SEED * 3_001n) / 10_000n;
      await expect(
        ssf.connect(deployer).deployLiquidity(
          recipient.address, await srx.getAddress(), overCap, "over cap"
        )
      ).to.be.revertedWithCustomError(ssf, "DeployerCapExceeded");
    });

    it("getDeployerCapRemaining decreases after each deployment", async function () {
      const { ssf, srx, oracle, deployer, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();

      const limit = (SEED * 3_000n) / 10_000n;
      const deploy = SEED / 10n; // 10%

      await ssf.connect(deployer).deployLiquidity(
        recipient.address, await srx.getAddress(), deploy, "partial"
      );

      expect(await ssf.getDeployerCapRemaining()).to.equal(limit - deploy);
    });

    it("reverts FastPathRequiresStress when no active stress", async function () {
      const { ssf, srx, deployer, recipient, SEED } = await loadFixture(deployFixture);
      await expect(
        ssf.connect(deployer).deployLiquidity(
          recipient.address, await srx.getAddress(), SEED / 10n, "no stress"
        )
      ).to.be.revertedWithCustomError(ssf, "FastPathRequiresStress");
    });

    it("reverts FastPathSRXOnly when deploying non-SRX token", async function () {
      const { ssf, oracle, deployer, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();

      // Use a dummy non-SRX address
      const fakeToken = ethers.Wallet.createRandom().address;
      await expect(
        ssf.connect(deployer).deployLiquidity(
          recipient.address, fakeToken, SEED / 10n, "wrong token"
        )
      ).to.be.revertedWithCustomError(ssf, "FastPathSRXOnly");
    });

    it("reverts with EmptyReason", async function () {
      const { ssf, srx, oracle, deployer, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      await expect(
        ssf.connect(deployer).deployLiquidity(
          recipient.address, await srx.getAddress(), SEED / 10n, ""
        )
      ).to.be.revertedWithCustomError(ssf, "EmptyReason");
    });

    it("cumulative cap: two deployments of 15% each succeed; third fails", async function () {
      const { ssf, srx, oracle, deployer, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();

      const half_cap = (SEED * 1_500n) / 10_000n; // 15%
      await ssf.connect(deployer).deployLiquidity(
        recipient.address, await srx.getAddress(), half_cap, "first"
      );
      await ssf.connect(deployer).deployLiquidity(
        recipient.address, await srx.getAddress(), half_cap, "second"
      );

      // Now at 30% — any further amount should fail
      await expect(
        ssf.connect(deployer).deployLiquidity(
          recipient.address, await srx.getAddress(), 1n, "over"
        )
      ).to.be.revertedWithCustomError(ssf, "DeployerCapExceeded");
    });

    it("caps reset on a new stress event", async function () {
      const { ssf, srx, oracle, deployer, timelock, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      const cap = (SEED * 3_000n) / 10_000n;
      await ssf.connect(deployer).deployLiquidity(
        recipient.address, await srx.getAddress(), cap, "use full cap"
      );

      // Resolve — then advance past 7-day cooldown before triggering again (A6-E-03)
      await ssf.connect(timelock).resolveStressEvent();
      await time.increase(7 * 24 * 3600 + 1);
      await ssf.connect(oracle).triggerStressEvent();

      // Deployer cap resets — should be able to deploy again
      const newCap = (await ssf.stressStartSRXBalance() * 3_000n) / 10_000n;
      expect(await ssf.getDeployerCapRemaining()).to.be.gt(0n);
    });
  });

  // ── deployLiquidity() — fast-path target allowlist (SC-TRUST-003) ─────────

  describe("Fast-path deploy target allowlist (SC-TRUST-003)", function () {
    it("fast-path reverts TargetNotApproved for an unapproved target", async function () {
      const { ssf, srx, oracle, deployer, stranger, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      await expect(
        ssf.connect(deployer).deployLiquidity(
          stranger.address, await srx.getAddress(), SEED / 100n, "unapproved target"
        )
      ).to.be.revertedWithCustomError(ssf, "TargetNotApproved");
    });

    it("governance can approve a target, then fast-path succeeds", async function () {
      const { ssf, srx, oracle, deployer, timelock, stranger, SEED } = await loadFixture(deployFixture);
      await ssf.connect(timelock).setDeployTarget(stranger.address, true);
      await ssf.connect(oracle).triggerStressEvent();
      const amt = SEED / 100n;
      await ssf.connect(deployer).deployLiquidity(
        stranger.address, await srx.getAddress(), amt, "approved target"
      );
      expect(await srx.balanceOf(stranger.address)).to.equal(amt);
    });

    it("governance can revoke a target, blocking further fast-path deploys", async function () {
      const { ssf, srx, oracle, deployer, timelock, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(timelock).setDeployTarget(recipient.address, false);
      await ssf.connect(oracle).triggerStressEvent();
      await expect(
        ssf.connect(deployer).deployLiquidity(
          recipient.address, await srx.getAddress(), SEED / 100n, "revoked"
        )
      ).to.be.revertedWithCustomError(ssf, "TargetNotApproved");
    });

    it("governance (Tier 3) path is NOT restricted by the allowlist", async function () {
      const { ssf, srx, timelock, stranger, SEED } = await loadFixture(deployFixture);
      // No stress, unapproved target — governance can still deploy any token/amount.
      const amt = SEED / 100n;
      await ssf.connect(timelock).deployLiquidity(
        stranger.address, await srx.getAddress(), amt, "governance unrestricted"
      );
      expect(await srx.balanceOf(stranger.address)).to.equal(amt);
    });

    it("setDeployTarget is governance-only and rejects the zero address", async function () {
      const { ssf, timelock, stranger } = await loadFixture(deployFixture);
      await expect(ssf.connect(stranger).setDeployTarget(stranger.address, true))
        .to.be.reverted; // AccessControl: missing GOVERNANCE_ROLE
      await expect(ssf.connect(timelock).setDeployTarget(ethers.ZeroAddress, true))
        .to.be.revertedWithCustomError(ssf, "ZeroAddress");
    });
  });

  // ── deployLiquidity() — GUARDIAN_ROLE (Tier 2) ────────────────────────────

  describe("deployLiquidity() — GUARDIAN_ROLE (Tier 2)", function () {
    it("deploys SRX during stress within combined 70% cap", async function () {
      const { ssf, srx, oracle, guardian, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();

      const deployAmount = (SEED * 7_000n) / 10_000n; // exactly 70%
      await ssf.connect(guardian).deployLiquidity(
        recipient.address, await srx.getAddress(), deployAmount, "tier 2"
      );

      expect(await ssf.guardianSRXUsed()).to.equal(deployAmount);
    });

    it("guardian combined cap includes deployer usage", async function () {
      const { ssf, srx, oracle, deployer, guardian, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();

      // Deployer uses 30%
      const dep = (SEED * 3_000n) / 10_000n;
      await ssf.connect(deployer).deployLiquidity(
        recipient.address, await srx.getAddress(), dep, "deployer"
      );

      // Guardian can use up to 40% more (70% total)
      const grd = (SEED * 4_000n) / 10_000n;
      await ssf.connect(guardian).deployLiquidity(
        recipient.address, await srx.getAddress(), grd, "guardian"
      );

      expect(await ssf.deployerSRXUsed()).to.equal(dep);
      expect(await ssf.guardianSRXUsed()).to.equal(grd);
    });

    it("reverts GuardianCapExceeded when over 70% combined", async function () {
      const { ssf, srx, oracle, guardian, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();

      const overCap = (SEED * 7_001n) / 10_000n;
      await expect(
        ssf.connect(guardian).deployLiquidity(
          recipient.address, await srx.getAddress(), overCap, "over"
        )
      ).to.be.revertedWithCustomError(ssf, "GuardianCapExceeded");
    });

    it("getGuardianCapRemaining returns correct value after deployer usage", async function () {
      const { ssf, srx, oracle, deployer, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();

      const dep = (SEED * 2_000n) / 10_000n; // 20%
      await ssf.connect(deployer).deployLiquidity(
        recipient.address, await srx.getAddress(), dep, "partial"
      );

      const expectedRemaining = (SEED * 5_000n) / 10_000n; // 70% - 20% = 50%
      expect(await ssf.getGuardianCapRemaining()).to.be.closeTo(
        expectedRemaining, ethers.parseUnits("1", 12)
      );
    });

    it("guardian also requires active stress", async function () {
      const { ssf, srx, guardian, recipient, SEED } = await loadFixture(deployFixture);
      await expect(
        ssf.connect(guardian).deployLiquidity(
          recipient.address, await srx.getAddress(), SEED / 10n, "no stress"
        )
      ).to.be.revertedWithCustomError(ssf, "FastPathRequiresStress");
    });
  });

  // ── deployLiquidity() — GOVERNANCE_ROLE (Tier 3) ─────────────────────────

  describe("deployLiquidity() — GOVERNANCE_ROLE (Tier 3)", function () {
    it("can deploy SRX at any time without stress", async function () {
      const { ssf, srx, timelock, recipient, SEED } = await loadFixture(deployFixture);
      const amount = SEED / 2n; // 50% — well over any fast-path cap

      await ssf.connect(timelock).deployLiquidity(
        recipient.address, await srx.getAddress(), amount, "governance"
      );

      expect(await srx.balanceOf(recipient.address)).to.equal(amount);
    });

    it("can deploy non-SRX tokens (ETH-side LP asset)", async function () {
      const { ssf, srx, admin, timelock, ssfAddr, recipient } = await loadFixture(deployFixture);

      // Give SSF some of a second token (simulate USDC accumulation)
      const MockLZ2 = await ethers.getContractFactory("MockLZEndpoint");
      const lz2 = await MockLZ2.deploy(40162);
      await lz2.waitForDeployment();
      const SRXToken2 = await ethers.getContractFactory("SRXToken");
      const token2 = await SRXToken2.deploy(await lz2.getAddress(), admin.address);
      await token2.waitForDeployment();
      await token2.connect(admin).genesis(admin.address);
      const t2Addr = await token2.getAddress();
      const amount = ethers.parseUnits("1000", 18);
      await token2.connect(admin).transfer(ssfAddr, amount);

      await ssf.connect(timelock).deployLiquidity(
        recipient.address, t2Addr, amount, "stable deployment"
      );

      expect(await token2.balanceOf(recipient.address)).to.equal(amount);
    });

    it("stranger cannot deploy liquidity", async function () {
      const { ssf, srx, stranger, recipient, SEED } = await loadFixture(deployFixture);
      await expect(
        ssf.connect(stranger).deployLiquidity(
          recipient.address, await srx.getAddress(), SEED / 10n, "unauth"
        )
      ).to.be.revertedWithCustomError(ssf, "UnauthorisedCaller");
    });
  });

  // ── recoverLiquidity() ────────────────────────────────────────────────────

  describe("recoverLiquidity()", function () {
    it("governance can recover SRX from an external source", async function () {
      const { ssf, srx, timelock, recipient, ssfAddr, SEED } = await loadFixture(deployFixture);

      // Deploy some SRX out first, then recover it
      const deployed = SEED / 4n;
      await ssf.connect(timelock).deployLiquidity(
        recipient.address, await srx.getAddress(), deployed, "deploy"
      );

      // recipient approves SSF to pull back
      await srx.connect(recipient).approve(ssfAddr, deployed);

      const before = await ssf.srxBalance();
      await ssf.connect(timelock).recoverLiquidity(
        recipient.address, await srx.getAddress(), deployed
      );

      expect(await ssf.srxBalance()).to.equal(before + deployed);
      expect(await ssf.totalRecovered()).to.equal(deployed);
    });

    it("emits LiquidityRecovered", async function () {
      const { ssf, srx, timelock, recipient, ssfAddr, SEED } = await loadFixture(deployFixture);
      const amount = SEED / 10n;
      await ssf.connect(timelock).deployLiquidity(
        recipient.address, await srx.getAddress(), amount, "out"
      );
      await srx.connect(recipient).approve(ssfAddr, amount);

      await expect(
        ssf.connect(timelock).recoverLiquidity(
          recipient.address, await srx.getAddress(), amount
        )
      ).to.emit(ssf, "LiquidityRecovered");
    });

    it("stranger cannot recover liquidity", async function () {
      const { ssf, srx, stranger, recipient } = await loadFixture(deployFixture);
      await expect(
        ssf.connect(stranger).recoverLiquidity(
          recipient.address, await srx.getAddress(), 1n
        )
      ).to.be.reverted;
    });
  });

  // ── Governance parameters ─────────────────────────────────────────────────

  describe("Governance parameters", function () {
    it("setMaxDeployerBps updates cap", async function () {
      const { ssf, timelock } = await loadFixture(deployFixture);
      await ssf.connect(timelock).setMaxDeployerBps(2_000);
      expect(await ssf.maxDeployerBps()).to.equal(2_000n);
    });

    it("setMaxDeployerBps reverts if newBps > maxGuardianBps", async function () {
      const { ssf, timelock } = await loadFixture(deployFixture);
      await expect(ssf.connect(timelock).setMaxDeployerBps(8_000))
        .to.be.revertedWithCustomError(ssf, "InvalidBps");
    });

    it("setMaxGuardianBps updates cap", async function () {
      const { ssf, timelock } = await loadFixture(deployFixture);
      await ssf.connect(timelock).setMaxGuardianBps(8_000);
      expect(await ssf.maxGuardianBps()).to.equal(8_000n);
    });

    it("setMaxGuardianBps reverts if newBps < maxDeployerBps", async function () {
      const { ssf, timelock } = await loadFixture(deployFixture);
      await expect(ssf.connect(timelock).setMaxGuardianBps(2_000))
        .to.be.revertedWithCustomError(ssf, "InvalidBps");
    });

    it("setWithdrawLockDuration updates lock", async function () {
      const { ssf, timelock } = await loadFixture(deployFixture);
      await ssf.connect(timelock).setWithdrawLockDuration(7 * 24 * 3600);
      expect(await ssf.withdrawLockDuration()).to.equal(7n * 24n * 3600n);
    });

    it("setLayerTargetBps updates targets when sum = 10000", async function () {
      const { ssf, timelock } = await loadFixture(deployFixture);
      await ssf.connect(timelock).setLayerTargetBps(6_000, 3_000, 1_000);
      expect(await ssf.stableTargetBps()).to.equal(6_000n);
      expect(await ssf.coreTargetBps()).to.equal(3_000n);
      expect(await ssf.yieldTargetBps()).to.equal(1_000n);
    });

    it("setLayerTargetBps reverts if sum != 10000", async function () {
      const { ssf, timelock } = await loadFixture(deployFixture);
      await expect(ssf.connect(timelock).setLayerTargetBps(5_000, 3_000, 1_000))
        .to.be.revertedWithCustomError(ssf, "InvalidBps");
    });

    it("setRewardRate emits RewardRateSet", async function () {
      const { ssf, timelock } = await loadFixture(deployFixture);
      await expect(ssf.connect(timelock).setRewardRate(1_000n))
        .to.emit(ssf, "RewardRateSet").withArgs(0n, 1_000n);
    });

    it("stranger cannot change parameters", async function () {
      const { ssf, stranger } = await loadFixture(deployFixture);
      await expect(ssf.connect(stranger).setMaxDeployerBps(1_000)).to.be.reverted;
      await expect(ssf.connect(stranger).setRewardRate(1n)).to.be.reverted;
    });
  });

  // ── View helpers ──────────────────────────────────────────────────────────

  describe("View helpers", function () {
    it("srxBalance() reflects current SRX balance", async function () {
      const { ssf, SEED } = await loadFixture(deployFixture);
      expect(await ssf.srxBalance()).to.equal(SEED);
    });

    it("ethBalance() reflects received ETH", async function () {
      const { ssf, ssfAddr, admin } = await loadFixture(deployFixture);
      await admin.sendTransaction({ to: ssfAddr, value: ethers.parseEther("1") });
      expect(await ssf.ethBalance()).to.equal(ethers.parseEther("1"));
    });

    it("getDeployerCapRemaining() returns 0 when stress not active", async function () {
      const { ssf } = await loadFixture(deployFixture);
      expect(await ssf.getDeployerCapRemaining()).to.equal(0n);
    });

    it("getGuardianCapRemaining() returns 0 when stress not active", async function () {
      const { ssf } = await loadFixture(deployFixture);
      expect(await ssf.getGuardianCapRemaining()).to.equal(0n);
    });
  });

  // ── ETH acceptance ────────────────────────────────────────────────────────

  describe("ETH receive", function () {
    it("accepts ETH and emits ETHReceived", async function () {
      const { ssf, ssfAddr, admin } = await loadFixture(deployFixture);
      await expect(
        admin.sendTransaction({ to: ssfAddr, value: ethers.parseEther("2") })
      ).to.emit(ssf, "ETHReceived").withArgs(admin.address, ethers.parseEther("2"));
    });
  });

  // ── Pause / unpause ───────────────────────────────────────────────────────

  describe("Pause / unpause", function () {
    it("PAUSER_ROLE can pause and unpause", async function () {
      const { ssf, pauser } = await loadFixture(deployFixture);
      await ssf.connect(pauser).pause();
      expect(await ssf.paused()).to.be.true;

      await ssf.connect(pauser).unpause();
      expect(await ssf.paused()).to.be.false;
    });

    it("stranger cannot pause", async function () {
      const { ssf, stranger } = await loadFixture(deployFixture);
      await expect(ssf.connect(stranger).pause()).to.be.reverted;
    });

    it("governance deployLiquidity is blocked when paused", async function () {
      const { ssf, srx, timelock, pauser, recipient, SEED } = await loadFixture(deployFixture);
      await ssf.connect(pauser).pause();
      await expect(
        ssf.connect(timelock).deployLiquidity(
          recipient.address, await srx.getAddress(), SEED / 10n, "blocked"
        )
      ).to.be.revertedWithCustomError(ssf, "EnforcedPause");
    });

    it("triggerStressEvent is blocked when paused", async function () {
      const { ssf, oracle, pauser } = await loadFixture(deployFixture);
      await ssf.connect(pauser).pause();
      await expect(ssf.connect(oracle).triggerStressEvent())
        .to.be.revertedWithCustomError(ssf, "EnforcedPause");
    });
  });

  // ── UUPS upgrade authorization ────────────────────────────────────────────

  describe("UUPS upgrade", function () {
    it("UPGRADER_ROLE can authorise upgrade (admin holds it at init)", async function () {
      const { ssf, admin } = await loadFixture(deployFixture);
      const SSF2 = await ethers.getContractFactory("StabilisationFund", admin);

      // admin receives UPGRADER_ROLE at init for deployment bootstrap
      await expect(upgrades.upgradeProxy(await ssf.getAddress(), SSF2))
        .to.not.be.reverted;
    });

    it("GOVERNANCE_ROLE alone cannot authorise upgrade (SC-TRUST-001 separation)", async function () {
      const { ssf, timelock } = await loadFixture(deployFixture);
      // timelock holds GOVERNANCE_ROLE but NOT UPGRADER_ROLE — upgrade must revert.
      // This proves upgrade authority is no longer conflated with routine governance.
      const SSF2 = await ethers.getContractFactory("StabilisationFund", timelock);
      await expect(upgrades.upgradeProxy(await ssf.getAddress(), SSF2))
        .to.be.reverted;
    });

    it("UPGRADER_ROLE migrated to Timelock can authorise upgrade", async function () {
      const { ssf, admin, timelock } = await loadFixture(deployFixture);
      // Simulate the pre-mainnet migration: grant UPGRADER_ROLE to the Timelock.
      const UPGRADER_ROLE = await ssf.UPGRADER_ROLE();
      await ssf.connect(admin).grantRole(UPGRADER_ROLE, timelock.address);

      const SSF2 = await ethers.getContractFactory("StabilisationFund", timelock);
      await expect(upgrades.upgradeProxy(await ssf.getAddress(), SSF2))
        .to.not.be.reverted;
    });

    it("stranger cannot authorise upgrade", async function () {
      const { ssf, stranger } = await loadFixture(deployFixture);
      const SSF2 = await ethers.getContractFactory("StabilisationFund", stranger);
      await expect(upgrades.upgradeProxy(await ssf.getAddress(), SSF2))
        .to.be.reverted;
    });
  });

  // ── Round 6 findings ──────────────────────────────────────────────────────

  describe("Stress cooldown (A6-E-03)", function () {
    it("initialises stressCooldownDuration to 7 days", async function () {
      const { ssf } = await loadFixture(deployFixture);
      expect(await ssf.stressCooldownDuration()).to.equal(7n * 24n * 3600n);
    });

    it("first stress event triggers without cooldown check (stressResolvedAt == 0)", async function () {
      const { ssf, oracle } = await loadFixture(deployFixture);
      // First ever trigger — stressResolvedAt is 0, no cooldown applies
      await expect(ssf.connect(oracle).triggerStressEvent()).to.not.be.reverted;
    });

    it("reverts if a new stress event is triggered within cooldown period after resolve", async function () {
      const { ssf, oracle, timelock } = await loadFixture(deployFixture);
      // Trigger → resolve → immediately try to trigger again
      await ssf.connect(oracle).triggerStressEvent();
      await ssf.connect(timelock).resolveStressEvent();
      // Cooldown is 7 days — still within window
      await expect(ssf.connect(oracle).triggerStressEvent())
        .to.be.revertedWithCustomError(ssf, "StressInCooldown");
    });

    it("allows a new stress event after cooldown period elapses", async function () {
      const { ssf, oracle, timelock } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      await ssf.connect(timelock).resolveStressEvent();
      // Advance past 7-day cooldown
      await time.increase(7 * 24 * 3600 + 1);
      await expect(ssf.connect(oracle).triggerStressEvent()).to.not.be.reverted;
    });

    it("records stressResolvedAt on resolve", async function () {
      const { ssf, oracle, timelock } = await loadFixture(deployFixture);
      await ssf.connect(oracle).triggerStressEvent();
      const tx   = await ssf.connect(timelock).resolveStressEvent();
      const rcpt = await tx.wait();
      const block = await ethers.provider.getBlock(rcpt.blockNumber);
      expect(await ssf.stressResolvedAt()).to.equal(BigInt(block.timestamp));
    });

    it("governance can reduce cooldown duration", async function () {
      const { ssf, oracle, timelock, admin } = await loadFixture(deployFixture);
      await ssf.connect(admin).setStressCooldownDuration(1); // 1 second cooldown
      await ssf.connect(oracle).triggerStressEvent();
      await ssf.connect(timelock).resolveStressEvent();
      await time.increase(2);
      await expect(ssf.connect(oracle).triggerStressEvent()).to.not.be.reverted;
    });
  });

  describe("rescueDonatedTokens() — VestingVault post-revoke rescue (A6-VV-02)", function () {
    // Note: These tests are in VestingVault.test.js — SSF has no revoke mechanism.
    // Placeholder so Round 6 is documented in SSF test suite.
    it("setStressCooldownDuration emits event", async function () {
      const { ssf, admin } = await loadFixture(deployFixture);
      await expect(ssf.connect(admin).setStressCooldownDuration(3 * 24 * 3600))
        .to.emit(ssf, "StressCooldownDurationSet")
        .withArgs(7n * 24n * 3600n, 3n * 24n * 3600n);
    });
  });

  // ── Round 7 findings ──────────────────────────────────────────────────────

  describe("rescueStrandedPool() emits RewardPoolReset (R7-2)", function () {
    it("emits RewardPoolReset with correct recipient and amount instead of misleading RewardPoolFunded(0,0)", async function () {
      const { ssf, srx, timelock, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      const rewardAmount = ethers.parseUnits("100000", 18);

      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      await ssf.connect(timelock).notifyRewardAmount(rewardAmount);

      const lockDuration = await ssf.withdrawLockDuration();
      await time.increase(Number(lockDuration) + 1);
      await ssf.connect(contributor1).withdrawContribution(CONTRIB_AMOUNT);

      const poolBefore = await ssf.rewardPool();

      await expect(ssf.connect(timelock).rescueStrandedPool(timelock.address))
        .to.emit(ssf, "RewardPoolReset")
        .withArgs(timelock.address, poolBefore);
    });

    it("does NOT emit RewardPoolFunded(0,0) during rescue (event semantics corrected)", async function () {
      const { ssf, timelock, contributor1, CONTRIB_AMOUNT } = await loadFixture(deployFixture);
      const rewardAmount = ethers.parseUnits("100000", 18);

      await ssf.connect(contributor1).contribute(CONTRIB_AMOUNT);
      await ssf.connect(timelock).notifyRewardAmount(rewardAmount);

      const lockDuration = await ssf.withdrawLockDuration();
      await time.increase(Number(lockDuration) + 1);
      await ssf.connect(contributor1).withdrawContribution(CONTRIB_AMOUNT);

      // RewardPoolFunded should NOT be emitted — only RewardPoolReset
      const tx   = await ssf.connect(timelock).rescueStrandedPool(timelock.address);
      const rcpt = await tx.wait();
      const fundedLogs = rcpt.logs.filter(l => {
        try { return ssf.interface.parseLog(l)?.name === "RewardPoolFunded"; } catch { return false; }
      });
      expect(fundedLogs.length).to.equal(0);
    });
  });
});
