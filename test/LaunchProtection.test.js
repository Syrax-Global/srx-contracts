const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("SRXToken — Launch Protection", function () {

  async function deployFixture() {
    const [admin, user1, user2, user3, gov] = await ethers.getSigners();

    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint   = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token    = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();

    const GOVERNANCE_ROLE = await token.GOVERNANCE_ROLE();

    // Grant governance to dedicated gov signer
    await token.connect(admin).grantRole(GOVERNANCE_ROLE, gov.address);

    // Mint supply to admin for distribution
    await token.connect(admin).genesis(admin.address);

    // Fund user1 and user2 with 1M SRX each for tests
    const ONE_M   = ethers.parseUnits("1000000",  18);
    const MAX_TX  = ethers.parseUnits("500000",   18); // 0.5M — test limit
    const MAX_WAL = ethers.parseUnits("2000000",  18); // 2M   — test limit

    await token.connect(admin).transfer(user1.address, ONE_M);
    await token.connect(admin).transfer(user2.address, ONE_M);

    return { token, admin, user1, user2, user3, gov, GOVERNANCE_ROLE, ONE_M, MAX_TX, MAX_WAL };
  }

  // ── setMaxTransferAmount ────────────────────────────────────────────────────

  describe("setMaxTransferAmount", function () {
    it("stores the limit and emits MaxTransferAmountUpdated", async function () {
      const { token, gov, MAX_TX } = await loadFixture(deployFixture);
      await expect(token.connect(gov).setMaxTransferAmount(MAX_TX))
        .to.emit(token, "MaxTransferAmountUpdated")
        .withArgs(MAX_TX);
      expect(await token.maxTransferAmount()).to.equal(MAX_TX);
    });

    it("reverts when called by non-GOVERNANCE_ROLE", async function () {
      const { token, user1, MAX_TX } = await loadFixture(deployFixture);
      await expect(token.connect(user1).setMaxTransferAmount(MAX_TX))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("accepts 0 to remove the limit", async function () {
      const { token, gov, MAX_TX } = await loadFixture(deployFixture);
      await token.connect(gov).setMaxTransferAmount(MAX_TX);
      await token.connect(gov).setMaxTransferAmount(0n);
      expect(await token.maxTransferAmount()).to.equal(0n);
    });
  });

  // ── setMaxWalletBalance ─────────────────────────────────────────────────────

  describe("setMaxWalletBalance", function () {
    it("stores the limit and emits MaxWalletBalanceUpdated", async function () {
      const { token, gov, MAX_WAL } = await loadFixture(deployFixture);
      await expect(token.connect(gov).setMaxWalletBalance(MAX_WAL))
        .to.emit(token, "MaxWalletBalanceUpdated")
        .withArgs(MAX_WAL);
      expect(await token.maxWalletBalance()).to.equal(MAX_WAL);
    });

    it("reverts when called by non-GOVERNANCE_ROLE", async function () {
      const { token, user1, MAX_WAL } = await loadFixture(deployFixture);
      await expect(token.connect(user1).setMaxWalletBalance(MAX_WAL))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  // ── setExemptFromLimits ─────────────────────────────────────────────────────

  describe("setExemptFromLimits", function () {
    it("sets exemption and emits ExemptionUpdated", async function () {
      const { token, gov, user3 } = await loadFixture(deployFixture);
      await expect(token.connect(gov).setExemptFromLimits(user3.address, true))
        .to.emit(token, "ExemptionUpdated")
        .withArgs(user3.address, true);
      expect(await token.isExemptFromLimits(user3.address)).to.be.true;
    });

    it("reverts on zero address", async function () {
      const { token, gov } = await loadFixture(deployFixture);
      await expect(token.connect(gov).setExemptFromLimits(ethers.ZeroAddress, true))
        .to.be.revertedWithCustomError(token, "ZeroAddress");
    });

    it("reverts when called by non-GOVERNANCE_ROLE", async function () {
      const { token, user1, user3 } = await loadFixture(deployFixture);
      await expect(token.connect(user1).setExemptFromLimits(user3.address, true))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  // ── Max transfer enforcement ────────────────────────────────────────────────

  describe("Max transfer enforcement", function () {
    it("reverts when transfer exceeds maxTransferAmount", async function () {
      const { token, gov, user1, user2, MAX_TX } = await loadFixture(deployFixture);
      await token.connect(gov).setMaxTransferAmount(MAX_TX);

      const overLimit = MAX_TX + 1n;
      await expect(token.connect(user1).transfer(user2.address, overLimit))
        .to.be.revertedWithCustomError(token, "TransferExceedsMaxAmount")
        .withArgs(overLimit, MAX_TX);
    });

    it("succeeds when transfer equals maxTransferAmount exactly", async function () {
      const { token, gov, user1, user2, MAX_TX } = await loadFixture(deployFixture);
      await token.connect(gov).setMaxTransferAmount(MAX_TX);
      await expect(token.connect(user1).transfer(user2.address, MAX_TX)).to.not.be.reverted;
    });

    it("succeeds when transfer is below maxTransferAmount", async function () {
      const { token, gov, user1, user2, MAX_TX } = await loadFixture(deployFixture);
      await token.connect(gov).setMaxTransferAmount(MAX_TX);
      await expect(token.connect(user1).transfer(user2.address, MAX_TX - 1n)).to.not.be.reverted;
    });

    it("no limit enforced when maxTransferAmount is 0", async function () {
      const { token, user1, user2, ONE_M } = await loadFixture(deployFixture);
      // maxTransferAmount defaults to 0 — large transfer should succeed
      await expect(token.connect(user1).transfer(user2.address, ONE_M)).to.not.be.reverted;
    });
  });

  // ── Max wallet enforcement ──────────────────────────────────────────────────

  describe("Max wallet enforcement", function () {
    it("reverts when receive would push wallet over maxWalletBalance", async function () {
      const { token, gov, user1, user2, user3 } = await loadFixture(deployFixture);
      // Cap at 800K — less than user1's 1M balance so the fill transfer succeeds
      const CAP = ethers.parseUnits("800000", 18);
      await token.connect(gov).setMaxWalletBalance(CAP);

      // Fill user3 to exactly the cap
      await token.connect(user1).transfer(user3.address, CAP);

      // One more token tips user3 over — must revert
      await expect(token.connect(user2).transfer(user3.address, 1n))
        .to.be.revertedWithCustomError(token, "WalletExceedsMaxBalance");
    });

    it("succeeds when receive lands wallet exactly at maxWalletBalance", async function () {
      const { token, gov, user3, MAX_WAL } = await loadFixture(deployFixture);
      await token.connect(gov).setMaxWalletBalance(MAX_WAL);
      // user3 starts at 0; transfer exactly MAX_WAL
      const { admin } = await loadFixture(deployFixture);
      // Re-derive admin from fixture
      const [adm] = await ethers.getSigners();
      await expect(token.connect(adm).transfer(user3.address, MAX_WAL)).to.not.be.reverted;
    });

    it("no limit enforced when maxWalletBalance is 0", async function () {
      const { token, user1, user2, ONE_M } = await loadFixture(deployFixture);
      // Default 0 — no wallet cap
      await expect(token.connect(user1).transfer(user2.address, ONE_M)).to.not.be.reverted;
    });
  });

  // ── Exemptions ─────────────────────────────────────────────────────────────

  describe("Exemptions", function () {
    it("exempt sender bypasses maxTransferAmount", async function () {
      const { token, gov, user1, user2, ONE_M, MAX_TX } = await loadFixture(deployFixture);
      await token.connect(gov).setMaxTransferAmount(MAX_TX);
      await token.connect(gov).setExemptFromLimits(user1.address, true);
      // user1 is exempt — can transfer more than MAX_TX
      await expect(token.connect(user1).transfer(user2.address, ONE_M)).to.not.be.reverted;
    });

    it("exempt recipient bypasses maxTransferAmount", async function () {
      const { token, gov, user1, user2, ONE_M, MAX_TX } = await loadFixture(deployFixture);
      await token.connect(gov).setMaxTransferAmount(MAX_TX);
      await token.connect(gov).setExemptFromLimits(user2.address, true);
      await expect(token.connect(user1).transfer(user2.address, ONE_M)).to.not.be.reverted;
    });

    it("exempt recipient bypasses maxWalletBalance", async function () {
      const { token, gov, user1, user2, ONE_M } = await loadFixture(deployFixture);
      // Cap at 500K — user2 already holds 1M which exceeds this; any receipt would
      // normally revert, but exemption must bypass the check entirely.
      const CAP = ethers.parseUnits("500000", 18);
      await token.connect(gov).setMaxWalletBalance(CAP);
      await token.connect(gov).setExemptFromLimits(user2.address, true);

      // Send 500K from user1 → user2 would reach 1.5M, far over the 500K cap
      const SEND = ethers.parseUnits("500000", 18);
      await token.connect(user1).transfer(user2.address, SEND); // succeeds — user2 is exempt
      expect(await token.balanceOf(user2.address)).to.equal(ONE_M + SEND);
    });

    it("exemption can be revoked", async function () {
      const { token, gov, user1, user2, ONE_M, MAX_TX } = await loadFixture(deployFixture);
      await token.connect(gov).setMaxTransferAmount(MAX_TX);
      await token.connect(gov).setExemptFromLimits(user1.address, true);
      await token.connect(gov).setExemptFromLimits(user1.address, false);
      // Now user1 is no longer exempt — over-limit transfer should revert
      await expect(token.connect(user1).transfer(user2.address, ONE_M))
        .to.be.revertedWithCustomError(token, "TransferExceedsMaxAmount");
    });
  });

  // ── Mint and burn bypass ────────────────────────────────────────────────────

  describe("Mint and burn always bypass limits", function () {
    it("genesis (mint) bypasses maxWalletBalance", async function () {
      // A fresh token — genesis mints 10B to admin, which far exceeds any wallet cap.
      // The fact that deployment succeeded means mint bypasses limits.
      const [adm] = await ethers.getSigners();
      const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
      const ep = await MockLZEndpoint.deploy(40161);
      await ep.waitForDeployment();
      const SRXToken = await ethers.getContractFactory("SRXToken");
      const t = await SRXToken.deploy(await ep.getAddress(), adm.address);
      await t.waitForDeployment();
      const GOVERNANCE_ROLE = await t.GOVERNANCE_ROLE();
      // Set a tiny wallet cap BEFORE genesis
      await t.connect(adm).setMaxWalletBalance(ethers.parseUnits("1", 18));
      // Genesis mints 10B — must succeed despite cap
      await expect(t.connect(adm).genesis(adm.address)).to.not.be.reverted;
    });

    it("buyAndBurn (burn) bypasses maxTransferAmount", async function () {
      const { token, gov, admin, user1, MAX_TX } = await loadFixture(deployFixture);
      const BURN_ROLE = await token.BURN_ROLE();
      await token.connect(admin).grantRole(BURN_ROLE, admin.address);
      await token.connect(gov).setMaxTransferAmount(MAX_TX);
      // Transfer a large amount to admin's account (admin is exempt as sender — but let's use user1)
      // Actually: buyAndBurn burns from msg.sender, which is admin here
      // admin has 10B - 2M already; burn 1M (within limit anyway) —
      // Test by calling burn on admin directly (burn bypasses limit)
      const burnAmount = ethers.parseUnits("8000000000", 18); // 8B — way over any transfer limit
      await expect(token.connect(admin).buyAndBurn(burnAmount)).to.not.be.reverted;
    });
  });

  // ── Self-transfer bypass (SC-LP-001 fix) ────────────────────────────────────

  describe("Self-transfer always bypasses limits (SC-LP-001)", function () {
    it("self-transfer succeeds even when value > maxTransferAmount", async function () {
      const { token, gov, user1, MAX_TX } = await loadFixture(deployFixture);
      await token.connect(gov).setMaxTransferAmount(MAX_TX);
      // user1 has 1M SRX (ONE_M); MAX_TX = 500K. Self-transfer of 600K (over limit) must succeed.
      const overLimit = MAX_TX + ethers.parseUnits("100000", 18);
      await expect(token.connect(user1).transfer(user1.address, overLimit)).to.not.be.reverted;
    });

    it("self-transfer succeeds even when balance + value > maxWalletBalance", async function () {
      const { token, gov, user1, ONE_M } = await loadFixture(deployFixture);
      // Cap wallet at 800K — user1 has 1M, already over cap. Self-transfer must still succeed.
      await token.connect(gov).setMaxWalletBalance(ethers.parseUnits("800000", 18));
      await expect(token.connect(user1).transfer(user1.address, ONE_M)).to.not.be.reverted;
      // Balance unchanged after self-transfer
      expect(await token.balanceOf(user1.address)).to.equal(ONE_M);
    });
  });
});
