/**
 * Bridge integration tests.
 *
 * LayerZero V2 cross-chain messaging requires their test harness (EndpointV2Mock)
 * which is available from @layerzerolabs/test-devtools-evm-hardhat.
 *
 * These tests simulate:
 *  1. Deploying SRXToken on "Ethereum" and SRXOFTNative on "BSC"
 *  2. Wiring them as peers via the mock endpoint
 *  3. Executing a cross-chain transfer (burn on ETH, mint on BSC)
 *  4. Verifying global supply integrity
 *
 * Install test helpers: npm install --save-dev @layerzerolabs/test-devtools-evm-hardhat
 *
 * If the test helpers are not installed, these tests are skipped gracefully.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

let EndpointV2Mock;
try {
  const lzTestHelpers = require("@layerzerolabs/test-devtools-evm-hardhat");
  EndpointV2Mock = lzTestHelpers.EndpointV2Mock;
} catch {
  EndpointV2Mock = null;
}

const SKIP_BRIDGE_TESTS = !EndpointV2Mock;

describe("Bridge (OFT Cross-Chain)", function () {

  if (SKIP_BRIDGE_TESTS) {
    it("SKIPPED — install @layerzerolabs/test-devtools-evm-hardhat to run bridge tests", function () {
      this.skip();
    });
    return;
  }

  const ETH_EID = 40161; // Sepolia
  const BSC_EID = 40102; // BSC Testnet

  function addressToBytes32(addr) {
    return ethers.zeroPadValue(addr, 32);
  }

  async function deployBridgeFixture() {
    const [admin, user, recipient] = await ethers.getSigners();

    // ── Deploy mock LZ endpoints ─────────────────────────────────────────────
    const MockEndpoint = await ethers.getContractFactory("EndpointV2Mock");
    const ethEndpoint = await MockEndpoint.deploy(ETH_EID);
    const bscEndpoint = await MockEndpoint.deploy(BSC_EID);
    await ethEndpoint.waitForDeployment();
    await bscEndpoint.waitForDeployment();

    // ── Deploy SRXToken (ETH) ────────────────────────────────────────────────
    const SRXToken = await ethers.getContractFactory("SRXToken");
    const ethToken = await SRXToken.deploy(
      await ethEndpoint.getAddress(),
      admin.address
    );
    await ethToken.waitForDeployment();
    await ethToken.connect(admin).genesis(admin.address);

    // ── Deploy SRXOFTNative (BSC) ────────────────────────────────────────────
    const SRXOFTNative = await ethers.getContractFactory("SRXOFTNative");
    const bscToken = await SRXOFTNative.deploy(
      await bscEndpoint.getAddress(),
      admin.address
    );
    await bscToken.waitForDeployment();

    // ── Wire peers ───────────────────────────────────────────────────────────
    await ethToken.connect(admin).setPeer(BSC_EID, addressToBytes32(await bscToken.getAddress()));
    await bscToken.connect(admin).setPeer(ETH_EID, addressToBytes32(await ethToken.getAddress()));

    // ── Connect mock endpoints ───────────────────────────────────────────────
    await ethEndpoint.setDestLzEndpoint(await bscToken.getAddress(), await bscEndpoint.getAddress());
    await bscEndpoint.setDestLzEndpoint(await ethToken.getAddress(), await ethEndpoint.getAddress());

    // Fund user with tokens
    const sendAmount = ethers.parseUnits("1000000", 18);
    await ethToken.connect(admin).transfer(user.address, sendAmount);

    return { ethToken, bscToken, ethEndpoint, bscEndpoint, admin, user, recipient, sendAmount };
  }

  // ── Supply integrity ─────────────────────────────────────────────────────────

  describe("Supply integrity", function () {
    it("total supply on ETH decreases by sent amount after bridge", async function () {
      const { ethToken, bscToken, ethEndpoint, user, recipient, sendAmount } =
        await loadFixture(deployBridgeFixture);

      const supplyBefore = await ethToken.totalSupply();
      const userBalBefore = await ethToken.balanceOf(user.address);

      const sendParam = {
        dstEid: BSC_EID,
        to: addressToBytes32(recipient.address),
        amountLD: sendAmount,
        minAmountLD: sendAmount,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      };

      const [nativeFee] = await ethToken.quoteSend(sendParam, false);
      await ethToken.connect(user).send(sendParam, { nativeFee, lzTokenFee: 0n }, user.address, {
        value: nativeFee,
      });

      // ETH side: tokens burned
      expect(await ethToken.balanceOf(user.address)).to.equal(userBalBefore - sendAmount);
      expect(await ethToken.totalSupply()).to.equal(supplyBefore - sendAmount);

      // BSC side: tokens minted
      expect(await bscToken.balanceOf(recipient.address)).to.equal(sendAmount);
    });

    it("global supply (ETH + BSC) remains constant after bridge", async function () {
      const { ethToken, bscToken, user, recipient, sendAmount } =
        await loadFixture(deployBridgeFixture);

      const globalBefore = await ethToken.totalSupply() + await bscToken.totalSupply();

      const sendParam = {
        dstEid: BSC_EID,
        to: addressToBytes32(recipient.address),
        amountLD: sendAmount,
        minAmountLD: sendAmount,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      };

      const [nativeFee] = await ethToken.quoteSend(sendParam, false);
      await ethToken.connect(user).send(sendParam, { nativeFee, lzTokenFee: 0n }, user.address, {
        value: nativeFee,
      });

      const globalAfter = await ethToken.totalSupply() + await bscToken.totalSupply();
      expect(globalAfter).to.equal(globalBefore);
    });

    it("round-trip preserves supply (BSC back to ETH)", async function () {
      const { ethToken, bscToken, user, recipient, sendAmount } =
        await loadFixture(deployBridgeFixture);

      const initialSupply = await ethToken.totalSupply();

      // ETH → BSC
      const sendToBSC = {
        dstEid: BSC_EID,
        to: addressToBytes32(recipient.address),
        amountLD: sendAmount,
        minAmountLD: sendAmount,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      };
      const [fee1] = await ethToken.quoteSend(sendToBSC, false);
      await ethToken.connect(user).send(sendToBSC, { nativeFee: fee1, lzTokenFee: 0n }, user.address, {
        value: fee1,
      });

      // BSC → ETH
      const sendBackToETH = {
        dstEid: ETH_EID,
        to: addressToBytes32(user.address),
        amountLD: sendAmount,
        minAmountLD: sendAmount,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      };
      const [fee2] = await bscToken.quoteSend(sendBackToETH, false);
      await bscToken.connect(recipient).send(sendBackToETH, { nativeFee: fee2, lzTokenFee: 0n }, recipient.address, {
        value: fee2,
      });

      // After round-trip, ETH supply should be back to initial
      expect(await ethToken.totalSupply()).to.equal(initialSupply);
      expect(await bscToken.totalSupply()).to.equal(0n);
    });
  });

  // ── Paused bridging ──────────────────────────────────────────────────────────

  describe("Paused state", function () {
    it("blocks bridge send when token is paused", async function () {
      const { ethToken, admin, user, recipient, sendAmount } =
        await loadFixture(deployBridgeFixture);

      await ethToken.connect(admin).pause();

      const sendParam = {
        dstEid: BSC_EID,
        to: addressToBytes32(recipient.address),
        amountLD: sendAmount,
        minAmountLD: sendAmount,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      };

      const [nativeFee] = await ethToken.quoteSend(sendParam, false);
      await expect(
        ethToken.connect(user).send(sendParam, { nativeFee, lzTokenFee: 0n }, user.address, {
          value: nativeFee,
        })
      ).to.be.revertedWithCustomError(ethToken, "EnforcedPause");
    });
  });
});
