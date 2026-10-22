/**
 * Bridge integration: SRXToken (Ethereum hub) and SRXOFTNative (a spoke) exchanging
 * the messages they actually produce.
 *
 * ⛔ Until 8 Oct 2026 this whole file was skipped (it needed a LayerZero test package
 *    nobody installed), while REMEDIATION.md cited it as proof of disclosure A's fix
 *    (internal review, 7 Oct). It now runs on the repo's own MockLZEndpoint: each
 *    endpoint records the message an OFT send produced (MockSent), and relay() delivers
 *    those exact bytes to the other chain the way LayerZero's executor would — by the
 *    destination endpoint calling lzReceive. Nothing is rebuilt by hand.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ETH_EID = 40161; // Sepolia (hub)
const BSC_EID = 40102; // BSC testnet (spoke)
const E = (n) => ethers.parseUnits(String(n), 18);
const b32 = (a) => ethers.zeroPadValue(a, 32);
const fee = { nativeFee: 0n, lzTokenFee: 0n };

async function impersonate(addr) {
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  await ethers.provider.send("hardhat_setBalance", [addr, "0x21e19e0c9bab2400000"]);
  return ethers.getSigner(addr);
}

async function deployBridgeFixture() {
  const [admin, user, recipient] = await ethers.getSigners();
  const Ep = await ethers.getContractFactory("MockLZEndpoint");
  const ethEndpoint = await Ep.deploy(ETH_EID);
  const bscEndpoint = await Ep.deploy(BSC_EID);
  const ethToken = await (await ethers.getContractFactory("SRXToken")).deploy(await ethEndpoint.getAddress(), admin.address);
  await ethToken.connect(admin).genesis(admin.address);
  const bscToken = await (await ethers.getContractFactory("SRXOFTNative"))
    .deploy(await bscEndpoint.getAddress(), admin.address, ETH_EID, await ethToken.getAddress());
  await ethToken.connect(admin).setPeer(BSC_EID, b32(await bscToken.getAddress()));
  await bscToken.connect(admin).setPeer(ETH_EID, b32(await ethToken.getAddress()));
  await ethToken.connect(admin).setInboundLimit(BSC_EID, E(10_000_000)); // returns fail closed without a limit
  await ethToken.connect(admin).transfer(user.address, E(1_000_000));

  const chains = {
    [ETH_EID]: { endpoint: ethEndpoint, token: ethToken, signer: await impersonate(await ethEndpoint.getAddress()) },
    [BSC_EID]: { endpoint: bscEndpoint, token: bscToken, signer: await impersonate(await bscEndpoint.getAddress()) },
  };

  // Deliver the message a send transaction produced, as the destination chain's executor would.
  async function relay(sendTx) {
    const receipt = await sendTx.wait();
    const log = receipt.logs.find((l) => { try { return ethEndpoint.interface.parseLog(l)?.name === "MockSent"; } catch { return false; } });
    if (!log) throw new Error("no MockSent in that transaction");
    const sent = ethEndpoint.interface.parseLog(log);
    const srcEid = Number(await (await ethers.getContractAt("MockLZEndpoint", log.address)).eid());
    const dst = chains[Number(sent.args.dstEid)];
    return dst.token.connect(dst.signer).lzReceive(
      { srcEid, sender: b32(sent.args.sender), nonce: sent.args.nonce },
      sent.args.guid, sent.args.message, ethers.ZeroAddress, "0x");
  }

  const sp = (dstEid, to, amt) => ({ dstEid, to: b32(to), amountLD: amt, minAmountLD: amt, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" });
  return { ethToken, bscToken, admin, user, recipient, relay, sp };
}

describe("Bridge (OFT cross-chain, real messages relayed)", function () {
  describe("Supply integrity", function () {
    it("Ethereum -> spoke: burns on Ethereum, mints the same amount on the spoke, records it outstanding", async function () {
      const { ethToken, bscToken, user, recipient, relay, sp } = await loadFixture(deployBridgeFixture);
      const supplyBefore = await ethToken.totalSupply();
      await relay(await ethToken.connect(user).send(sp(BSC_EID, recipient.address, E(250_000)), fee, user.address));
      expect(await ethToken.totalSupply()).to.equal(supplyBefore - E(250_000));
      expect(await ethToken.balanceOf(user.address)).to.equal(E(750_000));
      expect(await bscToken.balanceOf(recipient.address)).to.equal(E(250_000));
      expect(await ethToken.outstandingByEid(BSC_EID)).to.equal(E(250_000));
    });

    it("global supply (Ethereum + spoke) is unchanged by a transfer", async function () {
      const { ethToken, bscToken, user, recipient, relay, sp } = await loadFixture(deployBridgeFixture);
      const before = (await ethToken.totalSupply()) + (await bscToken.totalSupply());
      await relay(await ethToken.connect(user).send(sp(BSC_EID, recipient.address, E(400_000)), fee, user.address));
      expect((await ethToken.totalSupply()) + (await bscToken.totalSupply())).to.equal(before);
      expect(before).to.equal(await ethToken.MAX_SUPPLY());
    });

    it("a round trip restores Ethereum's supply, empties the spoke and clears the outstanding amount", async function () {
      const { ethToken, bscToken, user, recipient, relay, sp } = await loadFixture(deployBridgeFixture);
      const initial = await ethToken.totalSupply();
      await relay(await ethToken.connect(user).send(sp(BSC_EID, recipient.address, E(300_000)), fee, user.address));
      await relay(await bscToken.connect(recipient).send(sp(ETH_EID, user.address, E(300_000)), fee, recipient.address));
      expect(await ethToken.totalSupply()).to.equal(initial);
      expect(await bscToken.totalSupply()).to.equal(0n);
      expect(await ethToken.outstandingByEid(BSC_EID)).to.equal(0n);
      expect(await ethToken.balanceOf(user.address)).to.equal(E(1_000_000));
    });
  });

  describe("Returns to Ethereum (disclosure A)", function () {
    it("a return above the daily limit is refused, and the same message delivers once the limit allows", async function () {
      const { ethToken, bscToken, admin, user, recipient, relay, sp } = await loadFixture(deployBridgeFixture);
      await relay(await ethToken.connect(user).send(sp(BSC_EID, recipient.address, E(500_000)), fee, user.address));
      await ethToken.connect(admin).setInboundLimit(BSC_EID, E(100_000));
      const back = await bscToken.connect(recipient).send(sp(ETH_EID, user.address, E(200_000)), fee, recipient.address);
      await expect(relay(back)).to.be.revertedWithCustomError(ethToken, "InboundLimitExceeded");
      await ethToken.connect(admin).setInboundLimit(BSC_EID, E(10_000_000));
      await relay(back);
      expect(await ethToken.balanceOf(user.address)).to.equal(E(700_000));
    });

    it("with no limit set, every return is refused (fail closed); control: a limit lets it through", async function () {
      const { ethToken, bscToken, admin, user, recipient, relay, sp } = await loadFixture(deployBridgeFixture);
      await relay(await ethToken.connect(user).send(sp(BSC_EID, recipient.address, E(1_000)), fee, user.address));
      await ethToken.connect(admin).setInboundLimit(BSC_EID, 0n);
      const back = await bscToken.connect(recipient).send(sp(ETH_EID, user.address, E(1)), fee, recipient.address);
      await expect(relay(back)).to.be.revertedWithCustomError(ethToken, "InboundLimitExceeded");
      await ethToken.connect(admin).setInboundLimit(BSC_EID, E(1));
      await relay(back);
    });

    it("a frozen chain's return is refused until governance lifts the freeze", async function () {
      const { ethToken, bscToken, admin, user, recipient, relay, sp } = await loadFixture(deployBridgeFixture);
      await relay(await ethToken.connect(user).send(sp(BSC_EID, recipient.address, E(1_000)), fee, user.address));
      await ethToken.connect(admin).grantRole(await ethToken.PAUSER_ROLE(), admin.address);
      await ethToken.connect(admin).freezeInbound(BSC_EID);
      const back = await bscToken.connect(recipient).send(sp(ETH_EID, user.address, E(1_000)), fee, recipient.address);
      await expect(relay(back)).to.be.revertedWithCustomError(ethToken, "InboundChainFrozen");
      await ethToken.connect(admin).unfreezeInbound(BSC_EID);
      await relay(back);
      expect(await ethToken.outstandingByEid(BSC_EID)).to.equal(0n);
    });
  });

  describe("Paused state", function () {
    it("blocks a send while Ethereum's token is paused; control: it works after unpause", async function () {
      const { ethToken, admin, user, recipient, relay, sp } = await loadFixture(deployBridgeFixture);
      await ethToken.connect(admin).grantRole(await ethToken.PAUSER_ROLE(), admin.address);
      await ethToken.connect(admin).pause();
      await expect(ethToken.connect(user).send(sp(BSC_EID, recipient.address, E(1)), fee, user.address))
        .to.be.revertedWithCustomError(ethToken, "EnforcedPause");
      await ethToken.connect(admin).unpause();
      await relay(await ethToken.connect(user).send(sp(BSC_EID, recipient.address, E(1)), fee, user.address));
    });
  });
});
