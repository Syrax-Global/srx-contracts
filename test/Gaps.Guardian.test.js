// Gap-closing tests for GuardianModule: the real token as a target, role gates, the bridge
// freeze, the sunset, and the cooldown edges. Style follows test/Guardian.test.js.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const SUNSET = 15_552_000; // 6 months
const HOUR = 3600;
const ACTION = { Pause: 0, Unpause: 1, PauseAll: 2, CircuitBreakerTrip: 3, CrossChainSignal: 4, BridgeInboundFreeze: 5 };

async function deployFixture() {
  const [admin, guardian, governance, breaker, other] = await ethers.getSigners();
  const Stub = await ethers.getContractFactory("PausableStub");
  const stubs = {};
  const gm = await (await ethers.getContractFactory("GuardianModule"))
    .deploy(admin.address, guardian.address, governance.address, SUNSET);
  await gm.connect(admin).grantRole(await gm.CIRCUIT_BREAKER_ROLE(), breaker.address);
  const ids = {
    TOKEN: await gm.MODULE_TOKEN(), BRIDGE: await gm.MODULE_BRIDGE(), STAKING: await gm.MODULE_STAKING(),
    FEE: await gm.MODULE_FEE(), TREASURY: await gm.MODULE_TREASURY(), SSF: await gm.MODULE_SSF(),
  };
  for (const [k, id] of Object.entries(ids)) {
    stubs[k] = await Stub.deploy();
    await gm.connect(governance).registerModule(id, await stubs[k].getAddress());
  }
  return { gm, stubs, ids, admin, guardian, governance, breaker, other };
}

// A GuardianModule whose MODULE_TOKEN is a REAL SRXToken.
async function realTokenFixture({ grantPauser = true } = {}) {
  const [admin, guardian, governance, breaker, other] = await ethers.getSigners();
  const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
  const gm = await (await ethers.getContractFactory("GuardianModule"))
    .deploy(admin.address, guardian.address, governance.address, SUNSET);
  const MODULE_TOKEN = await gm.MODULE_TOKEN();
  await gm.connect(governance).registerModule(MODULE_TOKEN, await token.getAddress());
  if (grantPauser) await token.connect(admin).grantRole(await token.PAUSER_ROLE(), await gm.getAddress());
  return { gm, token, MODULE_TOKEN, admin, guardian, governance, breaker, other };
}

describe("Gaps — GuardianModule against a real SRXToken (G1)", function () {
  it("G1a pauseModule pauses the token; governanceUnpause unpauses it; pauseAll pauses it again", async function () {
    const { gm, token, MODULE_TOKEN, guardian, governance } = await loadFixture(realTokenFixture);
    expect(await token.paused()).to.equal(false);

    await gm.connect(guardian).pauseModule(MODULE_TOKEN, "suspected bridge incident");
    expect(await token.paused()).to.equal(true);
    expect(await gm.isModulePaused(MODULE_TOKEN)).to.equal(true);

    await gm.connect(governance).governanceUnpause(MODULE_TOKEN, "all clear");
    expect(await token.paused()).to.equal(false);
    expect(await gm.isModulePaused(MODULE_TOKEN)).to.equal(false);

    await gm.connect(guardian).pauseAll("emergency stop");
    expect(await token.paused()).to.equal(true);
    expect(await gm.isModulePaused(MODULE_TOKEN)).to.equal(true);
  });

  it("G1b without PAUSER_ROLE on the token, pauseModule reverts CallFailed and nothing changes; with it, the same call works (control)", async function () {
    const { gm, token, MODULE_TOKEN, admin, guardian } = await realTokenFixture({ grantPauser: false });
    await expect(gm.connect(guardian).pauseModule(MODULE_TOKEN, "try"))
      .to.be.revertedWithCustomError(gm, "CallFailed");
    expect(await token.paused()).to.equal(false);
    expect(await gm.isModulePaused(MODULE_TOKEN)).to.equal(false);

    await token.connect(admin).grantRole(await token.PAUSER_ROLE(), await gm.getAddress());
    await gm.connect(guardian).pauseModule(MODULE_TOKEN, "try again");
    expect(await token.paused()).to.equal(true);
  });
});

describe("Gaps — GuardianModule role gates (G2)", function () {
  const denied = (gm, p) => expect(p).to.be.revertedWithCustomError(gm, "AccessControlUnauthorizedAccount");

  it("G2a recordBridgeActivity needs CIRCUIT_BREAKER_ROLE (guardian and governance do not have it)", async function () {
    const { gm, ids, governance, guardian, breaker, other } = await loadFixture(deployFixture);
    await gm.connect(governance).configureCircuitBreaker(ids.BRIDGE, 1_000, HOUR);
    await denied(gm, gm.connect(other).recordBridgeActivity(ids.BRIDGE, 100));
    await denied(gm, gm.connect(guardian).recordBridgeActivity(ids.BRIDGE, 100));
    await denied(gm, gm.connect(governance).recordBridgeActivity(ids.BRIDGE, 100));
    await gm.connect(breaker).recordBridgeActivity(ids.BRIDGE, 100); // control
    expect((await gm.getCircuitBreakerStatus(ids.BRIDGE)).volumeInFlight).to.equal(100n);
  });

  it("G2b configureCircuitBreaker is governance's", async function () {
    const { gm, ids, governance, guardian, other } = await loadFixture(deployFixture);
    await denied(gm, gm.connect(other).configureCircuitBreaker(ids.BRIDGE, 1_000, HOUR));
    await denied(gm, gm.connect(guardian).configureCircuitBreaker(ids.BRIDGE, 1_000, HOUR));
    await expect(gm.connect(governance).configureCircuitBreaker(ids.BRIDGE, 1_000, HOUR))
      .to.emit(gm, "CircuitBreakerConfigured").withArgs(ids.BRIDGE, 1_000, HOUR);
  });

  it("G2c resetCircuitBreaker is governance's", async function () {
    const { gm, ids, governance, guardian, breaker, other } = await loadFixture(deployFixture);
    await gm.connect(governance).configureCircuitBreaker(ids.BRIDGE, 1_000, HOUR);
    await gm.connect(breaker).recordBridgeActivity(ids.BRIDGE, 1_000); // trips it
    expect((await gm.getCircuitBreakerStatus(ids.BRIDGE)).tripped).to.equal(true);
    await denied(gm, gm.connect(other).resetCircuitBreaker(ids.BRIDGE));
    await denied(gm, gm.connect(guardian).resetCircuitBreaker(ids.BRIDGE));
    await expect(gm.connect(governance).resetCircuitBreaker(ids.BRIDGE))
      .to.emit(gm, "CircuitBreakerReset").withArgs(ids.BRIDGE, governance.address);
    expect((await gm.getCircuitBreakerStatus(ids.BRIDGE)).tripped).to.equal(false);
  });

  it("G2d emergencyUnpauseAll is governance's", async function () {
    const { gm, ids, stubs, governance, guardian, other } = await loadFixture(deployFixture);
    await gm.connect(guardian).pauseAll("stop");
    expect(await stubs.TOKEN.paused()).to.equal(true);
    await denied(gm, gm.connect(other).emergencyUnpauseAll("go"));
    await denied(gm, gm.connect(guardian).emergencyUnpauseAll("go"));
    expect(await stubs.TOKEN.paused()).to.equal(true);
    await gm.connect(governance).emergencyUnpauseAll("go");
    expect(await stubs.TOKEN.paused()).to.equal(false);
    expect(await gm.isModulePaused(ids.TOKEN)).to.equal(false);
  });

  it("G2e updateModuleTarget is governance's", async function () {
    const { gm, ids, governance, guardian, other } = await loadFixture(deployFixture);
    await denied(gm, gm.connect(other).updateModuleTarget(ids.TOKEN, other.address));
    await denied(gm, gm.connect(guardian).updateModuleTarget(ids.TOKEN, other.address));
    await expect(gm.connect(governance).updateModuleTarget(ids.TOKEN, other.address))
      .to.emit(gm, "ModuleTargetUpdated");
    expect((await gm.modules(ids.TOKEN)).target).to.equal(other.address);
  });

  it("G2f pauseAll is the guardian's", async function () {
    const { gm, stubs, governance, guardian, other } = await loadFixture(deployFixture);
    await denied(gm, gm.connect(other).pauseAll("x"));
    await denied(gm, gm.connect(governance).pauseAll("x"));
    expect(await stubs.TOKEN.paused()).to.equal(false);
    await gm.connect(guardian).pauseAll("x");
    expect(await stubs.TOKEN.paused()).to.equal(true);
  });

  it("G2g unpauseModule is the guardian's", async function () {
    const { gm, ids, stubs, governance, guardian, other } = await loadFixture(deployFixture);
    await gm.connect(guardian).pauseModule(ids.STAKING, "x");
    await denied(gm, gm.connect(other).unpauseModule(ids.STAKING, "x"));
    await denied(gm, gm.connect(governance).unpauseModule(ids.STAKING, "x"));
    expect(await stubs.STAKING.paused()).to.equal(true);
    await gm.connect(guardian).unpauseModule(ids.STAKING, "x");
    expect(await stubs.STAKING.paused()).to.equal(false);
  });

  it("G2h signalCrossChainPause is the guardian's", async function () {
    const { gm, ids, governance, guardian, other } = await loadFixture(deployFixture);
    await denied(gm, gm.connect(other).signalCrossChainPause(30101, ids.BRIDGE, true, "x"));
    await denied(gm, gm.connect(governance).signalCrossChainPause(30101, ids.BRIDGE, true, "x"));
    expect(await gm.crossChainPauseIntent(30101, ids.BRIDGE)).to.equal(false);
    await expect(gm.connect(guardian).signalCrossChainPause(30101, ids.BRIDGE, true, "x"))
      .to.emit(gm, "CrossChainPauseSignal");
    expect(await gm.crossChainPauseIntent(30101, ids.BRIDGE)).to.equal(true);
  });
});

describe("Gaps — freezeBridgeInbound (G3)", function () {
  it("G3a emits GuardianAction with ActionType.BridgeInboundFreeze (index 5) and freezes the chain on the real token", async function () {
    const { gm, token, MODULE_TOKEN, guardian } = await loadFixture(realTokenFixture);
    expect(ACTION.BridgeInboundFreeze).to.equal(5);
    await expect(gm.connect(guardian).freezeBridgeInbound(40102, "spoke owner compromise"))
      .to.emit(gm, "GuardianAction")
      .withArgs(MODULE_TOKEN, guardian.address, 5, "spoke owner compromise", anyValue);
    expect(await token.inboundFrozen(40102)).to.equal(true);
    expect(await token.inboundFrozen(40106)).to.equal(false);
    // The freeze is not a pause.
    expect(await token.paused()).to.equal(false);
  });

  it("G3b reverts ModuleNotRegistered when MODULE_TOKEN is not registered; control: registered works", async function () {
    const [admin, guardian, governance] = await ethers.getSigners();
    const gm = await (await ethers.getContractFactory("GuardianModule"))
      .deploy(admin.address, guardian.address, governance.address, SUNSET);
    const MODULE_TOKEN = await gm.MODULE_TOKEN();
    await expect(gm.connect(guardian).freezeBridgeInbound(40102, "x"))
      .to.be.revertedWithCustomError(gm, "ModuleNotRegistered").withArgs(MODULE_TOKEN);
    // Control: registering a token that exposes freezeInbound (the real one) makes it work.
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await token.connect(admin).grantRole(await token.PAUSER_ROLE(), await gm.getAddress());
    await gm.connect(governance).registerModule(MODULE_TOKEN, await token.getAddress());
    await gm.connect(guardian).freezeBridgeInbound(40102, "x");
    expect(await token.inboundFrozen(40102)).to.equal(true);
  });

  it("G3c reverts GuardianExpired after the sunset; control: works before it", async function () {
    const { gm, token, guardian } = await loadFixture(realTokenFixture);
    await gm.connect(guardian).freezeBridgeInbound(40102, "before sunset"); // control
    expect(await token.inboundFrozen(40102)).to.equal(true);
    const sunset = await gm.effectiveSunset();
    await time.increaseTo(sunset);
    await expect(gm.connect(guardian).freezeBridgeInbound(40106, "after sunset"))
      .to.be.revertedWithCustomError(gm, "GuardianExpired");
    expect(await token.inboundFrozen(40106)).to.equal(false);
  });
});

describe("Gaps — reduceSunset is a one-way ratchet (G4)", function () {
  it("G4a after reducing, neither MAXIMUM_SUNSET nor the current effectiveSunset is accepted", async function () {
    const { gm, governance } = await loadFixture(deployFixture);
    const now = BigInt(await time.latest());
    const reduced = now + 30n * 86400n;
    await gm.connect(governance).reduceSunset(reduced); // control: a real reduction works
    expect(await gm.effectiveSunset()).to.equal(reduced);

    const max = await gm.MAXIMUM_SUNSET();
    await expect(gm.connect(governance).reduceSunset(max))
      .to.be.revertedWithCustomError(gm, "CannotExtendSunset").withArgs(reduced, max);
    await expect(gm.connect(governance).reduceSunset(reduced))
      .to.be.revertedWithCustomError(gm, "CannotExtendSunset").withArgs(reduced, reduced);
    expect(await gm.effectiveSunset()).to.equal(reduced);
    // A further reduction is still possible (ratchet only goes down).
    await gm.connect(governance).reduceSunset(reduced - 86400n);
    expect(await gm.effectiveSunset()).to.equal(reduced - 86400n);
  });

  it("G4b after expiry reduceSunset cannot restore guardian powers; guardian actions keep reverting GuardianExpired", async function () {
    const { gm, ids, stubs, governance, guardian } = await loadFixture(deployFixture);
    const reduced = BigInt(await time.latest()) + 7n * 86400n;
    await gm.connect(governance).reduceSunset(reduced);
    await gm.connect(guardian).pauseModule(ids.STAKING, "before sunset"); // control: guardian works pre-sunset
    expect(await stubs.STAKING.paused()).to.equal(true);
    await time.increaseTo(reduced + 10n);
    expect(await gm.isExpired()).to.equal(true);

    const max = await gm.MAXIMUM_SUNSET();
    const now = BigInt(await time.latest());
    // Pushing it back out toward the maximum is refused...
    await expect(gm.connect(governance).reduceSunset(max)).to.be.revertedWithCustomError(gm, "CannotExtendSunset");
    await expect(gm.connect(governance).reduceSunset(now + 1000n)).to.be.revertedWithCustomError(gm, "CannotExtendSunset");
    // ...and so is anything below it, since that is in the past.
    await expect(gm.connect(governance).reduceSunset(reduced - 1n)).to.be.revertedWithCustomError(gm, "NewSunsetMustBeFuture");
    expect(await gm.effectiveSunset()).to.equal(reduced);

    await expect(gm.connect(guardian).pauseModule(ids.TOKEN, "x")).to.be.revertedWithCustomError(gm, "GuardianExpired");
    await expect(gm.connect(guardian).pauseAll("x")).to.be.revertedWithCustomError(gm, "GuardianExpired");
    expect(await stubs.TOKEN.paused()).to.equal(false);

    // Control: governance's own powers survive the sunset (it can still unpause what the guardian paused).
    await gm.connect(governance).governanceUnpause(ids.STAKING, "post-sunset");
    expect(await stubs.STAKING.paused()).to.equal(false);
  });
});

describe("Gaps — cooldown edges (G5-G7)", function () {
  it("G5 pauseAll is not blocked by a module's per-module pause cooldown", async function () {
    const { gm, ids, stubs, guardian } = await loadFixture(deployFixture);
    await gm.connect(guardian).pauseModule(ids.STAKING, "x");
    await gm.connect(guardian).unpauseModule(ids.STAKING, "x");
    expect(await stubs.STAKING.paused()).to.equal(false);
    // Control: the per-module path IS blocked by the cooldown right now.
    await expect(gm.connect(guardian).pauseModule(ids.STAKING, "again"))
      .to.be.revertedWithCustomError(gm, "CooldownActive");
    // pauseAll goes straight through.
    await gm.connect(guardian).pauseAll("emergency");
    expect(await stubs.STAKING.paused()).to.equal(true);
    expect(await gm.isModulePaused(ids.STAKING)).to.equal(true);
  });

  // R7-13: GuardianModule's header used to say it prevented "flash-unpausing". Only the PAUSE side has
  // a cooldown (measured from the last pause), so a false alarm can be lifted at once but a module
  // cannot be cycled pause/unpause/pause. lastUnpauseTime is a record, read by nothing on chain.
  it("G6 unpause has no cooldown: pauseModule then unpauseModule back-to-back both succeed", async function () {
    const { gm, ids, stubs, guardian } = await loadFixture(deployFixture);
    await gm.connect(guardian).pauseModule(ids.TREASURY, "x");
    await gm.connect(guardian).unpauseModule(ids.TREASURY, "x");
    expect(await stubs.TREASURY.paused()).to.equal(false);
    const m = await gm.modules(ids.TREASURY);
    expect(m.paused).to.equal(false);
    expect(m.lastUnpauseTime).to.be.gt(0n);
    // The only thing the cooldown stops is the next PAUSE.
    await expect(gm.connect(guardian).pauseModule(ids.TREASURY, "x"))
      .to.be.revertedWithCustomError(gm, "CooldownActive");
  });

  it("G7 after governanceUnpause the guardian can re-pause, once the pause cooldown (from the last pause) has passed", async function () {
    const { gm, ids, stubs, governance, guardian } = await loadFixture(deployFixture);
    await gm.connect(guardian).pauseModule(ids.FEE, "first");
    const lastPause = (await gm.modules(ids.FEE)).lastPauseTime;
    await gm.connect(governance).governanceUnpause(ids.FEE, "false alarm");
    expect(await stubs.FEE.paused()).to.equal(false);

    // Immediately: the cooldown runs from the last PAUSE, so the guardian is held off for an hour.
    await expect(gm.connect(guardian).pauseModule(ids.FEE, "second"))
      .to.be.revertedWithCustomError(gm, "CooldownActive").withArgs(ids.FEE, lastPause + BigInt(HOUR));
    // After the cooldown the guardian re-pauses; governance's unpause did not remove that power.
    await time.increaseTo(lastPause + BigInt(HOUR));
    await gm.connect(guardian).pauseModule(ids.FEE, "second");
    expect(await stubs.FEE.paused()).to.equal(true);
    expect((await gm.modules(ids.FEE)).pauseCount).to.equal(2n);

    // And if governance unpauses after the cooldown has already elapsed, the guardian can re-pause at once.
    await time.increase(HOUR + 1);
    await gm.connect(governance).governanceUnpause(ids.FEE, "ok again");
    await gm.connect(guardian).pauseModule(ids.FEE, "third");
    expect(await stubs.FEE.paused()).to.equal(true);
  });
});
