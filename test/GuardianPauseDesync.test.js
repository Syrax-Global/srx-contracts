// R7-02 regression — a desynchronised module must not brick the emergency batch.
//
// Every protocol contract grants PAUSER_ROLE to the admin/Safe as well as to
// GuardianModule, so there are two independent pause authorities. GuardianModule's
// `modules[id].paused` flag only tracks calls made THROUGH it, so a direct pause() by
// the admin desyncs it. Previously that was fatal: the already-paused module reverted
// EnforcedPause inside _callPause, which reverted the ENTIRE pauseAll() and disabled
// the emergency stop for every other module — at exactly the moment it was needed.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("GuardianModule — pause desynchronisation (R7-02)", function () {
  const SUNSET_DURATION = 15_552_000; // 6 months

  async function fx() {
    const [admin, guardian, governance] = await ethers.getSigners();

    // MUST be the strict stub: PausableStub is idempotent and cannot revert, so it
    // silently passes the very scenarios this suite exists to catch (see R7-06).
    const PausableStub = await ethers.getContractFactory("PausableStrictStub");
    const stubs = {};
    for (const k of ["token", "bridge", "staking", "fee", "treasury"]) {
      stubs[k] = await PausableStub.deploy();
      await stubs[k].waitForDeployment();
    }

    const GuardianModule = await ethers.getContractFactory("GuardianModule");
    const gm = await GuardianModule.deploy(
      admin.address, guardian.address, governance.address, SUNSET_DURATION
    );
    await gm.waitForDeployment();

    const IDS = {
      token:    await gm.MODULE_TOKEN(),
      bridge:   await gm.MODULE_BRIDGE(),
      staking:  await gm.MODULE_STAKING(),
      fee:      await gm.MODULE_FEE(),
      treasury: await gm.MODULE_TREASURY(),
    };
    for (const k of Object.keys(IDS)) {
      await gm.connect(governance).registerModule(IDS[k], await stubs[k].getAddress());
    }
    return { gm, stubs, IDS, admin, guardian, governance };
  }

  it("REGRESSION: pauseAll succeeds even when a module was paused directly", async function () {
    const { gm, stubs, IDS, guardian } = await loadFixture(fx);

    // Simulate the admin Safe pausing the token directly, bypassing GuardianModule.
    await stubs.token.pause();
    expect(await stubs.token.paused()).to.equal(true);
    expect(await gm.isModulePaused(IDS.token)).to.equal(false); // local state is now STALE

    // Emergency stop must still work for everything else.
    await expect(gm.connect(guardian).pauseAll("incident")).to.not.be.reverted;

    for (const k of ["staking", "fee", "treasury"]) {
      expect(await stubs[k].paused()).to.equal(true);
      expect(await gm.isModulePaused(IDS[k])).to.equal(true);
    }
    expect(await stubs.bridge.bridgePaused()).to.equal(true); // the bridge-only stop
    expect(await gm.isModulePaused(IDS.bridge)).to.equal(true);
  });

  it("adopts a module already paused outside it, visibly, as governance's (SWEEP-02)", async function () {
    const { gm, stubs, IDS, guardian } = await loadFixture(fx);
    await stubs.token.pause();

    // Read first, so the batch never calls pause on it: adopted, and the guardian cannot lift it.
    await expect(gm.connect(guardian).pauseAll("incident"))
      .to.emit(gm, "ModuleStateReconciled")
      .withArgs(IDS.token, true);
    expect(await gm.governanceOnlyUnpause(IDS.token)).to.equal(true);
  });

  it("reconciles stale local state from the target contract", async function () {
    const { gm, stubs, IDS, guardian } = await loadFixture(fx);
    await stubs.token.pause();
    expect(await gm.isModulePaused(IDS.token)).to.equal(false); // stale

    await gm.connect(guardian).pauseAll("incident");

    // Local state now matches on-chain reality rather than staying wrong.
    expect(await gm.isModulePaused(IDS.token)).to.equal(true);
  });

  it("REGRESSION: emergencyUnpauseAll survives a module unpaused directly", async function () {
    const { gm, stubs, IDS, guardian, governance } = await loadFixture(fx);

    await gm.connect(guardian).pauseAll("incident");
    const stopped = async (k) => (k === "bridge" ? stubs[k].bridgePaused() : stubs[k].paused());
    for (const k of Object.keys(IDS)) expect(await stopped(k)).to.equal(true);

    // Admin unpauses one directly — GuardianModule still thinks it is paused.
    await stubs.token.unpause();
    expect(await gm.isModulePaused(IDS.token)).to.equal(true); // stale

    // Governance recovery must not be blocked by that one module.
    await expect(gm.connect(governance).emergencyUnpauseAll("recovered")).to.not.be.reverted;

    for (const k of Object.keys(IDS)) {
      expect(await stopped(k)).to.equal(false);
      expect(await gm.isModulePaused(IDS[k])).to.equal(false);
    }
  });

  it("still pauses every module when nothing is desynced (happy path intact)", async function () {
    const { gm, stubs, IDS, guardian } = await loadFixture(fx);
    await gm.connect(guardian).pauseAll("incident");
    for (const k of Object.keys(IDS)) {
      expect(await (k === "bridge" ? stubs[k].bridgePaused() : stubs[k].paused())).to.equal(true);
      expect(await gm.isModulePaused(IDS[k])).to.equal(true);
    }
    expect(await stubs.bridge.paused(), "the bridge module never pauses ordinary transfers").to.equal(false);
  });

  it("single-module pause still reverts loudly (strict path unchanged)", async function () {
    const { gm, stubs, IDS, guardian } = await loadFixture(fx);
    await stubs.staking.pause(); // desync this one (the bridge stop is idempotent, like the token's)

    // pauseModule targets ONE module — the caller must be told; it is already paused outside
    // the module, so it is not the guardian's to take over (SWEEP-02).
    await expect(gm.connect(guardian).pauseModule(IDS.staking, "targeted"))
      .to.be.revertedWithCustomError(gm, "ModuleAlreadyPaused");
  });
});

// Antoni's case (external report; Security work order A4, 22 Oct 2026): the bridge target is
// paused DIRECTLY (outside GuardianModule), then reported volume crosses the breaker's
// threshold. recordBridgeActivity must not revert: it latches `tripped`, counts the trip and
// keeps the volume in flight, and only governance reopens.
describe("GuardianModule — breaker trip on a target already paused directly (Antoni)", function () {
  async function wired(targetKind) {
    const [admin, guardian, governance, monitor] = await ethers.getSigners();
    const gm = await (await ethers.getContractFactory("GuardianModule"))
      .deploy(admin.address, guardian.address, governance.address, 15_552_000);
    let target;
    if (targetKind === "token") {
      const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
      target = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
      await target.connect(admin).grantRole(await target.PAUSER_ROLE(), await gm.getAddress());
    } else {
      target = await (await ethers.getContractFactory("PausableStrictStub")).deploy();
    }
    const BRIDGE = await gm.MODULE_BRIDGE();
    await gm.connect(governance).registerModule(BRIDGE, await target.getAddress());
    await gm.connect(governance).configureCircuitBreaker(BRIDGE, ethers.parseUnits("1000", 18), 3600);
    await gm.connect(admin).grantRole(await gm.CIRCUIT_BREAKER_ROLE(), monitor.address);
    return { admin, governance, monitor, gm, target, BRIDGE };
  }

  for (const kind of ["token", "strict stub"]) {
    it(`latches tripped and tripCount and keeps volumeInFlight, with no revert (${kind})`, async function () {
      const { admin, governance, monitor, gm, target, BRIDGE } = await wired(kind === "token" ? "token" : "stub");
      await target.connect(admin).setBridgePaused(true);            // paused outside the module
      expect(await gm.isModulePaused(BRIDGE)).to.equal(false);
      const amount = ethers.parseUnits("1500", 18);                 // crosses the 1,000 threshold
      await expect(gm.connect(monitor).recordBridgeActivity(BRIDGE, amount)).to.emit(gm, "CircuitBreakerTripped");
      const s = await gm.getCircuitBreakerStatus(BRIDGE);
      expect(s.tripped).to.equal(true);
      expect(s.tripCount).to.equal(1n);
      expect(s.volumeInFlight).to.equal(amount);
      expect(await target.bridgePaused()).to.equal(true);
      expect(await gm.isModulePaused(BRIDGE)).to.equal(true);
      // Only governance reopens; further reports are refused meanwhile.
      await expect(gm.connect(monitor).recordBridgeActivity(BRIDGE, 1n))
        .to.be.revertedWithCustomError(gm, "CircuitBreakerAlreadyTripped");
      await gm.connect(governance).resetCircuitBreaker(BRIDGE);
      expect((await gm.getCircuitBreakerStatus(BRIDGE)).tripped).to.equal(false);
    });
  }
});
