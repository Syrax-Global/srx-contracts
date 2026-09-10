const { expect } = require("chai");
const { ethers }  = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ─────────────────────────────────────────────────────────────────────────────
// Minimal pausable stub — stands in for any protocol contract (token, staking…)
// so we can test GuardianModule without deploying the full ecosystem.
// ─────────────────────────────────────────────────────────────────────────────
const PAUSABLE_STUB_ABI = [
  "function pause() external",
  "function unpause() external",
  "function paused() external view returns (bool)",
];

async function deployPausableStub(admin) {
  const factory = await ethers.getContractFactory("PausableStub");
  const stub = await factory.deploy();
  await stub.waitForDeployment();
  return stub;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("GuardianModule", function () {

  const PAUSE_COOLDOWN     = 3600;   // 1 hour
  const PAUSE_ALL_COOLDOWN = 1800;   // 30 min
  const SUNSET_DURATION    = 15_552_000; // 6 months

  async function deployFixture() {
    const [admin, guardian, governance, circuitBreaker, other] =
      await ethers.getSigners();

    // ── Deploy pausable stubs ──────────────────────────────────────────────
    const PausableStub = await ethers.getContractFactory("PausableStub");
    const tokenStub    = await PausableStub.deploy();
    const bridgeStub   = await PausableStub.deploy();
    const stakingStub  = await PausableStub.deploy();
    const feeStub      = await PausableStub.deploy();
    const treasuryStub = await PausableStub.deploy();
    // MODULE_SSF is in pauseAll()'s array but had NO stub here, so it was never
    // registered in the fixture and pauseAll silently `continue`d past it. The
    // Stabilisation Fund holds 1.5B SRX and was the one module in the emergency
    // stop with nothing asserting it actually stops. See PD-F11.
    const ssfStub      = await PausableStub.deploy();

    await Promise.all([
      tokenStub.waitForDeployment(),
      bridgeStub.waitForDeployment(),
      stakingStub.waitForDeployment(),
      feeStub.waitForDeployment(),
      treasuryStub.waitForDeployment(),
      ssfStub.waitForDeployment(),
    ]);

    // ── Deploy GuardianModule ─────────────────────────────────────────────
    const GuardianModule = await ethers.getContractFactory("GuardianModule");
    const guardian_module = await GuardianModule.deploy(
      admin.address,
      guardian.address,
      governance.address,
      SUNSET_DURATION
    );
    await guardian_module.waitForDeployment();

    // Grant CIRCUIT_BREAKER_ROLE
    const CB_ROLE = await guardian_module.CIRCUIT_BREAKER_ROLE();
    await guardian_module.connect(admin).grantRole(CB_ROLE, circuitBreaker.address);

    // ── Register modules ──────────────────────────────────────────────────
    const MODULE_TOKEN    = await guardian_module.MODULE_TOKEN();
    const MODULE_BRIDGE   = await guardian_module.MODULE_BRIDGE();
    const MODULE_STAKING  = await guardian_module.MODULE_STAKING();
    const MODULE_FEE      = await guardian_module.MODULE_FEE();
    const MODULE_TREASURY = await guardian_module.MODULE_TREASURY();
    const MODULE_SSF      = await guardian_module.MODULE_SSF();

    await guardian_module.connect(governance).registerModule(MODULE_TOKEN,    await tokenStub.getAddress());
    await guardian_module.connect(governance).registerModule(MODULE_BRIDGE,   await bridgeStub.getAddress());
    await guardian_module.connect(governance).registerModule(MODULE_STAKING,  await stakingStub.getAddress());
    await guardian_module.connect(governance).registerModule(MODULE_FEE,      await feeStub.getAddress());
    await guardian_module.connect(governance).registerModule(MODULE_TREASURY, await treasuryStub.getAddress());
    await guardian_module.connect(governance).registerModule(MODULE_SSF,      await ssfStub.getAddress());

    return {
      guardian_module,
      tokenStub, bridgeStub, stakingStub, feeStub, treasuryStub, ssfStub,
      admin, guardian, governance, circuitBreaker, other,
      MODULE_TOKEN, MODULE_BRIDGE, MODULE_STAKING, MODULE_FEE, MODULE_TREASURY, MODULE_SSF,
    };
  }

  // ── Deployment ─────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets MAXIMUM_SUNSET correctly", async function () {
      const { guardian_module } = await loadFixture(deployFixture);
      const deployed = await ethers.provider.getBlock("latest");
      const max = await guardian_module.MAXIMUM_SUNSET();
      expect(max).to.be.closeTo(BigInt(deployed.timestamp + SUNSET_DURATION), 10n);
    });

    it("effectiveSunset equals MAXIMUM_SUNSET at deployment", async function () {
      const { guardian_module } = await loadFixture(deployFixture);
      expect(await guardian_module.effectiveSunset()).to.equal(
        await guardian_module.MAXIMUM_SUNSET()
      );
    });

    it("isExpired returns false immediately after deployment", async function () {
      const { guardian_module } = await loadFixture(deployFixture);
      expect(await guardian_module.isExpired()).to.be.false;
    });

    it("all five modules are registered", async function () {
      const { guardian_module, MODULE_TOKEN, MODULE_BRIDGE, MODULE_STAKING, MODULE_FEE, MODULE_TREASURY } =
        await loadFixture(deployFixture);

      for (const id of [MODULE_TOKEN, MODULE_BRIDGE, MODULE_STAKING, MODULE_FEE, MODULE_TREASURY]) {
        const m = await guardian_module.modules(id);
        expect(m.registered).to.be.true;
      }
    });
  });

  // ── pauseModule ────────────────────────────────────────────────────────────

  describe("pauseModule()", function () {
    it("guardian can pause a module", async function () {
      const { guardian_module, guardian, tokenStub, MODULE_TOKEN } =
        await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "security incident");

      expect(await tokenStub.paused()).to.be.true;
      expect((await guardian_module.modules(MODULE_TOKEN)).paused).to.be.true;
    });

    it("emits GuardianAction with Pause action type", async function () {
      const { guardian_module, guardian, MODULE_TOKEN } = await loadFixture(deployFixture);

      await expect(
        guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "test pause")
      ).to.emit(guardian_module, "GuardianAction")
        .withArgs(MODULE_TOKEN, guardian.address, 0 /* Pause */, "test pause", await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));
    });

    it("increments pauseCount", async function () {
      const { guardian_module, guardian, MODULE_TOKEN } = await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "first");
      await guardian_module.connect(guardian).unpauseModule(MODULE_TOKEN, "restore");
      await time.increase(PAUSE_COOLDOWN);
      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "second");

      expect((await guardian_module.modules(MODULE_TOKEN)).pauseCount).to.equal(2n);
    });

    it("reverts if module is already paused", async function () {
      const { guardian_module, guardian, MODULE_TOKEN } = await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "first");
      await expect(
        guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "second")
      ).to.be.revertedWithCustomError(guardian_module, "ModuleAlreadyPaused");
    });

    it("reverts within cooldown window", async function () {
      const { guardian_module, guardian, MODULE_TOKEN } = await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "first");
      await guardian_module.connect(guardian).unpauseModule(MODULE_TOKEN, "restore");

      // No time increase — cooldown active
      await expect(
        guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "second")
      ).to.be.revertedWithCustomError(guardian_module, "CooldownActive");
    });

    it("succeeds after cooldown elapses", async function () {
      const { guardian_module, guardian, tokenStub, MODULE_TOKEN } =
        await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "first");
      await guardian_module.connect(guardian).unpauseModule(MODULE_TOKEN, "restore");
      await time.increase(PAUSE_COOLDOWN);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "second");
      expect(await tokenStub.paused()).to.be.true;
    });

    it("reverts if caller lacks GUARDIAN_ROLE", async function () {
      const { guardian_module, other, MODULE_TOKEN } = await loadFixture(deployFixture);

      await expect(
        guardian_module.connect(other).pauseModule(MODULE_TOKEN, "unauthorised")
      ).to.be.reverted;
    });

    it("reverts with empty reason", async function () {
      const { guardian_module, guardian, MODULE_TOKEN } = await loadFixture(deployFixture);

      await expect(
        guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "")
      ).to.be.revertedWithCustomError(guardian_module, "EmptyReason");
    });

    it("reverts after sunset expires", async function () {
      const { guardian_module, guardian, MODULE_TOKEN } = await loadFixture(deployFixture);

      await time.increase(SUNSET_DURATION + 1);

      await expect(
        guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "too late")
      ).to.be.revertedWithCustomError(guardian_module, "GuardianExpired");
    });
  });

  // ── unpauseModule ──────────────────────────────────────────────────────────

  describe("unpauseModule()", function () {
    it("guardian can unpause a paused module", async function () {
      const { guardian_module, guardian, tokenStub, MODULE_TOKEN } =
        await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "pause");
      await guardian_module.connect(guardian).unpauseModule(MODULE_TOKEN, "all clear");

      expect(await tokenStub.paused()).to.be.false;
      expect((await guardian_module.modules(MODULE_TOKEN)).paused).to.be.false;
    });

    it("reverts if module is not paused", async function () {
      const { guardian_module, guardian, MODULE_TOKEN } = await loadFixture(deployFixture);

      await expect(
        guardian_module.connect(guardian).unpauseModule(MODULE_TOKEN, "not paused")
      ).to.be.revertedWithCustomError(guardian_module, "ModuleNotPaused");
    });

    it("reverts after sunset expires", async function () {
      const { guardian_module, guardian, MODULE_TOKEN } = await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "pause before sunset");
      await time.increase(SUNSET_DURATION + 1);

      await expect(
        guardian_module.connect(guardian).unpauseModule(MODULE_TOKEN, "too late")
      ).to.be.revertedWithCustomError(guardian_module, "GuardianExpired");
    });
  });

  // ── pauseAll ───────────────────────────────────────────────────────────────

  describe("pauseAll()", function () {
    it("pauses all registered modules", async function () {
      const { guardian_module, guardian, tokenStub, bridgeStub, stakingStub, feeStub, treasuryStub, ssfStub } =
        await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseAll("system-wide incident");

      for (const stub of [tokenStub, bridgeStub, stakingStub, feeStub, treasuryStub, ssfStub]) {
        expect(await stub.paused()).to.be.true;
      }
    });

    // PD-F11 said pauseAll "omits the Stabilisation Fund". The contract does NOT
    // omit it — MODULE_SSF has been in the array since the initial commit. The
    // omission was in the TEST, and that is the more dangerous shape: pauseAll is
    // best-effort by design (R7-02), so it `continue`s past an unregistered
    // module and swallows a failed _tryPause without reverting. A regression that
    // stopped 1.5B SRX from pausing would therefore have been completely silent.
    // This asserts the fund specifically, so it cannot go quiet again.
    it("pauses the Stabilisation Fund specifically — 1.5B SRX must not stay movable", async function () {
      const { guardian_module, guardian, ssfStub, MODULE_SSF } = await loadFixture(deployFixture);

      expect(await ssfStub.paused()).to.be.false;
      expect((await guardian_module.modules(MODULE_SSF)).registered).to.be.true;

      await guardian_module.connect(guardian).pauseAll("stabilisation fund incident");

      expect(await ssfStub.paused(), "StabilisationFund was NOT paused by pauseAll").to.be.true;
      expect((await guardian_module.modules(MODULE_SSF)).paused).to.be.true;
    });

    // The mirror case. emergencyUnpauseAll carries the same best-effort semantics,
    // so a fund that pauses but never comes back is just as much a failure.
    it("brings the Stabilisation Fund back on emergencyUnpauseAll", async function () {
      const { guardian_module, guardian, governance, ssfStub, MODULE_SSF } = await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseAll("incident");
      expect(await ssfStub.paused()).to.be.true;

      // emergencyUnpauseAll is GOVERNANCE_ROLE, not admin.
      await guardian_module.connect(governance).emergencyUnpauseAll("all clear");

      expect(await ssfStub.paused(), "StabilisationFund stayed paused after emergencyUnpauseAll").to.be.false;
      expect((await guardian_module.modules(MODULE_SSF)).paused).to.be.false;
    });

    it("emits GuardianAction with PauseAll action type", async function () {
      const { guardian_module, guardian } = await loadFixture(deployFixture);

      await expect(
        guardian_module.connect(guardian).pauseAll("emergency")
      ).to.emit(guardian_module, "GuardianAction")
        .withArgs(ethers.ZeroHash, guardian.address, 2 /* PauseAll */, "emergency", await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));
    });

    it("skips already-paused modules", async function () {
      const { guardian_module, guardian, MODULE_TOKEN } = await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "pre-pause");
      // Should not revert even though TOKEN is already paused
      await expect(
        guardian_module.connect(guardian).pauseAll("emergency")
      ).to.not.be.reverted;
    });

    it("reverts within pauseAll cooldown", async function () {
      const { guardian_module, guardian } = await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseAll("first");
      await expect(
        guardian_module.connect(guardian).pauseAll("second")
      ).to.be.revertedWithCustomError(guardian_module, "PauseAllCooldownActive");
    });

    it("succeeds after pauseAll cooldown elapses", async function () {
      const { guardian_module, guardian } = await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseAll("first");
      await time.increase(PAUSE_ALL_COOLDOWN);
      await expect(
        guardian_module.connect(guardian).pauseAll("second")
      ).to.not.be.reverted;
    });
  });

  // ── governanceUnpause ──────────────────────────────────────────────────────

  describe("governanceUnpause()", function () {
    it("governance can unpause a guardian-paused module", async function () {
      const { guardian_module, guardian, governance, tokenStub, MODULE_TOKEN } =
        await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "guardian pause");
      await guardian_module.connect(governance).governanceUnpause(MODULE_TOKEN, "governance override");

      expect(await tokenStub.paused()).to.be.false;
      expect((await guardian_module.modules(MODULE_TOKEN)).paused).to.be.false;
    });

    it("emits GovernanceOverride", async function () {
      const { guardian_module, guardian, governance, MODULE_TOKEN } =
        await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "pause");

      await expect(
        guardian_module.connect(governance).governanceUnpause(MODULE_TOKEN, "override")
      ).to.emit(guardian_module, "GovernanceOverride")
        .withArgs(MODULE_TOKEN, governance.address, "override", await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));
    });

    it("governance can override even after sunset", async function () {
      const { guardian_module, guardian, governance, tokenStub, MODULE_TOKEN } =
        await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "pause");
      await time.increase(SUNSET_DURATION + 1); // Guardian authority expired

      await guardian_module.connect(governance).governanceUnpause(MODULE_TOKEN, "override post-sunset");
      expect(await tokenStub.paused()).to.be.false;
    });

    it("reverts if module is not paused", async function () {
      const { guardian_module, governance, MODULE_TOKEN } = await loadFixture(deployFixture);

      await expect(
        guardian_module.connect(governance).governanceUnpause(MODULE_TOKEN, "not paused")
      ).to.be.revertedWithCustomError(guardian_module, "ModuleNotPaused");
    });

    it("reverts if caller lacks GOVERNANCE_ROLE", async function () {
      const { guardian_module, guardian, other, MODULE_TOKEN } =
        await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "pause");
      await expect(
        guardian_module.connect(other).governanceUnpause(MODULE_TOKEN, "unauthorised")
      ).to.be.reverted;
    });
  });

  // ── emergencyUnpauseAll ────────────────────────────────────────────────────

  describe("emergencyUnpauseAll()", function () {
    it("unpauses all paused modules", async function () {
      const { guardian_module, guardian, governance, tokenStub, bridgeStub, stakingStub, feeStub, treasuryStub } =
        await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseAll("emergency pause");
      await guardian_module.connect(governance).emergencyUnpauseAll("governance restore");

      for (const stub of [tokenStub, bridgeStub, stakingStub, feeStub, treasuryStub]) {
        expect(await stub.paused()).to.be.false;
      }
    });

    it("skips modules that are already unpaused", async function () {
      const { guardian_module, guardian, governance, MODULE_TOKEN } =
        await loadFixture(deployFixture);

      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "just token");
      // Should not revert even though other modules are not paused
      await expect(
        guardian_module.connect(governance).emergencyUnpauseAll("restore")
      ).to.not.be.reverted;
    });
  });

  // ── reduceSunset ───────────────────────────────────────────────────────────

  describe("reduceSunset()", function () {
    it("governance can reduce the effective sunset", async function () {
      const { guardian_module, governance } = await loadFixture(deployFixture);

      const current = await guardian_module.effectiveSunset();
      const newSunset = current - BigInt(SUNSET_DURATION / 2);

      await guardian_module.connect(governance).reduceSunset(newSunset);
      expect(await guardian_module.effectiveSunset()).to.equal(newSunset);
    });

    it("emits SunsetReduced", async function () {
      const { guardian_module, governance } = await loadFixture(deployFixture);

      const current = await guardian_module.effectiveSunset();
      const newSunset = current - BigInt(SUNSET_DURATION / 2);

      await expect(
        guardian_module.connect(governance).reduceSunset(newSunset)
      ).to.emit(guardian_module, "SunsetReduced")
        .withArgs(current, newSunset, governance.address);
    });

    it("MAXIMUM_SUNSET is immutable — reduceSunset cannot raise effective above it", async function () {
      const { guardian_module, governance } = await loadFixture(deployFixture);

      const max = await guardian_module.MAXIMUM_SUNSET();
      const tooHigh = max + 1n;

      await expect(
        guardian_module.connect(governance).reduceSunset(tooHigh)
      ).to.be.revertedWithCustomError(guardian_module, "CannotExtendSunset");
    });

    it("reverts if new sunset is in the past", async function () {
      const { guardian_module, governance } = await loadFixture(deployFixture);

      const pastTimestamp = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 1n;
      await expect(
        guardian_module.connect(governance).reduceSunset(pastTimestamp)
      ).to.be.revertedWithCustomError(guardian_module, "NewSunsetMustBeFuture");
    });

    it("guardian CANNOT call reduceSunset", async function () {
      const { guardian_module, guardian } = await loadFixture(deployFixture);

      const current = await guardian_module.effectiveSunset();
      await expect(
        guardian_module.connect(guardian).reduceSunset(current - 1n)
      ).to.be.reverted;
    });

    it("guardian powers expire at reduced sunset", async function () {
      const { guardian_module, guardian, governance, MODULE_TOKEN } =
        await loadFixture(deployFixture);

      // Reduce sunset to just 5 minutes from now
      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const shortSunset = now + 300n;
      await guardian_module.connect(governance).reduceSunset(shortSunset);

      await time.increase(301);

      await expect(
        guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "too late")
      ).to.be.revertedWithCustomError(guardian_module, "GuardianExpired");
    });
  });

  // ── Circuit breaker ────────────────────────────────────────────────────────

  describe("Circuit breaker", function () {
    const VOLUME_THRESHOLD = ethers.parseUnits("10000000", 18); // 10M SRX
    const WINDOW_DURATION  = 3600n; // 1 hour

    async function withCircuitBreaker() {
      const ctx = await loadFixture(deployFixture);
      await ctx.guardian_module.connect(ctx.governance).configureCircuitBreaker(
        ctx.MODULE_BRIDGE,
        VOLUME_THRESHOLD,
        WINDOW_DURATION
      );
      return ctx;
    }

    it("configures circuit breaker correctly", async function () {
      const { guardian_module, MODULE_BRIDGE } = await withCircuitBreaker();

      const [tripped,, threshold] = await guardian_module.getCircuitBreakerStatus(MODULE_BRIDGE);
      expect(tripped).to.be.false;
      expect(threshold).to.equal(VOLUME_THRESHOLD);
    });

    it("does not trip below threshold", async function () {
      const { guardian_module, circuitBreaker, bridgeStub, MODULE_BRIDGE } =
        await withCircuitBreaker();

      await guardian_module.connect(circuitBreaker).recordBridgeActivity(
        MODULE_BRIDGE, VOLUME_THRESHOLD - 1n
      );

      expect(await bridgeStub.paused()).to.be.false;
      const [tripped] = await guardian_module.getCircuitBreakerStatus(MODULE_BRIDGE);
      expect(tripped).to.be.false;
    });

    it("trips and pauses bridge at threshold", async function () {
      const { guardian_module, circuitBreaker, bridgeStub, MODULE_BRIDGE } =
        await withCircuitBreaker();

      await guardian_module.connect(circuitBreaker).recordBridgeActivity(
        MODULE_BRIDGE, VOLUME_THRESHOLD
      );

      expect(await bridgeStub.paused()).to.be.true;
      const [tripped] = await guardian_module.getCircuitBreakerStatus(MODULE_BRIDGE);
      expect(tripped).to.be.true;
    });

    it("emits CircuitBreakerTripped", async function () {
      const { guardian_module, circuitBreaker, MODULE_BRIDGE } =
        await withCircuitBreaker();

      await expect(
        guardian_module.connect(circuitBreaker).recordBridgeActivity(MODULE_BRIDGE, VOLUME_THRESHOLD)
      ).to.emit(guardian_module, "CircuitBreakerTripped")
        .withArgs(MODULE_BRIDGE, VOLUME_THRESHOLD, VOLUME_THRESHOLD, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));
    });

    it("accumulates volume across multiple calls in same window", async function () {
      const { guardian_module, circuitBreaker, bridgeStub, MODULE_BRIDGE } =
        await withCircuitBreaker();

      const half = VOLUME_THRESHOLD / 2n;
      await guardian_module.connect(circuitBreaker).recordBridgeActivity(MODULE_BRIDGE, half);
      expect(await bridgeStub.paused()).to.be.false;

      await guardian_module.connect(circuitBreaker).recordBridgeActivity(MODULE_BRIDGE, half);
      expect(await bridgeStub.paused()).to.be.true;
    });

    it("resets volume after window expires", async function () {
      const { guardian_module, circuitBreaker, bridgeStub, MODULE_BRIDGE } =
        await withCircuitBreaker();

      // Use 90% — no trip yet
      await guardian_module.connect(circuitBreaker).recordBridgeActivity(
        MODULE_BRIDGE, (VOLUME_THRESHOLD * 9n) / 10n
      );
      expect(await bridgeStub.paused()).to.be.false;

      // Advance past window — volume resets
      await time.increase(Number(WINDOW_DURATION) + 1);

      // Another 90% — still below threshold since window reset
      await guardian_module.connect(circuitBreaker).recordBridgeActivity(
        MODULE_BRIDGE, (VOLUME_THRESHOLD * 9n) / 10n
      );
      expect(await bridgeStub.paused()).to.be.false;
    });

    it("governance can reset a tripped circuit breaker", async function () {
      const { guardian_module, circuitBreaker, governance, MODULE_BRIDGE } =
        await withCircuitBreaker();

      await guardian_module.connect(circuitBreaker).recordBridgeActivity(MODULE_BRIDGE, VOLUME_THRESHOLD);
      await guardian_module.connect(governance).resetCircuitBreaker(MODULE_BRIDGE);

      const [tripped] = await guardian_module.getCircuitBreakerStatus(MODULE_BRIDGE);
      expect(tripped).to.be.false;
    });

    it("emits CircuitBreakerReset", async function () {
      const { guardian_module, circuitBreaker, governance, MODULE_BRIDGE } =
        await withCircuitBreaker();

      await guardian_module.connect(circuitBreaker).recordBridgeActivity(MODULE_BRIDGE, VOLUME_THRESHOLD);

      await expect(
        guardian_module.connect(governance).resetCircuitBreaker(MODULE_BRIDGE)
      ).to.emit(guardian_module, "CircuitBreakerReset")
        .withArgs(MODULE_BRIDGE, governance.address);
    });

    it("reverts resetCircuitBreaker if not tripped", async function () {
      const { guardian_module, governance, MODULE_BRIDGE } = await withCircuitBreaker();

      await expect(
        guardian_module.connect(governance).resetCircuitBreaker(MODULE_BRIDGE)
      ).to.be.revertedWithCustomError(guardian_module, "CircuitBreakerNotTripped");
    });

    it("reverts recordBridgeActivity if already tripped within same window", async function () {
      const { guardian_module, circuitBreaker, MODULE_BRIDGE } = await withCircuitBreaker();

      await guardian_module.connect(circuitBreaker).recordBridgeActivity(MODULE_BRIDGE, VOLUME_THRESHOLD);
      await expect(
        guardian_module.connect(circuitBreaker).recordBridgeActivity(MODULE_BRIDGE, 1n)
      ).to.be.revertedWithCustomError(guardian_module, "CircuitBreakerAlreadyTripped");
    });

    it("auto-resets tripped flag when window expires (A4-M-02)", async function () {
      // Principle: a volume spike in window A should not permanently block window B.
      // The fix rolls the window BEFORE checking tripped, clearing the flag on new window.
      const { guardian_module, circuitBreaker, governance, MODULE_BRIDGE } =
        await withCircuitBreaker();

      // Trip the breaker in window A
      await guardian_module.connect(circuitBreaker).recordBridgeActivity(MODULE_BRIDGE, VOLUME_THRESHOLD);
      let [tripped] = await guardian_module.getCircuitBreakerStatus(MODULE_BRIDGE);
      expect(tripped).to.be.true;

      // Governance unpauses the bridge but does NOT call resetCircuitBreaker()
      await guardian_module.connect(governance).governanceUnpause(MODULE_BRIDGE, "market stable");

      // Advance past the window boundary (1 hour + 1 second)
      const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
      await time.increase(Number(WINDOW_DURATION) + 1);

      // Recording activity in the new window should succeed (auto-reset) not revert
      await expect(
        guardian_module.connect(circuitBreaker).recordBridgeActivity(MODULE_BRIDGE, 1n)
      ).to.not.be.reverted;

      // The tripped flag should now be false (new window)
      [tripped] = await guardian_module.getCircuitBreakerStatus(MODULE_BRIDGE);
      expect(tripped).to.be.false;
    });

    it("governance must separately unpause after reset", async function () {
      const { guardian_module, circuitBreaker, governance, bridgeStub, MODULE_BRIDGE } =
        await withCircuitBreaker();

      await guardian_module.connect(circuitBreaker).recordBridgeActivity(MODULE_BRIDGE, VOLUME_THRESHOLD);
      expect(await bridgeStub.paused()).to.be.true;

      await guardian_module.connect(governance).resetCircuitBreaker(MODULE_BRIDGE);
      // Circuit breaker reset but module still paused
      expect(await bridgeStub.paused()).to.be.true;

      await guardian_module.connect(governance).governanceUnpause(MODULE_BRIDGE, "safe to resume");
      expect(await bridgeStub.paused()).to.be.false;
    });
  });

  // ── Cross-chain signaling ──────────────────────────────────────────────────

  describe("Cross-chain pause signaling", function () {
    const BSC_EID = 40102;

    it("guardian can signal cross-chain pause", async function () {
      const { guardian_module, guardian, MODULE_BRIDGE } = await loadFixture(deployFixture);

      await guardian_module.connect(guardian).signalCrossChainPause(
        BSC_EID, MODULE_BRIDGE, true, "suspicious bridge activity"
      );

      expect(await guardian_module.crossChainPauseIntent(BSC_EID, MODULE_BRIDGE)).to.be.true;
    });

    it("emits CrossChainPauseSignal", async function () {
      const { guardian_module, guardian, MODULE_BRIDGE } = await loadFixture(deployFixture);

      await expect(
        guardian_module.connect(guardian).signalCrossChainPause(BSC_EID, MODULE_BRIDGE, true, "alert")
      ).to.emit(guardian_module, "CrossChainPauseSignal")
        .withArgs(BSC_EID, MODULE_BRIDGE, true, guardian.address, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));
    });

    it("guardian can signal unpause after investigation", async function () {
      const { guardian_module, guardian, MODULE_BRIDGE } = await loadFixture(deployFixture);

      await guardian_module.connect(guardian).signalCrossChainPause(BSC_EID, MODULE_BRIDGE, true, "pause");
      await guardian_module.connect(guardian).signalCrossChainPause(BSC_EID, MODULE_BRIDGE, false, "all clear");

      expect(await guardian_module.crossChainPauseIntent(BSC_EID, MODULE_BRIDGE)).to.be.false;
    });

    it("reverts after sunset", async function () {
      const { guardian_module, guardian, MODULE_BRIDGE } = await loadFixture(deployFixture);

      await time.increase(SUNSET_DURATION + 1);

      await expect(
        guardian_module.connect(guardian).signalCrossChainPause(BSC_EID, MODULE_BRIDGE, true, "late")
      ).to.be.revertedWithCustomError(guardian_module, "GuardianExpired");
    });
  });

  // ── Module registration edge cases ────────────────────────────────────────

  describe("Module registration", function () {
    it("reverts if registering same moduleId twice", async function () {
      const { guardian_module, governance, MODULE_TOKEN, tokenStub } =
        await loadFixture(deployFixture);

      await expect(
        guardian_module.connect(governance).registerModule(MODULE_TOKEN, await tokenStub.getAddress())
      ).to.be.revertedWithCustomError(guardian_module, "ModuleAlreadyRegistered");
    });

    it("reverts with zero address as target", async function () {
      const { guardian_module, governance } = await loadFixture(deployFixture);
      const newId = ethers.keccak256(ethers.toUtf8Bytes("NEW_MODULE"));

      await expect(
        guardian_module.connect(governance).registerModule(newId, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(guardian_module, "ZeroAddress");
    });

    it("non-governance cannot register modules", async function () {
      const { guardian_module, guardian, tokenStub } = await loadFixture(deployFixture);
      const newId = ethers.keccak256(ethers.toUtf8Bytes("NEW_MODULE"));

      await expect(
        guardian_module.connect(guardian).registerModule(newId, await tokenStub.getAddress())
      ).to.be.reverted;
    });

    it("governance can update module target address", async function () {
      const { guardian_module, governance, MODULE_TOKEN, bridgeStub } =
        await loadFixture(deployFixture);

      const newAddr = await bridgeStub.getAddress();
      await guardian_module.connect(governance).updateModuleTarget(MODULE_TOKEN, newAddr);
      expect((await guardian_module.modules(MODULE_TOKEN)).target).to.equal(newAddr);
    });
  });

  // ── View helpers ───────────────────────────────────────────────────────────

  describe("View helpers", function () {
    it("secondsUntilSunset decreases over time", async function () {
      const { guardian_module } = await loadFixture(deployFixture);

      const before = await guardian_module.secondsUntilSunset();
      await time.increase(1000);
      const after = await guardian_module.secondsUntilSunset();

      expect(after).to.be.lessThan(before);
    });

    it("secondsUntilSunset returns 0 after expiry", async function () {
      const { guardian_module } = await loadFixture(deployFixture);

      await time.increase(SUNSET_DURATION + 1);
      expect(await guardian_module.secondsUntilSunset()).to.equal(0n);
    });

    it("isModulePaused reflects current state", async function () {
      const { guardian_module, guardian, MODULE_TOKEN } = await loadFixture(deployFixture);

      expect(await guardian_module.isModulePaused(MODULE_TOKEN)).to.be.false;
      await guardian_module.connect(guardian).pauseModule(MODULE_TOKEN, "check");
      expect(await guardian_module.isModulePaused(MODULE_TOKEN)).to.be.true;
    });
  });
});
