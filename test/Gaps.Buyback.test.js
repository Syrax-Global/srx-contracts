// Gap-closing tests for BuybackBurner swap mode: exact allowance, overspend, slippage floor, access control, pause.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("Gaps: BuybackBurner swap mode", function () {
  const CAP = 10n ** 12n;
  const SRX_OUT = ethers.parseUnits("500", 18);

  async function fixture() {
    const [admin, executor, stranger] = await ethers.getSigners();
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    const burner = await (await ethers.getContractFactory("BuybackBurner")).deploy(await token.getAddress(), admin.address);
    await token.connect(admin).grantRole(await token.BURN_ROLE(), await burner.getAddress());
    const EXECUTOR_ROLE = await burner.EXECUTOR_ROLE();
    await burner.connect(admin).grantRole(EXECUTOR_ROLE, executor.address);
    await token.connect(admin).genesis(admin.address);

    const mock = await (await ethers.getContractFactory("MockSwapRouter")).deploy();
    const probe = await (await ethers.getContractFactory("GapsSProbeRouter")).deploy();
    for (const r of [mock, probe]) await token.connect(admin).transfer(await r.getAddress(), ethers.parseUnits("10000", 18));

    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    await usdc.mint(await burner.getAddress(), 10_000_000_000n);

    const swapData = (router, tokenIn, pull, out = SRX_OUT) => router.interface.encodeFunctionData("swap", [
      tokenIn, pull, token.target, out, burner.target,
    ]);
    return { admin, executor, stranger, token, burner, usdc, mock, probe, EXECUTOR_ROLE, swapData };
  }

  async function ready(ctx, router, tokenIn) {
    const { admin, burner } = ctx;
    await burner.connect(admin).setSwapRouter(await router.getAddress());
    await burner.connect(admin).setSwapLimits(await (tokenIn ?? ctx.usdc).getAddress(), CAP, CAP);
  }

  // ── B1 ─────────────────────────────────────────────────────────────────────
  describe("B1: the router's allowance is exactly amountIn during the call and 0 after", function () {
    it("even with a leftover allowance pre-seeded, the router sees exactly amountIn (not leftover + amountIn); afterwards 0", async function () {
      const ctx = await loadFixture(fixture);
      const { executor, burner, probe, token } = ctx;
      const gat = await (await ethers.getContractFactory("GapsSAllowanceToken")).deploy();
      await gat.mint(await burner.getAddress(), 1_000_000_000n);
      await ready(ctx, probe, gat);
      const burnerAddr = await burner.getAddress();
      const probeAddr = await probe.getAddress();

      // Pre-seed a leftover allowance from the burner to the router, and prove it is there.
      const LEFTOVER = 555_000_000n;
      await gat.forceAllowance(burnerAddr, probeAddr, LEFTOVER);
      expect(await gat.allowance(burnerAddr, probeAddr)).to.equal(LEFTOVER);

      const amountIn = 100_000_000n;
      const pull = 60_000_000n; // the router pulls LESS than it was approved for
      const data = ctx.swapData(probe, await gat.getAddress(), pull);
      await expect(burner.connect(executor).buyAndBurnWithToken(await gat.getAddress(), amountIn, SRX_OUT, data))
        .to.emit(burner, "SwapAndBurnExecuted").withArgs(await gat.getAddress(), amountIn, SRX_OUT);

      expect(await probe.called()).to.equal(true);
      expect(await probe.allowanceSeen()).to.equal(amountIn);                 // not LEFTOVER + amountIn
      expect(await gat.allowance(burnerAddr, probeAddr)).to.equal(0n);        // cleared, incl. the unused 40M and the old leftover
      expect(await gat.balanceOf(probeAddr)).to.equal(pull);
      void token;
    });

    it("control (no leftover): the router sees amountIn and the allowance is 0 afterwards", async function () {
      const ctx = await loadFixture(fixture);
      const { executor, burner, probe, usdc } = ctx;
      await ready(ctx, probe);
      await burner.connect(executor).buyAndBurnWithToken(
        await usdc.getAddress(), 250_000_000n, SRX_OUT, ctx.swapData(probe, await usdc.getAddress(), 250_000_000n));
      expect(await probe.allowanceSeen()).to.equal(250_000_000n);
      expect(await usdc.allowance(await burner.getAddress(), await probe.getAddress())).to.equal(0n);
    });
  });

  // ── B2 ─────────────────────────────────────────────────────────────────────
  describe("B2: a swap may not spend more than amountIn", function () {
    it("a router that tries to pull amountIn + 1 of a standard token cannot: the exact allowance makes the call fail", async function () {
      const ctx = await loadFixture(fixture);
      const { executor, burner, mock, usdc } = ctx;
      await ready(ctx, mock);
      const amountIn = 100_000_000n;
      // Note: the claim is "a swap that pulls more than amountIn reverts SwapOverspent". With a standard
      // ERC-20 the router's allowance is exactly amountIn, so pulling amountIn + 1 fails inside the router call
      // and the burner reverts "BuybackBurner: swap call failed" (SwapOverspent is never reached). SwapOverspent
      // is the second line of defence, reachable only when the token debits the burner more than the allowance
      // (next test).
      await expect(burner.connect(executor).buyAndBurnWithToken(
        await usdc.getAddress(), amountIn, SRX_OUT, ctx.swapData(mock, await usdc.getAddress(), amountIn + 1n)))
        .to.be.revertedWith("BuybackBurner: swap call failed");
      // Control: pulling exactly amountIn succeeds.
      await expect(burner.connect(executor).buyAndBurnWithToken(
        await usdc.getAddress(), amountIn, SRX_OUT, ctx.swapData(mock, await usdc.getAddress(), amountIn)))
        .to.emit(burner, "SwapAndBurnExecuted");
    });

    it("a swap that costs the burner more than amountIn (a token that over-debits) reverts SwapOverspent(spent, amountIn) and rolls everything back", async function () {
      const ctx = await loadFixture(fixture);
      const { executor, burner, mock } = ctx;
      const got = await (await ethers.getContractFactory("GapsSOverdebitToken")).deploy();
      await got.mint(await burner.getAddress(), 1_000_000_000n);
      await ready(ctx, mock, got);
      const amountIn = 100_000_000n;
      // The router pulls exactly the allowance (amountIn); the token burns an extra 10% from the burner.
      await expect(burner.connect(executor).buyAndBurnWithToken(
        await got.getAddress(), amountIn, SRX_OUT, ctx.swapData(mock, await got.getAddress(), amountIn)))
        .to.be.revertedWithCustomError(burner, "SwapOverspent").withArgs(110_000_000n, amountIn);
      // State rolled back: nothing swapped, nothing burned, burner balance untouched.
      expect(await got.balanceOf(await burner.getAddress())).to.equal(1_000_000_000n);
      expect(await burner.totalBurned()).to.equal(0n);
      expect(await burner.swapInFlight(await got.getAddress())).to.equal(0n);
    });
  });

  // ── B3 ─────────────────────────────────────────────────────────────────────
  describe("B3: output floor", function () {
    it("output below minSrxOut reverts SwapProducedInsufficientSRX(received, minimum); output equal to it succeeds and burns exactly that", async function () {
      const ctx = await loadFixture(fixture);
      const { executor, burner, mock, usdc, token } = ctx;
      await ready(ctx, mock);
      const usdcAddr = await usdc.getAddress();
      const data = ctx.swapData(mock, usdcAddr, 100_000_000n);

      await expect(burner.connect(executor).buyAndBurnWithToken(usdcAddr, 100_000_000n, SRX_OUT + 1n, data))
        .to.be.revertedWithCustomError(burner, "SwapProducedInsufficientSRX").withArgs(SRX_OUT, SRX_OUT + 1n);
      expect(await burner.totalBurned()).to.equal(0n);

      const supply = await token.totalSupply();
      await expect(burner.connect(executor).buyAndBurnWithToken(usdcAddr, 100_000_000n, SRX_OUT, data))
        .to.emit(burner, "SwapAndBurnExecuted").withArgs(usdcAddr, 100_000_000n, SRX_OUT);
      expect(await burner.totalBurned()).to.equal(SRX_OUT);
      expect(await token.totalSupply()).to.equal(supply - SRX_OUT);
    });

    it("minSrxOut == 0 reverts ZeroAmount (a swap with no floor is refused); any non-zero floor passes that check", async function () {
      const ctx = await loadFixture(fixture);
      const { executor, burner, mock, usdc } = ctx;
      await ready(ctx, mock);
      const usdcAddr = await usdc.getAddress();
      const data = ctx.swapData(mock, usdcAddr, 100_000_000n);
      await expect(burner.connect(executor).buyAndBurnWithToken(usdcAddr, 100_000_000n, 0n, data))
        .to.be.revertedWithCustomError(burner, "ZeroAmount");
      await expect(burner.connect(executor).buyAndBurnWithToken(usdcAddr, 100_000_000n, 1n, data))
        .to.emit(burner, "SwapAndBurnExecuted");
    });
  });

  // ── B4 ─────────────────────────────────────────────────────────────────────
  describe("B4: setSwapLimits is admin-only", function () {
    it("a stranger and an EXECUTOR_ROLE-only account are refused; the admin succeeds and the limits take effect", async function () {
      const { admin, executor, stranger, burner, usdc, EXECUTOR_ROLE } = await loadFixture(fixture);
      const DEFAULT_ADMIN = await burner.DEFAULT_ADMIN_ROLE();
      const usdcAddr = await usdc.getAddress();
      expect(await burner.hasRole(EXECUTOR_ROLE, executor.address)).to.equal(true);
      expect(await burner.hasRole(DEFAULT_ADMIN, executor.address)).to.equal(false);

      await expect(burner.connect(stranger).setSwapLimits(usdcAddr, 1n, 2n))
        .to.be.revertedWithCustomError(burner, "AccessControlUnauthorizedAccount").withArgs(stranger.address, DEFAULT_ADMIN);
      await expect(burner.connect(executor).setSwapLimits(usdcAddr, 1n, 2n))
        .to.be.revertedWithCustomError(burner, "AccessControlUnauthorizedAccount").withArgs(executor.address, DEFAULT_ADMIN);
      expect(await burner.maxAmountPerSwap(usdcAddr)).to.equal(0n);
      expect(await burner.dailySwapLimit(usdcAddr)).to.equal(0n);

      await expect(burner.connect(admin).setSwapLimits(usdcAddr, 1n, 2n))
        .to.emit(burner, "SwapLimitsSet").withArgs(usdcAddr, 1n, 2n);
      expect(await burner.maxAmountPerSwap(usdcAddr)).to.equal(1n);
      expect(await burner.dailySwapLimit(usdcAddr)).to.equal(2n);
    });
  });

  // ── B5 ─────────────────────────────────────────────────────────────────────
  describe("B5: buyAndBurnWithToken access and pause", function () {
    it("a stranger is refused (AccessControlUnauthorizedAccount); the executor succeeds", async function () {
      const ctx = await loadFixture(fixture);
      const { executor, stranger, burner, mock, usdc, EXECUTOR_ROLE } = ctx;
      await ready(ctx, mock);
      const usdcAddr = await usdc.getAddress();
      const data = ctx.swapData(mock, usdcAddr, 100_000_000n);
      await expect(burner.connect(stranger).buyAndBurnWithToken(usdcAddr, 100_000_000n, SRX_OUT, data))
        .to.be.revertedWithCustomError(burner, "AccessControlUnauthorizedAccount").withArgs(stranger.address, EXECUTOR_ROLE);
      await expect(burner.connect(executor).buyAndBurnWithToken(usdcAddr, 100_000_000n, SRX_OUT, data))
        .to.emit(burner, "SwapAndBurnExecuted");
    });

    it("while paused the executor is refused with EnforcedPause; after unpause the same call succeeds", async function () {
      const ctx = await loadFixture(fixture);
      const { admin, executor, burner, mock, usdc } = ctx;
      await ready(ctx, mock);
      const usdcAddr = await usdc.getAddress();
      const data = ctx.swapData(mock, usdcAddr, 100_000_000n);
      await burner.connect(admin).pause();
      await expect(burner.connect(executor).buyAndBurnWithToken(usdcAddr, 100_000_000n, SRX_OUT, data))
        .to.be.revertedWithCustomError(burner, "EnforcedPause");
      expect(await burner.swapInFlight(usdcAddr)).to.equal(0n);
      await burner.connect(admin).unpause();
      await expect(burner.connect(executor).buyAndBurnWithToken(usdcAddr, 100_000_000n, SRX_OUT, data))
        .to.emit(burner, "SwapAndBurnExecuted");
    });
  });
});
