// Review round 22 Oct 2026: one regression test per fix (IDs as in the review brief), written
// from the reviewers' proof-of-concept tests. Each POC asserted the OLD bad behaviour; each test
// here asserts the corrected one, and was shown to FAIL on the code before the fixes (9395487).
// Exception: "D-1" is a pin on behaviour that is deliberately unchanged (see its comment).
//
//   A2  SRXToken._debit refuses a send into a frozen chain          A3  no plain transfer to the token itself
//   D-1 guardian freeze survives the sunset (pin)                   D-2 no repointing a module held paused
//   D-3 ReleasedAfterSunset / stale unpause event                   lead  only the six ids, one pause() target each
//   B1  releaseRewardAllocation checks the successor's backing      B2  stress snapshot syncs the allocation first
//   B3  withdraw lock ceiling at deployment                         B4  a top-up never moves an unlock earlier
//   C1  returnFunds  C2 approvals clamp  C3 claimRefund(to)  C4 quoteStable(coin)  C6 removeInvestor after finalize
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { allocationSource } = require("../helpers/allocationSource");
const { approveBuyers, refFor } = require("../helpers/buyers");

const ETH_EID = 40161;
const BSC_EID = 40102;
const DAY = 86_400;
const HOUR = 3_600;
const E = (n) => ethers.parseUnits(String(n), 18);
const U6 = (n) => BigInt(n) * 10n ** 6n;
const usd = (d) => BigInt(d) * 10n ** 8n;
const b32 = (a) => ethers.zeroPadValue(a, 32);
const ZERO = ethers.ZeroAddress;
const fee = { nativeFee: 0n, lzTokenFee: 0n };
const anyValue = () => true;

async function impersonate(addr) {
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  await ethers.provider.send("hardhat_setBalance", [addr, "0x21e19e0c9bab2400000"]);
  return ethers.getSigner(addr);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Token and bridge (A2, A3)
// ═══════════════════════════════════════════════════════════════════════════════

// Hub SRXToken + spoke SRXOFTNative on mock endpoints; `relay` delivers the exact bytes a send produced.
async function bridge(limit = E(1_000_000)) {
  const [admin, honest, other] = await ethers.getSigners();
  const Ep = await ethers.getContractFactory("MockLZEndpoint");
  const ethEp = await Ep.deploy(ETH_EID);
  const bscEp = await Ep.deploy(BSC_EID);
  const hub = await (await ethers.getContractFactory("SRXToken")).deploy(await ethEp.getAddress(), admin.address);
  await hub.connect(admin).genesis(admin.address);
  const spoke = await (await ethers.getContractFactory("SRXOFTNative"))
    .deploy(await bscEp.getAddress(), admin.address, ETH_EID, await hub.getAddress());
  await hub.connect(admin).setPeer(BSC_EID, b32(await spoke.getAddress()));
  await spoke.connect(admin).setPeer(ETH_EID, b32(await hub.getAddress()));
  await hub.connect(admin).setInboundLimit(BSC_EID, limit);
  const chains = {
    [ETH_EID]: { token: hub, signer: await impersonate(await ethEp.getAddress()) },
    [BSC_EID]: { token: spoke, signer: await impersonate(await bscEp.getAddress()) },
  };
  async function relay(sendTx) {
    const receipt = await sendTx.wait();
    const log = receipt.logs.find((l) => { try { return ethEp.interface.parseLog(l)?.name === "MockSent"; } catch { return false; } });
    const sent = ethEp.interface.parseLog(log);
    const srcEid = Number(await (await ethers.getContractAt("MockLZEndpoint", log.address)).eid());
    const dst = chains[Number(sent.args.dstEid)];
    return dst.token.connect(dst.signer).lzReceive(
      { srcEid, sender: b32(sent.args.sender), nonce: sent.args.nonce },
      sent.args.guid, sent.args.message, ZERO, "0x");
  }
  const sp = (dstEid, to, amt) => ({ dstEid, to: b32(to), amountLD: amt, minAmountLD: amt, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" });
  return { admin, honest, other, hub, spoke, relay, sp };
}

describe("Review 22 Oct fixes: token and bridge", function () {
  it("A2: a send INTO a frozen chain is refused (InboundChainFrozen); nothing is burned, outstanding does not grow; after unfreeze it works", async function () {
    const { admin, honest, hub, spoke, relay, sp } = await bridge();
    await hub.connect(admin).transfer(honest.address, E(10_000));
    await hub.connect(admin).grantRole(await hub.PAUSER_ROLE(), admin.address);
    await hub.connect(admin).freezeInbound(BSC_EID);

    const outstandingBefore = await hub.outstandingByEid(BSC_EID);
    const supplyBefore = await hub.totalSupply();
    await expect(hub.connect(honest).send(sp(BSC_EID, honest.address, E(10_000)), fee, honest.address))
      .to.be.revertedWithCustomError(hub, "InboundChainFrozen").withArgs(BSC_EID);
    expect(await hub.balanceOf(honest.address)).to.equal(E(10_000));
    expect(await hub.totalSupply()).to.equal(supplyBefore);
    expect(await hub.outstandingByEid(BSC_EID)).to.equal(outstandingBefore);
    expect(await spoke.balanceOf(honest.address)).to.equal(0n);

    // Other chains and the unfrozen chain are not affected: governance lifts the freeze, the send goes through.
    await hub.connect(admin).unfreezeInbound(BSC_EID);
    await relay(await hub.connect(honest).send(sp(BSC_EID, honest.address, E(10_000)), fee, honest.address));
    expect(await spoke.balanceOf(honest.address)).to.equal(E(10_000));
    expect(await hub.outstandingByEid(BSC_EID)).to.equal(outstandingBefore + E(10_000));
  });

  it("A3: a plain transfer to the hub's own address is refused (TransferToTokenContract); a bridge credit to it still lands and rescueTokens recovers it", async function () {
    const { admin, honest, other, hub, spoke, relay, sp } = await bridge();
    await hub.connect(admin).transfer(honest.address, E(100));
    await relay(await hub.connect(honest).send(sp(BSC_EID, honest.address, E(50)), fee, honest.address));
    const hubAddr = await hub.getAddress();

    // The spoke refused this already; the hub now does too, for every holder (the admin included).
    await expect(spoke.connect(honest).transfer(await spoke.getAddress(), E(1)))
      .to.be.revertedWithCustomError(spoke, "TransferToTokenContract");
    await expect(hub.connect(honest).transfer(hubAddr, E(50))).to.be.revertedWithCustomError(hub, "TransferToTokenContract");
    await expect(hub.connect(admin).transfer(hubAddr, E(1))).to.be.revertedWithCustomError(hub, "TransferToTokenContract");
    await hub.connect(honest).approve(admin.address, E(10));
    await expect(hub.connect(admin).transferFrom(honest.address, hubAddr, E(10))).to.be.revertedWithCustomError(hub, "TransferToTokenContract");
    expect(await hub.balanceOf(hubAddr)).to.equal(0n);
    expect(await hub.balanceOf(honest.address)).to.equal(E(50));

    // A bridge credit (a mint, from == 0) addressed to the token itself is not refused ...
    await relay(await spoke.connect(honest).send(sp(ETH_EID, hubAddr, E(50)), fee, honest.address));
    expect(await hub.balanceOf(hubAddr)).to.equal(E(50));
    // ... and the 48-hour rescue path recovers it.
    await expect(hub.connect(admin).rescueTokens(hubAddr, other.address, E(50)))
      .to.emit(hub, "TokenRescued").withArgs(hubAddr, other.address, E(50));
    expect(await hub.balanceOf(other.address)).to.equal(E(50));
    expect(await hub.balanceOf(hubAddr)).to.equal(0n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GuardianModule (D-1, D-2, D-3, lead)
// ═══════════════════════════════════════════════════════════════════════════════

// Hub token + one spoke + GuardianModule holding the token's PAUSER_ROLE (launch topology; "admin"
// stands in for the Timelock as the token's governance).
async function guardianTopology() {
  const [admin, guardian, governance, user, recipient, stranger] = await ethers.getSigners();
  const b = await bridge(E(10_000_000));
  const { hub: token, spoke } = b;
  await token.connect(admin).transfer(user.address, E(1_000_000));
  const gm = await (await ethers.getContractFactory("GuardianModule"))
    .deploy(admin.address, guardian.address, governance.address, 30 * DAY);
  const TOKEN = await gm.MODULE_TOKEN();
  const BRIDGE = await gm.MODULE_BRIDGE();
  await gm.connect(governance).registerModule(TOKEN, await token.getAddress());
  await gm.connect(governance).registerModule(BRIDGE, await token.getAddress()); // the bridge MAY share the token's target
  const PAUSER = await token.PAUSER_ROLE();
  await token.connect(admin).grantRole(PAUSER, await gm.getAddress());
  if (await token.hasRole(PAUSER, admin.address)) await token.connect(admin).revokeRole(PAUSER, admin.address);
  return { admin, guardian, governance, user, recipient, stranger, token, spoke, gm, TOKEN, BRIDGE, relay: b.relay, sp: b.sp };
}

// A GuardianModule with six simple pausable stubs registered, one per module id.
async function stubbed() {
  const [admin, guardian, governance, stranger] = await ethers.getSigners();
  const gm = await (await ethers.getContractFactory("GuardianModule"))
    .deploy(admin.address, guardian.address, governance.address, 30 * DAY);
  const Stub = await ethers.getContractFactory("PausableStub");
  const ids = {
    token: await gm.MODULE_TOKEN(), bridge: await gm.MODULE_BRIDGE(), staking: await gm.MODULE_STAKING(),
    fee: await gm.MODULE_FEE(), treasury: await gm.MODULE_TREASURY(), ssf: await gm.MODULE_SSF(),
  };
  const stubs = {};
  for (const k of Object.keys(ids)) {
    stubs[k] = await Stub.deploy();
    await gm.connect(governance).registerModule(ids[k], await stubs[k].getAddress());
  }
  const fresh = async () => Stub.deploy();
  return { admin, guardian, governance, stranger, gm, ids, stubs, fresh };
}

describe("Review 22 Oct fixes: GuardianModule", function () {
  it("D-1 (pin, unchanged behaviour): a guardian per-chain freeze survives the sunset; releaseAfterSunset cannot lift it; only governance unfreezeInbound does", async function () {
    const { admin, guardian, user, recipient, stranger, token, spoke, gm, BRIDGE, relay, sp } = await guardianTopology();
    await relay(await token.connect(user).send(sp(BSC_EID, recipient.address, E(1_000)), fee, user.address));

    // One minute before the sunset the guardian freezes returns from the spoke.
    await time.increaseTo((await gm.effectiveSunset()) - 60n);
    await gm.connect(guardian).freezeBridgeInbound(BSC_EID, "last act");
    expect(await token.inboundFrozen(BSC_EID)).to.equal(true);

    // Sunset passes. The bridge module itself is not paused, so there is nothing to release ...
    await time.increaseTo((await gm.effectiveSunset()) + BigInt(30 * DAY));
    expect(await gm.isExpired()).to.equal(true);
    await expect(gm.connect(stranger).releaseAfterSunset(BRIDGE)).to.be.revertedWithCustomError(gm, "ModuleNotPaused");
    // ... the guardian has no power left ...
    await expect(gm.connect(guardian).freezeBridgeInbound(BSC_EID, "again")).to.be.revertedWithCustomError(gm, "GuardianExpired");
    // ... and nobody but governance can lift the freeze.
    await expect(token.connect(stranger).unfreezeInbound(BSC_EID)).to.be.reverted;
    await expect(token.connect(guardian).unfreezeInbound(BSC_EID)).to.be.reverted;
    expect(await token.inboundFrozen(BSC_EID)).to.equal(true);
    const back = await spoke.connect(recipient).send(sp(ETH_EID, user.address, E(1_000)), fee, recipient.address);
    await expect(relay(back)).to.be.revertedWithCustomError(token, "InboundChainFrozen");

    // Governance (the token's admin, via the Timelock) lifts it; the held return then delivers.
    await token.connect(admin).unfreezeInbound(BSC_EID);
    expect(await token.inboundFrozen(BSC_EID)).to.equal(false);
    await relay(back);
    expect(await token.balanceOf(user.address)).to.equal(E(1_000_000));
  });

  it("D-2: updateModuleTarget is refused (ModuleAlreadyPaused) while the module is held paused and its old target is paused; it proceeds once governance has unpaused it, or when the flag is stale", async function () {
    const { guardian, governance, gm, ids, stubs, fresh } = await stubbed();

    // 1. Held paused, old target really paused: refused, nothing changes.
    await gm.connect(guardian).pauseModule(ids.token, "incident");
    expect(await stubs.token.paused()).to.equal(true);
    const next = await fresh();
    await expect(gm.connect(governance).updateModuleTarget(ids.token, await next.getAddress()))
      .to.be.revertedWithCustomError(gm, "ModuleAlreadyPaused").withArgs(ids.token);
    expect((await gm.modules(ids.token)).target).to.equal(await stubs.token.getAddress());
    expect(await gm.tokenPauseEndsAt()).to.not.equal(0n);     // the guardian's term is still running
    expect(await stubs.token.paused()).to.equal(true);

    // 2. Governance lifts the pause first; then the repoint goes through.
    await gm.connect(governance).governanceUnpause(ids.token, "resolved");
    expect(await stubs.token.paused()).to.equal(false);
    await gm.connect(governance).updateModuleTarget(ids.token, await next.getAddress());
    expect((await gm.modules(ids.token)).target).to.equal(await next.getAddress());

    // 3. Stale flag: the module thinks it is paused but its target was reopened directly: not refused.
    await gm.connect(guardian).pauseModule(ids.staking, "incident");
    await stubs.staking.unpause();                              // reopened outside the module
    expect(await gm.isModulePaused(ids.staking)).to.equal(true); // the flag is stale
    const next2 = await fresh();
    await gm.connect(governance).updateModuleTarget(ids.staking, await next2.getAddress());
    expect((await gm.modules(ids.staking)).target).to.equal(await next2.getAddress());
    expect(await gm.isModulePaused(ids.staking)).to.equal(false);
  });

  it("D-3 (a): releaseAfterSunset emits ReleasedAfterSunset(moduleId, caller) and no GuardianAction naming the stranger", async function () {
    const { guardian, stranger, gm, ids, stubs } = await stubbed();
    await gm.connect(guardian).pauseModule(ids.fee, "x");
    await time.increaseTo(await gm.effectiveSunset());
    const tx = gm.connect(stranger).releaseAfterSunset(ids.fee);
    await expect(tx).to.emit(gm, "ReleasedAfterSunset").withArgs(ids.fee, stranger.address);
    await expect(tx).to.not.emit(gm, "GuardianAction");
    expect(await stubs.fee.paused()).to.equal(false);
    expect(await gm.hasRole(await gm.GUARDIAN_ROLE(), stranger.address)).to.equal(false);
  });

  it("D-3 (b): unpauseModule on a stale flag (target already reopened) corrects it AND emits GuardianAction(Unpause, reason)", async function () {
    const { guardian, gm, ids, stubs } = await stubbed();
    await gm.connect(guardian).pauseModule(ids.treasury, "incident");
    await stubs.treasury.unpause();                             // reopened directly: the flag is stale
    await expect(gm.connect(guardian).unpauseModule(ids.treasury, "already open"))
      .to.emit(gm, "GuardianAction").withArgs(ids.treasury, guardian.address, 1 /* Unpause */, "already open", anyValue);
    expect(await gm.isModulePaused(ids.treasury)).to.equal(false);
  });

  it("lead: only the six MODULE_* ids can be registered; no two non-bridge modules share a pause() target; the bridge may share the token's; repointing frees the old target", async function () {
    const [admin, guardian, governance] = await ethers.getSigners();
    const gm = await (await ethers.getContractFactory("GuardianModule"))
      .deploy(admin.address, guardian.address, governance.address, 30 * DAY);
    const Stub = await ethers.getContractFactory("PausableStub");
    const [a, b, c, d] = [await Stub.deploy(), await Stub.deploy(), await Stub.deploy(), await Stub.deploy()];
    const [A, B, C, D] = [await a.getAddress(), await b.getAddress(), await c.getAddress(), await d.getAddress()];
    const TOKEN = await gm.MODULE_TOKEN(), BRIDGE = await gm.MODULE_BRIDGE(), STAKING = await gm.MODULE_STAKING();
    const FEE = await gm.MODULE_FEE(), TREASURY = await gm.MODULE_TREASURY(), SSF = await gm.MODULE_SSF();

    // An id that is not one of the six: refused, even on a fresh target.
    const extra = ethers.id("TOKEN_TWO");
    await expect(gm.connect(governance).registerModule(extra, A))
      .to.be.revertedWithCustomError(gm, "InvalidModuleTarget").withArgs(extra, A);
    expect((await gm.modules(extra)).registered).to.equal(false);

    // The token's target is held by TOKEN; no other pause() module can take it ...
    await gm.connect(governance).registerModule(TOKEN, A);
    expect(await gm.pauseTargetOf(A)).to.equal(TOKEN);
    await expect(gm.connect(governance).registerModule(STAKING, A))
      .to.be.revertedWithCustomError(gm, "InvalidModuleTarget").withArgs(STAKING, A);
    // ... but the bridge (whose stop is the token's own setBridgePaused) may share it.
    await gm.connect(governance).registerModule(BRIDGE, A);
    expect((await gm.modules(BRIDGE)).target).to.equal(A);
    expect(await gm.pauseTargetOf(A)).to.equal(TOKEN);

    // A second module cannot be repointed onto a held target either.
    await gm.connect(governance).registerModule(FEE, B);
    await expect(gm.connect(governance).updateModuleTarget(FEE, A))
      .to.be.revertedWithCustomError(gm, "InvalidModuleTarget").withArgs(FEE, A);
    expect((await gm.modules(FEE)).target).to.equal(B);

    // Repointing TOKEN frees A for another module, and records the new holder.
    await gm.connect(governance).updateModuleTarget(TOKEN, C);
    expect(await gm.pauseTargetOf(A)).to.equal(ethers.ZeroHash);
    expect(await gm.pauseTargetOf(C)).to.equal(TOKEN);
    await gm.connect(governance).registerModule(STAKING, A);
    expect(await gm.pauseTargetOf(A)).to.equal(STAKING);

    // The remaining ids register on their own targets.
    await gm.connect(governance).registerModule(TREASURY, D);
    await gm.connect(governance).registerModule(SSF, await (await Stub.deploy()).getAddress());
    expect(await gm.pauseTargetOf(D)).to.equal(TREASURY);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rewards and deposits (B1 to B4)
// ═══════════════════════════════════════════════════════════════════════════════

async function srxToken() {
  const [admin] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(ETH_EID);
  const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
  await srx.connect(admin).genesis(admin.address);
  return srx;
}

// A v1 fund with registered rewards, wound down, ready to release to a successor.
async function woundDownFund() {
  const [admin, timelock, safe, alice, bob, stranger] = await ethers.getSigners();
  const srx = await srxToken();
  const Fund = await ethers.getContractFactory("StabilisationFund");
  const fund = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000),
    await allocationSource(srx, E(1_500_000_000)));
  await fund.connect(admin).grantRole(await fund.GOVERNANCE_ROLE(), timelock.address);
  await fund.connect(admin).grantRole(await fund.WIND_DOWN_ROLE(), safe.address);
  await srx.connect(admin).transfer(await fund.getAddress(), E(20_000_000));
  for (const u of [alice, bob]) {
    await srx.connect(admin).transfer(u.address, E(2_000_000));
    await srx.connect(u).approve(await fund.getAddress(), ethers.MaxUint256);
  }
  await fund.connect(alice).contribute(E(5_000));
  await fund.connect(timelock).notifyRewardAmount(E(1_000_000));
  await fund.connect(safe).startWindDown();
  return { admin, timelock, safe, alice, bob, stranger, srx, fund, Fund };
}

describe("Review 22 Oct fixes: rewards and deposits", function () {
  it("B1 (a): a release to a successor whose own reward cap is below the amount is refused (NotASuccessor); nothing moves; a correct successor still receives it as backing", async function () {
    const { admin, timelock, srx, fund, Fund } = await woundDownFund();
    const releasable = await fund.releasableRewardAllocation();
    expect(releasable).to.be.gt(0n);

    // v2 names v1 as its allocation source (passes the old check) but was deployed with rewardAllocation 0.
    const v2 = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, 0n, await fund.getAddress());
    const backingBefore = await fund.rewardBacking();
    await expect(fund.connect(timelock).releaseRewardAllocation(await v2.getAddress(), releasable))
      .to.be.revertedWithCustomError(fund, "NotASuccessor").withArgs(await v2.getAddress());
    expect(await srx.balanceOf(await v2.getAddress())).to.equal(0n);
    expect(await fund.rewardBacking()).to.equal(backingBefore);
    expect(await fund.releasableRewardAllocation()).to.equal(releasable);

    // Control: a successor with the right cap takes it as reward backing, exactly.
    const v3 = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), await fund.getAddress());
    await fund.connect(timelock).releaseRewardAllocation(await v3.getAddress(), releasable);
    expect(await v3.rewardBacking()).to.equal(releasable);
    expect(await srx.balanceOf(await v3.getAddress())).to.equal(releasable);
  });

  it("B1 (b): a release to a successor fund that is already wound down is refused from its own syncAllocation (WoundDown)", async function () {
    const { admin, timelock, srx, fund, Fund } = await woundDownFund();
    const releasable = await fund.releasableRewardAllocation();
    const v2 = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), await fund.getAddress());
    await v2.connect(admin).startWindDown();
    await expect(fund.connect(timelock).releaseRewardAllocation(await v2.getAddress(), releasable))
      .to.be.revertedWithCustomError(v2, "WoundDown");
    expect(await srx.balanceOf(await v2.getAddress())).to.equal(0n);
    expect(await fund.releasableRewardAllocation()).to.equal(releasable);
  });

  it("B1 (c): a release to a wound-down staking successor is refused (WoundDown), so it is not frozen there for good; a live staking successor takes it as backing", async function () {
    const { admin, timelock, srx, fund } = await woundDownFund();
    const releasable = await fund.releasableRewardAllocation();
    const Staking = await ethers.getContractFactory("SRXStaking");
    const v2 = await Staking.deploy(await srx.getAddress(), admin.address, await fund.getAddress());
    await v2.connect(admin).startWindDown();
    await expect(fund.connect(timelock).releaseRewardAllocation(await v2.getAddress(), releasable))
      .to.be.revertedWithCustomError(v2, "WoundDown");
    expect(await srx.balanceOf(await v2.getAddress())).to.equal(0n);
    expect(await fund.releasableRewardAllocation()).to.equal(releasable);

    // Control: a live staking successor receives it as reward backing, exactly.
    const v3 = await Staking.deploy(await srx.getAddress(), admin.address, await fund.getAddress());
    await fund.connect(timelock).releaseRewardAllocation(await v3.getAddress(), releasable);
    expect(await v3.rewardBacking()).to.equal(releasable);
    expect(await srx.balanceOf(await v3.getAddress())).to.equal(releasable);
  });

  it("B1 (d): the same check in SRXStaking.releaseRewardAllocation: a successor with too small a cap, or already wound down, is refused", async function () {
    const [admin, , , , , stranger] = await ethers.getSigners();
    const srx = await srxToken();
    const Staking = await ethers.getContractFactory("SRXStaking");
    const Fund = await ethers.getContractFactory("StabilisationFund");
    const v1 = await Staking.deploy(await srx.getAddress(), admin.address, await allocationSource(srx));
    await srx.connect(admin).transfer(await v1.getAddress(), E(10_000_000));
    await srx.connect(admin).transfer(stranger.address, E(10_000));
    await srx.connect(stranger).approve(await v1.getAddress(), ethers.MaxUint256);
    await v1.connect(stranger).lock(E(1_000), 7 * DAY);
    await v1.connect(admin).notifyRewardAmount(E(1_000_000));
    await v1.connect(admin).startWindDown();
    const releasable = await v1.releasableRewardAllocation();
    expect(releasable).to.be.gt(0n);

    const tiny = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, 0n, await v1.getAddress());
    await expect(v1.connect(admin).releaseRewardAllocation(await tiny.getAddress(), releasable))
      .to.be.revertedWithCustomError(v1, "NotASuccessor").withArgs(await tiny.getAddress());
    const dead = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), await v1.getAddress());
    await dead.connect(admin).startWindDown();
    await expect(v1.connect(admin).releaseRewardAllocation(await dead.getAddress(), releasable))
      .to.be.revertedWithCustomError(dead, "WoundDown");
    expect(await srx.balanceOf(await tiny.getAddress())).to.equal(0n);
    expect(await srx.balanceOf(await dead.getAddress())).to.equal(0n);

    const ok = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), await v1.getAddress());
    await v1.connect(admin).releaseRewardAllocation(await ok.getAddress(), releasable);
    expect(await ok.rewardBacking()).to.equal(releasable);
  });

  it("B2: triggerStressEvent syncs the allocation first, so SRX delivered since the last sync does not count as free SRX and widen the caps", async function () {
    const [admin, , , , , , guardian, oracle, pool] = await ethers.getSigners();
    const srx = await srxToken();
    const Src = await ethers.getContractFactory("MockTGEAllocationSource");
    const src = await Src.deploy(await srx.getAddress(), 0n, true);
    const Fund = await ethers.getContractFactory("StabilisationFund");
    const fund = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), await src.getAddress());
    await fund.connect(admin).grantRole(await fund.GUARDIAN_ROLE(), guardian.address);
    await fund.connect(admin).grantRole(await fund.ORACLE_REPORTER_ROLE(), oracle.address);
    await fund.connect(admin).setDeployTarget(pool.address, true);

    await fund.syncAllocation();                                  // an early sync: nothing delivered yet, backing 0
    expect(await fund.rewardBacking()).to.equal(0n);
    const FREE = E(100_000);
    await srx.connect(admin).transfer(await fund.getAddress(), FREE);
    // The launch reward SRX arrives afterwards and the source now records it, but nobody has synced.
    await src.setAllocatedTo(await fund.getAddress(), E(10_000_000));
    await srx.connect(admin).transfer(await fund.getAddress(), E(10_000_000));
    expect(await fund.rewardBacking()).to.equal(0n);              // still unsynced

    await fund.connect(oracle).triggerStressEvent();
    expect(await fund.rewardBacking()).to.equal(E(10_000_000));   // synced by the trigger
    expect(await fund.stressStartSRXBalance()).to.equal(FREE);    // only the genuinely free SRX is the base

    // The guardian cap is 70% of the free SRX, not of free SRX plus the reward allocation.
    await expect(fund.connect(guardian).deployLiquidity(pool.address, await srx.getAddress(), FREE, "stress"))
      .to.be.revertedWithCustomError(fund, "GuardianCapExceeded").withArgs((FREE * 7_000n) / 10_000n, FREE);
    await fund.connect(guardian).deployLiquidity(pool.address, await srx.getAddress(), (FREE * 7_000n) / 10_000n, "stress");
    expect(await srx.balanceOf(pool.address)).to.equal((FREE * 7_000n) / 10_000n);
  });

  it("B3: the constructor refuses a withdraw lock above 90 days (InvalidDuration); exactly 90 days is accepted", async function () {
    const [admin] = await ethers.getSigners();
    const srx = await srxToken();
    const Fund = await ethers.getContractFactory("StabilisationFund");
    const src = await allocationSource(srx, E(1_500_000_000));
    const args = (lock) => [srx.target, admin.address, 3_000, 7_000, lock, 0n, src];
    const MAX = 90 * DAY;
    await expect(Fund.deploy(...args(MAX + 1))).to.be.revertedWithCustomError(Fund, "InvalidDuration");
    await expect(Fund.deploy(...args(365 * DAY))).to.be.revertedWithCustomError(Fund, "InvalidDuration");
    await expect(Fund.deploy(...args(ethers.MaxUint256))).to.be.revertedWithCustomError(Fund, "InvalidDuration");
    const ok = await Fund.deploy(...args(MAX));
    expect(await ok.withdrawLockDuration()).to.equal(BigInt(MAX));
    expect(await ok.withdrawLockDuration()).to.equal(await ok.MAX_WITHDRAW_LOCK());
  });

  it("B4: a dust top-up never moves a deposit's unlock time earlier after the lock is shortened; a longer lock still moves it later", async function () {
    const [admin, alice] = await ethers.getSigners();
    const srx = await srxToken();
    const Fund = await ethers.getContractFactory("StabilisationFund");
    const fund = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 90 * DAY, 0n,
      await allocationSource(srx, E(1_500_000_000)));
    await srx.connect(admin).transfer(alice.address, E(1_000_002));
    await srx.connect(alice).approve(await fund.getAddress(), ethers.MaxUint256);
    await fund.connect(alice).contribute(E(1_000_000));
    const unlockAt = await fund.contributionUnlockAt(alice.address);

    await fund.connect(admin).setWithdrawLockDuration(0);        // "for deposits made from now on"
    await fund.connect(alice).contribute(1n);                     // dust top-up
    expect(await fund.contributionUnlockAt(alice.address)).to.equal(unlockAt);
    await expect(fund.connect(alice).withdrawContribution(E(1_000_000) + 1n))
      .to.be.revertedWithCustomError(fund, "WithdrawLockActive").withArgs(unlockAt);

    // Control: a longer lock still takes effect on a new deposit.
    await fund.connect(admin).setWithdrawLockDuration(90 * DAY);
    await fund.connect(alice).contribute(1n);
    expect(await fund.contributionUnlockAt(alice.address)).to.be.gt(unlockAt);
    // And the position is released at the (original) time once it is reached, not before.
    await time.increaseTo((await fund.contributionUnlockAt(alice.address)));
    await fund.connect(alice).withdrawContribution(E(1_000_000) + 2n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PreSaleRound (C1, C2, C3, C4, C6)
// ═══════════════════════════════════════════════════════════════════════════════

const PRICE = 1_250_000n;                       // $0.0125
const CAP = ethers.parseUnits("300000000", 18); // 300M SRX
const ETH_PRICE = 2_500n * 10n ** 8n;
const BTC_PRICE = 60_000n * 10n ** 8n;

async function presale({ usdcDisabled = false, usdtDisabled = false, usdtDecimals = 6 } = {}) {
  const [admin, i1, i2, i3, treasury, other, recipient] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(ETH_EID);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(lz.target, admin.address);
  await token.connect(admin).genesis(admin.address);
  const M = await ethers.getContractFactory("MockERC20");
  const usdc = await M.deploy("USD Coin", "USDC", 6);
  const usdt = await M.deploy("Tether USD", "USDT", usdtDecimals);
  const wbtc = await M.deploy("Wrapped BTC", "WBTC", 8);
  const F = await ethers.getContractFactory("MockChainlinkFeed");
  const ethFeed = await F.deploy(ETH_PRICE);
  const btcFeed = await F.deploy(BTC_PRICE);
  const r = await (await ethers.getContractFactory("PreSaleRound")).deploy(
    token.target, usdcDisabled ? ZERO : usdc.target, usdtDisabled ? ZERO : usdt.target, wbtc.target, ethFeed.target, btcFeed.target,
    admin.address, CAP, PRICE, true, 5_000n, treasury.address,
  );
  for (const w of [i1, i2, i3]) {
    await usdc.mint(w.address, U6(1_000_000));
    await usdt.mint(w.address, 10n ** BigInt(usdtDecimals) * 1_000_000n);
    await usdc.connect(w).approve(r.target, ethers.MaxUint256);
    await usdt.connect(w).approve(r.target, ethers.MaxUint256);
  }
  return { r, token, usdc, usdt, wbtc, ethFeed, F, admin, i1, i2, i3, treasury, other, recipient };
}

describe("Review 22 Oct fixes: PreSaleRound", function () {
  it("C1: returnFunds() (admin only, payable) lets raised ETH be put back after withdrawETH + finalize, so the refund pays; it credits no one", async function () {
    const { r, admin, i1, i2, treasury, other } = await presale();
    await approveBuyers(r, admin, [i1, i2]);
    await r.connect(i1).invest({ value: E(2) });                 // $5,000 of ETH
    await r.connect(i2).investWithUSDC(U6(5_000));
    await r.connect(admin).withdrawETH(treasury.address);
    await r.connect(admin).withdrawUSDC(treasury.address);
    await r.connect(admin).finalize();

    await expect(r.connect(admin).refundInvestor(i1.address))
      .to.be.revertedWithCustomError(r, "RefundUnderfunded").withArgs(ZERO, E(2), 0n);

    const countBefore = await r.investorCount();
    const allocatedBefore = await r.totalAllocated();
    await expect(r.connect(other).returnFunds({ value: E(2) })).to.be.revertedWithCustomError(r, "OnlyAdmin");
    await expect(r.connect(admin).returnFunds({ value: E(2) })).to.changeEtherBalance(r, E(2));
    // It books the sender as nobody: no investor, no allocation, no approval, no refund owed.
    expect(await r.investorCount()).to.equal(countBefore);
    expect(await r.totalAllocated()).to.equal(allocatedBefore);
    expect((await r.investors(admin.address)).srxAllocation).to.equal(0n);
    expect((await r.investors(admin.address)).cumulativeUsd8Dec).to.equal(0n);
    expect(await r.refundOwed(admin.address, ZERO)).to.equal(0n);
    expect(await r.totalRefundOwed(ZERO)).to.equal(0n);
    expect(await r.getInvestorList()).to.not.include(admin.address);

    // The ETH payer is now refunded in full.
    await r.connect(admin).refundInvestor(i1.address);
    await expect(r.connect(i1).claimRefund(ZERO, i1.address)).to.changeEtherBalances([r, i1], [-E(2), E(2)]);
  });

  it("C2: setBuyerApprovals does not revert for a cap below what the buyer bought: the cap is raised to it, the agreement ref kept, and the rest of the batch applies", async function () {
    const { r, admin, i1, i2, i3 } = await presale();
    await r.connect(admin).setMinContribution(usd(2_500));
    await approveBuyers(r, admin, [i1], usd(100_000));
    await r.connect(i1).investWithUSDC(U6(10_000));              // i1 has $10,000

    // The Safe signs: stop i1 at $5,000 (already below what they have), and approve new buyer i2.
    await expect(r.connect(admin).setBuyerApprovals(
      [i1.address, i2.address], [usd(5_000), usd(50_000)], [refFor(i2.address), refFor(i2.address)]))
      .to.emit(r, "BuyerApprovalSet").withArgs(i1.address, usd(10_000), refFor(i1.address))
      .and.to.emit(r, "BuyerApprovalSet").withArgs(i2.address, usd(50_000), refFor(i2.address));
    const a1 = await r.buyerApprovals(i1.address);
    expect(a1.capUsd8Dec).to.equal(usd(10_000));                 // raised to what they bought
    expect(a1.agreementRef).to.equal(refFor(i1.address));        // the existing ref is kept, not the one passed in
    expect((await r.buyerApprovals(i2.address)).capUsd8Dec).to.equal(usd(50_000));
    await r.connect(i2).investWithUSDC(U6(2_500));               // and the new buyer can buy within it

    // "Revoke" (cap 0, no ref) a buyer who already bought: stopped where they are, ref kept.
    await r.connect(admin).setBuyerApprovals([i1.address], [0n], [ethers.ZeroHash]);
    const a2 = await r.buyerApprovals(i1.address);
    expect(a2.capUsd8Dec).to.equal(usd(10_000));
    expect(a2.agreementRef).to.equal(refFor(i1.address));
    await expect(r.connect(i1).investWithUSDC(U6(2_500))).to.be.revertedWithCustomError(r, "NotApproved");
    // A buyer who bought nothing is revoked as before.
    await approveBuyers(r, admin, [i3], usd(50_000));
    await r.connect(admin).setBuyerApprovals([i3.address], [0n], [ethers.ZeroHash]);
    expect((await r.buyerApprovals(i3.address)).capUsd8Dec).to.equal(0n);
  });

  it("C3: claimRefund(asset, to) pays `to`, so a payer that cannot take ETH (or a blacklisted token holder) is still paid; zero `to` reverts; nobody can claim another's refund", async function () {
    const { r, usdc, admin, i1, other, recipient } = await presale();
    const B = await ethers.getContractFactory("Review2210NoReceiveBuyer");
    const buyer = await B.deploy(r.target);
    await approveBuyers(r, admin, [buyer.target, i1]);
    await buyer.buyETH({ value: E(2) });
    await r.connect(i1).investWithUSDC(U6(10_000));
    await r.connect(admin).refundInvestor(buyer.target);
    await r.connect(admin).refundInvestor(i1.address);

    // A stranger owes nothing, so cannot claim, and cannot redirect someone else's refund to itself.
    await expect(r.connect(other).claimRefund(ZERO, other.address)).to.be.revertedWithCustomError(r, "ZeroAmount");
    await expect(r.connect(other).claimRefund(usdc.target, other.address)).to.be.revertedWithCustomError(r, "ZeroAmount");
    // Zero destination refused.
    await expect(buyer.claim(ZERO, ZERO)).to.be.revertedWithCustomError(r, "ZeroAddress");
    await expect(r.connect(i1).claimRefund(usdc.target, ZERO)).to.be.revertedWithCustomError(r, "ZeroAddress");
    // The contract that cannot take ETH names a wallet that can.
    await expect(buyer.claim(ZERO, recipient.address)).to.changeEtherBalances([r, recipient], [-E(2), E(2)]);
    expect(await r.refundOwed(buyer.target, ZERO)).to.equal(0n);
    expect(await r.totalRefundOwed(ZERO)).to.equal(0n);
    // Same for a token refund: the owed address chooses where it goes (and nowhere else changes).
    await expect(r.connect(i1).claimRefund(usdc.target, recipient.address))
      .to.changeTokenBalances(usdc, [r, i1, recipient], [-U6(10_000), 0n, U6(10_000)]);
    expect(await r.totalRefundOwed(usdc.target)).to.equal(0n);
    // Once claimed it cannot be claimed again.
    await expect(r.connect(i1).claimRefund(usdc.target, i1.address)).to.be.revertedWithCustomError(r, "ZeroAmount");
  });

  it("C4: quoteStable(coin, amount, investor) uses that coin's own decimals and feed: USDT (18 dec, own feed) and USDC (6 dec) both quote exactly what a purchase credits", async function () {
    const { r, admin, i1, i2, usdc, usdt, F } = await presale({ usdtDecimals: 18 });
    await approveBuyers(r, admin, [i1, i2]);
    // USDT depegs to $0.90 on its own feed; USDC stays at $1.00.
    await r.connect(admin).setStablecoinFeeds((await F.deploy(100_000_000n)).target, (await F.deploy(90_000_000n)).target);

    const usdtAmt = 100n * 10n ** 18n, usdcAmt = U6(100);
    const qUsdt = await r.quoteStable(usdt.target, usdtAmt, i1.address);
    const qUsdc = await r.quoteStable(usdc.target, usdcAmt, i2.address);
    await r.connect(i1).investWithUSDT(usdtAmt);
    await r.connect(i2).investWithUSDC(usdcAmt);
    expect((await r.investors(i1.address)).srxAllocation).to.equal(qUsdt);
    expect((await r.investors(i2.address)).srxAllocation).to.equal(qUsdc);
    expect(qUsdt).to.equal(E(100 * 0.9 * 120));                  // $90 at 120 SRX per dollar, not USDC's decimals or feed
    expect(qUsdc).to.equal(E(100 * 120));
  });

  it("C4: quoteStable reverts CurrencyDisabled for a coin the round does not accept (disabled, unknown or zero), as the purchase does", async function () {
    const { r, admin, i1, usdc, usdt, wbtc } = await presale({ usdcDisabled: true, usdtDecimals: 18 });
    await approveBuyers(r, admin, [i1]);
    await expect(r.quoteStable(usdc.target, U6(100), i1.address)).to.be.revertedWithCustomError(r, "CurrencyDisabled");
    await expect(r.quoteStable(ZERO, U6(100), i1.address)).to.be.revertedWithCustomError(r, "CurrencyDisabled");
    await expect(r.quoteStable(wbtc.target, 1n, i1.address)).to.be.revertedWithCustomError(r, "CurrencyDisabled");
    await expect(r.connect(i1).investWithUSDC(U6(100))).to.be.revertedWithCustomError(r, "CurrencyDisabled");
    // The enabled coin quotes what it buys (18 decimals, the 10^12-too-high case before the fix).
    const amt = 100n * 10n ** 18n;
    const q = await r.quoteStable(usdt.target, amt, i1.address);
    await r.connect(i1).investWithUSDT(amt);
    expect(q).to.equal(E(12_000));
    expect((await r.investors(i1.address)).srxAllocation).to.equal(q);

    // And the other way round: USDT disabled, USDC enabled.
    const s2 = await presale({ usdtDisabled: true });
    await expect(s2.r.quoteStable(s2.usdt.target, U6(100), s2.i1.address)).to.be.revertedWithCustomError(s2.r, "CurrencyDisabled");
    expect(await s2.r.quoteStable(s2.usdc.target, U6(100), s2.i1.address)).to.equal(E(12_000));
  });

  it("C6: removeInvestor works after finalize for a wire buyer; an on-chain payer is still HasOnChainPayment and a deployed vault is still VaultAlreadyDeployed", async function () {
    const { r, token, admin, i1, i2, i3 } = await presale();
    await approveBuyers(r, admin, [i1, i2, i3]);
    await r.connect(admin).addInvestor(i1.address, usd(10_000));  // wire buyer
    await r.connect(admin).addInvestor(i3.address, usd(10_000));  // wire buyer
    await r.connect(i2).investWithUSDC(U6(10_000));               // on-chain buyer
    await r.connect(admin).finalize();                            // before launch Step 3

    // Late KYC failure: the wire buyer is removed after the round closed.
    const before = await r.totalAllocated();
    await r.connect(admin).removeInvestor(i1.address);
    expect((await r.investors(i1.address)).srxAllocation).to.equal(0n);
    expect(await r.totalAllocated()).to.equal(before - E(10_000 * 120));
    expect(await r.getInvestorList()).to.not.include(i1.address);
    // The on-chain payer is still refunded, not removed.
    await expect(r.connect(admin).removeInvestor(i2.address))
      .to.be.revertedWithCustomError(r, "HasOnChainPayment").withArgs(i2.address);
    // Once their vault exists, a buyer can no longer be removed.
    await token.connect(admin).transfer(r.target, await r.totalAllocated());
    await r.connect(admin).deployVault(i3.address);
    await expect(r.connect(admin).removeInvestor(i3.address)).to.be.revertedWithCustomError(r, "VaultAlreadyDeployed");
  });
});
