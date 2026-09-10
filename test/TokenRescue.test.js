const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("SRXToken — rescueTokens", function () {

  async function deployFixture() {
    const [admin, other, recipient] = await ethers.getSigners();

    // Deploy SRXToken
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint   = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token    = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    // Deploy two mock ERC-20 tokens for rescue tests
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    const dai = await MockERC20.deploy("Dai Stablecoin", "DAI", 18);
    await dai.waitForDeployment();

    // Send some USDC directly to the SRXToken contract (simulating user error)
    const STUCK_USDC = ethers.parseUnits("500", 6);
    await usdc.connect(admin).mint(await token.getAddress(), STUCK_USDC);

    return { token, usdc, dai, admin, other, recipient, STUCK_USDC };
  }

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("rescues a foreign ERC-20 and emits TokenRescued", async function () {
    const { token, usdc, admin, recipient, STUCK_USDC } = await loadFixture(deployFixture);

    await expect(
      token.connect(admin).rescueTokens(await usdc.getAddress(), recipient.address, STUCK_USDC)
    )
      .to.emit(token, "TokenRescued")
      .withArgs(await usdc.getAddress(), recipient.address, STUCK_USDC);

    expect(await usdc.balanceOf(recipient.address)).to.equal(STUCK_USDC);
    expect(await usdc.balanceOf(await token.getAddress())).to.equal(0n);
  });

  it("transfers the correct amount to the recipient", async function () {
    const { token, usdc, admin, recipient, STUCK_USDC } = await loadFixture(deployFixture);
    const balBefore = await usdc.balanceOf(recipient.address);
    await token.connect(admin).rescueTokens(await usdc.getAddress(), recipient.address, STUCK_USDC);
    expect(await usdc.balanceOf(recipient.address)).to.equal(balBefore + STUCK_USDC);
  });

  it("can rescue a partial amount", async function () {
    const { token, usdc, admin, recipient, STUCK_USDC } = await loadFixture(deployFixture);
    const half = STUCK_USDC / 2n;
    await token.connect(admin).rescueTokens(await usdc.getAddress(), recipient.address, half);
    expect(await usdc.balanceOf(recipient.address)).to.equal(half);
    expect(await usdc.balanceOf(await token.getAddress())).to.equal(STUCK_USDC - half);
  });

  it("can rescue tokens in two separate calls", async function () {
    const { token, usdc, admin, recipient, STUCK_USDC } = await loadFixture(deployFixture);
    const half = STUCK_USDC / 2n;
    await token.connect(admin).rescueTokens(await usdc.getAddress(), recipient.address, half);
    await token.connect(admin).rescueTokens(await usdc.getAddress(), recipient.address, half);
    expect(await usdc.balanceOf(recipient.address)).to.equal(STUCK_USDC);
  });

  it("can rescue a 18-decimal token (DAI)", async function () {
    const { token, dai, admin, recipient } = await loadFixture(deployFixture);
    const STUCK_DAI = ethers.parseUnits("1000", 18);
    await dai.connect(admin).mint(await token.getAddress(), STUCK_DAI);
    await token.connect(admin).rescueTokens(await dai.getAddress(), recipient.address, STUCK_DAI);
    expect(await dai.balanceOf(recipient.address)).to.equal(STUCK_DAI);
  });

  // ── Reverts ─────────────────────────────────────────────────────────────────

  it("rescues SRX accidentally sent to SRXToken contract (SC-RT-001 fix)", async function () {
    const { token, admin, recipient } = await loadFixture(deployFixture);
    // Simulate user mistake: send SRX to the SRXToken contract address
    const STUCK_SRX = ethers.parseUnits("10000", 18);
    await token.connect(admin).transfer(await token.getAddress(), STUCK_SRX);
    expect(await token.balanceOf(await token.getAddress())).to.equal(STUCK_SRX);
    // Admin can now rescue it
    const balBefore = await token.balanceOf(recipient.address);
    await expect(token.connect(admin).rescueTokens(await token.getAddress(), recipient.address, STUCK_SRX))
      .to.emit(token, "TokenRescued")
      .withArgs(await token.getAddress(), recipient.address, STUCK_SRX);
    expect(await token.balanceOf(recipient.address)).to.equal(balBefore + STUCK_SRX);
    expect(await token.balanceOf(await token.getAddress())).to.equal(0n);
  });

  it("reverts with ZeroAddress when recipient is zero address", async function () {
    const { token, usdc, admin, STUCK_USDC } = await loadFixture(deployFixture);
    await expect(
      token.connect(admin).rescueTokens(await usdc.getAddress(), ethers.ZeroAddress, STUCK_USDC)
    ).to.be.revertedWithCustomError(token, "ZeroAddress");
  });

  it("reverts with ZeroAmount when amount is zero", async function () {
    const { token, usdc, admin, recipient } = await loadFixture(deployFixture);
    await expect(
      token.connect(admin).rescueTokens(await usdc.getAddress(), recipient.address, 0n)
    ).to.be.revertedWithCustomError(token, "ZeroAmount");
  });

  it("reverts with AccessControlUnauthorizedAccount when called by non-admin", async function () {
    const { token, usdc, other, recipient, STUCK_USDC } = await loadFixture(deployFixture);
    await expect(
      token.connect(other).rescueTokens(await usdc.getAddress(), recipient.address, STUCK_USDC)
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });

  it("GOVERNANCE_ROLE alone cannot call rescueTokens", async function () {
    const { token, usdc, admin, other, recipient, STUCK_USDC } = await loadFixture(deployFixture);
    await token.connect(admin).grantRole(await token.GOVERNANCE_ROLE(), other.address);
    await expect(
      token.connect(other).rescueTokens(await usdc.getAddress(), recipient.address, STUCK_USDC)
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });

  it("reverts when contract holds insufficient token balance", async function () {
    const { token, usdc, admin, recipient, STUCK_USDC } = await loadFixture(deployFixture);
    await expect(
      token.connect(admin).rescueTokens(await usdc.getAddress(), recipient.address, STUCK_USDC + 1n)
    ).to.be.reverted; // ERC20 insufficient balance revert
  });
});
