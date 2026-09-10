const { expect }  = require("chai");
const { ethers }  = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/**
 * TGEDistributor tests.
 *
 * Key design point: TGEDistributor.distribute() sends tokens to each vault
 * but does NOT call triggerTGE(). That is done separately by the admin
 * (step 3 in 06_execute_tge.js) because the vault admin is the Gnosis Safe,
 * not the distributor contract. This is the correct separation of concerns:
 *  - Distributor controls token movement
 *  - Admin (Safe) controls when vesting clocks start
 *  - Admin (Safe) controls revocation
 */
describe("TGEDistributor", function () {

  const MAX_SUPPLY = ethers.parseUnits("10000000000", 18); // 10B SRX

  const AMOUNTS = {
    founders:      ethers.parseUnits("1000000000", 18),
    coreTeam:      ethers.parseUnits("600000000",  18),
    seedInvestors: ethers.parseUnits("400000000",  18),
    presale:       ethers.parseUnits("1400000000", 18),
    ecosystem:     ethers.parseUnits("1300000000", 18),
    liquidity:     ethers.parseUnits("1200000000", 18),
    staking:       ethers.parseUnits("1700000000", 18),
    treasury:      ethers.parseUnits("900000000",  18),
    strategic:     ethers.parseUnits("1500000000", 18),
  };

  async function deployFixture() {
    const [admin, stranger] = await ethers.getSigners();

    // Dedicated wallets for non-vested direct allocations
    const liquidityWallet  = ethers.Wallet.createRandom().connect(ethers.provider);
    const stakingWallet    = ethers.Wallet.createRandom().connect(ethers.provider);
    const treasuryWallet   = ethers.Wallet.createRandom().connect(ethers.provider);
    const strategicWallet  = ethers.Wallet.createRandom().connect(ethers.provider);

    // ── Token ─────────────────────────────────────────────────────────────
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();

    // ── VestingVaults (admin = admin.address so admin can call triggerTGE) ─
    const VestingVault = await ethers.getContractFactory("VestingVault");

    async function deployVault(beneficiary, cliffDays, vestingDays, tgeBps) {
      const vault = await VestingVault.deploy(
        await token.getAddress(), // token
        beneficiary,              // beneficiary
        admin.address,            // admin (can call triggerTGE + revoke)
        BigInt(cliffDays)   * 86400n,
        BigInt(vestingDays) * 86400n,
        BigInt(tgeBps)
      );
      await vault.waitForDeployment();
      return vault;
    }

    const foundersVault  = await deployVault(admin.address, 365, 1095, 0);
    const coreTeamVault  = await deployVault(admin.address, 182,  730, 0);
    const seedVault      = await deployVault(admin.address, 273,  730, 0);
    const presaleVault   = await deployVault(admin.address,   0,  180, 2500);
    const ecosystemVault = await deployVault(admin.address,   0, 1460, 0);

    // ── TGEDistributor ────────────────────────────────────────────────────
    const TGEDistributor = await ethers.getContractFactory("TGEDistributor");
    const distributor = await TGEDistributor.deploy(await token.getAddress(), admin.address);
    await distributor.waitForDeployment();
    const distributorAddr = await distributor.getAddress();

    // ── Build allocation array ────────────────────────────────────────────
    const allocations = [
      { destination: await foundersVault.getAddress(),  amount: AMOUNTS.founders,      isVestingVault: true,  label: "Founders" },
      { destination: await coreTeamVault.getAddress(),  amount: AMOUNTS.coreTeam,      isVestingVault: true,  label: "CoreTeam" },
      { destination: await seedVault.getAddress(),      amount: AMOUNTS.seedInvestors, isVestingVault: true,  label: "Seed" },
      { destination: await presaleVault.getAddress(),   amount: AMOUNTS.presale,       isVestingVault: true,  label: "Presale" },
      { destination: await ecosystemVault.getAddress(), amount: AMOUNTS.ecosystem,     isVestingVault: true,  label: "Ecosystem" },
      { destination: liquidityWallet.address,           amount: AMOUNTS.liquidity,     isVestingVault: false, label: "Liquidity" },
      { destination: stakingWallet.address,             amount: AMOUNTS.staking,       isVestingVault: false, label: "Staking" },
      { destination: treasuryWallet.address,            amount: AMOUNTS.treasury,      isVestingVault: false, label: "Treasury" },
      { destination: strategicWallet.address,           amount: AMOUNTS.strategic,     isVestingVault: false, label: "Strategic" },
    ];

    return {
      token, distributor, distributorAddr,
      foundersVault, coreTeamVault, seedVault, presaleVault, ecosystemVault,
      liquidityWallet, stakingWallet, treasuryWallet, strategicWallet,
      allocations, admin, stranger,
    };
  }

  // Full distribute flow: setAllocations → genesis → distribute → triggerTGE
  async function fullDistribute(ctx) {
    const { token, distributor, distributorAddr, allocations, admin,
            foundersVault, coreTeamVault, seedVault, presaleVault, ecosystemVault } = ctx;

    await distributor.connect(admin).setAllocations(allocations);
    await token.connect(admin).genesis(distributorAddr);
    await distributor.connect(admin).distribute();

    // Step 3: admin triggers TGE on each vault separately
    for (const vault of [foundersVault, coreTeamVault, seedVault, presaleVault, ecosystemVault]) {
      await vault.connect(admin).triggerTGE();
    }
  }

  // ── Deployment ─────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets admin correctly", async function () {
      const { distributor, admin } = await loadFixture(deployFixture);
      expect(await distributor.admin()).to.equal(admin.address);
    });

    it("distributed starts as false", async function () {
      const { distributor } = await loadFixture(deployFixture);
      expect(await distributor.distributed()).to.be.false;
    });

    it("MAX_SUPPLY is 10B SRX", async function () {
      const { distributor } = await loadFixture(deployFixture);
      expect(await distributor.MAX_SUPPLY()).to.equal(MAX_SUPPLY);
    });
  });

  // ── setAllocations ─────────────────────────────────────────────────────────

  describe("setAllocations()", function () {
    it("accepts a valid allocation set summing to MAX_SUPPLY", async function () {
      const { distributor, allocations, admin } = await loadFixture(deployFixture);
      await expect(distributor.connect(admin).setAllocations(allocations)).to.not.be.reverted;
    });

    it("reverts if total does not equal MAX_SUPPLY", async function () {
      const { distributor, allocations, admin } = await loadFixture(deployFixture);
      const bad = allocations.map((a, i) => i === 0 ? { ...a, amount: a.amount - 1n } : a);
      await expect(
        distributor.connect(admin).setAllocations(bad)
      ).to.be.revertedWithCustomError(distributor, "SupplyMismatch");
    });

    it("reverts if a destination is zero address", async function () {
      const { distributor, allocations, admin } = await loadFixture(deployFixture);
      const bad = allocations.map((a, i) => i === 0 ? { ...a, destination: ethers.ZeroAddress } : a);
      await expect(
        distributor.connect(admin).setAllocations(bad)
      ).to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("reverts if called by non-admin", async function () {
      const { distributor, allocations, stranger } = await loadFixture(deployFixture);
      await expect(
        distributor.connect(stranger).setAllocations(allocations)
      ).to.be.revertedWithCustomError(distributor, "OnlyAdmin");
    });

    it("reverts if called after distribution", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);
      await expect(
        ctx.distributor.connect(ctx.admin).setAllocations(ctx.allocations)
      ).to.be.revertedWithCustomError(ctx.distributor, "AlreadyDistributed");
    });

    it("can be called multiple times before distribution (overwrites)", async function () {
      const { distributor, allocations, admin } = await loadFixture(deployFixture);
      await distributor.connect(admin).setAllocations(allocations);
      await expect(distributor.connect(admin).setAllocations(allocations)).to.not.be.reverted;
    });
  });

  // ── distribute ────────────────────────────────────────────────────────────

  describe("distribute()", function () {
    it("sets distributed to true", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);
      expect(await ctx.distributor.distributed()).to.be.true;
    });

    it("emits DistributionComplete with MAX_SUPPLY", async function () {
      const { token, distributor, distributorAddr, allocations, admin } =
        await loadFixture(deployFixture);

      await distributor.connect(admin).setAllocations(allocations);
      await token.connect(admin).genesis(distributorAddr);

      await expect(distributor.connect(admin).distribute())
        .to.emit(distributor, "DistributionComplete")
        .withArgs(MAX_SUPPLY, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));
    });

    it("emits AllocationSent for every allocation", async function () {
      const { token, distributor, distributorAddr, allocations, admin } =
        await loadFixture(deployFixture);

      await distributor.connect(admin).setAllocations(allocations);
      await token.connect(admin).genesis(distributorAddr);

      const tx      = await distributor.connect(admin).distribute();
      const receipt = await tx.wait();
      const sent    = receipt.logs.filter(l => l.fragment?.name === "AllocationSent");
      expect(sent.length).to.equal(allocations.length);
    });

    it("distributor holds zero SRX after distribution", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);
      expect(await ctx.token.balanceOf(ctx.distributorAddr)).to.equal(0n);
    });

    it("total supply matches MAX_SUPPLY after distribution", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);
      expect(await ctx.token.totalSupply()).to.equal(MAX_SUPPLY);
    });

    it("direct wallets receive correct amounts", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);

      expect(await ctx.token.balanceOf(ctx.liquidityWallet.address)).to.equal(AMOUNTS.liquidity);
      expect(await ctx.token.balanceOf(ctx.stakingWallet.address)).to.equal(AMOUNTS.staking);
      expect(await ctx.token.balanceOf(ctx.treasuryWallet.address)).to.equal(AMOUNTS.treasury);
      expect(await ctx.token.balanceOf(ctx.strategicWallet.address)).to.equal(AMOUNTS.strategic);
    });

    it("vesting vaults receive correct amounts", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);

      expect(await ctx.token.balanceOf(await ctx.foundersVault.getAddress())).to.equal(AMOUNTS.founders);
      expect(await ctx.token.balanceOf(await ctx.presaleVault.getAddress())).to.equal(AMOUNTS.presale);
    });

    it("reverts if genesis not yet called (insufficient balance)", async function () {
      const { distributor, allocations, admin } = await loadFixture(deployFixture);
      await distributor.connect(admin).setAllocations(allocations);
      await expect(
        distributor.connect(admin).distribute()
      ).to.be.revertedWithCustomError(distributor, "TokenBalanceInsufficient");
    });

    it("reverts if called twice", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);
      await expect(
        ctx.distributor.connect(ctx.admin).distribute()
      ).to.be.revertedWithCustomError(ctx.distributor, "AlreadyDistributed");
    });

    it("reverts if called by non-admin", async function () {
      const { token, distributor, distributorAddr, allocations, admin, stranger } =
        await loadFixture(deployFixture);

      await distributor.connect(admin).setAllocations(allocations);
      await token.connect(admin).genesis(distributorAddr);

      await expect(
        distributor.connect(stranger).distribute()
      ).to.be.revertedWithCustomError(distributor, "OnlyAdmin");
    });
  });

  // ── TGE triggering (step 3 — admin calls after distribute) ────────────────

  describe("VestingVault.triggerTGE() — called by admin after distribution", function () {
    it("all vaults triggered after fullDistribute", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);

      for (const vault of [ctx.foundersVault, ctx.coreTeamVault, ctx.seedVault, ctx.presaleVault, ctx.ecosystemVault]) {
        expect(await vault.tgeTriggered()).to.be.true;
        expect(await vault.tgeTimestamp()).to.be.gt(0n);
      }
    });

    it("presale vault has 25% releasable immediately after TGE", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);

      const expectedTGE = (AMOUNTS.presale * 2500n) / 10_000n;
      // fullDistribute() runs ~10 txs, each adding 1s; presale vests ~67.5 SRX/s → allow 1000 SRX
      expect(await ctx.presaleVault.releasable()).to.be.closeTo(
        expectedTGE, ethers.parseUnits("1000", 18)
      );
    });

    it("founders vault has zero releasable immediately (12m cliff)", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);
      expect(await ctx.foundersVault.releasable()).to.equal(0n);
    });

    it("founders vault unlocks after cliff + partial vesting period", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);

      // 365 days cliff + 547 days (half the 1095-day vesting period)
      await time.increase(365 * 86400 + 547 * 86400);

      const releasable    = await ctx.foundersVault.releasable();
      const expectedApprox = (AMOUNTS.founders * 547n) / 1095n;
      const tolerance      = expectedApprox / 100n; // 1%
      expect(releasable).to.be.closeTo(expectedApprox, tolerance);
    });
  });

  // ── recoverToken ───────────────────────────────────────────────────────────

  describe("recoverToken()", function () {
    it("does not revert when called after distribution (even if balance is 0)", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);
      await expect(
        ctx.distributor.connect(ctx.admin).recoverToken(
          await ctx.token.getAddress(), ctx.admin.address
        )
      ).to.not.be.reverted;
    });

    it("reverts if distribution has not happened", async function () {
      const { distributor, token, admin } = await loadFixture(deployFixture);
      await expect(
        distributor.connect(admin).recoverToken(await token.getAddress(), admin.address)
      ).to.be.revertedWithCustomError(distributor, "NotDistributed");
    });

    it("reverts with zero recipient", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);
      await expect(
        ctx.distributor.connect(ctx.admin).recoverToken(
          await ctx.token.getAddress(), ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(ctx.distributor, "ZeroAddress");
    });

    it("reverts if called by non-admin", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);
      await expect(
        ctx.distributor.connect(ctx.stranger).recoverToken(
          await ctx.token.getAddress(), ctx.stranger.address
        )
      ).to.be.revertedWithCustomError(ctx.distributor, "OnlyAdmin");
    });
  });

  // ── Supply integrity ───────────────────────────────────────────────────────

  describe("Supply integrity", function () {
    it("allocation amounts sum exactly to MAX_SUPPLY", function () {
      const total = Object.values(AMOUNTS).reduce((a, b) => a + b, 0n);
      expect(total).to.equal(MAX_SUPPLY);
    });

    it("second genesis call reverts", async function () {
      const ctx = await loadFixture(deployFixture);
      await fullDistribute(ctx);
      await expect(
        ctx.token.connect(ctx.admin).genesis(ctx.admin.address)
      ).to.be.revertedWithCustomError(ctx.token, "GenesisAlreadyComplete");
    });

    it("total supply is unchanged by distribution (tokens redistributed, not re-minted)", async function () {
      const { token, distributor, distributorAddr, allocations, admin } =
        await loadFixture(deployFixture);

      await distributor.connect(admin).setAllocations(allocations);
      await token.connect(admin).genesis(distributorAddr);
      const supplyBeforeDist = await token.totalSupply();

      await distributor.connect(admin).distribute();
      expect(await token.totalSupply()).to.equal(supplyBeforeDist);
    });
  });
});
