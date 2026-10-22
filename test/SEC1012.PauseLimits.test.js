// Security ruling, 12 Oct 2026 (bus 20261012T1626Z): the token-wide pause.
//
// ⛔ WHAT WAS WRONG. MODULE_BRIDGE targeted SRXToken.pause(), so a circuit-breaker trip froze
//    EVERY SRX transfer until a ~10-day governance vote, and CIRCUIT_BREAKER_ROLE is a hot
//    key on a monitoring server. A token pause also blocked the exit-only withdrawals the
//    whitepaper promises, and the guardian could keep the token paused until its sunset,
//    which only the deploy script limited.
//
// The four changes, each proven against the REAL SRXToken and GuardianModule:
//   1. the breaker stops the bridge only, never ordinary transfers;
//   2. while paused, a wound-down staking or Fund contract can still pay holders out;
//   3. guardian token pauses lapse after 14 days, a 7-day block follows a full term, and
//      they add up to at most 30 days;
//   4. the guardian's sunset is at most 180 days, in the constructor.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { allocationSource } = require("./helpers/allocationSource");

const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;
const HUB = 40161, SPOKE = 40102;
const b32 = (a) => ethers.zeroPadValue(a, 32);
const msgTo = (to, amountLD) => ethers.concat([b32(to), ethers.toBeHex(amountLD / 10n ** 12n, 8)]);
const fee = { nativeFee: 0n, lzTokenFee: 0n };

async function impersonate(addr) {
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  await ethers.provider.send("hardhat_setBalance", [addr, "0x21e19e0c9bab2400000"]);
  return ethers.getSigner(addr);
}

/** The real token, wired to a real GuardianModule as the launch hand-over leaves it. */
async function wired() {
  const [admin, guardian, governance, monitor, alice, bob, stranger] = await ethers.getSigners();
  const Ep = await ethers.getContractFactory("MockLZEndpoint");
  const hubEp = await Ep.deploy(HUB);
  const spokeEp = await Ep.deploy(SPOKE);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await hubEp.getAddress(), admin.address);
  const native = await (await ethers.getContractFactory("SRXOFTNative"))
    .deploy(await spokeEp.getAddress(), admin.address, HUB, await token.getAddress());
  await token.connect(admin).genesis(admin.address);
  await token.connect(admin).setPeer(SPOKE, b32(await native.getAddress()));
  await native.connect(admin).setPeer(HUB, b32(await token.getAddress()));
  await token.connect(admin).setInboundLimit(SPOKE, E(1_000_000));

  const gm = await (await ethers.getContractFactory("GuardianModule"))
    .deploy(admin.address, guardian.address, governance.address, 180 * DAY);
  const ids = { token: await gm.MODULE_TOKEN(), bridge: await gm.MODULE_BRIDGE() };
  await gm.connect(governance).registerModule(ids.token, await token.getAddress());
  await gm.connect(governance).registerModule(ids.bridge, await token.getAddress());
  await gm.connect(admin).grantRole(await gm.CIRCUIT_BREAKER_ROLE(), monitor.address);
  await gm.connect(governance).configureCircuitBreaker(ids.bridge, E(100), 3600);
  // As after the hand-over: only the module can pause the token.
  await token.connect(admin).grantRole(await token.PAUSER_ROLE(), await gm.getAddress());
  await token.connect(admin).revokeRole(await token.PAUSER_ROLE(), admin.address);

  await token.connect(admin).transfer(alice.address, E(1_000_000));
  const hubEpS = await impersonate(await hubEp.getAddress());
  let n = 0;
  const onHub = (to, amt) => token.connect(hubEpS).lzReceive(
    { srcEid: SPOKE, sender: b32(native.target), nonce: ++n }, ethers.ZeroHash, msgTo(to, amt), ethers.ZeroAddress, "0x");
  const sp = (to, amt) => ({ dstEid: SPOKE, to: b32(to), amountLD: amt, minAmountLD: amt, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" });
  return { admin, guardian, governance, monitor, alice, bob, stranger, token, gm, ids, onHub, sp };
}

// ═════════════════════════════════════════════════════════════════════════════
describe("Security 12 Oct (1): the circuit breaker stops the bridge, never ordinary transfers", function () {
  it("a trip stops bridge sends and returns; ordinary transfers carry on", async function () {
    const { token, gm, ids, monitor, alice, bob, onHub, sp } = await loadFixture(wired);
    await token.connect(alice).send(sp(alice.address, E(50_000)), fee, alice.address); // genuine outflow, before
    await gm.connect(monitor).recordBridgeActivity(ids.bridge, E(100));                // trips

    expect(await token.bridgePaused()).to.equal(true);
    expect(await token.paused(), "a trip must not pause the token").to.equal(false);
    await expect(token.connect(alice).transfer(bob.address, E(1))).to.not.be.reverted;
    await expect(token.connect(alice).send(sp(alice.address, E(1)), fee, alice.address))
      .to.be.revertedWithCustomError(token, "BridgeStopped");
    await expect(onHub(alice.address, E(10_000))).to.be.revertedWithCustomError(token, "BridgeStopped");
  });

  it("only governance reopens the bridge after a trip; a refused return can then be retried", async function () {
    const { token, gm, ids, monitor, guardian, governance, alice, sp, onHub } = await loadFixture(wired);
    await token.connect(alice).send(sp(alice.address, E(50_000)), fee, alice.address);
    await gm.connect(monitor).recordBridgeActivity(ids.bridge, E(100));
    await expect(onHub(alice.address, E(10_000))).to.be.revertedWithCustomError(token, "BridgeStopped");
    await expect(gm.connect(guardian).unpauseModule(ids.bridge, "reopen"))
      .to.be.revertedWithCustomError(gm, "CircuitBreakerAlreadyTripped");
    await gm.connect(governance).resetCircuitBreaker(ids.bridge);
    await gm.connect(governance).governanceUnpause(ids.bridge, "drain ruled out");
    expect(await token.bridgePaused()).to.equal(false);
    const before = await token.balanceOf(alice.address);
    await onHub(alice.address, E(10_000));
    expect(await token.balanceOf(alice.address)).to.equal(before + E(10_000));
  });

  it("the breaker can be configured on the bridge only, and reports for any other module are refused", async function () {
    const { gm, ids, governance, monitor } = await loadFixture(wired);
    await expect(gm.connect(governance).configureCircuitBreaker(ids.token, E(100), 3600))
      .to.be.revertedWithCustomError(gm, "CircuitBreakerBridgeOnly").withArgs(ids.token);
    await expect(gm.connect(monitor).recordBridgeActivity(ids.token, E(1_000)))
      .to.be.revertedWithCustomError(gm, "CircuitBreakerBridgeOnly").withArgs(ids.token);
  });

  it("the bridge stop is the PAUSER_ROLE's alone", async function () {
    const { token, stranger } = await loadFixture(wired);
    await expect(token.connect(stranger).setBridgePaused(true))
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("Security 12 Oct (2): a token pause never blocks an exit-only withdrawal", function () {
  async function pools() {
    const [admin, timelock, safe, alice, bob, stranger] = await ethers.getSigners();
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(HUB);
    const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    await srx.connect(admin).genesis(admin.address);
    const src = await allocationSource(srx, E(1_700_000_000));
    const staking = await (await ethers.getContractFactory("SRXStaking")).deploy(await srx.getAddress(), admin.address, src);
    const fund = await (await ethers.getContractFactory("StabilisationFund"))
      .deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), src);
    for (const c of [staking, fund]) {
      await c.connect(admin).grantRole(await c.WIND_DOWN_ROLE(), safe.address);
      await srx.connect(admin).transfer(await c.getAddress(), E(20_000_000));
    }
    for (const u of [alice, bob]) {
      await srx.connect(admin).transfer(u.address, E(100_000));
      await srx.connect(u).approve(await staking.getAddress(), ethers.MaxUint256);
      await srx.connect(u).approve(await fund.getAddress(), ethers.MaxUint256);
    }
    await staking.connect(alice).lock(E(10_000), 180 * DAY);
    await staking.connect(bob).lock(E(5_000), 7 * DAY);
    await fund.connect(alice).contribute(E(3_000));
    return { admin, timelock, safe, alice, bob, stranger, srx, staking, fund };
  }
  const listed = async (ctx) => {
    for (const c of [ctx.staking, ctx.fund]) await ctx.srx.connect(ctx.admin).addWindDownExit(await c.getAddress());
    return ctx;
  };

  it("paused + listed + wound down: each holder gets exactly their principal, but cannot move it on", async function () {
    const ctx = await listed(await loadFixture(pools));
    const { srx, staking, fund, admin, safe, alice, bob } = ctx;
    await staking.connect(safe).startWindDown();
    await fund.connect(safe).startWindDown();
    await srx.connect(admin).pause();

    for (const [pool, u, p] of [[staking, alice, E(10_000)], [staking, bob, E(5_000)], [fund, alice, E(3_000)]]) {
      const before = await srx.balanceOf(u.address);
      await pool.connect(u).exitAfterWindDown();
      expect(await srx.balanceOf(u.address)).to.equal(before + p);
    }
    await expect(srx.connect(alice).transfer(bob.address, 1n)).to.be.revertedWithCustomError(srx, "EnforcedPause");
  });

  it("paused + listed but NOT wound down: nothing leaves the pool", async function () {
    const ctx = await listed(await loadFixture(pools));
    const { srx, staking, admin, alice, bob } = ctx;
    await time.increase(8 * DAY); // bob's lock has ended: an ordinary withdrawal
    await srx.connect(admin).pause();
    await expect(staking.connect(bob).unlock()).to.be.revertedWithCustomError(srx, "EnforcedPause");
    await expect(staking.connect(alice).earlyWithdraw()).to.be.revertedWithCustomError(srx, "EnforcedPause");
  });

  it("paused + wound down but NOT listed: nothing leaves the pool (the exemption is opt-in by governance)", async function () {
    const { srx, staking, admin, safe, alice } = await loadFixture(pools);
    await staking.connect(safe).startWindDown();
    await srx.connect(admin).pause();
    await expect(staking.connect(alice).exitAfterWindDown()).to.be.revertedWithCustomError(srx, "EnforcedPause");
  });

  it("only governance lists an exit", async function () {
    const { srx, staking, stranger } = await loadFixture(pools);
    await expect(srx.connect(stranger).addWindDownExit(await staking.getAddress()))
      .to.be.revertedWithCustomError(srx, "AccessControlUnauthorizedAccount");
  });

  it("the exit list is add-only: no function can unlist, and adding again changes nothing", async function () {
    const ctx = await listed(await loadFixture(pools));
    const { srx, staking, admin } = ctx;
    // ⛔ Security (12 Oct): an unlist path would let a later vote silently break the exit
    //    promise. The only function that writes the list takes an address and nothing else.
    const touching = srx.interface.fragments
      .filter((f) => f.type === "function" && /WindDownExit/i.test(f.name))
      .map((f) => `${f.name}(${f.inputs.map((i) => i.type).join(",")}) ${f.stateMutability}`).sort();
    expect(touching).to.deep.equal(["addWindDownExit(address) nonpayable", "isWindDownExit(address) view"]);
    await srx.connect(admin).addWindDownExit(await staking.getAddress());
    expect(await srx.isWindDownExit(await staking.getAddress())).to.equal(true);
    // Admin holds every token role here: still nothing it can call takes the listing away.
    for (const f of srx.interface.fragments.filter((f) => f.type === "function" && f.stateMutability === "nonpayable")) {
      expect(f.name, "a writer that could unlist").to.not.match(/remove|unlist|delist|setWindDown/i);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("Security 12 Oct (3): guardian token pauses are bounded", function () {
  const pause = (ctx) => ctx.gm.connect(ctx.guardian).pauseModule(ctx.ids.token, "incident");

  it("a guardian token pause lapses after 14 days; anyone can then end it", async function () {
    const ctx = await loadFixture(wired);
    const { gm, token, stranger } = ctx;
    await pause(ctx);
    const endsAt = await gm.tokenPauseEndsAt();
    expect(endsAt - BigInt(await time.latest())).to.equal(BigInt(14 * DAY));
    await expect(gm.connect(stranger).lapseTokenPause()).to.be.revertedWithCustomError(gm, "TokenPauseNotLapsed");
    await time.increaseTo(endsAt);
    await gm.connect(stranger).lapseTokenPause();
    expect(await token.paused()).to.equal(false);
    expect(await gm.isModulePaused(ctx.ids.token)).to.equal(false);
  });

  it("after a full term the guardian cannot pause the token for 7 days", async function () {
    const ctx = await loadFixture(wired);
    const { gm } = ctx;
    await pause(ctx);
    await time.increaseTo(await gm.tokenPauseEndsAt());
    await gm.lapseTokenPause();
    await expect(pause(ctx)).to.be.revertedWithCustomError(gm, "TokenRepauseBlocked");
    await time.increase(7 * DAY);
    await pause(ctx); // control: allowed again after the block
  });

  it("ending a full term by hand also starts the block (no dodging it by unpausing at day 14)", async function () {
    const ctx = await loadFixture(wired);
    const { gm, guardian, ids } = ctx;
    await pause(ctx);
    await time.increaseTo(await gm.tokenPauseEndsAt());
    await gm.connect(guardian).unpauseModule(ids.token, "end of term");
    await time.increase(2 * 3600); // past the 1 h cooldown
    await expect(pause(ctx)).to.be.revertedWithCustomError(gm, "TokenRepauseBlocked");
  });

  it("a short pause lifted early leaves no block, and charges only the time it ran", async function () {
    const ctx = await loadFixture(wired);
    const { gm, guardian, ids } = ctx;
    await pause(ctx);
    await time.increase(DAY);
    await gm.connect(guardian).unpauseModule(ids.token, "false alarm");
    expect(await gm.tokenPauseUsed()).to.be.closeTo(BigInt(DAY), 5n);
    await time.increase(2 * 3600);
    await pause(ctx);
  });

  it("guardian token pauses add up to at most 30 days, the last one cut to what is left", async function () {
    const ctx = await loadFixture(wired);
    const { gm } = ctx;
    for (const term of [14 * DAY, 14 * DAY, 2 * DAY]) {
      await pause(ctx);
      expect(await gm.tokenPauseEndsAt() - BigInt(await time.latest())).to.equal(BigInt(term));
      await time.increaseTo(await gm.tokenPauseEndsAt());
      await gm.lapseTokenPause();
      await time.increase(7 * DAY);
    }
    expect(await gm.tokenPauseUsed()).to.equal(BigInt(30 * DAY));
    await expect(pause(ctx)).to.be.revertedWithCustomError(gm, "TokenPauseBudgetSpent");
  });

  it("pauseAll skips the token, visibly, when the limits refuse it, and still stops the bridge", async function () {
    const ctx = await loadFixture(wired);
    const { gm, guardian, token, ids } = ctx;
    await pause(ctx);
    await time.increaseTo(await gm.tokenPauseEndsAt());
    await gm.lapseTokenPause();
    await expect(gm.connect(guardian).pauseAll("second incident"))
      .to.emit(gm, "ModuleCallSkipped").withArgs(ids.token, await token.getAddress(), true);
    expect(await token.paused()).to.equal(false);
    expect(await token.bridgePaused()).to.equal(true);
  });

  it("pauseAll's token pause is bounded the same way", async function () {
    const ctx = await loadFixture(wired);
    const { gm, guardian, token, stranger } = ctx;
    await gm.connect(guardian).pauseAll("incident");
    expect(await token.paused()).to.equal(true);
    await time.increaseTo(await gm.tokenPauseEndsAt());
    await gm.connect(stranger).lapseTokenPause();
    expect(await token.paused()).to.equal(false);
  });

  it("a pause still running at the guardian's sunset lapses on schedule; no vote needed", async function () {
    const ctx = await loadFixture(wired);
    const { gm, token, stranger } = ctx;
    await time.increaseTo(Number(await gm.effectiveSunset()) - DAY);
    await pause(ctx);
    await time.increaseTo(await gm.tokenPauseEndsAt()); // 13 days past the sunset
    expect(await gm.isExpired()).to.equal(true);
    await gm.connect(stranger).lapseTokenPause();
    expect(await token.paused()).to.equal(false);
  });

  it("only governance can keep a pause past 14 days, and then only governance lifts it", async function () {
    const ctx = await loadFixture(wired);
    const { gm, governance, guardian, token, ids, stranger } = ctx;
    await pause(ctx);
    await expect(gm.connect(guardian).governanceHoldTokenPause("hold"))
      .to.be.revertedWithCustomError(gm, "AccessControlUnauthorizedAccount");
    await gm.connect(governance).governanceHoldTokenPause("exploit still live");
    await time.increase(20 * DAY);
    await expect(gm.connect(stranger).lapseTokenPause()).to.be.revertedWithCustomError(gm, "TokenPauseNotLapsed");
    expect(await token.paused()).to.equal(true);
    await gm.connect(governance).governanceUnpause(ids.token, "resolved");
    expect(await token.paused()).to.equal(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("Security 12 Oct (4): the guardian's sunset is at most 180 days, in the constructor", function () {
  it("180 days is accepted; one second more is refused", async function () {
    const [admin, guardian, governance] = await ethers.getSigners();
    const G = await ethers.getContractFactory("GuardianModule");
    await expect(G.deploy(admin.address, guardian.address, governance.address, 180 * DAY + 1))
      .to.be.revertedWithCustomError(G, "SunsetTooLong").withArgs(180 * DAY + 1, 180 * DAY);
    const gm = await G.deploy(admin.address, guardian.address, governance.address, 180 * DAY);
    expect(await gm.MAX_SUNSET_DURATION()).to.equal(BigInt(180 * DAY));
  });
});
