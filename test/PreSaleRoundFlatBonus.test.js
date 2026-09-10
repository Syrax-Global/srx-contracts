// Genesis round — PreSaleRound deployed in flat-bonus mode.
//
// The Genesis page promises ONE +50% founding bonus to every participant,
// whatever their size. The contract used to pay only a 10–20% ladder that rises
// with the amount invested, so the only way to hand out +50% was an admin typing
// each allocation by hand through updateAllocation() — which made the contract
// back-calculate, and permanently record, a payment ~36% larger than the real
// one. These tests pin the flat mode that replaces that workaround, and the
// Genesis terms it is deployed with (300M SRX cap, +50%, seed vesting schedule).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("PreSaleRound — flat bonus mode (Genesis)", function () {
  const SRX_PRICE_8DEC = 1_250_000n;                         // $0.0125
  const GENESIS_BONUS  = 5_000n;                             // +50%
  const GENESIS_CAP    = ethers.parseUnits("300000000", 18); // 300M SRX
  const ETH_PRICE_8DEC = 2_500n * 10n ** 8n;
  const BTC_PRICE_8DEC = 60_000n * 10n ** 8n;

  const usd = (dollars) => BigInt(dollars) * 10n ** 8n;      // whole dollars → 8-dec USD
  const srx = (n) => ethers.parseUnits(String(n), 18);

  async function baseFixture() {
    const [admin, investor1, investor2] = await ethers.getSigners();

    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const endpoint = await MockLZEndpoint.deploy(40161);
    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await endpoint.getAddress(), admin.address);
    await token.connect(admin).genesis(admin.address);

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    const usdt = await MockERC20.deploy("Tether USD", "USDT", 6);
    const wbtc = await MockERC20.deploy("Wrapped BTC", "WBTC", 8);
    await usdc.mint(investor1.address, 1_000_000n * 10n ** 6n); // 1M USDC

    const MockFeed = await ethers.getContractFactory("MockChainlinkFeed");
    const ethFeed = await MockFeed.deploy(ETH_PRICE_8DEC);
    const btcFeed = await MockFeed.deploy(BTC_PRICE_8DEC);

    return { token, usdc, usdt, wbtc, ethFeed, btcFeed, admin, investor1, investor2 };
  }

  async function deployRound(env, flat, bonusBps, cap = GENESIS_CAP) {
    const PreSaleRound = await ethers.getContractFactory("PreSaleRound");
    return PreSaleRound.deploy(
      await env.token.getAddress(),
      await env.usdc.getAddress(),
      await env.usdt.getAddress(),
      await env.wbtc.getAddress(),
      await env.ethFeed.getAddress(),
      await env.btcFeed.getAddress(),
      env.admin.address,
      cap,
      SRX_PRICE_8DEC,
      flat,
      bonusBps
    );
  }

  // Exactly what scripts/deploy/10_deploy_presale.js deploys for Genesis.
  async function genesisFixture() {
    const env = await baseFixture();
    const round = await deployRound(env, true, GENESIS_BONUS);
    await env.token.connect(env.admin).transfer(await round.getAddress(), GENESIS_CAP);
    return { ...env, round };
  }

  describe("configuration", function () {
    it("records the flat mode and the +50% rate", async function () {
      const { round } = await loadFixture(genesisFixture);
      expect(await round.flatBonusEnabled()).to.equal(true);
      expect(await round.flatBonusBps()).to.equal(GENESIS_BONUS);
      expect(await round.MAX_FLAT_BONUS_BPS()).to.equal(10_000n);
    });

    it("has no function that can change the bonus after deployment", async function () {
      const { round } = await loadFixture(genesisFixture);
      const bonusWriters = round.interface.fragments.filter(
        (f) => f.type === "function" && /bonus/i.test(f.name) && !["view", "pure"].includes(f.stateMutability)
      );
      expect(bonusWriters.map((f) => f.name)).to.deep.equal([]);
    });
  });

  describe("allocation", function () {
    it("$10,000 buys exactly 1,200,000 SRX — 800,000 base plus 50%", async function () {
      const { round, admin, investor1 } = await loadFixture(genesisFixture);
      await expect(round.connect(admin).addInvestor(investor1.address, usd(10_000)))
        .to.emit(round, "BonusApplied")
        .withArgs(investor1.address, "Flat", GENESIS_BONUS, srx(800_000), srx(1_200_000));
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(srx(1_200_000));
    });

    it("the rate does not step up with size — $400,000 still earns exactly +50%", async function () {
      const { round, admin, investor1 } = await loadFixture(genesisFixture);
      await round.connect(admin).addInvestor(investor1.address, usd(400_000));
      // The ladder would have paid +20% here (38.4M); flat mode pays +50%.
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(srx(48_000_000));
    });

    it("a top-up across the ladder's old $100,000 boundary stays at +50%", async function () {
      const { round, admin, investor1 } = await loadFixture(genesisFixture);
      await round.connect(admin).addInvestor(investor1.address, usd(90_000));
      await round.connect(admin).addInvestor(investor1.address, usd(20_000));
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(srx(13_200_000));
    });

    it("the on-chain USDC path pays the same flat rate as an admin-recorded wire", async function () {
      const { round, usdc, investor1 } = await loadFixture(genesisFixture);
      const amount = 10_000n * 10n ** 6n;
      await usdc.connect(investor1).approve(await round.getAddress(), amount);
      await round.connect(investor1).investWithUSDC(amount);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(srx(1_200_000));
    });

    it("a quote equals what is then received", async function () {
      const { round, usdc, investor1 } = await loadFixture(genesisFixture);
      const amount = 25_000n * 10n ** 6n;
      const quoted = await round.quoteStable(amount, investor1.address);
      await usdc.connect(investor1).approve(await round.getAddress(), amount);
      await round.connect(investor1).investWithUSDC(amount);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(quoted);
      expect(quoted).to.equal(srx(3_000_000));
    });

    it("every tier view reports Flat at +50%, at any size", async function () {
      const { round, admin, investor1 } = await loadFixture(genesisFixture);
      for (const dollars of [1, 99_999, 100_000, 500_000]) {
        const [name, bps] = await round.quoteTier(usd(dollars));
        expect(name).to.equal("Flat");
        expect(bps).to.equal(GENESIS_BONUS);
      }
      await round.connect(admin).addInvestor(investor1.address, usd(10_000));
      expect(await round.getTierName(investor1.address)).to.equal("Flat");
      expect(await round.getBonusBps(investor1.address)).to.equal(GENESIS_BONUS);
    });
  });

  describe("the on-chain record of what was paid", function () {
    it("REGRESSION: a manual correction records the true payment, not an inflated one", async function () {
      const { round, admin, investor1 } = await loadFixture(genesisFixture);
      await round.connect(admin).addInvestor(investor1.address, usd(1_000));
      await round.connect(admin).updateAllocation(investor1.address, srx(1_200_000));
      // 1,200,000 SRX at $0.0125 with +50% is exactly $10,000 paid.
      expect((await round.investors(investor1.address)).cumulativeUsd8Dec).to.equal(usd(10_000));
    });

    it("contrast: the same correction on a ladder round would record ~$13,636", async function () {
      const env = await loadFixture(baseFixture);
      const ladder = await deployRound(env, false, 0n);
      await ladder.connect(env.admin).addInvestor(env.investor1.address, usd(1_000));
      await ladder.connect(env.admin).updateAllocation(env.investor1.address, srx(1_200_000));
      const recorded = (await ladder.investors(env.investor1.address)).cumulativeUsd8Dec;
      expect(recorded).to.equal(srx(1_200_000) * SRX_PRICE_8DEC * 10_000n / (10n ** 18n * 11_000n));
      expect(recorded).to.be.greaterThan(usd(13_636)); // why flat mode exists
    });
  });

  describe("capacity", function () {
    it("the 300M SRX cap is exactly a $2,500,000 round", async function () {
      const { round, admin, investor1, investor2 } = await loadFixture(genesisFixture);
      await round.connect(admin).addInvestor(investor1.address, usd(2_500_000));
      expect(await round.totalAllocated()).to.equal(GENESIS_CAP);
      expect(await round.remainingCap()).to.equal(0n);
      await expect(round.connect(admin).addInvestor(investor2.address, usd(1)))
        .to.be.revertedWithCustomError(round, "HardCapExceeded");
    });
  });

  describe("vesting stays on the seed schedule the Genesis page now states", function () {
    it("a Genesis vault releases nothing at launch, then a 273-day cliff, then 730 days linear", async function () {
      const { round, admin, investor1 } = await loadFixture(genesisFixture);
      await round.connect(admin).addInvestor(investor1.address, usd(10_000));
      await round.connect(admin).deployVault(investor1.address);
      const vault = await ethers.getContractAt("VestingVault", await round.getVault(investor1.address));
      expect(await vault.tgeUnlockBps()).to.equal(0n);
      expect(await vault.cliffDuration()).to.equal(273n * 86400n);
      expect(await vault.vestingDuration()).to.equal(730n * 86400n);
    });
  });

  describe("constructor validation", function () {
    it("rejects a flat rate above the +100% ceiling (a 50_000-for-50% typo)", async function () {
      const env = await loadFixture(baseFixture);
      const factory = await ethers.getContractFactory("PreSaleRound");
      await expect(deployRound(env, true, 10_001n)).to.be.revertedWithCustomError(factory, "InvalidFlatBonus");
      await expect(deployRound(env, true, 50_000n)).to.be.revertedWithCustomError(factory, "InvalidFlatBonus");
    });

    it("rejects a rate passed in ladder mode, where it would be silently ignored", async function () {
      const env = await loadFixture(baseFixture);
      const factory = await ethers.getContractFactory("PreSaleRound");
      await expect(deployRound(env, false, GENESIS_BONUS)).to.be.revertedWithCustomError(factory, "InvalidFlatBonus");
    });

    it("accepts the ceiling itself", async function () {
      const env = await loadFixture(baseFixture);
      const round = await deployRound(env, true, 10_000n);
      expect(await round.flatBonusBps()).to.equal(10_000n);
    });

    it("flat 0% is a valid no-bonus round", async function () {
      const env = await loadFixture(baseFixture);
      const round = await deployRound(env, true, 0n);
      await round.connect(env.admin).addInvestor(env.investor1.address, usd(10_000));
      expect((await round.investors(env.investor1.address)).srxAllocation).to.equal(srx(800_000));
    });

    it("ladder mode is unchanged when flat is off — $100,000 is Standard at +12.5%", async function () {
      const env = await loadFixture(baseFixture);
      const round = await deployRound(env, false, 0n);
      await round.connect(env.admin).addInvestor(env.investor1.address, usd(100_000));
      expect((await round.investors(env.investor1.address)).srxAllocation).to.equal(srx(9_000_000));
      expect(await round.getTierName(env.investor1.address)).to.equal("Standard");
    });
  });
});
