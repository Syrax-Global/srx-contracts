// Three external reports to security@ (3–4 Oct 2026), triaged by Syrax Security on 7 Oct
// (bus 20261007T0522Z) from the reports' descriptions — no reporter code was run. The harness
// below is Security's; each attack is now asserted to FAIL against the fixed contracts, and
// each verdict keeps a control showing the test could have gone the other way.
//
// ⛔ PRIVATE until the fix is merged: this file describes the exploit. The public mirror
//    (srx-contracts) is not synced with it until then.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (n) => ethers.parseUnits(String(n), 18);
const HUB = 40161, SPOKE = 40102;
const DAY = 24 * 3600;
const b32 = (a) => ethers.zeroPadValue(a, 32);
// OFTMsgCodec: abi.encodePacked(bytes32 to, uint64 amountSD); shared decimals 6 -> divide by 1e12.
const msgTo = (to, amountLD) => ethers.concat([b32(to), ethers.toBeHex(amountLD / 10n ** 12n, 8)]);
const fee = { nativeFee: 0n, lzTokenFee: 0n };

async function impersonate(addr) {
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  await ethers.provider.send("hardhat_setBalance", [addr, "0x21e19e0c9bab2400000"]);
  return ethers.getSigner(addr);
}

async function hubAndSpoke() {
  const [admin, alice, attacker, recipient, treasury, guardian] = await ethers.getSigners();
  const Ep = await ethers.getContractFactory("MockLZEndpoint");
  const hubEp = await Ep.deploy(HUB);
  const spokeEp = await Ep.deploy(SPOKE);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await hubEp.getAddress(), admin.address);
  const native = await (await ethers.getContractFactory("SRXOFTNative"))
    .deploy(await spokeEp.getAddress(), admin.address, HUB, await token.getAddress());
  await token.connect(admin).genesis(admin.address);
  await token.connect(admin).setPeer(SPOKE, b32(await native.getAddress()));
  await native.connect(admin).setPeer(HUB, b32(await token.getAddress()));
  const hubEpS = await impersonate(await hubEp.getAddress());
  const spokeEpS = await impersonate(await spokeEp.getAddress());
  let n = 0;
  // Deliver a message as the destination chain's endpoint would (the mock endpoint does not relay).
  const onSpoke = (senderB32, to, amt) => native.connect(spokeEpS).lzReceive(
    { srcEid: HUB, sender: senderB32, nonce: ++n }, ethers.ZeroHash, msgTo(to, amt), ethers.ZeroAddress, "0x");
  const onHub = (to, amt, nonce = ++n) => token.connect(hubEpS).lzReceive(
    { srcEid: SPOKE, sender: b32(native.target), nonce }, ethers.ZeroHash, msgTo(to, amt), ethers.ZeroAddress, "0x");
  const sp = (dstEid, to, amt) => ({ dstEid, to: b32(to), amountLD: amt, minAmountLD: amt, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" });
  return { admin, alice, attacker, recipient, treasury, guardian, token, native, onSpoke, onHub, sp };
}

// Alice genuinely bridges 1,000,000 SRX to the spoke.
async function aliceOnSpoke(ctx) {
  const { admin, alice, token, onSpoke, sp } = ctx;
  await token.connect(admin).transfer(alice.address, E(1_000_000));
  await token.connect(alice).send(sp(SPOKE, alice.address, E(1_000_000)), fee, alice.address);
  await onSpoke(b32(token.target), alice.address, E(1_000_000));
}

describe("Security triage 2026-10 — report A: bridge returns (FIXED, disclosure A)", function () {
  it("A1 the reported attack is refused at its first step: the spoke's hub peer cannot be repointed", async function () {
    const ctx = await hubAndSpoke();
    const { admin, attacker, native } = ctx;
    await aliceOnSpoke(ctx);
    await expect(native.connect(admin).setPeer(HUB, b32(attacker.address)))
      .to.be.revertedWithCustomError(native, "PeerNotHub");
    // Zero (freeze) and the real hub remain allowed: incident step 5 still works.
    await native.connect(admin).setPeer(HUB, ethers.ZeroHash);
    await native.connect(admin).setPeer(HUB, b32(ctx.token.target));
  });

  it("A2 a forged mint that reaches the spoke anyway (compromised DVN/delegate) is capped at the daily limit on return", async function () {
    const ctx = await hubAndSpoke();
    const { admin, attacker, token, native, onSpoke, onHub, sp } = ctx;
    await aliceOnSpoke(ctx);
    await token.connect(admin).setInboundLimit(SPOKE, E(100_000));

    // A forged message from the genuine hub address mints 600,000 on the spoke.
    await onSpoke(b32(token.target), attacker.address, E(600_000));
    await native.connect(attacker).send(sp(HUB, attacker.address, E(600_000)), fee, attacker.address);

    // Ethereum refuses all of it in one go...
    await expect(onHub(attacker.address, E(600_000)))
      .to.be.revertedWithCustomError(token, "InboundLimitExceeded").withArgs(SPOKE, E(600_000), E(100_000));
    // ...and at most one day's limit can come back before anyone reacts.
    await onHub(attacker.address, E(100_000));
    // The bucket refills about 1.2 SRX per second at this limit, so 1,000 SRX more is refused.
    await expect(onHub(attacker.address, E(1_000))).to.be.revertedWithCustomError(token, "InboundLimitExceeded");
    expect(await token.balanceOf(attacker.address)).to.equal(E(100_000));
  });

  it("A3 once the guardian freezes the spoke, nothing more comes back — and only governance lifts it", async function () {
    const ctx = await hubAndSpoke();
    const { admin, alice, guardian, token, native, onHub, sp } = ctx;
    await aliceOnSpoke(ctx);
    await token.connect(admin).setInboundLimit(SPOKE, E(1_000_000));

    // GuardianModule holds the token's PAUSER_ROLE after hand-over; the guardian multisig freezes through it.
    const gm = await (await ethers.getContractFactory("GuardianModule"))
      .deploy(admin.address, guardian.address, admin.address, 180 * DAY);
    await gm.connect(admin).registerModule(await gm.MODULE_TOKEN(), token.target);
    await token.connect(admin).grantRole(await token.PAUSER_ROLE(), gm.target);
    await expect(gm.connect(alice).freezeBridgeInbound(SPOKE, "x")).to.be.reverted; // not the guardian
    await gm.connect(guardian).freezeBridgeInbound(SPOKE, "spoke owner compromise suspected");
    expect(await token.inboundFrozen(SPOKE)).to.equal(true);

    await native.connect(alice).send(sp(HUB, alice.address, E(1_000)), fee, alice.address);
    const nonce = 900;
    await expect(onHub(alice.address, E(1_000), nonce)).to.be.revertedWithCustomError(token, "InboundChainFrozen");

    // The guardian (PAUSER) cannot lift it; governance can, and the same message then goes through
    // (LayerZero V2 keeps a reverted message verified and retryable).
    await expect(token.connect(guardian).unfreezeInbound(SPOKE)).to.be.reverted;
    await token.connect(admin).unfreezeInbound(SPOKE);
    await onHub(alice.address, E(1_000), nonce);
    expect(await token.balanceOf(alice.address)).to.equal(E(1_000));
  });

  it("A4 a real return delayed by the limit is delivered once the window rolls over", async function () {
    const ctx = await hubAndSpoke();
    const { admin, alice, token, native, onHub, sp } = ctx;
    await aliceOnSpoke(ctx);
    await token.connect(admin).setInboundLimit(SPOKE, E(400_000));
    await native.connect(alice).send(sp(HUB, alice.address, E(400_000)), fee, alice.address);
    await native.connect(alice).send(sp(HUB, alice.address, E(400_000)), fee, alice.address);
    await onHub(alice.address, E(400_000), 1001);
    await expect(onHub(alice.address, E(400_000), 1002)).to.be.revertedWithCustomError(token, "InboundLimitExceeded");
    await time.increase(DAY);
    await onHub(alice.address, E(400_000), 1002); // the retry
    expect(await token.balanceOf(alice.address)).to.equal(E(800_000));
    expect(await token.outstandingByEid(SPOKE)).to.equal(E(200_000));
  });

  it("A7 no burst across a reset: a full limit just before and another just after is refused (draining bucket)", async function () {
    // ⛔ With the first, fixed-window version a dust return started a 24-hour window;
    //    the full limit just before it ended and again just after it reset brought back
    //    twice the limit within seconds (internal review, 7 Oct 2026). Now at most the
    //    limit is in flight at once, draining smoothly.
    const ctx = await hubAndSpoke();
    const { admin, attacker, token, native, onSpoke, onHub, sp } = ctx;
    await aliceOnSpoke(ctx);
    const L = E(100_000);
    await token.connect(admin).setInboundLimit(SPOKE, L);
    await onSpoke(b32(token.target), attacker.address, E(300_000)); // forged, as in A2
    await native.connect(attacker).send(sp(HUB, attacker.address, E(300_000)), fee, attacker.address);

    await onHub(attacker.address, 1n * 10n ** 12n, 2001);         // T0: dust
    await time.increase(DAY - 3);
    await onHub(attacker.address, L - E(10), 2002);              // just before T0 + 24h
    await time.increase(2);
    await expect(onHub(attacker.address, L, 2003))               // just after T0 + 24h
      .to.be.revertedWithCustomError(token, "InboundLimitExceeded");
    // What can come back is only what has drained since: a few SRX, not another limit.
    expect(await token.inboundAvailable(SPOKE)).to.be.lt(E(20));
    // A full day later the bucket has drained and a full limit fits again.
    await time.increase(DAY);
    expect(await token.inboundAvailable(SPOKE)).to.equal(L);
  });

  it("A5 fails closed: a chain with no limit returns nothing, even when fully backed", async function () {
    const ctx = await hubAndSpoke();
    const { alice, token, native, onHub, sp } = ctx;
    await aliceOnSpoke(ctx);
    await native.connect(alice).send(sp(HUB, alice.address, E(1)), fee, alice.address);
    await expect(onHub(alice.address, E(1))).to.be.revertedWithCustomError(token, "InboundLimitExceeded").withArgs(SPOKE, E(1), 0n);
  });

  it("A6 the limit is governance's; the freeze is the pauser's; the unfreeze is governance's", async function () {
    const { admin, alice, token } = await hubAndSpoke();
    await expect(token.connect(alice).setInboundLimit(SPOKE, 1n)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    await expect(token.connect(alice).freezeInbound(SPOKE)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    await expect(token.connect(alice).unfreezeInbound(SPOKE)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    await expect(token.connect(admin).setInboundLimit(SPOKE, E(5))).to.emit(token, "InboundLimitSet").withArgs(SPOKE, E(5));
    await expect(token.connect(admin).freezeInbound(SPOKE)).to.emit(token, "InboundFrozenSet").withArgs(SPOKE, true);
    await expect(token.connect(admin).unfreezeInbound(SPOKE)).to.emit(token, "InboundFrozenSet").withArgs(SPOKE, false);

    // A holder of PAUSER_ROLE alone can freeze but never lift: a compromised pauser cannot undo a freeze.
    await token.connect(admin).grantRole(await token.PAUSER_ROLE(), alice.address);
    await token.connect(alice).freezeInbound(SPOKE);
    await expect(token.connect(alice).unfreezeInbound(SPOKE)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    expect(await token.inboundFrozen(SPOKE)).to.equal(true);
  });

  it("A-control: the backing check still applies within the limit — never more than was sent", async function () {
    const ctx = await hubAndSpoke();
    const { admin, attacker, token, onHub } = ctx;
    await aliceOnSpoke(ctx);
    await token.connect(admin).setInboundLimit(SPOKE, E(10_000_000));
    await expect(onHub(attacker.address, E(1_000_001))).to.be.revertedWithCustomError(token, "UnbackedInboundCredit");
  });
});

describe("Security triage 2026-10 — report B: rescueTokens vs launch protection (FIXED)", function () {
  async function stuck() {
    const ctx = await hubAndSpoke();
    const { admin, token, onHub } = ctx;
    // review round 22 Oct (A3): a plain transfer to the token's own address is refused now, so the
    // stuck SRX arrives the one way left: a bridge credit (a mint) addressed to the token itself.
    await aliceOnSpoke(ctx);
    await token.connect(admin).setInboundLimit(SPOKE, E(10_000_000));
    await onHub(token.target, E(100_000));                           // credited to the token, before limits
    await token.connect(admin).setMaxTransferAmount(E(50_000));     // launch protection switched on
    return ctx;
  }

  it("B1 the token contract is exempt from launch limits from deployment", async function () {
    const { token } = await hubAndSpoke();
    expect(await token.isExemptFromLimits(token.target)).to.equal(true);
  });

  it("B2 rescuing 100,000 SRX to a NON-exempt recipient now succeeds under a 50,000 cap", async function () {
    const { admin, recipient, token } = await stuck();
    await token.connect(admin).rescueTokens(token.target, recipient.address, E(100_000));
    expect(await token.balanceOf(recipient.address)).to.equal(E(100_000));
    expect(await token.balanceOf(token.target)).to.equal(0n);
  });

  it("B-control: the cap still applies to ordinary transfers between non-exempt wallets", async function () {
    const { admin, alice, recipient, token } = await stuck();
    await token.connect(admin).setExemptFromLimits(admin.address, true); // to fund alice above the cap
    await token.connect(admin).transfer(alice.address, E(60_000));
    await expect(token.connect(alice).transfer(recipient.address, E(60_000)))
      .to.be.revertedWithCustomError(token, "TransferExceedsMaxAmount");
  });
});

describe("Security triage 2026-10 — report C: buyAndBurn while paused (by design)", function () {
  it("C1 buyAndBurn reverts while the token is paused, and works again after unpause (control)", async function () {
    const { admin, token } = await hubAndSpoke();
    await token.connect(admin).grantRole(await token.BURN_ROLE(), admin.address);
    await token.connect(admin).pause();
    await expect(token.connect(admin).buyAndBurn(E(1))).to.be.revertedWithCustomError(token, "EnforcedPause");
    await token.connect(admin).unpause();
    await token.connect(admin).buyAndBurn(E(1));
    expect(await token.totalBurned()).to.equal(E(1));
  });

  it("C2 while paused a buyback could not acquire SRX anyway — every transfer reverts", async function () {
    const { admin, alice, token } = await hubAndSpoke();
    await token.connect(admin).pause();
    await expect(token.connect(admin).transfer(alice.address, E(1))).to.be.revertedWithCustomError(token, "EnforcedPause");
  });

  it("C3 the quoted comment is about ADMIN controls: setPeer and the inbound freeze still work while paused", async function () {
    const { admin, token } = await hubAndSpoke();
    await token.connect(admin).pause();
    await token.connect(admin).setPeer(SPOKE, ethers.ZeroHash);   // the runbook's freeze-the-bridge step
    expect(await token.peers(SPOKE)).to.equal(ethers.ZeroHash);
    await token.connect(admin).freezeInbound(SPOKE);
    expect(await token.inboundFrozen(SPOKE)).to.equal(true);
  });
});
