const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("VestingVault", function () {
  const DAY = 86400n;
  const TOTAL = ethers.parseUnits("1000000", 18); // 1M SRX for testing

  async function deployVestingFixture() {
    const [admin, beneficiary, treasury, other] = await ethers.getSigners();

    // Deploy mock token
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    return { token, admin, beneficiary, treasury, other };
  }

  async function deployStandardVault(cliffDays, vestingDays, tgeUnlockBps) {
    const { token, admin, beneficiary, treasury, other } = await loadFixture(deployVestingFixture);

    const VestingVault = await ethers.getContractFactory("VestingVault");
    const vault = await VestingVault.deploy(
      await token.getAddress(),
      beneficiary.address,
      admin.address,
      BigInt(cliffDays) * DAY,
      BigInt(vestingDays) * DAY,
      BigInt(tgeUnlockBps)
    );
    await vault.waitForDeployment();

    // Fund the vault
    await token.connect(admin).transfer(await vault.getAddress(), TOTAL);

    return { vault, token, admin, beneficiary, treasury, other };
  }

  // ── Founders vesting (12m cliff, 36m linear, 0% TGE) ──────────────────────

  describe("Founders vesting (12m cliff, 36m linear)", function () {
    it("total allocation is correct", async function () {
      const { vault } = await deployStandardVault(365, 1095, 0);
      expect(await vault.totalAllocation()).to.equal(TOTAL);
    });

    it("nothing vested before TGE", async function () {
      const { vault } = await deployStandardVault(365, 1095, 0);
      expect(await vault.vestedAmount()).to.equal(0n);
    });

    it("nothing vested just after TGE but before cliff", async function () {
      const { vault, admin } = await deployStandardVault(365, 1095, 0);
      await vault.connect(admin).triggerTGE();

      await time.increase(30 * 86400); // 30 days — within cliff
      expect(await vault.vestedAmount()).to.equal(0n);
    });

    it("nothing vested at cliff end (vesting starts after cliff)", async function () {
      const { vault, admin } = await deployStandardVault(365, 1095, 0);
      await vault.connect(admin).triggerTGE();

      await time.increase(365 * 86400); // exactly cliff end
      expect(await vault.vestedAmount()).to.equal(0n);
    });

    it("partial vesting halfway through vesting period", async function () {
      const { vault, admin } = await deployStandardVault(365, 1095, 0);
      await vault.connect(admin).triggerTGE();

      await time.increase((365 + 547) * 86400); // cliff + 18 months

      const vested = await vault.vestedAmount();
      // 547 days / 1095 days = 49.95%, not exactly 50% — use arithmetic expected value
      const expected = TOTAL * 547n / 1095n;
      expect(vested).to.be.closeTo(expected, ethers.parseUnits("100", 18));
    });

    it("fully vested after cliff + vesting duration", async function () {
      const { vault, admin } = await deployStandardVault(365, 1095, 0);
      await vault.connect(admin).triggerTGE();

      await time.increase((365 + 1095 + 1) * 86400);
      expect(await vault.vestedAmount()).to.equal(TOTAL);
    });
  });

  // ── Presale vesting (0 cliff, 6m linear, 25% TGE) ─────────────────────────

  describe("Presale vesting (0 cliff, 6m linear, 25% TGE)", function () {
    it("25% releasable immediately after TGE", async function () {
      const { vault, admin } = await deployStandardVault(0, 180, 2500);
      await vault.connect(admin).triggerTGE();

      const tgeAmount = TOTAL * 2500n / 10000n;
      expect(await vault.releasable()).to.be.closeTo(tgeAmount, ethers.parseUnits("1", 18));
    });

    it("50% releasable after 3 months (TGE 25% + 3/6 of 75%)", async function () {
      const { vault, admin } = await deployStandardVault(0, 180, 2500);
      await vault.connect(admin).triggerTGE();

      await time.increase(90 * 86400); // 3 months

      const tgeAmount   = TOTAL * 2500n / 10000n;      // 25%
      const vestingPart = TOTAL - tgeAmount;            // 75%
      const halfVested  = vestingPart / 2n;             // 3/6 months
      const expected    = tgeAmount + halfVested;       // ~50%

      expect(await vault.releasable()).to.be.closeTo(expected, ethers.parseUnits("1000", 18));
    });

    it("100% releasable after 6 months", async function () {
      const { vault, admin } = await deployStandardVault(0, 180, 2500);
      await vault.connect(admin).triggerTGE();

      await time.increase(181 * 86400);
      expect(await vault.releasable()).to.equal(TOTAL);
    });
  });

  // ── Release ────────────────────────────────────────────────────────────────

  describe("release()", function () {
    it("transfers vested tokens to beneficiary", async function () {
      const { vault, token, admin, beneficiary } = await deployStandardVault(0, 180, 2500);
      await vault.connect(admin).triggerTGE();

      const before = await token.balanceOf(beneficiary.address);
      await vault.connect(beneficiary).release();
      const after = await token.balanceOf(beneficiary.address);

      expect(after).to.be.gt(before);
    });

    it("updates released counter", async function () {
      const { vault, admin, beneficiary } = await deployStandardVault(0, 180, 2500);
      await vault.connect(admin).triggerTGE();

      const releasable = await vault.releasable();
      await vault.connect(beneficiary).release();
      // release() executes one block later — 1 extra second of vesting may accrue
      expect(await vault.released()).to.be.closeTo(releasable, ethers.parseUnits("1", 18));
    });

    it("reverts if called by non-beneficiary", async function () {
      const { vault, admin, other } = await deployStandardVault(0, 180, 2500);
      await vault.connect(admin).triggerTGE();

      await expect(vault.connect(other).release())
        .to.be.revertedWithCustomError(vault, "OnlyBeneficiary");
    });

    it("reverts if nothing to release", async function () {
      const { vault, admin, beneficiary } = await deployStandardVault(365, 1095, 0);
      await vault.connect(admin).triggerTGE();

      await expect(vault.connect(beneficiary).release())
        .to.be.revertedWithCustomError(vault, "NothingToRelease");
    });

    it("reverts if TGE not triggered", async function () {
      const { vault, beneficiary } = await deployStandardVault(0, 180, 2500);
      await expect(vault.connect(beneficiary).release())
        .to.be.revertedWithCustomError(vault, "TGENotTriggered");
    });
  });

  // ── TGE trigger ────────────────────────────────────────────────────────────

  describe("triggerTGE()", function () {
    it("sets tgeTriggered = true", async function () {
      const { vault, admin } = await deployStandardVault(365, 1095, 0);
      await vault.connect(admin).triggerTGE();
      expect(await vault.tgeTriggered()).to.be.true;
    });

    it("reverts if called twice", async function () {
      const { vault, admin } = await deployStandardVault(365, 1095, 0);
      await vault.connect(admin).triggerTGE();
      await expect(vault.connect(admin).triggerTGE())
        .to.be.revertedWithCustomError(vault, "TGEAlreadyTriggered");
    });

    it("reverts if not admin", async function () {
      const { vault, beneficiary } = await deployStandardVault(365, 1095, 0);
      await expect(vault.connect(beneficiary).triggerTGE())
        .to.be.revertedWithCustomError(vault, "OnlyAdmin");
    });
  });

  // ── Revocation ─────────────────────────────────────────────────────────────

  describe("revoke()", function () {
    it("sends releasable amount to beneficiary and unvested to recipient", async function () {
      const { vault, token, admin, beneficiary, treasury } = await deployStandardVault(0, 365, 0);
      await vault.connect(admin).triggerTGE();
      await time.increase(180 * 86400); // 6 months in — ~50% vested

      const vaultBal = await token.balanceOf(await vault.getAddress());
      const vestedSoFar = await vault.vestedAmount();
      const expectedBeneficiary = vestedSoFar; // releasable
      const expectedTreasury    = vaultBal - vestedSoFar; // unvested

      await vault.connect(admin).revoke(treasury.address);

      expect(await token.balanceOf(beneficiary.address)).to.be.closeTo(
        expectedBeneficiary, ethers.parseUnits("100", 18)
      );
      expect(await token.balanceOf(treasury.address)).to.be.closeTo(
        expectedTreasury, ethers.parseUnits("100", 18)
      );
    });

    it("sets revoked = true", async function () {
      const { vault, admin, treasury } = await deployStandardVault(0, 365, 0);
      await vault.connect(admin).triggerTGE();
      await vault.connect(admin).revoke(treasury.address);
      expect(await vault.revoked()).to.be.true;
    });

    it("blocks release after revocation", async function () {
      const { vault, admin, beneficiary, treasury } = await deployStandardVault(0, 365, 2500);
      await vault.connect(admin).triggerTGE();
      await vault.connect(admin).revoke(treasury.address);

      await expect(vault.connect(beneficiary).release())
        .to.be.revertedWithCustomError(vault, "VaultRevoked");
    });

    it("reverts if not admin", async function () {
      const { vault, admin, beneficiary, treasury } = await deployStandardVault(0, 365, 0);
      await vault.connect(admin).triggerTGE();

      await expect(vault.connect(beneficiary).revoke(treasury.address))
        .to.be.revertedWithCustomError(vault, "OnlyAdmin");
    });

    it("reverts if TGE not yet triggered (A3-M-02: prevents token lock)", async function () {
      // Without the A3-M-02 guard, revoking a pre-TGE vault would set revoked=true
      // with unvested=0 (initialAllocation not yet set), trapping all vault tokens
      // permanently with no admin recovery path.
      const { vault, admin, treasury } = await deployStandardVault(0, 365, 0);
      // Do NOT call triggerTGE — vault is funded but TGE clock not started
      await expect(vault.connect(admin).revoke(treasury.address))
        .to.be.revertedWithCustomError(vault, "TGENotTriggered");
    });

    it("reverts if already revoked", async function () {
      const { vault, admin, treasury } = await deployStandardVault(0, 365, 0);
      await vault.connect(admin).triggerTGE();
      await vault.connect(admin).revoke(treasury.address);

      await expect(vault.connect(admin).revoke(treasury.address))
        .to.be.revertedWithCustomError(vault, "AlreadyRevoked");
    });

    it("uses initialAllocation snapshot not live balance for unvested calculation (A2-M-03)", async function () {
      const { vault, token, admin, beneficiary, treasury, other } = await deployStandardVault(0, 365, 0);
      await vault.connect(admin).triggerTGE();

      // Accidentally send extra tokens to the vault — should NOT inflate unvested calculation
      const extra = ethers.parseUnits("100000", 18);
      await token.connect(admin).transfer(await vault.getAddress(), extra);

      await time.increase(182 * 86400); // ~50% vested

      const initialAlloc = await vault.initialAllocation();
      const vestedSoFar  = await vault.vestedAmount();
      // Expected unvested = initialAllocation - released - releasable
      // NOT live balance - released - releasable (which would include the extra tokens)
      const releasableNow = vestedSoFar; // released=0
      const expectedUnvested = initialAlloc - releasableNow;

      const treasuryBefore = await token.balanceOf(treasury.address);
      await vault.connect(admin).revoke(treasury.address);
      const treasuryAfter  = await token.balanceOf(treasury.address);

      // Extra tokens should NOT be swept to treasury
      expect(treasuryAfter - treasuryBefore).to.be.closeTo(
        expectedUnvested, ethers.parseUnits("100", 18)
      );
    });
  });

  // ── Round 6: rescueDonatedTokens() (A6-VV-02) ─────────────────────────────

  describe("rescueDonatedTokens() (A6-VV-02)", function () {
    it("reverts if vault has not been revoked yet", async function () {
      const { vault, admin, treasury } = await deployStandardVault(0, 365, 0);
      await vault.connect(admin).triggerTGE();
      // Vault is active — rescue must reject
      await expect(vault.connect(admin).rescueDonatedTokens(treasury.address))
        .to.be.revertedWithCustomError(vault, "VaultNotRevoked");
    });

    it("reverts if called by non-admin", async function () {
      const { vault, admin, beneficiary, treasury } = await deployStandardVault(0, 365, 0);
      await vault.connect(admin).triggerTGE();
      await vault.connect(admin).revoke(treasury.address);
      await expect(vault.connect(beneficiary).rescueDonatedTokens(treasury.address))
        .to.be.revertedWithCustomError(vault, "OnlyAdmin");
    });

    it("reverts if zero-address recipient", async function () {
      const { vault, admin, treasury } = await deployStandardVault(0, 365, 0);
      await vault.connect(admin).triggerTGE();
      await vault.connect(admin).revoke(treasury.address);
      await expect(vault.connect(admin).rescueDonatedTokens(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("reverts if no donated tokens are present after revoke", async function () {
      const { vault, admin, treasury } = await deployStandardVault(0, 365, 0);
      await vault.connect(admin).triggerTGE();
      await vault.connect(admin).revoke(treasury.address);
      // After revoke, vault balance should be 0 (all swept)
      await expect(vault.connect(admin).rescueDonatedTokens(treasury.address))
        .to.be.revertedWithCustomError(vault, "NoDonatedTokens");
    });

    it("rescues tokens accidentally sent to a revoked vault", async function () {
      const { vault, token, admin, treasury, other } = await deployStandardVault(0, 365, 0);
      await vault.connect(admin).triggerTGE();
      await vault.connect(admin).revoke(treasury.address);

      // Accidentally send tokens to the revoked vault
      const donated = ethers.parseUnits("500", 18);
      await token.connect(admin).transfer(await vault.getAddress(), donated);

      const before = await token.balanceOf(treasury.address);
      await vault.connect(admin).rescueDonatedTokens(treasury.address);
      const after  = await token.balanceOf(treasury.address);

      expect(after - before).to.equal(donated);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(0n);
    });
  });
});
