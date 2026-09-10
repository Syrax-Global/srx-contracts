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

    for (const k of ["bridge", "staking", "fee", "treasury"]) {
      expect(await stubs[k].paused()).to.equal(true);
      expect(await gm.isModulePaused(IDS[k])).to.equal(true);
    }
  });

  it("emits ModuleCallSkipped for the module it could not pause", async function () {
    const { gm, stubs, IDS, guardian } = await loadFixture(fx);
    await stubs.token.pause();

    await expect(gm.connect(guardian).pauseAll("incident"))
      .to.emit(gm, "ModuleCallSkipped")
      .withArgs(IDS.token, await stubs.token.getAddress(), true);
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
    for (const k of Object.keys(IDS)) expect(await stubs[k].paused()).to.equal(true);

    // Admin unpauses one directly — GuardianModule still thinks it is paused.
    await stubs.token.unpause();
    expect(await gm.isModulePaused(IDS.token)).to.equal(true); // stale

    // Governance recovery must not be blocked by that one module.
    await expect(gm.connect(governance).emergencyUnpauseAll("recovered")).to.not.be.reverted;

    for (const k of Object.keys(IDS)) {
      expect(await stubs[k].paused()).to.equal(false);
      expect(await gm.isModulePaused(IDS[k])).to.equal(false);
    }
  });

  it("still pauses every module when nothing is desynced (happy path intact)", async function () {
    const { gm, stubs, IDS, guardian } = await loadFixture(fx);
    await gm.connect(guardian).pauseAll("incident");
    for (const k of Object.keys(IDS)) {
      expect(await stubs[k].paused()).to.equal(true);
      expect(await gm.isModulePaused(IDS[k])).to.equal(true);
    }
  });

  it("single-module pause still reverts loudly (strict path unchanged)", async function () {
    const { gm, stubs, IDS, guardian } = await loadFixture(fx);
    await stubs.bridge.pause(); // desync this one

    // pauseModule targets ONE module — the caller must be told it failed.
    await expect(gm.connect(guardian).pauseModule(IDS.bridge, "targeted"))
      .to.be.revertedWithCustomError(gm, "CallFailed");
  });
});
