const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

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

    it("sets default maxSlippageBps to 200", async function () {
      const { burner } = await loadFixture(deployFixture);
      expect(await burner.maxSlippageBps()).to.equal(200n);
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

  // ── setMaxSlippageBps ───────────────────────────────────────────────────────

  describe("setMaxSlippageBps", function () {
    it("updates slippage and emits MaxSlippageUpdated", async function () {
      const { burner, admin } = await loadFixture(deployFixture);
      await expect(burner.connect(admin).setMaxSlippageBps(300n))
        .to.emit(burner, "MaxSlippageUpdated")
        .withArgs(300n);
      expect(await burner.maxSlippageBps()).to.equal(300n);
    });

    it("reverts when slippage exceeds MAX_SLIPPAGE_CAP (5000 bps)", async function () {
      const { burner, admin } = await loadFixture(deployFixture);
      await expect(burner.connect(admin).setMaxSlippageBps(5001n))
        .to.be.revertedWithCustomError(burner, "SlippageExceedsCap")
        .withArgs(5001n, 5000n);
    });

    it("accepts exactly MAX_SLIPPAGE_CAP", async function () {
      const { burner, admin } = await loadFixture(deployFixture);
      await expect(burner.connect(admin).setMaxSlippageBps(5000n)).to.not.be.reverted;
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
});
