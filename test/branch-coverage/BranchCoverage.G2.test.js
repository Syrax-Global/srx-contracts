// Branch coverage, group G2: GuardianModule, SRXToken, SRXOFTNative, ZkSyncMigrator.
//
// Every test drives one previously unexecuted branch AND asserts what the branch encodes
// (the exact custom error, the state afterwards, the event). Branch -> test mapping is in
// the title of each test: [Gnnn] = GuardianModule line nnn, [Tnnn] = SRXToken, [Nnnn] =
// SRXOFTNative, [Mnnn] = ZkSyncMigrator.
//
// ── The reentrancy stub ──────────────────────────────────────────────────────
// Several branches are the `nonReentrant` modifier refusing a call made while the contract
// is already inside a guarded call. The only way in is a hostile TARGET (a module target
// governance registered, or the token a migrator was deployed with) that calls back during
// the callback the contract makes to it. contracts/ may not change and the existing mocks
// cannot call back with arbitrary data, so this file installs a few bytes of hand-assembled
// EVM code (hardhat_setCode) that, when called, makes ONE call to `target` with fixed
// calldata and then either
//   "record": stores the inner call's first return word in slot 0 and its success flag in
//             slot 1 and returns normally (so the outer call completes and can be asserted), or
//   "bubble": reverts with the inner call's revert data (so the outer call fails with it).
// Calls whose selector is in `skip` (the paused()/bridgePaused() views the guardian makes
// with STATICCALL) return `retWord` at once: a state write inside a static call would halt
// the frame and burn its gas.
// A positive control (the same stub, called from outside any guarded call) shows the inner
// call succeeds, so a "blocked" result means the guard refused it, not that the stub is broken.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const DAY = 86_400;
const SUNSET = 180 * DAY; // GuardianModule.MAX_SUNSET_DURATION
const E = (n) => ethers.parseUnits(String(n), 18);
const ZERO = ethers.ZeroAddress;
const NOPE = ethers.id("NOT_A_REGISTERED_MODULE");
const GUARD_SELECTOR = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);
const sel = (sig) => parseInt(ethers.id(sig).slice(0, 10), 16);
const SKIP_VIEWS = [sel("paused()"), sel("bridgePaused()")];

// ── Hand-assembled reentrancy stub ───────────────────────────────────────────

const OPS = {
  EQ: 0x14, SHR: 0x1c, CALLDATALOAD: 0x35, CODECOPY: 0x39, RETURNDATASIZE: 0x3d,
  RETURNDATACOPY: 0x3e, GAS: 0x5a, POP: 0x50, MLOAD: 0x51, MSTORE: 0x52, SSTORE: 0x55,
  JUMPI: 0x57, DUP1: 0x80, CALL: 0xf1, RETURN: 0xf3, REVERT: 0xfd,
};

function buildStubCode({ target, data, mode, retWord, skip }) {
  const dataBytes = ethers.getBytes(data);
  const prog = [];
  const op = (name) => prog.push({ t: "op", name });
  const push = (n, v) => prog.push({ t: "push", n, v });
  const label = (name) => prog.push({ t: "label", name });

  if (mode === "record" && skip.length) {
    push(1, 0); op("CALLDATALOAD"); push(1, 0xe0); op("SHR");        // [selector]
    for (const s of skip) { op("DUP1"); push(4, s); op("EQ"); push(2, "@RET"); op("JUMPI"); }
    op("POP");
  }
  push(2, dataBytes.length); push(2, "@DATA"); push(1, 0); op("CODECOPY");   // calldata -> memory
  push(1, 0); push(1, 0); push(2, dataBytes.length); push(1, 0); push(1, 0); // ret, args
  push(20, target); op("GAS"); op("CALL");                                   // [success]
  push(1, 0); push(1, 0); op("MSTORE");                                      // clear word 0
  op("RETURNDATASIZE"); push(1, 0); push(1, 0); op("RETURNDATACOPY");
  if (mode === "record") {
    op("DUP1"); push(1, 1); op("SSTORE");                                    // slot1 = success
    push(1, 0); op("MLOAD"); push(1, 0); op("SSTORE");                       // slot0 = first return word
    op("POP");
  } else {
    push(2, "@RET"); op("JUMPI");                                            // success -> return
    op("RETURNDATASIZE"); push(1, 0); op("REVERT");                          // else bubble
  }
  label("RET");
  push(1, retWord); push(1, 0); op("MSTORE"); push(1, 0x20); push(1, 0); op("RETURN");

  // pass 1: offsets
  const labels = {};
  let pc = 0;
  for (const i of prog) {
    if (i.t === "label") { labels[i.name] = pc; pc += 1; }
    else if (i.t === "push") pc += 1 + i.n;
    else pc += 1;
  }
  labels.DATA = pc;
  // pass 2: bytes
  const out = [];
  for (const i of prog) {
    if (i.t === "label") out.push(0x5b);
    else if (i.t === "op") out.push(OPS[i.name] ?? (i.name === "JUMPI" ? 0x57 : undefined));
    else {
      out.push(0x5f + i.n);
      if (typeof i.v === "string" && i.v.startsWith("@")) out.push(...ethers.getBytes(ethers.toBeHex(labels[i.v.slice(1)], 2)));
      else if (i.n === 20) out.push(...ethers.getBytes(i.v));
      else out.push(...ethers.getBytes(ethers.toBeHex(i.v, i.n)));
    }
  }
  if (out.some((b) => b === undefined)) throw new Error("bad opcode in stub");
  return ethers.hexlify(Uint8Array.from([...out, ...dataBytes]));
}

/** Install a stub at a fresh address and return that address. */
async function installStub({ target, data, mode = "record", retWord = 0, skip = SKIP_VIEWS, at }) {
  const addr = at || ethers.Wallet.createRandom().address;
  await network.provider.send("hardhat_setCode", [addr, buildStubCode({ target, data, mode, retWord, skip })]);
  return addr;
}
async function stubResult(addr) {
  const word = await ethers.provider.getStorage(addr, 0);
  const ok = BigInt(await ethers.provider.getStorage(addr, 1)) === 1n;
  return { word, ok };
}
async function resetStub(addr) {
  await network.provider.send("hardhat_setStorageAt", [addr, "0x0", ethers.ZeroHash]);
  await network.provider.send("hardhat_setStorageAt", [addr, "0x1", ethers.ZeroHash]);
}
/** The inner call ran and was refused by the reentrancy guard. */
async function expectBlocked(addr) {
  const r = await stubResult(addr);
  expect(r.ok, "inner call must not succeed").to.equal(false);
  expect(r.word.startsWith(GUARD_SELECTOR), "inner call must fail with ReentrancyGuardReentrantCall, got " + r.word).to.equal(true);
}

// ═════════════════════════════════════════════════════════════════════════════
// GuardianModule
// ═════════════════════════════════════════════════════════════════════════════

async function gfx() {
  const [admin, guardian, governance, monitor, other] = await ethers.getSigners();
  const Strict = await ethers.getContractFactory("PausableStrictStub");
  const gm = await (await ethers.getContractFactory("GuardianModule"))
    .deploy(admin.address, guardian.address, governance.address, SUNSET);
  const ids = {
    token: await gm.MODULE_TOKEN(), bridge: await gm.MODULE_BRIDGE(), staking: await gm.MODULE_STAKING(),
    fee: await gm.MODULE_FEE(), treasury: await gm.MODULE_TREASURY(), ssf: await gm.MODULE_SSF(),
  };
  const stubs = {};
  for (const k of Object.keys(ids)) {
    stubs[k] = await Strict.deploy();
    await gm.connect(governance).registerModule(ids[k], await stubs[k].getAddress());
  }
  await gm.connect(admin).grantRole(await gm.CIRCUIT_BREAKER_ROLE(), monitor.address);
  return { gm, ids, stubs, admin, guardian, governance, monitor, other };
}

describe("BranchCoverage G2: GuardianModule", function () {
  // ── constructor ───────────────────────────────────────────────────────────

  it("[G266] constructor refuses a zero admin, a zero guardian and a zero governance, each with ZeroAddress", async function () {
    const [a, g, gov] = await ethers.getSigners();
    const GM = await ethers.getContractFactory("GuardianModule");
    await expect(GM.deploy(ZERO, g.address, gov.address, SUNSET)).to.be.revertedWithCustomError(GM, "ZeroAddress");
    await expect(GM.deploy(a.address, ZERO, gov.address, SUNSET)).to.be.revertedWithCustomError(GM, "ZeroAddress");
    await expect(GM.deploy(a.address, g.address, ZERO, SUNSET)).to.be.revertedWithCustomError(GM, "ZeroAddress");
    // control: the same call with all three set deploys and grants each role to the right address
    const gm = await GM.deploy(a.address, g.address, gov.address, SUNSET);
    expect(await gm.hasRole(await gm.GUARDIAN_ROLE(), g.address)).to.equal(true);
    expect(await gm.hasRole(await gm.GOVERNANCE_ROLE(), gov.address)).to.equal(true);
    expect(await gm.hasRole(await gm.DEFAULT_ADMIN_ROLE(), a.address)).to.equal(true);
  });

  // ── updateModuleTarget ────────────────────────────────────────────────────

  it("[G334] updateModuleTarget on an unregistered module reverts ModuleNotRegistered", async function () {
    const { gm, governance, other } = await loadFixture(gfx);
    await expect(gm.connect(governance).updateModuleTarget(NOPE, other.address))
      .to.be.revertedWithCustomError(gm, "ModuleNotRegistered").withArgs(NOPE);
  });

  it("[G336] updateModuleTarget to the zero address reverts ZeroAddress and leaves the target alone; a real target is recorded with its event", async function () {
    const { gm, ids, stubs, governance, other } = await loadFixture(gfx);
    const old = await stubs.staking.getAddress();
    await expect(gm.connect(governance).updateModuleTarget(ids.staking, ZERO)).to.be.revertedWithCustomError(gm, "ZeroAddress");
    expect((await gm.modules(ids.staking)).target).to.equal(old);
    await expect(gm.connect(governance).updateModuleTarget(ids.staking, other.address))
      .to.emit(gm, "ModuleTargetUpdated").withArgs(ids.staking, old, other.address);
    expect((await gm.modules(ids.staking)).target).to.equal(other.address);
  });

  // ── notExpired on every guardian-window function ──────────────────────────

  it("[notExpired] after the sunset every guardian-window function reverts GuardianExpired, and governance functions still work", async function () {
    const { gm, ids, guardian, governance, monitor } = await loadFixture(gfx);
    await gm.connect(governance).configureCircuitBreaker(ids.bridge, E(100), 3600);
    await time.increase(SUNSET);
    expect(await gm.isExpired()).to.equal(true);
    await expect(gm.connect(guardian).pauseModule(ids.staking, "r")).to.be.revertedWithCustomError(gm, "GuardianExpired");
    await expect(gm.connect(guardian).unpauseModule(ids.staking, "r")).to.be.revertedWithCustomError(gm, "GuardianExpired");
    await expect(gm.connect(guardian).pauseAll("r")).to.be.revertedWithCustomError(gm, "GuardianExpired");
    await expect(gm.connect(guardian).signalCrossChainPause(1, ids.token, true, "r")).to.be.revertedWithCustomError(gm, "GuardianExpired");
    await expect(gm.connect(guardian).freezeBridgeInbound(1, "r")).to.be.revertedWithCustomError(gm, "GuardianExpired");
    await expect(gm.connect(monitor).recordBridgeActivity(ids.bridge, 1)).to.be.revertedWithCustomError(gm, "GuardianExpired");
    // governance is not bound by the sunset
    await expect(gm.connect(governance).emergencyUnpauseAll("g")).to.emit(gm, "GovernanceOverride");
  });

  // ── moduleExists: every function guarded by it ────────────────────────────

  describe("moduleExists: an unregistered module id reverts ModuleNotRegistered(id)", function () {
    const cases = {
      "[G353] pauseModule": (c) => c.gm.connect(c.guardian).pauseModule(NOPE, "r"),
      "[G387] unpauseModule": (c) => c.gm.connect(c.guardian).unpauseModule(NOPE, "r"),
      "[G526] governanceUnpause": (c) => c.gm.connect(c.governance).governanceUnpause(NOPE, "r"),
      "[G609] releaseAfterSunset": async (c) => { await time.increase(SUNSET); return c.gm.releaseAfterSunset(NOPE); },
      "[G673] configureCircuitBreaker": (c) => c.gm.connect(c.governance).configureCircuitBreaker(NOPE, 1, 1),
      "[G709] recordBridgeActivity": (c) => c.gm.connect(c.monitor).recordBridgeActivity(NOPE, 1),
      "[G766] resetCircuitBreaker": (c) => c.gm.connect(c.governance).resetCircuitBreaker(NOPE),
    };
    for (const [name, call] of Object.entries(cases)) {
      it(name, async function () {
        const c = await loadFixture(gfx);
        await expect(call(c)).to.be.revertedWithCustomError(c.gm, "ModuleNotRegistered").withArgs(NOPE);
      });
    }

    it("[G506] freezeBridgeInbound with no token module registered reverts ModuleNotRegistered(MODULE_TOKEN)", async function () {
      const [admin, guardian, governance] = await ethers.getSigners();
      const gm = await (await ethers.getContractFactory("GuardianModule"))
        .deploy(admin.address, guardian.address, governance.address, SUNSET);
      await expect(gm.connect(guardian).freezeBridgeInbound(1, "r"))
        .to.be.revertedWithCustomError(gm, "ModuleNotRegistered").withArgs(await gm.MODULE_TOKEN());
    });
  });

  // ── validReason: every function guarded by it ─────────────────────────────

  describe("validReason: an empty reason reverts EmptyReason", function () {
    const cases = {
      "[G354/G388] pauseModule / unpauseModule": async (c) => {
        await expect(c.gm.connect(c.guardian).pauseModule(c.ids.staking, "")).to.be.revertedWithCustomError(c.gm, "EmptyReason");
        await expect(c.gm.connect(c.guardian).unpauseModule(c.ids.staking, "")).to.be.revertedWithCustomError(c.gm, "EmptyReason");
      },
      "[G424] pauseAll": (c) => expect(c.gm.connect(c.guardian).pauseAll("")).to.be.revertedWithCustomError(c.gm, "EmptyReason"),
      "[G487] signalCrossChainPause": (c) =>
        expect(c.gm.connect(c.guardian).signalCrossChainPause(1, c.ids.token, true, "")).to.be.revertedWithCustomError(c.gm, "EmptyReason"),
      "[G507] freezeBridgeInbound": (c) =>
        expect(c.gm.connect(c.guardian).freezeBridgeInbound(1, "")).to.be.revertedWithCustomError(c.gm, "EmptyReason"),
      "[G527] governanceUnpause": (c) =>
        expect(c.gm.connect(c.governance).governanceUnpause(c.ids.staking, "")).to.be.revertedWithCustomError(c.gm, "EmptyReason"),
      "[G551] emergencyUnpauseAll": (c) =>
        expect(c.gm.connect(c.governance).emergencyUnpauseAll("")).to.be.revertedWithCustomError(c.gm, "EmptyReason"),
      "[G630] governanceHoldTokenPause": (c) =>
        expect(c.gm.connect(c.governance).governanceHoldTokenPause("")).to.be.revertedWithCustomError(c.gm, "EmptyReason"),
    };
    for (const [name, run] of Object.entries(cases)) {
      it(name, async function () {
        const c = await loadFixture(gfx);
        await run(c);
        // nothing moved
        for (const k of Object.keys(c.ids)) expect(await c.gm.isModulePaused(c.ids[k])).to.equal(false);
      });
    }

    it("a reason is bounded at MAX_REASON_LENGTH bytes (branch tests, 22 Oct: 5,000 bytes used to be accepted)", async function () {
      const { gm, ids, guardian } = await loadFixture(gfx);
      const max = Number(await gm.MAX_REASON_LENGTH());
      await expect(gm.connect(guardian).pauseModule(ids.staking, "x".repeat(max + 1)))
        .to.be.revertedWithCustomError(gm, "ReasonTooLong").withArgs(max);
      await expect(gm.connect(guardian).pauseModule(ids.staking, "x".repeat(max)))
        .to.emit(gm, "GuardianAction");
    });
  });

  // ── access control on the same functions (onlyRole else) ──────────────────

  it("[onlyRole] a stranger is refused on every guardian and governance function with AccessControlUnauthorizedAccount", async function () {
    const { gm, ids, other } = await loadFixture(gfx);
    const calls = [
      () => gm.connect(other).registerModule(NOPE, other.address),
      () => gm.connect(other).updateModuleTarget(ids.token, other.address),
      () => gm.connect(other).pauseModule(ids.token, "r"),
      () => gm.connect(other).unpauseModule(ids.token, "r"),
      () => gm.connect(other).pauseAll("r"),
      () => gm.connect(other).signalCrossChainPause(1, ids.token, true, "r"),
      () => gm.connect(other).freezeBridgeInbound(1, "r"),
      () => gm.connect(other).governanceUnpause(ids.token, "r"),
      () => gm.connect(other).emergencyUnpauseAll("r"),
      () => gm.connect(other).governanceHoldTokenPause("r"),
      () => gm.connect(other).reduceSunset(1),
      () => gm.connect(other).configureCircuitBreaker(ids.bridge, 1, 1),
      () => gm.connect(other).recordBridgeActivity(ids.bridge, 1),
      () => gm.connect(other).resetCircuitBreaker(ids.bridge),
    ];
    for (const c of calls) await expect(c()).to.be.revertedWithCustomError(gm, "AccessControlUnauthorizedAccount");
  });

  // ── releaseAfterSunset ────────────────────────────────────────────────────

  it("[G612] releaseAfterSunset on a module that is not paused reverts ModuleNotPaused", async function () {
    const { gm, ids, other } = await loadFixture(gfx);
    await time.increase(SUNSET);
    await expect(gm.connect(other).releaseAfterSunset(ids.staking))
      .to.be.revertedWithCustomError(gm, "ModuleNotPaused").withArgs(ids.staking);
  });

  it("[G616] releaseAfterSunset on the TOKEN module ends the guardian's token-pause clock, unpauses the token and logs the release", async function () {
    const { gm, ids, stubs, guardian, other } = await loadFixture(gfx);
    await gm.connect(guardian).pauseModule(ids.token, "incident");
    expect(await gm.tokenPauseEndsAt()).to.not.equal(0n);
    await time.increase(SUNSET);
    await expect(gm.connect(other).releaseAfterSunset(ids.token))
      // review round 22 Oct (D-3): the release is its own event, so a stranger is not logged as the guardian who acted
      .to.emit(gm, "ReleasedAfterSunset").withArgs(ids.token, other.address)
      .and.to.emit(gm, "TokenPauseEnded");
    expect(await stubs.token.paused()).to.equal(false);
    expect(await gm.isModulePaused(ids.token)).to.equal(false);
    expect(await gm.tokenPauseEndsAt()).to.equal(0n);
    expect(await gm.tokenPauseStartedAt()).to.equal(0n);
    // the 14-day term had already run out by the sunset, so it counts as a full term: the repause block started
    expect(await gm.tokenRepauseAt()).to.be.gt(0n);
    expect(await gm.tokenPauseUsed()).to.equal(14n * BigInt(DAY));
  });

  // ── governanceHoldTokenPause ──────────────────────────────────────────────

  it("[G632] governanceHoldTokenPause with no guardian token pause running reverts ModuleNotPaused(MODULE_TOKEN)", async function () {
    const { gm, ids, governance } = await loadFixture(gfx);
    await expect(gm.connect(governance).governanceHoldTokenPause("hold"))
      .to.be.revertedWithCustomError(gm, "ModuleNotPaused").withArgs(ids.token);
    expect(await gm.governanceOnlyUnpause(ids.token)).to.equal(false);
  });

  // ── circuit breaker configuration and reports ─────────────────────────────

  describe("[G679] configureCircuitBreaker threshold and window checks", function () {
    it("a zero threshold, a zero window and a threshold above uint128 each revert InvalidThreshold; uint128 max itself is accepted", async function () {
      const { gm, ids, governance } = await loadFixture(gfx);
      await expect(gm.connect(governance).configureCircuitBreaker(ids.bridge, 0, 3600)).to.be.revertedWithCustomError(gm, "InvalidThreshold");
      await expect(gm.connect(governance).configureCircuitBreaker(ids.bridge, 1, 0)).to.be.revertedWithCustomError(gm, "InvalidThreshold");
      const max = (1n << 128n) - 1n;
      await expect(gm.connect(governance).configureCircuitBreaker(ids.bridge, max + 1n, 3600)).to.be.revertedWithCustomError(gm, "InvalidThreshold");
      await expect(gm.connect(governance).configureCircuitBreaker(ids.bridge, max, 3600))
        .to.emit(gm, "CircuitBreakerConfigured").withArgs(ids.bridge, max, 3600);
      const s = await gm.getCircuitBreakerStatus(ids.bridge);
      expect(s.volumeThreshold).to.equal(max);
      expect(s.windowDuration).to.equal(3600n);
    });

    it("a registered module that is not the bridge reverts CircuitBreakerBridgeOnly", async function () {
      const { gm, ids, governance } = await loadFixture(gfx);
      await expect(gm.connect(governance).configureCircuitBreaker(ids.staking, 1, 1))
        .to.be.revertedWithCustomError(gm, "CircuitBreakerBridgeOnly").withArgs(ids.staking);
    });
  });

  it("[G716/G816] a bridge with no breaker configured ignores reports (no state, no event) and reports an all-zero status", async function () {
    const { gm, ids, monitor, stubs } = await loadFixture(gfx);
    await expect(gm.connect(monitor).recordBridgeActivity(ids.bridge, E(1_000_000_000))).to.not.emit(gm, "CircuitBreakerTripped");
    const s = await gm.getCircuitBreakerStatus(ids.bridge);
    expect([s.tripped, s.volumeInFlight, s.volumeThreshold, s.windowDuration, s.tripCount])
      .to.deep.equal([false, 0n, 0n, 0n, 0n]);
    expect((await gm.circuitBreakers(ids.bridge)).volumeInFlight).to.equal(0n); // nothing was recorded
    expect(await gm.isModulePaused(ids.bridge)).to.equal(false);
    expect(await stubs.bridge.bridgePaused()).to.equal(false);
  });

  // ── tokenPauseAvailable ───────────────────────────────────────────────────

  describe("tokenPauseAvailable", function () {
    it("[G791/G794] fresh: available for the full 14-day run; in the repause block after a full term: unavailable and 0", async function () {
      const { gm, ids, guardian, other } = await loadFixture(gfx);
      let [available, max] = await gm.tokenPauseAvailable();
      expect(available).to.equal(true);
      expect(max).to.equal(14n * BigInt(DAY)); // budget left (30d) is not smaller than the run (14d)

      await gm.connect(guardian).pauseModule(ids.token, "a");
      await time.increase(14 * DAY);
      await gm.connect(other).lapseTokenPause();
      [available, max] = await gm.tokenPauseAvailable();
      expect(available).to.equal(false);
      expect(max).to.equal(0n);
    });

    it("[G794] when the remaining budget is smaller than a run, the budget is the maximum (2 days after 28 used) and the next pause gets exactly that term", async function () {
      const { gm, ids, guardian, other } = await loadFixture(gfx);
      for (let i = 0; i < 2; i++) {
        await gm.connect(guardian).pauseModule(ids.token, "p" + i);
        await time.increase(14 * DAY);
        await gm.connect(other).lapseTokenPause();
        await time.increase(7 * DAY + 5);
      }
      expect(await gm.tokenPauseUsed()).to.equal(28n * BigInt(DAY));
      const [available, max] = await gm.tokenPauseAvailable();
      expect(available).to.equal(true);
      expect(max).to.equal(2n * BigInt(DAY));

      await gm.connect(guardian).pauseModule(ids.token, "last");
      expect((await gm.tokenPauseEndsAt()) - (await gm.tokenPauseStartedAt())).to.equal(2n * BigInt(DAY));
      await time.increase(2 * DAY);
      await gm.connect(other).lapseTokenPause();
      expect(await gm.tokenPauseUsed()).to.equal(30n * BigInt(DAY));
      await time.increase(8 * DAY);
      await expect(gm.connect(guardian).pauseModule(ids.token, "over budget"))
        .to.be.revertedWithCustomError(gm, "TokenPauseBudgetSpent").withArgs(30n * BigInt(DAY), 30n * BigInt(DAY));
      const [availableNow, maxNow] = await gm.tokenPauseAvailable();
      expect([availableNow, maxNow]).to.deep.equal([false, 0n]);
    });
  });

  // ── Failing calls into the target ─────────────────────────────────────────

  it("[G912] freezeBridgeInbound against a token target with no freezeInbound reverts CallFailed(MODULE_TOKEN, empty data) and logs nothing", async function () {
    const { gm, ids, guardian } = await loadFixture(gfx); // the strict stub has no freezeInbound
    await expect(gm.connect(guardian).freezeBridgeInbound(7, "freeze"))
      .to.be.revertedWithCustomError(gm, "CallFailed").withArgs(ids.token, "0x");
  });

  it("[G917] a target reopened directly: unpauseModule and governanceUnpause correct the stale flag instead of failing", async function () {
    const { gm, ids, stubs, guardian, governance } = await loadFixture(gfx);
    await gm.connect(guardian).pauseModule(ids.staking, "incident");
    await stubs.staking.unpause(); // a PAUSER_ROLE holder reopens it directly
    await expect(gm.connect(guardian).unpauseModule(ids.staking, "reopen"))
      .to.emit(gm, "ModuleStateReconciled").withArgs(ids.staking, false);
    expect(await gm.isModulePaused(ids.staking)).to.equal(false);
    // governanceUnpause, the same
    await gm.connect(guardian).pauseModule(ids.fee, "incident");
    await stubs.fee.unpause();
    await expect(gm.connect(governance).governanceUnpause(ids.fee, "reopen"))
      .to.emit(gm, "ModuleStateReconciled").withArgs(ids.fee, false);
    expect(await gm.isModulePaused(ids.fee)).to.equal(false);
  });

  // ── Batch paths with a target that fails ──────────────────────────────────

  describe("pauseAll with a target whose pause fails", function () {
    it("[G462/G941/G967] a target with no pause() and no paused() view is skipped visibly; the other modules still stop and the flag is not set", async function () {
      const { gm, ids, stubs, guardian, governance } = await loadFixture(gfx);
      const erc20 = await (await ethers.getContractFactory("MockERC20")).deploy("X", "X", 18); // no pause(), no paused()
      await gm.connect(governance).updateModuleTarget(ids.staking, await erc20.getAddress());
      await expect(gm.connect(guardian).pauseAll("incident"))
        .to.emit(gm, "ModuleCallSkipped").withArgs(ids.staking, await erc20.getAddress(), true)
        .and.to.emit(gm, "GuardianAction");
      const m = await gm.modules(ids.staking);
      expect(m.paused).to.equal(false);          // no view to reconcile from: left untouched
      expect(m.pauseCount).to.equal(0n);
      expect(m.lastPauseTime).to.equal(0n);
      expect(await gm.governanceOnlyUnpause(ids.staking)).to.equal(false);
      expect(await stubs.fee.paused()).to.equal(true); // the rest of the emergency stop went through
      expect(await stubs.treasury.paused()).to.equal(true);
    });

    it("[G969] a pause that fails on a target that reports itself unpaused changes nothing: no reconcile event", async function () {
      const { gm, ids, admin, guardian, governance } = await loadFixture(gfx);
      // A real token the module holds no PAUSER_ROLE on: pause() reverts, paused() says false.
      const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
      const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
      await gm.connect(governance).updateModuleTarget(ids.staking, await token.getAddress());
      const tx = gm.connect(guardian).pauseAll("incident");
      await expect(tx).to.emit(gm, "ModuleCallSkipped").withArgs(ids.staking, await token.getAddress(), true);
      await expect(tx).to.not.emit(gm, "ModuleStateReconciled");
      expect(await gm.isModulePaused(ids.staking)).to.equal(false);
      expect(await token.paused()).to.equal(false);
    });
  });

  it("[G597] lapseTokenPause still completes when the token was already reopened on the target: the module is reconciled to unpaused and the clock ended", async function () {
    const { gm, ids, stubs, guardian, other } = await loadFixture(gfx);
    await gm.connect(guardian).pauseModule(ids.token, "incident");
    await stubs.token.unpause(); // reopened directly
    await time.increase(14 * DAY);
    await expect(gm.connect(other).lapseTokenPause())
      .to.emit(gm, "ModuleCallSkipped").withArgs(ids.token, await stubs.token.getAddress(), false) // its own unpause failed
      .and.to.emit(gm, "ModuleStateReconciled").withArgs(ids.token, false)
      .and.to.emit(gm, "TokenPauseEnded");
    expect(await gm.isModulePaused(ids.token)).to.equal(false);
    expect(await gm.tokenPauseEndsAt()).to.equal(0n);
    expect(await gm.tokenRepauseAt()).to.be.gt(0n); // full term: the 7-day block started
  });

  it("[G969 via unpause] a unpause that fails on a target that still reports paused leaves the module paused, visibly", async function () {
    const { gm, ids, admin, guardian, governance } = await loadFixture(gfx);
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await token.grantRole(await token.PAUSER_ROLE(), await gm.getAddress());
    await gm.connect(governance).updateModuleTarget(ids.staking, await token.getAddress());
    await gm.connect(guardian).pauseModule(ids.staking, "incident");
    expect(await token.paused()).to.equal(true);
    await token.revokeRole(await token.PAUSER_ROLE(), await gm.getAddress()); // the module can no longer unpause it
    const tx = gm.connect(governance).emergencyUnpauseAll("recover");
    await expect(tx).to.emit(gm, "ModuleCallSkipped").withArgs(ids.staking, await token.getAddress(), false);
    await expect(tx).to.not.emit(gm, "ModuleStateReconciled"); // local true == actual true
    expect(await gm.isModulePaused(ids.staking)).to.equal(true);
  });

  // ── SUSPECT ───────────────────────────────────────────────────────────────

  describe("SUSPECT", function () {
    it("FIXED (was SUSPECT): a module reopened directly behind a stale flag is stopped again by pauseAll and by pauseModule", async function () {
      const { gm, ids, stubs, guardian } = await loadFixture(gfx);
      // the single-module path first
      await gm.connect(guardian).pauseModule(ids.treasury, "first");
      await stubs.treasury.unpause();
      await ethers.provider.send("evm_increaseTime", [3601]);
      await gm.connect(guardian).pauseModule(ids.treasury, "stop treasury");
      expect(await stubs.treasury.paused()).to.equal(true);
      // then the emergency stop
      await gm.connect(guardian).pauseModule(ids.staking, "first incident");
      await stubs.staking.unpause(); // reopened on the target; the module's flag is stale
      expect(await gm.isModulePaused(ids.staking)).to.equal(true);
      await expect(gm.connect(guardian).pauseAll("second incident"))
        .to.emit(gm, "ModuleStateReconciled").withArgs(ids.staking, false);
      expect(await stubs.staking.paused(), "the emergency stop stops it").to.equal(true);
      expect(await gm.isModulePaused(ids.staking)).to.equal(true);
    });
  });

  // ── Reentrancy: nonReentrant refuses a call made from the target's callback ──

  describe("nonReentrant (a hostile target calls back during the module's own call to it)", function () {
    const reasonRe = "re";

    it("control: the stub's inner call SUCCEEDS when made outside any guarded call, so a 'blocked' result below is the guard", async function () {
      const { gm, ids, admin, guardian, other } = await loadFixture(gfx);
      const data = gm.interface.encodeFunctionData("pauseModule", [ids.fee, reasonRe]);
      const stub = await installStub({ target: await gm.getAddress(), data });
      await gm.connect(admin).grantRole(await gm.GUARDIAN_ROLE(), stub);
      await other.sendTransaction({ to: stub, data: "0x" });
      const r = await stubResult(stub);
      expect(r.ok).to.equal(true);
      expect(await gm.isModulePaused(ids.fee)).to.equal(true);
    });

    it("[G355] pauseModule: a call back into pauseModule is refused; the outer pause completes", async function () {
      const { gm, ids, admin, guardian, governance } = await loadFixture(gfx);
      const stub = await installStub({ target: await gm.getAddress(), data: gm.interface.encodeFunctionData("pauseModule", [ids.fee, reasonRe]) });
      await gm.connect(admin).grantRole(await gm.GUARDIAN_ROLE(), stub);
      await gm.connect(governance).updateModuleTarget(ids.staking, stub);
      await expect(gm.connect(guardian).pauseModule(ids.staking, "outer")).to.emit(gm, "GuardianAction");
      await expectBlocked(stub);
      expect(await gm.isModulePaused(ids.staking)).to.equal(true);
      expect(await gm.isModulePaused(ids.fee)).to.equal(false); // the inner pause did not happen
    });

    it("[G389] unpauseModule: a call back into unpauseModule from the target is refused; the outer unpause completes", async function () {
      const { gm, ids, admin, guardian, governance } = await loadFixture(gfx);
      const t = await (await ethers.getContractFactory("ReentrantPausableTarget")).deploy();
      await t.arm(await gm.getAddress(), gm.interface.encodeFunctionData("unpauseModule", [ids.fee, reasonRe]));
      await gm.connect(admin).grantRole(await gm.GUARDIAN_ROLE(), await t.getAddress());
      await gm.connect(governance).updateModuleTarget(ids.staking, await t.getAddress());
      await gm.connect(guardian).pauseModule(ids.staking, "outer");
      await expect(gm.connect(guardian).unpauseModule(ids.staking, "outer")).to.emit(gm, "GuardianAction");
      expect(await t.called()).to.equal(true);
      expect(await t.innerOk()).to.equal(false);
      expect((await t.innerRet()).slice(0, 10)).to.equal(ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10));
      expect(await gm.isModulePaused(ids.staking)).to.equal(false);
    });

    it("[G425] pauseAll: a call back into pauseAll is refused; the batch completes for every module", async function () {
      const { gm, ids, stubs, admin, guardian, governance } = await loadFixture(gfx);
      const stub = await installStub({ target: await gm.getAddress(), data: gm.interface.encodeFunctionData("pauseAll", [reasonRe]) });
      await gm.connect(admin).grantRole(await gm.GUARDIAN_ROLE(), stub);
      await gm.connect(governance).updateModuleTarget(ids.staking, stub);
      await expect(gm.connect(guardian).pauseAll("outer")).to.emit(gm, "GuardianAction");
      await expectBlocked(stub);
      expect(await gm.isModulePaused(ids.staking)).to.equal(true);
      expect(await stubs.treasury.paused()).to.equal(true);
    });

    it("[G508] freezeBridgeInbound: a call back into freezeBridgeInbound is refused; the outer freeze completes", async function () {
      const { gm, ids, admin, guardian, governance } = await loadFixture(gfx);
      const stub = await installStub({ target: await gm.getAddress(), data: gm.interface.encodeFunctionData("freezeBridgeInbound", [9, reasonRe]) });
      await gm.connect(admin).grantRole(await gm.GUARDIAN_ROLE(), stub);
      await gm.connect(governance).updateModuleTarget(ids.token, stub);
      await expect(gm.connect(guardian).freezeBridgeInbound(7, "outer")).to.emit(gm, "GuardianAction");
      await expectBlocked(stub);
    });

    it("[G528] governanceUnpause: a call back into governanceUnpause from the target is refused; the outer unpause completes", async function () {
      const { gm, ids, admin, guardian, governance } = await loadFixture(gfx);
      const t = await (await ethers.getContractFactory("ReentrantPausableTarget")).deploy();
      await t.arm(await gm.getAddress(), gm.interface.encodeFunctionData("governanceUnpause", [ids.fee, reasonRe]));
      await gm.connect(admin).grantRole(await gm.GOVERNANCE_ROLE(), await t.getAddress());
      await gm.connect(governance).updateModuleTarget(ids.staking, await t.getAddress());
      await gm.connect(guardian).pauseModule(ids.staking, "outer");
      await expect(gm.connect(governance).governanceUnpause(ids.staking, "outer")).to.emit(gm, "GovernanceOverride");
      expect(await t.innerOk()).to.equal(false);
      expect((await t.innerRet()).slice(0, 10)).to.equal(ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10));
      expect(await gm.isModulePaused(ids.staking)).to.equal(false);
    });

    it("[G552] emergencyUnpauseAll: a call back into emergencyUnpauseAll is refused; the batch completes", async function () {
      const { gm, ids, admin, guardian, governance } = await loadFixture(gfx);
      const stub = await installStub({ target: await gm.getAddress(), data: gm.interface.encodeFunctionData("emergencyUnpauseAll", [reasonRe]) });
      await gm.connect(admin).grantRole(await gm.GOVERNANCE_ROLE(), stub);
      await gm.connect(governance).updateModuleTarget(ids.staking, stub);
      await gm.connect(guardian).pauseModule(ids.staking, "outer");
      await resetStub(stub);
      await expect(gm.connect(governance).emergencyUnpauseAll("outer")).to.emit(gm, "GovernanceOverride");
      await expectBlocked(stub);
      expect(await gm.isModulePaused(ids.staking)).to.equal(false);
    });

    it("[G587] lapseTokenPause: a call back into lapseTokenPause is refused; the outer lapse completes", async function () {
      const { gm, ids, guardian, governance, other } = await loadFixture(gfx);
      const stub = await installStub({ target: await gm.getAddress(), data: gm.interface.encodeFunctionData("lapseTokenPause") });
      await gm.connect(governance).updateModuleTarget(ids.token, stub);
      await gm.connect(guardian).pauseModule(ids.token, "outer");
      await resetStub(stub);
      await time.increase(14 * DAY);
      await expect(gm.connect(other).lapseTokenPause()).to.emit(gm, "TokenPauseEnded");
      await expectBlocked(stub);
      expect(await gm.isModulePaused(ids.token)).to.equal(false);
      expect(await gm.tokenPauseEndsAt()).to.equal(0n);
    });

    it("[G609] releaseAfterSunset: a call back into releaseAfterSunset is refused; the outer release completes", async function () {
      const { gm, ids, guardian, governance, other } = await loadFixture(gfx);
      const stub = await installStub({ target: await gm.getAddress(), data: gm.interface.encodeFunctionData("releaseAfterSunset", [ids.fee]) });
      await gm.connect(governance).updateModuleTarget(ids.staking, stub);
      await gm.connect(guardian).pauseModule(ids.staking, "outer");
      await resetStub(stub);
      await time.increase(SUNSET);
      // review round 22 Oct (D-3): ReleasedAfterSunset, not GuardianAction
      await expect(gm.connect(other).releaseAfterSunset(ids.staking)).to.emit(gm, "ReleasedAfterSunset");
      await expectBlocked(stub);
      expect(await gm.isModulePaused(ids.staking)).to.equal(false);
    });

    it("[G710] recordBridgeActivity: a call back into recordBridgeActivity while the breaker trips is refused; the trip completes", async function () {
      const { gm, ids, admin, governance, monitor } = await loadFixture(gfx);
      const stub = await installStub({ target: await gm.getAddress(), data: gm.interface.encodeFunctionData("recordBridgeActivity", [ids.bridge, 1]) });
      await gm.connect(admin).grantRole(await gm.CIRCUIT_BREAKER_ROLE(), stub);
      await gm.connect(governance).updateModuleTarget(ids.bridge, stub);
      await gm.connect(governance).configureCircuitBreaker(ids.bridge, E(100), 3600);
      await expect(gm.connect(monitor).recordBridgeActivity(ids.bridge, E(100))).to.emit(gm, "CircuitBreakerTripped");
      await expectBlocked(stub);
      const s = await gm.getCircuitBreakerStatus(ids.bridge);
      expect(s.tripped).to.equal(true);
      expect(s.tripCount).to.equal(1n);
    });
  });

  // ── Branches proved unreachable ───────────────────────────────────────────

  it("[G843 else, G858 then] a spent run (tokenRunUsed == 14 days) is never seen inside its window: the full term that spends it also starts the repause block, which answers first", async function () {
    const { gm, ids, guardian, other } = await loadFixture(gfx);
    await gm.connect(guardian).pauseModule(ids.token, "a");
    await time.increase(10 * DAY);
    await gm.connect(guardian).unpauseModule(ids.token, "a");
    const ranA = await gm.tokenRunUsed();
    expect(ranA).to.be.gte(BigInt(10 * DAY));
    await time.increase(DAY); // past the 1 hour pause cooldown, inside the 7 day window: the same run
    await gm.connect(guardian).pauseModule(ids.token, "b");
    expect((await gm.tokenPauseEndsAt()) - (await gm.tokenPauseStartedAt())).to.equal(14n * BigInt(DAY) - ranA);
    await time.increase(14 * DAY);
    await gm.connect(other).lapseTokenPause(); // B ran its full term
    expect(await gm.tokenRunUsed()).to.equal(14n * BigInt(DAY)); // the run is exactly spent...
    expect((await gm.tokenPauseAvailable())[0]).to.equal(false);
    // ...and the guardian is stopped by the repause block (the check before runLeft), not by runLeft == 0
    await expect(gm.connect(guardian).pauseModule(ids.token, "c"))
      .to.be.revertedWithCustomError(gm, "TokenRepauseBlocked").withArgs(await gm.tokenRepauseAt());
  });
});

// matcher helper: any value (timestamps are not predictable)
function anyTimestamp(v) { return typeof v === "bigint"; }

// ═════════════════════════════════════════════════════════════════════════════
// SRXToken
// ═════════════════════════════════════════════════════════════════════════════

describe("BranchCoverage G2: SRXToken", function () {
  async function tfx() {
    const [admin, other, to] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
    const SRX = await ethers.getContractFactory("SRXToken");
    const token = await SRX.deploy(await ep.getAddress(), admin.address);
    return { SRX, token, ep, admin, other, to };
  }

  it("[T226] transferOwnership by a non-owner reverts OwnableUnauthorizedAccount and starts nothing", async function () {
    const { token, other } = await loadFixture(tfx);
    await expect(token.connect(other).transferOwnership(other.address))
      .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount").withArgs(other.address);
    expect(await token.pendingOwner()).to.equal(ZERO);
  });

  it("[T234] renounceOwnership by a non-owner reverts OwnableUnauthorizedAccount (the owner gets OwnershipCannotBeRenounced)", async function () {
    const { token, admin, other } = await loadFixture(tfx);
    await expect(token.connect(other).renounceOwnership())
      .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount").withArgs(other.address);
    await expect(token.connect(admin).renounceOwnership()).to.be.revertedWithCustomError(token, "OwnershipCannotBeRenounced");
    expect(await token.owner()).to.equal(admin.address);
  });

  it("[T252] a zero admin cannot deploy the token (unreachable as ZeroAddress: Ownable(_admin) refuses it first)", async function () {
    const { SRX, ep, token } = await loadFixture(tfx);
    await expect(SRX.deploy(await ep.getAddress(), ZERO))
      .to.be.revertedWithCustomError(token, "OwnableInvalidOwner").withArgs(ZERO);
  });

  it("[T344] unpause by a non-pauser reverts AccessControlUnauthorizedAccount; the pauser can; the token stays paused until then", async function () {
    const { token, admin, other } = await loadFixture(tfx);
    await token.connect(admin).pause();
    await expect(token.connect(other).unpause())
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount").withArgs(other.address, await token.PAUSER_ROLE());
    expect(await token.paused()).to.equal(true);
    await token.connect(admin).unpause();
    expect(await token.paused()).to.equal(false);
  });

  it("[T461] rescuing ETH to a receiver that refuses it reverts (ETHRescueFailed; review round 22 Oct, was ZeroAmount) and the ETH stays in the token", async function () {
    const { token, admin, to } = await loadFixture(tfx);
    const refuser = await (await ethers.getContractFactory("MockERC20")).deploy("R", "R", 18); // no receive()
    await network.provider.send("hardhat_setBalance", [await token.getAddress(), ethers.toBeHex(ethers.parseEther("1"))]);
    await expect(token.connect(admin).rescueTokens(ZERO, await refuser.getAddress(), ethers.parseEther("1")))
      .to.be.revertedWithCustomError(token, "ETHRescueFailed");
    expect(await ethers.provider.getBalance(await token.getAddress())).to.equal(ethers.parseEther("1"));
    // control: an EOA receiver takes it
    await expect(token.connect(admin).rescueTokens(ZERO, to.address, ethers.parseEther("1")))
      .to.changeEtherBalances([token, to], [-ethers.parseEther("1"), ethers.parseEther("1")]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SRXOFTNative
// ═════════════════════════════════════════════════════════════════════════════

describe("BranchCoverage G2: SRXOFTNative", function () {
  const HUB = 40161, SPOKE = 40102;
  const b32 = (a) => ethers.zeroPadValue(a, 32);

  async function nfx() {
    const [admin, other, to] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(SPOKE);
    const N = await ethers.getContractFactory("SRXOFTNative");
    const native = await N.deploy(await ep.getAddress(), admin.address, HUB, admin.address);
    await native.connect(admin).setPeer(HUB, b32(admin.address));
    return { N, native, ep, admin, other, to };
  }

  it("[N126] renounceOwnership by a non-owner reverts OwnableUnauthorizedAccount (the owner gets OwnershipCannotBeRenounced)", async function () {
    const { native, admin, other } = await loadFixture(nfx);
    await expect(native.connect(other).renounceOwnership())
      .to.be.revertedWithCustomError(native, "OwnableUnauthorizedAccount").withArgs(other.address);
    await expect(native.connect(admin).renounceOwnership()).to.be.revertedWithCustomError(native, "OwnershipCannotBeRenounced");
  });

  it("[N149] constructor: a zero hub reverts ZeroAddress; a zero admin cannot deploy either (OwnableInvalidOwner fires first, so the admin half of the ZeroAddress check is unreachable)", async function () {
    const { N, native, ep, admin } = await loadFixture(nfx);
    await expect(N.deploy(await ep.getAddress(), admin.address, HUB, ZERO)).to.be.revertedWithCustomError(N, "ZeroAddress");
    await expect(N.deploy(await ep.getAddress(), ZERO, HUB, admin.address))
      .to.be.revertedWithCustomError(native, "OwnableInvalidOwner").withArgs(ZERO);
  });

  it("[N208] rescuing ETH to a receiver that refuses it reverts (ETHRescueFailed; review round 22 Oct, was ZeroAmount) and the ETH stays; an EOA receiver takes it", async function () {
    const { native, admin, to } = await loadFixture(nfx);
    const refuser = await (await ethers.getContractFactory("MockERC20")).deploy("R", "R", 18);
    const one = ethers.parseEther("1");
    await network.provider.send("hardhat_setBalance", [await native.getAddress(), ethers.toBeHex(one)]);
    await expect(native.connect(admin).rescueTokens(ZERO, await refuser.getAddress(), one))
      .to.be.revertedWithCustomError(native, "ETHRescueFailed");
    expect(await ethers.provider.getBalance(await native.getAddress())).to.equal(one);
    await expect(native.connect(admin).rescueTokens(ZERO, to.address, one))
      .to.emit(native, "TokenRescued").withArgs(ZERO, to.address, one);
  });

  it("[N267] _credit's source check is unreachable through lzReceive: a message from any eid but the hub is refused earlier (NoPeer), and no peer can be set for another eid (NotHub)", async function () {
    const { native, admin, ep } = await loadFixture(nfx);
    await expect(native.connect(admin).setPeer(99, b32(admin.address)))
      .to.be.revertedWithCustomError(native, "NotHub").withArgs(99, HUB);
    await ethers.provider.send("hardhat_impersonateAccount", [await ep.getAddress()]);
    await ethers.provider.send("hardhat_setBalance", [await ep.getAddress(), "0x21e19e0c9bab2400000"]);
    const epSigner = await ethers.getSigner(await ep.getAddress());
    const msg = ethers.concat([b32(admin.address), ethers.toBeHex(1n, 8)]);
    await expect(native.connect(epSigner).lzReceive({ srcEid: 99, sender: b32(admin.address), nonce: 1 }, ethers.ZeroHash, msg, ZERO, "0x"))
      .to.be.revertedWithCustomError(native, "NoPeer").withArgs(99);
    expect(await native.totalSupply()).to.equal(0n);
    // control: the hub, at its fixed address, is delivered
    await native.connect(epSigner).lzReceive({ srcEid: HUB, sender: b32(admin.address), nonce: 1 }, ethers.ZeroHash, msg, ZERO, "0x");
    expect(await native.totalSupply()).to.equal(1n * 10n ** 12n);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ZkSyncMigrator
// ═════════════════════════════════════════════════════════════════════════════

describe("BranchCoverage G2: ZkSyncMigrator", function () {
  async function mfx() {
    const [admin, user, other, recipient] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await token.connect(admin).genesis(admin.address);
    await token.connect(admin).transfer(user.address, E(1_000));
    const M = await ethers.getContractFactory("ZkSyncMigrator");
    const migrator = await M.deploy(await token.getAddress(), admin.address);
    await token.connect(admin).grantRole(await token.BURN_ROLE(), await migrator.getAddress());
    await token.connect(user).approve(await migrator.getAddress(), ethers.MaxUint256);
    return { M, token, migrator, admin, user, other, recipient };
  }

  it("[M131] constructor: a zero token and a zero admin each revert ZeroAddress", async function () {
    const { M, token, admin } = await loadFixture(mfx);
    await expect(M.deploy(ZERO, admin.address)).to.be.revertedWithCustomError(M, "ZeroAddress");
    await expect(M.deploy(await token.getAddress(), ZERO)).to.be.revertedWithCustomError(M, "ZeroAddress");
    const ok = await M.deploy(await token.getAddress(), admin.address); // control
    expect(await ok.srxToken()).to.equal(await token.getAddress());
  });

  it("[M268] rescueTokens to the zero address reverts ZeroAddress", async function () {
    const { migrator, token, admin } = await loadFixture(mfx);
    await expect(migrator.connect(admin).rescueTokens(await token.getAddress(), ZERO))
      .to.be.revertedWithCustomError(migrator, "ZeroAddress");
  });

  it("[M270] rescueTokens of a token the migrator does not hold reverts ZeroAmount; with a stray balance it moves all of it", async function () {
    const { migrator, admin, recipient } = await loadFixture(mfx);
    const stray = await (await ethers.getContractFactory("MockERC20")).deploy("S", "S", 18);
    await expect(migrator.connect(admin).rescueTokens(await stray.getAddress(), recipient.address))
      .to.be.revertedWithCustomError(migrator, "ZeroAmount");
    await stray.mint(await migrator.getAddress(), 500n);
    await expect(migrator.connect(admin).rescueTokens(await stray.getAddress(), recipient.address))
      .to.emit(migrator, "TokensRescued").withArgs(await stray.getAddress(), recipient.address, 500n);
    expect(await stray.balanceOf(recipient.address)).to.equal(500n);
    expect(await stray.balanceOf(await migrator.getAddress())).to.equal(0n);
  });

  describe("nonReentrant (a hostile token calls back during the migrator's call to it)", function () {
    // The migrator needs its token's address at deploy time and the stub needs the migrator's, so the
    // migrator is deployed against a placeholder address and the stub's code is then put AT that address.
    async function withHostileToken(innerSig, innerArgs, mode, retWord) {
      const [admin, user, , recipient] = await ethers.getSigners();
      const hostile = ethers.Wallet.createRandom().address;
      await network.provider.send("hardhat_setCode", [hostile, "0x00"]);
      const M = await ethers.getContractFactory("ZkSyncMigrator");
      const migrator = await M.deploy(hostile, admin.address);
      const data = migrator.interface.encodeFunctionData(innerSig, innerArgs);
      await installStub({ at: hostile, target: await migrator.getAddress(), data, mode, retWord, skip: [] });
      await migrator.connect(admin).enableMigration();
      return { migrator, hostile, admin, user, recipient };
    }

    it("[M158] migrate: a call back into migrate is refused; the outer migration still completes and is counted once", async function () {
      const { migrator, hostile, user } = await withHostileToken("migrate", [1], "record", 1);
      await expect(migrator.connect(user).migrate(100)).to.emit(migrator, "MigrationRequest");
      await expectBlocked(hostile);
      expect(await migrator.totalMigrated()).to.equal(100n);
      expect(await migrator.migrationCount()).to.equal(1n);
      const chainId = (await ethers.provider.getNetwork()).chainId;
      expect(await migrator.migrationUser((chainId << 128n) | 1n)).to.equal(user.address);
    });

    it("[M169] migrateTo: a call back into migrateTo is refused; the outer migration still completes for the recipient", async function () {
      const [, , , recipient0] = await ethers.getSigners();
      const { migrator, hostile, user, recipient } = await withHostileToken("migrateTo", [1, recipient0.address], "record", 1);
      await expect(migrator.connect(user).migrateTo(100, recipient.address))
        .to.emit(migrator, "MigrationRequest").and.to.emit(migrator, "MigrationFunded");
      await expectBlocked(hostile);
      expect(await migrator.userMigrated(recipient.address)).to.equal(100n);
      expect(await migrator.userMigrated(user.address)).to.equal(0n);
      expect(await migrator.migrationCount()).to.equal(1n);
    });

    it("[M158 control] the same hostile token's inner migrate succeeds when called outside any migrate, so 'blocked' above is the guard", async function () {
      const { migrator, hostile, user } = await withHostileToken("migrate", [1], "record", 1);
      await user.sendTransaction({ to: hostile, data: "0x" }); // stub calls migrator.migrate(1) as itself, outside a guarded call
      // the stub then re-enters through transferFrom, whose own inner call is refused: one migration, not two
      const r = await stubResult(hostile);
      expect(r.ok).to.equal(true);
      expect(await migrator.migrationCount()).to.equal(1n);
    });

    it("[M266] rescueTokens: a call back into rescueTokens from the token's balanceOf is refused, so the outer rescue fails with ReentrancyGuardReentrantCall", async function () {
      const [admin, , , recipient] = await ethers.getSigners();
      const hostile = ethers.Wallet.createRandom().address;
      await network.provider.send("hardhat_setCode", [hostile, "0x00"]);
      const M = await ethers.getContractFactory("ZkSyncMigrator");
      const migrator = await M.deploy(hostile, admin.address);
      const data = migrator.interface.encodeFunctionData("rescueTokens", [hostile, recipient.address]);
      await installStub({ at: hostile, target: await migrator.getAddress(), data, mode: "bubble", retWord: 1, skip: [] });
      await migrator.connect(admin).grantRole(await migrator.GOVERNANCE_ROLE(), hostile); // the hostile token also holds the governance role
      await expect(migrator.connect(admin).rescueTokens(hostile, recipient.address))
        .to.be.revertedWithCustomError(migrator, "ReentrancyGuardReentrantCall");
    });
  });
});
