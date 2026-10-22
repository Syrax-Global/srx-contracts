// Gap-closing tests for the token and the bridge (SRXToken hub, SRXOFTNative spoke).
// Harness follows test/security-triage-2026-10.test.js: a hub and spoke(s) on MockLZEndpoint,
// with the endpoint impersonated to deliver lzReceive (the mock does not relay).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySpokeTimelock, handoverSpoke, finalizeSpoke } = require("../scripts/deploy/lib/spokeOps");

const E = (n) => ethers.parseUnits(String(n), 18);
const HUB = 40161, SPOKE = 40102, SPOKE_B = 40106;
const b32 = (a) => ethers.zeroPadValue(a, 32);
// OFTMsgCodec: abi.encodePacked(bytes32 to, uint64 amountSD); shared decimals 6 -> divide by 1e12.
const msgTo = (to, amountLD) => ethers.concat([b32(to), ethers.toBeHex(amountLD / 10n ** 12n, 8)]);
const fee = { nativeFee: 0n, lzTokenFee: 0n };
const sp = (dstEid, to, amt) => ({ dstEid, to: b32(to), amountLD: amt, minAmountLD: amt, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" });

async function impersonate(addr) {
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  await ethers.provider.send("hardhat_setBalance", [addr, "0x21e19e0c9bab2400000"]);
  return ethers.getSigner(addr);
}

// One hub and one spoke; alice genuinely bridges `bridged` SRX to the spoke.
async function hubAndSpoke(bridged = 1_000_000) {
  const [admin, alice, bob, attacker, recipient] = await ethers.getSigners();
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

  const hubMsg = (to, amt, nonce = 1, sender = b32(native.target), srcEid = SPOKE) =>
    [{ srcEid, sender, nonce }, ethers.ZeroHash, msgTo(to, amt), ethers.ZeroAddress, "0x"];
  const spokeMsg = (to, amt, nonce = 1, sender = b32(token.target), srcEid = HUB) =>
    [{ srcEid, sender, nonce }, ethers.ZeroHash, msgTo(to, amt), ethers.ZeroAddress, "0x"];
  const onHub = (to, amt, nonce = 1) => token.connect(hubEpS).lzReceive(...hubMsg(to, amt, nonce));
  const onSpoke = (to, amt, nonce = 1) => native.connect(spokeEpS).lzReceive(...spokeMsg(to, amt, nonce));

  if (bridged) {
    await token.connect(admin).transfer(alice.address, E(bridged));
    await token.connect(alice).send(sp(SPOKE, alice.address, E(bridged)), fee, alice.address);
    await onSpoke(alice.address, E(bridged), 1);
  }
  return { admin, alice, bob, attacker, recipient, token, native, hubEp, spokeEp, hubEpS, spokeEpS, hubMsg, spokeMsg, onHub, onSpoke };
}

describe("Gaps — lzReceive authentication (T1)", function () {
  it("T1a hub: a non-endpoint caller reverts OnlyEndpoint; the endpoint with the right peer succeeds (control)", async function () {
    const { admin, alice, attacker, token, hubMsg, onHub } = await hubAndSpoke();
    await token.connect(admin).setInboundLimit(SPOKE, E(1_000_000));
    await expect(token.connect(attacker).lzReceive(...hubMsg(attacker.address, E(10))))
      .to.be.revertedWithCustomError(token, "OnlyEndpoint").withArgs(attacker.address);
    const before = await token.balanceOf(alice.address);
    await onHub(alice.address, E(10));
    expect(await token.balanceOf(alice.address)).to.equal(before + E(10));
  });

  it("T1b hub: a message from a sender that is not the peer reverts OnlyPeer; the real peer succeeds (control)", async function () {
    const { admin, alice, attacker, token, native, hubEpS, hubMsg } = await hubAndSpoke();
    await token.connect(admin).setInboundLimit(SPOKE, E(1_000_000));
    const fake = b32(attacker.address);
    await expect(token.connect(hubEpS).lzReceive(...hubMsg(attacker.address, E(10), 1, fake)))
      .to.be.revertedWithCustomError(token, "OnlyPeer").withArgs(SPOKE, fake);
    await token.connect(hubEpS).lzReceive(...hubMsg(alice.address, E(10), 1, b32(native.target)));
    expect(await token.balanceOf(alice.address)).to.equal(E(10));
  });

  it("T1c hub: a message from an eid with no peer reverts NoPeer; the configured eid succeeds (control)", async function () {
    const { admin, alice, attacker, token, native, hubEpS, hubMsg } = await hubAndSpoke();
    await token.connect(admin).setInboundLimit(SPOKE, E(1_000_000));
    const unknownEid = 55555;
    await expect(token.connect(hubEpS).lzReceive(...hubMsg(attacker.address, E(10), 1, b32(native.target), unknownEid)))
      .to.be.revertedWithCustomError(token, "NoPeer").withArgs(unknownEid);
    await token.connect(hubEpS).lzReceive(...hubMsg(alice.address, E(10)));
    expect(await token.balanceOf(alice.address)).to.equal(E(10));
  });

  it("T1d spoke: a non-endpoint caller reverts OnlyEndpoint; the endpoint with the right peer succeeds (control)", async function () {
    const { alice, attacker, native, spokeMsg, onSpoke } = await hubAndSpoke(0);
    await expect(native.connect(attacker).lzReceive(...spokeMsg(attacker.address, E(10))))
      .to.be.revertedWithCustomError(native, "OnlyEndpoint").withArgs(attacker.address);
    expect(await native.balanceOf(attacker.address)).to.equal(0n);
    await onSpoke(alice.address, E(10));
    expect(await native.balanceOf(alice.address)).to.equal(E(10));
  });

  it("T1e spoke: a sender that is not the peer reverts OnlyPeer; an eid with no peer reverts NoPeer", async function () {
    const { alice, attacker, token, native, spokeEpS, spokeMsg } = await hubAndSpoke(0);
    const fake = b32(attacker.address);
    await expect(native.connect(spokeEpS).lzReceive(...spokeMsg(attacker.address, E(10), 1, fake)))
      .to.be.revertedWithCustomError(native, "OnlyPeer").withArgs(HUB, fake);
    const unknownEid = 55555;
    await expect(native.connect(spokeEpS).lzReceive(...spokeMsg(attacker.address, E(10), 1, b32(token.target), unknownEid)))
      .to.be.revertedWithCustomError(native, "NoPeer").withArgs(unknownEid);
    // Control: the hub, from the real peer address, is accepted.
    await native.connect(spokeEpS).lzReceive(...spokeMsg(alice.address, E(10)));
    expect(await native.balanceOf(alice.address)).to.equal(E(10));
  });
});

describe("Gaps — pause stops bridging both ways (T2)", function () {
  it("T2a hub: send() and an inbound credit revert EnforcedPause while paused; both work after unpause", async function () {
    const { admin, alice, token, onHub } = await hubAndSpoke();
    await token.connect(admin).setInboundLimit(SPOKE, E(1_000_000));
    await token.connect(admin).transfer(alice.address, E(500));
    await token.connect(admin).pause();

    await expect(token.connect(alice).send(sp(SPOKE, alice.address, E(100)), fee, alice.address))
      .to.be.revertedWithCustomError(token, "EnforcedPause");
    await expect(onHub(alice.address, E(100), 7)).to.be.revertedWithCustomError(token, "EnforcedPause");
    // Nothing moved while paused.
    expect(await token.outstandingByEid(SPOKE)).to.equal(E(1_000_000));

    await token.connect(admin).unpause();
    await token.connect(alice).send(sp(SPOKE, alice.address, E(100)), fee, alice.address);
    expect(await token.outstandingByEid(SPOKE)).to.equal(E(1_000_100));
    const before = await token.balanceOf(alice.address);
    await onHub(alice.address, E(100), 7); // the SAME message is delivered after unpause
    expect(await token.balanceOf(alice.address)).to.equal(before + E(100));
  });

  it("T2b spoke: send() and an inbound credit revert EnforcedPause while paused; both work after unpause", async function () {
    const { admin, alice, native, onSpoke } = await hubAndSpoke();
    await native.connect(admin).pause();

    await expect(native.connect(alice).send(sp(HUB, alice.address, E(100)), fee, alice.address))
      .to.be.revertedWithCustomError(native, "EnforcedPause");
    await expect(onSpoke(alice.address, E(100), 9)).to.be.revertedWithCustomError(native, "EnforcedPause");
    expect(await native.balanceOf(alice.address)).to.equal(E(1_000_000));

    await native.connect(admin).unpause();
    await native.connect(alice).send(sp(HUB, alice.address, E(100)), fee, alice.address);
    expect(await native.balanceOf(alice.address)).to.equal(E(999_900));
    await onSpoke(alice.address, E(100), 9);
    expect(await native.balanceOf(alice.address)).to.equal(E(1_000_000));
  });
});

describe("Gaps — one spoke's freeze is contained (T3)", function () {
  it("T3 freezing spoke A's inbound leaves spoke B's returns and ordinary hub transfers working", async function () {
    const [admin, alice, bob] = await ethers.getSigners();
    const Ep = await ethers.getContractFactory("MockLZEndpoint");
    const hubEp = await Ep.deploy(HUB);
    const epA = await Ep.deploy(SPOKE);
    const epB = await Ep.deploy(SPOKE_B);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await hubEp.getAddress(), admin.address);
    const Native = await ethers.getContractFactory("SRXOFTNative");
    const nativeA = await Native.deploy(await epA.getAddress(), admin.address, HUB, await token.getAddress());
    const nativeB = await Native.deploy(await epB.getAddress(), admin.address, HUB, await token.getAddress());
    await token.connect(admin).genesis(admin.address);
    await token.connect(admin).setPeer(SPOKE, b32(await nativeA.getAddress()));
    await token.connect(admin).setPeer(SPOKE_B, b32(await nativeB.getAddress()));
    await nativeA.connect(admin).setPeer(HUB, b32(await token.getAddress()));
    await nativeB.connect(admin).setPeer(HUB, b32(await token.getAddress()));
    const hubEpS = await impersonate(await hubEp.getAddress());
    const epAS = await impersonate(await epA.getAddress());
    const epBS = await impersonate(await epB.getAddress());

    // Alice bridges 1,000 to each spoke.
    await token.connect(admin).transfer(alice.address, E(2_000));
    await token.connect(alice).send(sp(SPOKE, alice.address, E(1_000)), fee, alice.address);
    await token.connect(alice).send(sp(SPOKE_B, alice.address, E(1_000)), fee, alice.address);
    const toSpoke = (native, epS, nonce) => native.connect(epS).lzReceive(
      { srcEid: HUB, sender: b32(token.target), nonce }, ethers.ZeroHash, msgTo(alice.address, E(1_000)), ethers.ZeroAddress, "0x");
    await toSpoke(nativeA, epAS, 1);
    await toSpoke(nativeB, epBS, 1);
    await token.connect(admin).setInboundLimit(SPOKE, E(1_000));
    await token.connect(admin).setInboundLimit(SPOKE_B, E(1_000));

    const back = async (native, eid, nonce) => {
      await native.connect(alice).send(sp(HUB, alice.address, E(300)), fee, alice.address);
      return token.connect(hubEpS).lzReceive(
        { srcEid: eid, sender: b32(native.target), nonce }, ethers.ZeroHash, msgTo(alice.address, E(300)), ethers.ZeroAddress, "0x");
    };

    // Control: before the freeze, A's returns work.
    await back(nativeA, SPOKE, 10);
    expect(await token.outstandingByEid(SPOKE)).to.equal(E(700));

    await token.connect(admin).freezeInbound(SPOKE);
    expect(await token.inboundFrozen(SPOKE)).to.equal(true);
    expect(await token.inboundFrozen(SPOKE_B)).to.equal(false);

    await expect(back(nativeA, SPOKE, 11)).to.be.revertedWithCustomError(token, "InboundChainFrozen").withArgs(SPOKE);
    // B is untouched.
    const beforeB = await token.balanceOf(alice.address);
    await back(nativeB, SPOKE_B, 10);
    expect(await token.balanceOf(alice.address)).to.equal(beforeB + E(300));
    expect(await token.outstandingByEid(SPOKE_B)).to.equal(E(700));
    // Ordinary hub transfers are untouched.
    await token.connect(alice).transfer(bob.address, E(50));
    expect(await token.balanceOf(bob.address)).to.equal(E(50));
  });
});

describe("Gaps — buyAndBurn burns only the caller's own balance (T4)", function () {
  it("T4 B (BURN_ROLE) burns from B only: A's balance is unchanged, B's and totalSupply fall by the amount", async function () {
    const { admin, alice: A, bob: B, token } = await hubAndSpoke(0);
    await token.connect(admin).transfer(A.address, E(1_000));
    await token.connect(admin).transfer(B.address, E(1_000));
    // Control for the role gate: without BURN_ROLE, B cannot burn at all.
    await expect(token.connect(B).buyAndBurn(E(100)))
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    await token.connect(admin).grantRole(await token.BURN_ROLE(), B.address);

    const supplyBefore = await token.totalSupply();
    await expect(token.connect(B).buyAndBurn(E(400))).to.emit(token, "BuyAndBurn").withArgs(B.address, E(400));
    expect(await token.balanceOf(A.address)).to.equal(E(1_000));
    expect(await token.balanceOf(B.address)).to.equal(E(600));
    expect(await token.totalSupply()).to.equal(supplyBefore - E(400));
    expect(await token.totalBurned()).to.equal(E(400));
    // The function takes no address argument: B cannot name A's balance. Burning more than B holds fails
    // even though A holds plenty.
    await expect(token.connect(B).buyAndBurn(E(601))).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
  });
});

describe("Gaps — a single return above the limit waits for governance (T5)", function () {
  it("T5 reverts InboundLimitExceeded; after governance raises the limit the SAME message (same nonce) delivers", async function () {
    const { admin, alice, token, onHub } = await hubAndSpoke();
    await token.connect(admin).setInboundLimit(SPOKE, E(100));
    await expect(onHub(alice.address, E(500), 42))
      .to.be.revertedWithCustomError(token, "InboundLimitExceeded").withArgs(SPOKE, E(500), E(100));
    // Control: a return within the limit passes (nonce differs; a different message).
    await onHub(alice.address, E(100), 43);
    expect(await token.balanceOf(alice.address)).to.equal(E(100));

    // Only governance may raise it.
    await expect(token.connect(alice).setInboundLimit(SPOKE, E(1_000)))
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    await token.connect(admin).setInboundLimit(SPOKE, E(1_000));
    // The 100 already returned is still in flight, but the raised limit leaves room for 500.
    await onHub(alice.address, E(500), 42); // the SAME message, same nonce
    expect(await token.balanceOf(alice.address)).to.equal(E(600));
    expect(await token.outstandingByEid(SPOKE)).to.equal(E(1_000_000) - E(600));
  });
});

describe("Gaps — a spoke behind its own Timelock (T6)", function () {
  const DELAY = 172_800;

  async function handedOver() {
    const [deployer, safe, hub, stranger] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(SPOKE);
    const spoke = await (await ethers.getContractFactory("SRXOFTNative"))
      .deploy(await ep.getAddress(), safe.address, HUB, hub.address);
    await spoke.connect(safe).setPeer(HUB, b32(hub.address));
    const timelock = await deploySpokeTimelock({ deployer, safe: safe.address, minDelay: DELAY });
    const send = async (c, fn, args) => (await c.connect(safe)[fn](...args)).wait();
    await handoverSpoke({ spoke, timelock, send });
    await time.increase(DELAY + 1);
    await finalizeSpoke({ spoke, timelock, signer: deployer });
    return { safe, hub, stranger, spoke, timelock };
  }

  it("T6 the Timelock can schedule and, after the delay, execute setPeer(hubEid, 0); before the delay it reverts", async function () {
    const { safe, hub, stranger, spoke, timelock } = await handedOver();
    expect(await spoke.owner()).to.equal(await timelock.getAddress());
    expect(await spoke.peers(HUB)).to.equal(b32(hub.address));

    const data = spoke.interface.encodeFunctionData("setPeer", [HUB, ethers.ZeroHash]);
    const salt = ethers.id("T6:freeze-hub-peer");
    const target = await spoke.getAddress();

    // Only the Safe (proposer) may schedule.
    await expect(timelock.connect(stranger).schedule(target, 0, data, ethers.ZeroHash, salt, DELAY))
      .to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    await timelock.connect(safe).schedule(target, 0, data, ethers.ZeroHash, salt, DELAY);
    const id = await timelock.hashOperation(target, 0, data, ethers.ZeroHash, salt);
    expect(await timelock.isOperationPending(id)).to.equal(true);

    // Before the delay: refused, and the peer is unchanged.
    await expect(timelock.connect(stranger).execute(target, 0, data, ethers.ZeroHash, salt))
      .to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    expect(await spoke.peers(HUB)).to.equal(b32(hub.address));
    await time.increase(DELAY - 60);
    await expect(timelock.connect(stranger).execute(target, 0, data, ethers.ZeroHash, salt))
      .to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

    // After the delay anyone can execute it.
    await time.increase(120);
    await timelock.connect(stranger).execute(target, 0, data, ethers.ZeroHash, salt);
    expect(await spoke.peers(HUB)).to.equal(ethers.ZeroHash);
    expect(await timelock.isOperationDone(id)).to.equal(true);
  });
});
