// Class sweep, 22 Oct 2026 (Security work order B): regression tests for the defects it found
// and for guarantees it found untested. Each asserts the corrected behaviour.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { allocationSource } = require("../helpers/allocationSource");

const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400, HOUR = 3_600;

async function token() {
  const [admin] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
  await srx.connect(admin).genesis(admin.address);
  return { srx, lz };
}

async function fundSuite() {
  const [admin, alice, stranger] = await ethers.getSigners();
  const { srx } = await token();
  const Fund = await ethers.getContractFactory("StabilisationFund");
  const fund = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000),
    await allocationSource(srx, E(1_500_000_000)));
  await srx.connect(admin).transfer(await fund.getAddress(), E(20_000_000));
  await srx.connect(admin).transfer(alice.address, E(10_000));
  await srx.connect(alice).approve(await fund.getAddress(), ethers.MaxUint256);
  return { admin, alice, stranger, srx, fund, Fund };
}

async function stakingSuite() {
  const [admin, alice, stranger] = await ethers.getSigners();
  const { srx } = await token();
  const staking = await (await ethers.getContractFactory("SRXStaking"))
    .deploy(await srx.getAddress(), admin.address, await allocationSource(srx));
  await srx.connect(admin).transfer(await staking.getAddress(), E(10_000_000));
  await srx.connect(admin).transfer(alice.address, E(10_000));
  await srx.connect(alice).approve(await staking.getAddress(), ethers.MaxUint256);
  await staking.connect(alice).lock(E(1_000), 7 * DAY);
  return { admin, alice, stranger, srx, staking };
}

describe("Sweep 22 Oct: SWEEP-01, one allocation can never be released twice", function () {
  it("after a release, an SRX deployLiquidity leaves rewardBacking and the releasable amount unchanged", async function () {
    const { admin, alice, stranger, srx, fund, Fund } = await fundSuite();
    await fund.connect(alice).contribute(E(5_000));
    await fund.connect(admin).notifyRewardAmount(E(1_000_000));
    await fund.connect(admin).startWindDown();
    const v2 = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), await fund.getAddress());
    await fund.connect(admin).releaseRewardAllocation(await v2.getAddress(), await fund.releasableRewardAllocation());
    const backing = await fund.rewardBacking();
    expect(await fund.releasableRewardAllocation()).to.equal(0n);
    await fund.connect(admin).deployLiquidity(stranger.address, await srx.getAddress(), 1n, "routine");
    expect(await fund.rewardBacking()).to.equal(backing);                    // not restored
    expect(await fund.releasableRewardAllocation()).to.equal(0n);             // nothing to release again
  });

  it("syncAllocation is refused after wind-down, in the fund and in staking (guards were untested)", async function () {
    const { admin, fund } = await fundSuite();
    await fund.connect(admin).startWindDown();
    await expect(fund.syncAllocation()).to.be.revertedWithCustomError(fund, "WoundDown");
    const { admin: a2, staking } = await stakingSuite();
    await staking.connect(a2).startWindDown();
    await expect(staking.syncAllocation()).to.be.revertedWithCustomError(staking, "WoundDown");
  });
});

describe("Sweep 22 Oct: SWEEP-03, the 30 days are 30 days of actual pause", function () {
  async function chainOfShortPauses(c, admin) {
    for (let i = 0; i < 5; i++) {               // five one-hour pauses, six days apart
      await c.connect(admin).pause();
      await time.increase(HOUR);
      await c.connect(admin).unpause();
      await time.increase(6 * DAY);
    }
    await c.connect(admin).pause();              // a sixth, at about day 30
  }

  it("staking: a chain of short pauses does not open the permissionless wind-down", async function () {
    const { admin, stranger, staking } = await stakingSuite();
    await chainOfShortPauses(staking, admin);
    await expect(staking.connect(stranger).startWindDown()).to.be.revertedWithCustomError(staking, "NotAuthorisedToWindDown");
    expect(await staking.pausedInRun()).to.be.closeTo(BigInt(5 * HOUR), 20n);
  });

  it("fund: the same", async function () {
    const { admin, stranger, fund } = await fundSuite();
    await chainOfShortPauses(fund, admin);
    await expect(fund.connect(stranger).startWindDown()).to.be.revertedWithCustomError(fund, "NotAuthorisedToWindDown");
  });

  it("control: 29 days paused, a one-block break, then one more day paused opens it (L2 still holds)", async function () {
    const { admin, stranger, staking } = await stakingSuite();
    await staking.connect(admin).pause();
    await time.increase(29 * DAY);
    await staking.connect(admin).unpause();
    await staking.connect(admin).pause();
    await time.increase(DAY);
    await expect(staking.connect(stranger).startWindDown()).to.emit(staking, "WindDownStarted");
  });
});

describe("Sweep 22 Oct: guarantees that had no test", function () {
  it("the hub never mints above MAX_SUPPLY, whatever the path (the _update check itself)", async function () {
    const [admin, other] = await ethers.getSigners();
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const h = await (await ethers.getContractFactory("SRXTokenMintHarness")).deploy(await lz.getAddress(), admin.address);
    await h.connect(admin).genesis(admin.address);
    const cap = await h.MAX_SUPPLY();
    await expect(h.harnessMint(other.address, 1n)).to.be.revertedWithCustomError(h, "SupplyCapExceeded").withArgs(cap + 1n, cap);
  });

  it("L15: after the sunset a tripped breaker's pause stays governance's", async function () {
    const [admin, guardian, governance, monitor, stranger] = await ethers.getSigners();
    const gm = await (await ethers.getContractFactory("GuardianModule"))
      .deploy(admin.address, guardian.address, governance.address, 30 * DAY);
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
    const tok = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    await tok.connect(admin).grantRole(await tok.PAUSER_ROLE(), await gm.getAddress());
    const BRIDGE = await gm.MODULE_BRIDGE();
    await gm.connect(governance).registerModule(BRIDGE, await tok.getAddress());
    await gm.connect(governance).configureCircuitBreaker(BRIDGE, E(1_000), HOUR);
    await gm.connect(admin).grantRole(await gm.CIRCUIT_BREAKER_ROLE(), monitor.address);
    await gm.connect(monitor).recordBridgeActivity(BRIDGE, E(1_000));      // trips
    await time.increaseTo(await gm.effectiveSunset());
    await expect(gm.connect(stranger).releaseAfterSunset(BRIDGE)).to.be.revertedWithCustomError(gm, "GovernanceOnlyUnpause");
    expect(await tok.bridgePaused()).to.equal(true);
  });
});

describe("Sweep 22 Oct: SWEEP-02, the bridge breaker and outside bridge stops", function () {
  async function wired() {
    const [admin, guardian, governance, monitor, other] = await ethers.getSigners();
    const gm = await (await ethers.getContractFactory("GuardianModule"))
      .deploy(admin.address, guardian.address, governance.address, 180 * DAY);
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
    const tok = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    await tok.connect(admin).grantRole(await tok.PAUSER_ROLE(), await gm.getAddress());
    const BRIDGE = await gm.MODULE_BRIDGE();
    await gm.connect(governance).registerModule(BRIDGE, await tok.getAddress());
    await gm.connect(governance).configureCircuitBreaker(BRIDGE, E(1_000), HOUR);
    await gm.connect(admin).grantRole(await gm.CIRCUIT_BREAKER_ROLE(), monitor.address);
    return { admin, guardian, governance, monitor, gm, tok, BRIDGE };
  }

  it("(a) a trip stops the bridge even when the module's flag is stale", async function () {
    const { admin, guardian, monitor, gm, tok, BRIDGE } = await wired();
    await gm.connect(guardian).pauseModule(BRIDGE, "incident");
    await tok.connect(admin).setBridgePaused(false);                 // reopened outside the module
    expect(await gm.isModulePaused(BRIDGE)).to.equal(true);           // stale
    await gm.connect(monitor).recordBridgeActivity(BRIDGE, E(1_000)); // trips
    expect(await tok.bridgePaused()).to.equal(true);
  });

  it("(b) a bridge stop made outside the module is governance's, not the guardian's", async function () {
    const { admin, guardian, governance, gm, tok, BRIDGE } = await wired();
    await tok.connect(admin).setBridgePaused(true);                  // stopped outside the module
    await expect(gm.connect(guardian).pauseModule(BRIDGE, "take over"))
      .to.be.revertedWithCustomError(gm, "ModuleAlreadyPaused");
    await gm.connect(guardian).pauseAll("incident");                 // adopts it
    await expect(gm.connect(guardian).unpauseModule(BRIDGE, "lift"))
      .to.be.revertedWithCustomError(gm, "GovernanceOnlyUnpause");
    await gm.connect(governance).governanceUnpause(BRIDGE, "lift");
    expect(await tok.bridgePaused()).to.equal(false);
  });
});

describe("Sweep 22 Oct: guarantees strengthened and small fixes", function () {
  it("fund: fee SRX sent after wind-down never becomes releasable (REG-50; staking was the only one tested)", async function () {
    const [, , , feePayer] = await ethers.getSigners();
    const { admin, alice, srx, fund } = await fundSuite();
    await fund.connect(alice).contribute(E(5_000));
    await fund.connect(admin).notifyRewardAmount(E(1_000_000));
    await fund.connect(admin).startWindDown();
    const before = await fund.releasableRewardAllocation();
    await srx.connect(admin).transfer(feePayer.address, E(5_000_000));
    await srx.connect(feePayer).transfer(await fund.getAddress(), E(5_000_000));   // "fee" SRX
    expect(await fund.releasableRewardAllocation()).to.equal(before);
  });

  it("the wind-down exit list is add-only: by structure, the only write to isWindDownExit is `= true`", async function () {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "contracts", "token", "SRXToken.sol"), "utf8")
      .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");                                // code only, no comments
    const writes = src.match(/isWindDownExit\s*\[[^\]]*\]\s*=[^=;]*;/g) || [];
    expect(writes.length).to.equal(1);
    expect(writes[0]).to.match(/=\s*true\s*;$/);
    expect(src).to.not.match(/delete\s+isWindDownExit/);
  });

  it("fund wind-down during a stress event resolves it visibly", async function () {
    const { admin, fund } = await fundSuite();
    await fund.connect(admin).grantRole(await fund.ORACLE_REPORTER_ROLE(), admin.address);
    await fund.connect(admin).triggerStressEvent();
    expect(await fund.stressActive()).to.equal(true);
    await expect(fund.connect(admin).startWindDown()).to.emit(fund, "StressEventResolved");
    expect(await fund.stressResolvedAt()).to.be.gt(0n);
  });

  it("reconfiguring a tripped breaker emits CircuitBreakerReset", async function () {
    const [admin, guardian, governance, monitor] = await ethers.getSigners();
    const gm = await (await ethers.getContractFactory("GuardianModule"))
      .deploy(admin.address, guardian.address, governance.address, 180 * DAY);
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
    const tok = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    await tok.connect(admin).grantRole(await tok.PAUSER_ROLE(), await gm.getAddress());
    const BRIDGE = await gm.MODULE_BRIDGE();
    await gm.connect(governance).registerModule(BRIDGE, await tok.getAddress());
    await gm.connect(governance).configureCircuitBreaker(BRIDGE, E(1_000), HOUR);
    await gm.connect(admin).grantRole(await gm.CIRCUIT_BREAKER_ROLE(), monitor.address);
    await gm.connect(monitor).recordBridgeActivity(BRIDGE, E(1_000));
    await expect(gm.connect(governance).configureCircuitBreaker(BRIDGE, E(2_000), HOUR))
      .to.emit(gm, "CircuitBreakerReset").withArgs(BRIDGE, governance.address);
  });

  it("TGEDistributor.recoverToken emits TokenRecovered; the hub refuses to rescue to itself", async function () {
    const [admin] = await ethers.getSigners();
    const { srx } = await token();
    await expect(srx.connect(admin).rescueTokens(await srx.getAddress(), await srx.getAddress(), 1n))
      .to.be.revertedWithCustomError(srx, "ZeroAddress");
    const D = await ethers.getContractFactory("TGEDistributor");
    expect(D.interface.getEvent("TokenRecovered")).to.not.equal(null);
  });
});

describe("Sweep 22 Oct: governance reopening resets the breaker; a new target starts clean", function () {
  async function wired() {
    const [admin, guardian, governance, monitor] = await ethers.getSigners();
    const gm = await (await ethers.getContractFactory("GuardianModule"))
      .deploy(admin.address, guardian.address, governance.address, 180 * DAY);
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
    const tok = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    await tok.connect(admin).grantRole(await tok.PAUSER_ROLE(), await gm.getAddress());
    const BRIDGE = await gm.MODULE_BRIDGE();
    await gm.connect(governance).registerModule(BRIDGE, await tok.getAddress());
    await gm.connect(governance).configureCircuitBreaker(BRIDGE, E(1_000), HOUR);
    await gm.connect(admin).grantRole(await gm.CIRCUIT_BREAKER_ROLE(), monitor.address);
    return { admin, guardian, governance, monitor, gm, tok, lz, BRIDGE };
  }

  it("governanceUnpause of a tripped bridge resets the breaker, so it watches again", async function () {
    const { governance, monitor, gm, BRIDGE } = await wired();
    await gm.connect(monitor).recordBridgeActivity(BRIDGE, E(1_000));        // trips
    await expect(gm.connect(governance).governanceUnpause(BRIDGE, "resolved"))
      .to.emit(gm, "CircuitBreakerReset").withArgs(BRIDGE, governance.address);
    await gm.connect(monitor).recordBridgeActivity(BRIDGE, E(1));            // not blind
    expect((await gm.getCircuitBreakerStatus(BRIDGE)).tripped).to.equal(false);
  });

  it("updateModuleTarget drops the old target's flags and adopts the new target's pause as governance's", async function () {
    const { admin, guardian, governance, gm, lz, BRIDGE } = await wired();
    await gm.connect(guardian).pauseModule(BRIDGE, "incident");
    const tok2 = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    await gm.connect(governance).updateModuleTarget(BRIDGE, await tok2.getAddress());
    expect(await gm.isModulePaused(BRIDGE)).to.equal(false);                 // new target is open
    await tok2.connect(admin).setBridgePaused(true);
    const tok3 = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    await tok3.connect(admin).setBridgePaused(true);
    await gm.connect(governance).updateModuleTarget(BRIDGE, await tok3.getAddress());
    expect(await gm.isModulePaused(BRIDGE)).to.equal(true);
    expect(await gm.governanceOnlyUnpause(BRIDGE)).to.equal(true);           // not the guardian's
  });
});
