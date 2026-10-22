const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("BuybackBurner", function () {

  async function deployFixture() {
    const [admin, executor, user1] = await ethers.getSigners();

    // Deploy SRXToken
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint   = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token    = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();

    // Deploy BuybackBurner
    const BuybackBurner = await ethers.getContractFactory("BuybackBurner");
    const burner = await BuybackBurner.deploy(await token.getAddress(), admin.address);
    await burner.waitForDeployment();

    // Grant BURN_ROLE on SRXToken to BuybackBurner
    const BURN_ROLE      = await token.BURN_ROLE();
    const EXECUTOR_ROLE  = await burner.EXECUTOR_ROLE();
    await token.connect(admin).grantRole(BURN_ROLE, await burner.getAddress());

    // Grant EXECUTOR_ROLE to executor signer
    await burner.connect(admin).grantRole(EXECUTOR_ROLE, executor.address);

    // Mint supply and fund burner with some SRX for testing
    await token.connect(admin).genesis(admin.address);
    const FUND_AMOUNT = ethers.parseUnits("1000000", 18); // 1M SRX
    await token.connect(admin).transfer(await burner.getAddress(), FUND_AMOUNT);

    // Deploy a mock ERC20 for swap tests / rescue tests
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    return {
      token, burner, usdc,
      admin, executor, user1,
      BURN_ROLE, EXECUTOR_ROLE,
      FUND_AMOUNT,
    };
  }

  // ── Deployment ──────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets srxToken correctly", async function () {
      const { burner, token } = await loadFixture(deployFixture);
      expect(await burner.srxToken()).to.equal(await token.getAddress());
    });

    it("totalBurned starts at 0", async function () {
      const { burner } = await loadFixture(deployFixture);
      expect(await burner.totalBurned()).to.equal(0n);
    });

    it("swapRouter starts at zero address", async function () {
      const { burner } = await loadFixture(deployFixture);
      expect(await burner.swapRouter()).to.equal(ethers.ZeroAddress);
    });

    it("reverts deployment on zero srxToken", async function () {
      const [admin] = await ethers.getSigners();
      const BuybackBurner = await ethers.getContractFactory("BuybackBurner");
      await expect(BuybackBurner.deploy(ethers.ZeroAddress, admin.address))
        .to.be.revertedWithCustomError({ interface: (await ethers.getContractFactory("BuybackBurner")).interface }, "ZeroAddress");
    });
  });

  // ── burnHeld ────────────────────────────────────────────────────────────────

  describe("burnHeld", function () {
    it("burns all SRX held in the contract and emits BurnExecuted", async function () {
      const { burner, token, executor, FUND_AMOUNT } = await loadFixture(deployFixture);
      const supplyBefore = await token.totalSupply();

      await expect(burner.connect(executor).burnHeld())
        .to.emit(burner, "BurnExecuted")
        .withArgs(FUND_AMOUNT, FUND_AMOUNT);

      expect(await token.balanceOf(await burner.getAddress())).to.equal(0n);
      expect(await token.totalSupply()).to.equal(supplyBefore - FUND_AMOUNT);
      expect(await burner.totalBurned()).to.equal(FUND_AMOUNT);
    });

    it("reverts with NothingToBurn when balance is zero", async function () {
      const { burner, executor } = await loadFixture(deployFixture);
      // Drain first
      await burner.connect(executor).burnHeld();
      await expect(burner.connect(executor).burnHeld())
        .to.be.revertedWithCustomError(burner, "NothingToBurn");
    });

    it("reverts when caller lacks EXECUTOR_ROLE", async function () {
      const { burner, user1 } = await loadFixture(deployFixture);
      await expect(burner.connect(user1).burnHeld())
        .to.be.revertedWithCustomError(burner, "AccessControlUnauthorizedAccount");
    });

    it("accumulates totalBurned across multiple calls", async function () {
      const { burner, token, admin, executor, FUND_AMOUNT } = await loadFixture(deployFixture);
      await burner.connect(executor).burnHeld();

      // Fund again and burn again
      await token.connect(admin).transfer(await burner.getAddress(), FUND_AMOUNT);
      await burner.connect(executor).burnHeld();

      expect(await burner.totalBurned()).to.equal(FUND_AMOUNT * 2n);
    });

    it("reverts when paused", async function () {
      const { burner, admin, executor } = await loadFixture(deployFixture);
      await burner.connect(admin).pause();
      await expect(burner.connect(executor).burnHeld())
        .to.be.revertedWithCustomError(burner, "EnforcedPause");
    });
  });

  // ── setSwapRouter ───────────────────────────────────────────────────────────

  describe("setSwapRouter", function () {
    it("updates router and emits SwapRouterUpdated", async function () {
      const { burner, admin, user1 } = await loadFixture(deployFixture);
      await expect(burner.connect(admin).setSwapRouter(user1.address))
        .to.emit(burner, "SwapRouterUpdated")
        .withArgs(user1.address);
      expect(await burner.swapRouter()).to.equal(user1.address);
    });

    it("accepts zero address to disable swap mode", async function () {
      const { burner, admin, user1 } = await loadFixture(deployFixture);
      await burner.connect(admin).setSwapRouter(user1.address);
      await burner.connect(admin).setSwapRouter(ethers.ZeroAddress);
      expect(await burner.swapRouter()).to.equal(ethers.ZeroAddress);
    });

    it("reverts when called by non-admin", async function () {
      const { burner, user1 } = await loadFixture(deployFixture);
      await expect(burner.connect(user1).setSwapRouter(user1.address))
        .to.be.revertedWithCustomError(burner, "AccessControlUnauthorizedAccount");
    });
  });

  // ── No slippage setting (132c0422, 1 Oct 2026) ───────────────────────────────

  describe("slippage", function () {
    // ⛔ maxSlippageBps existed and nothing read it: with no on-chain price, the
    //    contract had nothing to apply it to. A setting that looks like a control
    //    and is not one was removed. What actually bounds a swap is minSrxOut, the
    //    per-token caps and the exact approval (tested elsewhere in this file).
    it("has no slippage setting that nothing reads", async function () {
      const { burner } = await loadFixture(deployFixture);
      for (const name of ["maxSlippageBps", "setMaxSlippageBps", "MAX_SLIPPAGE_CAP"]) {
        expect(burner.interface.getFunction(name), name).to.equal(null);
      }
    });
  });

  // ── rescueTokens ────────────────────────────────────────────────────────────

  describe("rescueTokens", function () {
    it("rescues a non-SRX ERC-20 to the specified address", async function () {
      const { burner, usdc, admin, user1 } = await loadFixture(deployFixture);

      // Mint USDC directly to burner (simulating fee routing)
      await usdc.connect(admin).mint(await burner.getAddress(), ethers.parseUnits("1000", 6));

      await expect(burner.connect(admin).rescueTokens(await usdc.getAddress(), user1.address, ethers.parseUnits("1000", 6)))
        .to.emit(burner, "TokenRescued");

      expect(await usdc.balanceOf(user1.address)).to.equal(ethers.parseUnits("1000", 6));
    });

    it("reverts when trying to rescue SRXToken", async function () {
      const { burner, token, admin, user1 } = await loadFixture(deployFixture);
      await expect(burner.connect(admin).rescueTokens(await token.getAddress(), user1.address, 1n))
        .to.be.revertedWithCustomError(burner, "CannotRescueSRX");
    });

    it("reverts on zero recipient address", async function () {
      const { burner, usdc, admin } = await loadFixture(deployFixture);
      await usdc.connect(admin).mint(await burner.getAddress(), 1000n);
      await expect(burner.connect(admin).rescueTokens(await usdc.getAddress(), ethers.ZeroAddress, 1000n))
        .to.be.revertedWithCustomError(burner, "ZeroAddress");
    });

    it("reverts when called by non-admin", async function () {
      const { burner, usdc, user1 } = await loadFixture(deployFixture);
      await expect(burner.connect(user1).rescueTokens(await usdc.getAddress(), user1.address, 1n))
        .to.be.revertedWithCustomError(burner, "AccessControlUnauthorizedAccount");
    });
  });

  // ── buyAndBurnWithToken — swap router not set ───────────────────────────────

  describe("buyAndBurnWithToken — swap router guard", function () {
    it("reverts with SwapRouterNotSet when router is zero address", async function () {
      const { burner, usdc, executor } = await loadFixture(deployFixture);
      await expect(
        burner.connect(executor).buyAndBurnWithToken(
          await usdc.getAddress(),
          ethers.parseUnits("100", 6),
          ethers.parseUnits("1000", 18),
          "0x"
        )
      ).to.be.revertedWithCustomError(burner, "SwapRouterNotSet");
    });
  });

  // ── rescueETH (SC-BB-002 fix) ───────────────────────────────────────────────

  describe("rescueETH", function () {
    async function fundedFixture() {
      const base = await loadFixture(deployFixture);
      // Send 1 ETH to the burner
      await base.admin.sendTransaction({
        to: await base.burner.getAddress(),
        value: ethers.parseEther("1"),
      });
      return base;
    }

    it("rescues ETH to recipient and emits ETHRescued", async function () {
      const { burner, admin, user1 } = await fundedFixture();
      const amount = ethers.parseEther("1");
      const balBefore = await ethers.provider.getBalance(user1.address);
      await expect(burner.connect(admin).rescueETH(user1.address, amount))
        .to.emit(burner, "ETHRescued")
        .withArgs(user1.address, amount);
      expect(await ethers.provider.getBalance(user1.address)).to.equal(balBefore + amount);
      expect(await ethers.provider.getBalance(await burner.getAddress())).to.equal(0n);
    });

    it("supports partial rescue", async function () {
      const { burner, admin, user1 } = await fundedFixture();
      const half = ethers.parseEther("0.5");
      await burner.connect(admin).rescueETH(user1.address, half);
      expect(await ethers.provider.getBalance(await burner.getAddress())).to.equal(half);
    });

    it("reverts with InsufficientETH if amount exceeds balance", async function () {
      const { burner, admin, user1 } = await fundedFixture();
      await expect(
        burner.connect(admin).rescueETH(user1.address, ethers.parseEther("2"))
      ).to.be.revertedWithCustomError(burner, "InsufficientETH");
    });

    it("reverts with ZeroAddress on zero recipient", async function () {
      const { burner, admin } = await fundedFixture();
      await expect(
        burner.connect(admin).rescueETH(ethers.ZeroAddress, ethers.parseEther("0.1"))
      ).to.be.revertedWithCustomError(burner, "ZeroAddress");
    });

    it("reverts with ZeroAmount on zero amount", async function () {
      const { burner, admin, user1 } = await fundedFixture();
      await expect(
        burner.connect(admin).rescueETH(user1.address, 0n)
      ).to.be.revertedWithCustomError(burner, "ZeroAmount");
    });

    it("reverts when called by non-admin", async function () {
      const { burner, user1 } = await fundedFixture();
      await expect(
        burner.connect(user1).rescueETH(user1.address, ethers.parseEther("0.1"))
      ).to.be.revertedWithCustomError(burner, "AccessControlUnauthorizedAccount");
    });
  });

  // ── Re-entry during a swap (Slither 0.11.6 reentrancy-balance, 7 Oct 2026) ──
  //
  // buyAndBurnWithToken measures the swap by the burner's balances before and after
  // the router call. Slither flags those reads as possibly stale if the router calls
  // back in. Every state-changing entry point a router could reach is nonReentrant
  // (or admin-only, and the router is not an admin), so a call-back is refused. Proven
  // here with a hostile router that even holds EXECUTOR_ROLE.
  describe("re-entry during a swap", function () {
    async function hostile() {
      const ctx = await loadFixture(deployFixture);
      const { token, burner, usdc, admin, EXECUTOR_ROLE } = ctx;
      const router = await (await ethers.getContractFactory("MockReentrantRouter")).deploy();
      await burner.connect(admin).setSwapRouter(await router.getAddress());
      await burner.connect(admin).setSwapLimits(await usdc.getAddress(), 10n ** 12n, 10n ** 12n);
      await burner.connect(admin).grantRole(EXECUTOR_ROLE, await router.getAddress()); // worst case
      await token.connect(admin).transfer(await router.getAddress(), ethers.parseUnits("1000", 18));
      await usdc.mint(await burner.getAddress(), 1_000_000_000n);
      const swapData = router.interface.encodeFunctionData("swap", [
        await usdc.getAddress(), 1_000_000_000n, await token.getAddress(), ethers.parseUnits("500", 18), await burner.getAddress(),
      ]);
      return { ...ctx, router, swapData };
    }
    const REENTRANT = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);

    it("a router calling burnHeld() mid-swap is refused, and the swap still burns what it bought", async function () {
      const { burner, usdc, token, executor, router, swapData } = await hostile();
      await router.arm(await burner.getAddress(), burner.interface.encodeFunctionData("burnHeld"));
      const before = await burner.totalBurned();
      await burner.connect(executor).buyAndBurnWithToken(await usdc.getAddress(), 1_000_000_000n, ethers.parseUnits("500", 18), swapData);
      expect(await router.reentered()).to.equal(false);
      expect((await router.reenterResult()).slice(0, 10)).to.equal(REENTRANT);
      expect((await burner.totalBurned()) - before).to.equal(ethers.parseUnits("500", 18));
      void token;
    });

    it("a router calling buyAndBurnWithToken() again mid-swap is refused", async function () {
      const { burner, usdc, executor, router, swapData } = await hostile();
      const inner = burner.interface.encodeFunctionData("buyAndBurnWithToken", [await usdc.getAddress(), 1n, 1n, swapData]);
      await router.arm(await burner.getAddress(), inner);
      await burner.connect(executor).buyAndBurnWithToken(await usdc.getAddress(), 1_000_000_000n, ethers.parseUnits("500", 18), swapData);
      expect(await router.reentered()).to.equal(false);
      expect((await router.reenterResult()).slice(0, 10)).to.equal(REENTRANT);
    });

    it("control: outside a swap the same router call to burnHeld() succeeds, so the refusal above is the lock", async function () {
      const { burner, usdc, token, router } = await hostile();
      await router.arm(await burner.getAddress(), burner.interface.encodeFunctionData("burnHeld"));
      await router.swap(await usdc.getAddress(), 0n, await token.getAddress(), 0n, await router.getAddress());
      expect(await router.reentered()).to.equal(true);
    });
  });

  // ── The daily swap cap is a draining bucket (internal review, 7 Oct 2026) ──────
  describe("daily swap cap", function () {
    it("no burst across a reset: a full cap just before and another just after is refused", async function () {
      const { token, burner, usdc, admin, executor } = await loadFixture(deployFixture);
      const router = await (await ethers.getContractFactory("MockSwapRouter")).deploy();
      await burner.connect(admin).setSwapRouter(await router.getAddress());
      const CAP = 100_000n * 10n ** 6n;
      await burner.connect(admin).setSwapLimits(await usdc.getAddress(), CAP, CAP);
      await token.connect(admin).transfer(await router.getAddress(), ethers.parseUnits("1000", 18));
      await usdc.mint(await burner.getAddress(), 1_000_000n * 10n ** 6n);
      const swap = async (amt) => burner.connect(executor).buyAndBurnWithToken(
        await usdc.getAddress(), amt, 1n,
        router.interface.encodeFunctionData("swap", [await usdc.getAddress(), amt, await token.getAddress(), 1n, await burner.getAddress()]));
      await swap(1n);                                   // T0: tiny swap
      await time.increase(24 * 3600 - 3);
      await swap(CAP - 10n * 10n ** 6n);                // just before T0 + 24h
      await time.increase(2);
      await expect(swap(CAP)).to.be.revertedWithCustomError(burner, "SwapLimitExceeded"); // just after
    });
  });
});
