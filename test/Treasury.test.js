const { expect }  = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/**
 * SRXTreasury tests.
 *
 * The treasury holds SRX + arbitrary ERC-20 tokens + ETH.
 * All spend functions require SPENDER_ROLE (Timelock in production).
 * Tests use the admin as the SPENDER_ROLE holder for simplicity.
 */
describe("SRXTreasury", function () {

  async function deployFixture() {
    const [admin, timelock, recipient, stranger, pauser] = await ethers.getSigners();

    // ── Token ─────────────────────────────────────────────────────────────
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    // ── Treasury (UUPS) ───────────────────────────────────────────────────
    const SRXTreasury = await ethers.getContractFactory("SRXTreasury");
    const treasury = await upgrades.deployProxy(
      SRXTreasury,
      [await token.getAddress(), admin.address, timelock.address],
      { kind: "uups", initializer: "initialize" }
    );
    await treasury.waitForDeployment();
    const treasuryAddr = await treasury.getAddress();

    // ── Grant SPENDER_ROLE to admin for test convenience ──────────────────
    // (In production this role belongs exclusively to the Timelock)
    const SPENDER_ROLE = await treasury.SPENDER_ROLE();
    await treasury.connect(admin).grantRole(SPENDER_ROLE, admin.address);

    // ── Grant BURN_ROLE on token to treasury ──────────────────────────────
    const BURN_ROLE = await token.BURN_ROLE();
    await token.connect(admin).grantRole(BURN_ROLE, treasuryAddr);

    // ── Fund treasury with SRX ────────────────────────────────────────────
    const TREASURY_FUND = ethers.parseUnits("10000000", 18); // 10M SRX
    await token.connect(admin).transfer(treasuryAddr, TREASURY_FUND);

    // ── Fund treasury with ETH ────────────────────────────────────────────
    await admin.sendTransaction({ to: treasuryAddr, value: ethers.parseEther("10") });

    return { treasury, token, admin, timelock, recipient, stranger, pauser, TREASURY_FUND, treasuryAddr };
  }

  // ── Deployment ─────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets srxToken correctly", async function () {
      const { treasury, token } = await loadFixture(deployFixture);
      expect(await treasury.srxToken()).to.equal(await token.getAddress());
    });

    it("receives SRX correctly", async function () {
      const { treasury, TREASURY_FUND } = await loadFixture(deployFixture);
      expect(await treasury.srxBalance()).to.equal(TREASURY_FUND);
    });

    it("receives ETH correctly", async function () {
      const { treasury } = await loadFixture(deployFixture);
      expect(await treasury.ethBalance()).to.equal(ethers.parseEther("10"));
    });

    it("totalBurned starts at zero", async function () {
      const { treasury } = await loadFixture(deployFixture);
      expect(await treasury.totalBurned()).to.equal(0n);
    });

    it("totalSpentSRX starts at zero", async function () {
      const { treasury } = await loadFixture(deployFixture);
      expect(await treasury.totalSpentSRX()).to.equal(0n);
    });
  });

  // ── withdraw (ERC-20) ──────────────────────────────────────────────────────

  describe("withdraw()", function () {
    it("transfers ERC-20 tokens to recipient", async function () {
      const { treasury, token, admin, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("1000", 18);

      await treasury.connect(admin).withdraw(
        await token.getAddress(), recipient.address, amount, "ecosystem grant"
      );

      expect(await token.balanceOf(recipient.address)).to.equal(amount);
    });

    it("emits Withdrawal event", async function () {
      const { treasury, token, admin, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("500", 18);

      await expect(
        treasury.connect(admin).withdraw(
          await token.getAddress(), recipient.address, amount, "grant"
        )
      ).to.emit(treasury, "Withdrawal")
        .withArgs(await token.getAddress(), recipient.address, amount, "grant");
    });

    it("increments totalSpentSRX when withdrawing SRX", async function () {
      const { treasury, token, admin, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("5000", 18);

      await treasury.connect(admin).withdraw(
        await token.getAddress(), recipient.address, amount, "ops"
      );

      expect(await treasury.totalSpentSRX()).to.equal(amount);
    });

    it("does NOT increment totalSpentSRX for non-SRX token", async function () {
      const { treasury, admin, recipient } = await loadFixture(deployFixture);

      // Deploy a separate ERC-20 stub for this test
      const MockLZEndpoint2 = await ethers.getContractFactory("MockLZEndpoint");
      const mockEp2 = await MockLZEndpoint2.deploy(40162);
      await mockEp2.waitForDeployment();
      const ERC20Mock = await ethers.getContractFactory("SRXToken");
      const mock = await ERC20Mock.deploy(await mockEp2.getAddress(), admin.address);
      await mock.waitForDeployment();
      await mock.connect(admin).genesis(admin.address);
      const mockAddr = await mock.getAddress();

      const treasuryAddr = await treasury.getAddress();
      await mock.connect(admin).transfer(treasuryAddr, ethers.parseUnits("1000", 18));

      await treasury.connect(admin).withdraw(
        mockAddr, recipient.address, ethers.parseUnits("100", 18), "usdc grant"
      );

      expect(await treasury.totalSpentSRX()).to.equal(0n);
    });

    it("reverts with zero recipient", async function () {
      const { treasury, token, admin } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(admin).withdraw(
          await token.getAddress(), ethers.ZeroAddress, 100n, "test"
        )
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("reverts with zero amount", async function () {
      const { treasury, token, admin, recipient } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(admin).withdraw(
          await token.getAddress(), recipient.address, 0n, "test"
        )
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("reverts with empty reason", async function () {
      const { treasury, token, admin, recipient } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(admin).withdraw(
          await token.getAddress(), recipient.address, 100n, ""
        )
      ).to.be.revertedWithCustomError(treasury, "EmptyReason");
    });

    it("reverts if caller lacks SPENDER_ROLE", async function () {
      const { treasury, token, stranger, recipient } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(stranger).withdraw(
          await token.getAddress(), recipient.address, 100n, "unauthorized"
        )
      ).to.be.reverted;
    });

    it("reverts when paused", async function () {
      const { treasury, token, admin, recipient } = await loadFixture(deployFixture);
      await treasury.connect(admin).pause();

      await expect(
        treasury.connect(admin).withdraw(
          await token.getAddress(), recipient.address, 100n, "blocked"
        )
      ).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    });
  });

  // ── withdrawETH ────────────────────────────────────────────────────────────

  describe("withdrawETH()", function () {
    it("transfers ETH to recipient", async function () {
      const { treasury, admin, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1");

      const beforeBal = await ethers.provider.getBalance(recipient.address);
      await treasury.connect(admin).withdrawETH(recipient.address, amount, "ETH grant");
      const afterBal  = await ethers.provider.getBalance(recipient.address);

      expect(afterBal - beforeBal).to.equal(amount);
    });

    it("emits ETHWithdrawal event", async function () {
      const { treasury, admin, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("0.5");

      await expect(
        treasury.connect(admin).withdrawETH(recipient.address, amount, "ops fee")
      ).to.emit(treasury, "ETHWithdrawal")
        .withArgs(recipient.address, amount, "ops fee");
    });

    it("reverts if balance insufficient", async function () {
      const { treasury, admin, recipient } = await loadFixture(deployFixture);
      const tooMuch = ethers.parseEther("100");

      await expect(
        treasury.connect(admin).withdrawETH(recipient.address, tooMuch, "too much")
      ).to.be.revertedWithCustomError(treasury, "InsufficientBalance");
    });

    it("reverts with zero recipient", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(admin).withdrawETH(ethers.ZeroAddress, 1n, "test")
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("reverts with zero amount", async function () {
      const { treasury, admin, recipient } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(admin).withdrawETH(recipient.address, 0n, "test")
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("reverts with empty reason", async function () {
      const { treasury, admin, recipient } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(admin).withdrawETH(recipient.address, 1n, "")
      ).to.be.revertedWithCustomError(treasury, "EmptyReason");
    });

    it("reverts when paused", async function () {
      const { treasury, admin, recipient } = await loadFixture(deployFixture);
      await treasury.connect(admin).pause();

      await expect(
        treasury.connect(admin).withdrawETH(recipient.address, ethers.parseEther("1"), "blocked")
      ).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    });

    it("reverts if caller lacks SPENDER_ROLE", async function () {
      const { treasury, stranger, recipient } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(stranger).withdrawETH(recipient.address, 1n, "unauth")
      ).to.be.reverted;
    });
  });

  // ── executeBuyAndBurn ──────────────────────────────────────────────────────

  describe("executeBuyAndBurn()", function () {
    it("burns SRX and increments totalBurned", async function () {
      const { treasury, token, admin } = await loadFixture(deployFixture);
      const burnAmount = ethers.parseUnits("100000", 18);

      const supplyBefore = await token.totalSupply();
      await treasury.connect(admin).executeBuyAndBurn(burnAmount);

      expect(await token.totalSupply()).to.equal(supplyBefore - burnAmount);
      expect(await treasury.totalBurned()).to.equal(burnAmount);
    });

    it("emits BuyAndBurnExecuted", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);
      const burnAmount = ethers.parseUnits("50000", 18);

      await expect(treasury.connect(admin).executeBuyAndBurn(burnAmount))
        .to.emit(treasury, "BuyAndBurnExecuted")
        .withArgs(burnAmount, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));
    });

    it("accumulates totalBurned across multiple burns", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("10000", 18);

      await treasury.connect(admin).executeBuyAndBurn(amount);
      await treasury.connect(admin).executeBuyAndBurn(amount);
      await treasury.connect(admin).executeBuyAndBurn(amount);

      expect(await treasury.totalBurned()).to.equal(amount * 3n);
    });

    it("reverts with zero amount", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(admin).executeBuyAndBurn(0n)
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("reverts if caller lacks SPENDER_ROLE", async function () {
      const { treasury, stranger } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(stranger).executeBuyAndBurn(ethers.parseUnits("1", 18))
      ).to.be.reverted;
    });

    it("reverts when paused", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);
      await treasury.connect(admin).pause();

      await expect(
        treasury.connect(admin).executeBuyAndBurn(ethers.parseUnits("1000", 18))
      ).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    });
  });

  // ── Receive ETH ────────────────────────────────────────────────────────────

  describe("ETH receive", function () {
    it("accepts ETH via receive() and emits Received", async function () {
      const { treasury, admin, treasuryAddr } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1");

      await expect(
        admin.sendTransaction({ to: treasuryAddr, value: amount })
      ).to.emit(treasury, "Received")
        .withArgs(admin.address, amount);
    });
  });

  // ── View helpers ───────────────────────────────────────────────────────────

  describe("View helpers", function () {
    it("tokenBalance returns correct balance for arbitrary ERC-20", async function () {
      const { treasury, token, treasuryAddr, TREASURY_FUND } = await loadFixture(deployFixture);
      expect(await treasury.tokenBalance(await token.getAddress())).to.equal(TREASURY_FUND);
    });
  });

  // ── Pause ──────────────────────────────────────────────────────────────────

  describe("Pause / unpause", function () {
    it("admin can pause and unpause", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);

      await treasury.connect(admin).pause();
      expect(await treasury.paused()).to.be.true;

      await treasury.connect(admin).unpause();
      expect(await treasury.paused()).to.be.false;
    });

    it("non-pauser cannot pause", async function () {
      const { treasury, stranger } = await loadFixture(deployFixture);
      await expect(treasury.connect(stranger).pause()).to.be.reverted;
    });
  });
});
