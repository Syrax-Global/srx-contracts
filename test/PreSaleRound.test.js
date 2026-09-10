const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("PreSaleRound", function () {

  // ── Constants ────────────────────────────────────────────────────────────────

  const CLIFF   = 273n * 86400n;
  const VESTING = 730n * 86400n;

  // SRX price: $0.0125 = 0.0125 × 1e8 = 1_250_000
  const SRX_PRICE_8DEC = 1_250_000n;

  // Oracle prices (8 decimal Chainlink format)
  const ETH_PRICE_8DEC = 2_500n * 10n ** 8n;  // $2,500 per ETH  → 250_000_000_000
  const BTC_PRICE_8DEC = 60_000n * 10n ** 8n; // $60,000 per BTC → 6_000_000_000_000

  // Participation tier thresholds (cumulative USD in 8-decimal format)
  const TIER_STANDARD_MIN      = 10_000_000_000_000n; // $100,000
  const TIER_ENHANCED_MIN      = 20_000_000_000_000n; // $200,000
  const TIER_PRIORITY_MIN      = 30_000_000_000_000n; // $300,000
  const TIER_INSTITUTIONAL_MIN = 40_000_000_000_000n; // $400,000

  // Tier bonus BPS
  const ENTRY_BPS         = 1_000n; // +10%
  const STANDARD_BPS      = 1_250n; // +12.5%
  const ENHANCED_BPS      = 1_500n; // +15%
  const PRIORITY_BPS      = 1_750n; // +17.5%
  const INSTITUTIONAL_BPS = 2_000n; // +20%

  // USD amounts for addInvestor (8-decimal format)
  const USD_1000_8DEC     = 100_000_000_000n;         // $1,000
  const USD_5000_8DEC     = 500_000_000_000n;         // $5,000
  const USD_10000_8DEC    = 1_000_000_000_000n;       // $10,000
  const USD_100000_8DEC   = 10_000_000_000_000n;      // $100,000
  const USD_150000_8DEC   = 15_000_000_000_000n;      // $150,000
  const USD_200000_8DEC   = 20_000_000_000_000n;      // $200,000
  const USD_300000_8DEC   = 30_000_000_000_000n;      // $300,000
  const USD_400000_8DEC   = 40_000_000_000_000n;      // $400,000
  const USD_EXCEEDS_CAP   = 50_000_000_000_000_000n;  // $500M — far exceeds 400M SRX cap

  const HARD_CAP = ethers.parseUnits("400000000", 18); // 400M SRX

  // ── Helper: compute expected SRX with bonus ───────────────────────────────────
  //
  // Mirrors _computeTotalSRXWithBonus() in the contract:
  //   totalSRX = cumulativeUsd8Dec × 1e18 × (10000 + bonusBps) / srxPriceUsd8Dec / 10000
  //
  function srxWithBonus(cumulativeUsd8Dec, bonusBps) {
    return cumulativeUsd8Dec * 10n ** 18n * (10000n + bonusBps) / SRX_PRICE_8DEC / 10000n;
  }

  // Shortcut for Entry tier (most test amounts are small → Entry)
  function srxEntry(cumulativeUsd8Dec) {
    return srxWithBonus(cumulativeUsd8Dec, ENTRY_BPS);
  }

  // Expected SRX for a single ETH/USDC/WBTC investment (Entry tier, first investment)
  // 1 ETH at $2500: usd = 250_000_000_000 → Entry +10% → 220,000 SRX
  const ETH_USD_8DEC  = ETH_PRICE_8DEC;               // 250_000_000_000 per ETH
  const SRX_PER_ETH_1 = srxEntry(ETH_USD_8DEC);       // 220,000 SRX (was 200,000 base)

  // 1 WBTC at $60,000: usd = 6_000_000_000_000 → Entry +10% → 5,280,000 SRX
  const WBTC_USD_8DEC  = BTC_PRICE_8DEC;               // 6_000_000_000_000 per WBTC
  const SRX_PER_WBTC_1 = srxEntry(WBTC_USD_8DEC);      // 5,280,000 SRX (was 4,800,000 base)

  // 1 USDC (1_000_000 units) = $1: usd = 100_000_000 → Entry +10% → 88 SRX
  const ONE_USDC_USD_8DEC = 100_000_000n;               // $1 in 8-dec
  const SRX_PER_USDC_1    = srxEntry(ONE_USDC_USD_8DEC); // 88 SRX (was 80 base)

  // ── Fixture ───────────────────────────────────────────────────────────────────

  async function deployFixture() {
    const [admin, investor1, investor2, investor3, stranger] = await ethers.getSigners();

    // ── SRX Token ────────────────────────────────────────────────────────────
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint   = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token    = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    // ── Mock stablecoins & WBTC ──────────────────────────────────────────────
    const MockERC20 = await ethers.getContractFactory("MockERC20");

    const mockUsdc = await MockERC20.deploy("USD Coin",  "USDC", 6);
    await mockUsdc.waitForDeployment();

    const mockUsdt = await MockERC20.deploy("Tether USD", "USDT", 6);
    await mockUsdt.waitForDeployment();

    const mockWbtc = await MockERC20.deploy("Wrapped BTC", "WBTC", 8);
    await mockWbtc.waitForDeployment();

    // Mint test balances for investors
    const ONE_USDC  = 1_000_000n;                      // 1 USDC  (6 dec)
    const ONE_WBTC  = 100_000_000n;                    // 1 WBTC  (8 dec)
    const USDC_BAL  = ONE_USDC  * 100_000n;            // 100,000 USDC
    const WBTC_BAL  = ONE_WBTC  * 100n;                // 100 WBTC

    await mockUsdc.mint(investor1.address, USDC_BAL);
    await mockUsdc.mint(investor2.address, USDC_BAL);
    await mockUsdt.mint(investor1.address, USDC_BAL);
    await mockUsdt.mint(investor2.address, USDC_BAL);
    await mockWbtc.mint(investor1.address, WBTC_BAL);
    await mockWbtc.mint(investor2.address, WBTC_BAL);

    // ── Mock Chainlink feeds ─────────────────────────────────────────────────
    const MockFeed = await ethers.getContractFactory("MockChainlinkFeed");

    const ethFeed = await MockFeed.deploy(ETH_PRICE_8DEC);
    await ethFeed.waitForDeployment();

    const btcFeed = await MockFeed.deploy(BTC_PRICE_8DEC);
    await btcFeed.waitForDeployment();

    // ── PreSaleRound ─────────────────────────────────────────────────────────
    const PreSaleRound = await ethers.getContractFactory("PreSaleRound");
    const round = await PreSaleRound.deploy(
      await token.getAddress(),
      await mockUsdc.getAddress(),
      await mockUsdt.getAddress(),
      await mockWbtc.getAddress(),
      await ethFeed.getAddress(),
      await btcFeed.getAddress(),
      admin.address,
      HARD_CAP,
      SRX_PRICE_8DEC
    );
    await round.waitForDeployment();

    // Fund the round with SRX
    await token.connect(admin).transfer(await round.getAddress(), HARD_CAP);

    return {
      round, token, mockUsdc, mockUsdt, mockWbtc, ethFeed, btcFeed,
      admin, investor1, investor2, investor3, stranger,
      ONE_USDC, ONE_WBTC,
    };
  }

  // ── Deployment ────────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets srxToken correctly", async function () {
      const { round, token } = await loadFixture(deployFixture);
      expect(await round.srxToken()).to.equal(await token.getAddress());
    });

    it("sets admin correctly", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      expect(await round.admin()).to.equal(admin.address);
    });

    it("sets hard cap correctly", async function () {
      const { round } = await loadFixture(deployFixture);
      expect(await round.hardCapSRX()).to.equal(HARD_CAP);
    });

    it("sets SRX price correctly", async function () {
      const { round } = await loadFixture(deployFixture);
      expect(await round.srxPriceUsd8Dec()).to.equal(SRX_PRICE_8DEC);
    });

    it("is not finalized at deployment", async function () {
      const { round } = await loadFixture(deployFixture);
      expect(await round.finalized()).to.be.false;
    });

    it("totalAllocated starts at zero", async function () {
      const { round } = await loadFixture(deployFixture);
      expect(await round.totalAllocated()).to.equal(0n);
    });

    it("sets default maxStaleness to 300 seconds", async function () {
      // SC-004 fix: DEFAULT_MAX_STALENESS reduced from 3600s to 1800s (30 minutes)
      // SC-PR-001 fix: further reduced from 1800s to 300s (5 minutes) to close
      // the oracle price-drift MEV window during update lag
      const { round } = await loadFixture(deployFixture);
      expect(await round.maxStaleness()).to.equal(300n);
    });

    it("tier constants are correct", async function () {
      const { round } = await loadFixture(deployFixture);
      expect(await round.TIER_STANDARD_MIN()).to.equal(TIER_STANDARD_MIN);
      expect(await round.TIER_INSTITUTIONAL_MIN()).to.equal(TIER_INSTITUTIONAL_MIN);
      expect(await round.ENTRY_BONUS_BPS()).to.equal(ENTRY_BPS);
      expect(await round.INSTITUTIONAL_BONUS_BPS()).to.equal(INSTITUTIONAL_BPS);
    });

    it("reverts with zero srxToken", async function () {
      const { round, mockUsdc, mockUsdt, mockWbtc, ethFeed, btcFeed, admin } = await loadFixture(deployFixture);
      const PreSaleRound = await ethers.getContractFactory("PreSaleRound");
      await expect(
        PreSaleRound.deploy(
          ethers.ZeroAddress,
          await mockUsdc.getAddress(),
          await mockUsdt.getAddress(),
          await mockWbtc.getAddress(),
          await ethFeed.getAddress(),
          await btcFeed.getAddress(),
          admin.address,
          HARD_CAP,
          SRX_PRICE_8DEC
        )
      ).to.be.revertedWithCustomError(round, "ZeroAddress");
    });

    it("reverts with zero SRX price", async function () {
      const { round, token, mockUsdc, mockUsdt, mockWbtc, ethFeed, btcFeed, admin } = await loadFixture(deployFixture);
      const PreSaleRound = await ethers.getContractFactory("PreSaleRound");
      await expect(
        PreSaleRound.deploy(
          await token.getAddress(),
          await mockUsdc.getAddress(),
          await mockUsdt.getAddress(),
          await mockWbtc.getAddress(),
          await ethFeed.getAddress(),
          await btcFeed.getAddress(),
          admin.address,
          HARD_CAP,
          0n
        )
      ).to.be.revertedWithCustomError(round, "ZeroAmount");
    });
  });

  // ── Participation tier bonuses ─────────────────────────────────────────────────

  describe("Participation tier bonuses", function () {

    it("Entry tier: <$100K cumulative → +10% bonus", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      const expected = srxEntry(USD_10000_8DEC);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(expected);
      expect(await round.getTierName(investor1.address)).to.equal("Entry");
      expect(await round.getBonusBps(investor1.address)).to.equal(ENTRY_BPS);
    });

    it("Standard tier: $100K cumulative → +12.5% bonus", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_100000_8DEC);
      const expected = srxWithBonus(USD_100000_8DEC, STANDARD_BPS);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(expected);
      expect(await round.getTierName(investor1.address)).to.equal("Standard");
      expect(await round.getBonusBps(investor1.address)).to.equal(STANDARD_BPS);
    });

    it("Enhanced tier: $200K cumulative → +15% bonus", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_200000_8DEC);
      const expected = srxWithBonus(USD_200000_8DEC, ENHANCED_BPS);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(expected);
      expect(await round.getTierName(investor1.address)).to.equal("Enhanced");
      expect(await round.getBonusBps(investor1.address)).to.equal(ENHANCED_BPS);
    });

    it("Priority tier: $300K cumulative → +17.5% bonus", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_300000_8DEC);
      const expected = srxWithBonus(USD_300000_8DEC, PRIORITY_BPS);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(expected);
      expect(await round.getTierName(investor1.address)).to.equal("Priority");
      expect(await round.getBonusBps(investor1.address)).to.equal(PRIORITY_BPS);
    });

    it("Institutional tier: $400K cumulative → +20% bonus", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_400000_8DEC);
      const expected = srxWithBonus(USD_400000_8DEC, INSTITUTIONAL_BPS);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(expected);
      expect(await round.getTierName(investor1.address)).to.equal("Institutional");
      expect(await round.getBonusBps(investor1.address)).to.equal(INSTITUTIONAL_BPS);
    });

    it("Tier upgrade on top-up: Entry → Standard retroactively upgrades full allocation", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);

      // First investment: $50K → Entry tier
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC * 5n);
      const afterFirst = srxEntry(USD_10000_8DEC * 5n);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(afterFirst);
      expect(await round.getTierName(investor1.address)).to.equal("Entry");

      // Top-up $60K → cumulative $110K → Standard tier
      // FULL $110K is recalculated at Standard rate
      const USD_50K = USD_10000_8DEC * 5n;
      const USD_60K = USD_10000_8DEC * 6n;
      await round.connect(admin).addInvestor(investor1.address, USD_60K);
      const newCumulative = USD_50K + USD_60K; // $110K
      const afterUpgrade  = srxWithBonus(newCumulative, STANDARD_BPS);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(afterUpgrade);
      expect(await round.getTierName(investor1.address)).to.equal("Standard");

      // Verify the upgrade gave MORE SRX than if Entry had applied throughout
      const entryEquivalent = srxEntry(newCumulative);
      expect(afterUpgrade).to.be.gt(entryEquivalent);
    });

    it("Tier upgrade on top-up: Standard → Enhanced retroactively upgrades full allocation", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);

      // Start at $150K → Standard tier
      await round.connect(admin).addInvestor(investor1.address, USD_150000_8DEC);
      expect(await round.getTierName(investor1.address)).to.equal("Standard");

      // Top-up $60K → cumulative $210K → Enhanced tier
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC * 6n);
      const cumulative = USD_150000_8DEC + USD_10000_8DEC * 6n;
      expect(await round.getTierName(investor1.address)).to.equal("Enhanced");
      expect((await round.investors(investor1.address)).srxAllocation)
        .to.equal(srxWithBonus(cumulative, ENHANCED_BPS));
    });

    it("BonusApplied event emitted on every investment", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      const expected = srxEntry(USD_10000_8DEC);
      const base     = USD_10000_8DEC * 10n ** 18n / SRX_PRICE_8DEC;

      await expect(round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC))
        .to.emit(round, "BonusApplied")
        .withArgs(investor1.address, "Entry", ENTRY_BPS, base, expected);
    });

    it("BonusApplied emitted with upgraded tier name on tier-crossing top-up", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC * 9n); // $90K Entry
      // Top-up $20K → $110K → Standard
      const cumulative = USD_10000_8DEC * 9n + USD_10000_8DEC * 2n;
      const expected   = srxWithBonus(cumulative, STANDARD_BPS);
      await expect(round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC * 2n))
        .to.emit(round, "BonusApplied")
        .withArgs(investor1.address, "Standard", STANDARD_BPS,
          cumulative * 10n ** 18n / SRX_PRICE_8DEC, expected);
    });

    it("quoteTier returns correct tier name and BPS", async function () {
      const { round } = await loadFixture(deployFixture);
      let result;

      result = await round.quoteTier(USD_10000_8DEC);
      expect(result.tierName).to.equal("Entry");
      expect(result.bonusBps).to.equal(ENTRY_BPS);

      result = await round.quoteTier(TIER_STANDARD_MIN);
      expect(result.tierName).to.equal("Standard");
      expect(result.bonusBps).to.equal(STANDARD_BPS);

      result = await round.quoteTier(TIER_ENHANCED_MIN);
      expect(result.tierName).to.equal("Enhanced");
      expect(result.bonusBps).to.equal(ENHANCED_BPS);

      result = await round.quoteTier(TIER_PRIORITY_MIN);
      expect(result.tierName).to.equal("Priority");
      expect(result.bonusBps).to.equal(PRIORITY_BPS);

      result = await round.quoteTier(TIER_INSTITUTIONAL_MIN);
      expect(result.tierName).to.equal("Institutional");
      expect(result.bonusBps).to.equal(INSTITUTIONAL_BPS);
    });

    it("totalAllocated tracks delta correctly across tier upgrade", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);

      // First: $50K → Entry
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC * 5n);
      const afterFirst = srxEntry(USD_10000_8DEC * 5n);
      expect(await round.totalAllocated()).to.equal(afterFirst);

      // Top-up: $60K → $110K → Standard
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC * 6n);
      const afterUpgrade = srxWithBonus(USD_10000_8DEC * 11n, STANDARD_BPS);
      expect(await round.totalAllocated()).to.equal(afterUpgrade);
    });

    it("on-chain ETH investment receives Entry tier bonus", async function () {
      const { round, investor1 } = await loadFixture(deployFixture);
      await round.connect(investor1).invest({ value: ethers.parseEther("1") });
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(SRX_PER_ETH_1);
      expect(await round.getBonusBps(investor1.address)).to.equal(ENTRY_BPS);
    });

    it("on-chain USDC investment receives Entry tier bonus", async function () {
      const { round, mockUsdc, investor1, ONE_USDC } = await loadFixture(deployFixture);
      await mockUsdc.connect(investor1).approve(await round.getAddress(), ONE_USDC);
      await round.connect(investor1).investWithUSDC(ONE_USDC);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(SRX_PER_USDC_1);
      expect(await round.getBonusBps(investor1.address)).to.equal(ENTRY_BPS);
    });
  });

  // ── Off-chain investor management ─────────────────────────────────────────────

  describe("addInvestor()", function () {
    it("records an off-chain investor with correct SRX (including bonus)", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      const expected = srxEntry(USD_10000_8DEC);

      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);

      const inv = await round.investors(investor1.address);
      expect(inv.srxAllocation).to.equal(expected);
      expect(inv.offChain).to.be.true;
      expect(inv.vault).to.equal(ethers.ZeroAddress);
    });

    it("increments totalAllocated", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      const expected = srxEntry(USD_5000_8DEC);
      await round.connect(admin).addInvestor(investor1.address, USD_5000_8DEC);
      expect(await round.totalAllocated()).to.equal(expected);
    });

    it("emits InvestorAdded with offChain = true", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      const expected = srxEntry(USD_10000_8DEC);
      await expect(round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC))
        .to.emit(round, "InvestorAdded")
        .withArgs(investor1.address, expected, true);
    });

    it("reverts if not admin", async function () {
      const { round, stranger, investor1 } = await loadFixture(deployFixture);
      await expect(
        round.connect(stranger).addInvestor(investor1.address, USD_1000_8DEC)
      ).to.be.revertedWithCustomError(round, "OnlyAdmin");
    });

    it("reverts with zero address", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      await expect(
        round.connect(admin).addInvestor(ethers.ZeroAddress, USD_1000_8DEC)
      ).to.be.revertedWithCustomError(round, "ZeroAddress");
    });

    it("reverts with zero amount", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await expect(
        round.connect(admin).addInvestor(investor1.address, 0n)
      ).to.be.revertedWithCustomError(round, "ZeroAmount");
    });

    it("accumulates and recalculates allocation on top-up (same tier)", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).addInvestor(investor1.address, USD_5000_8DEC);
      const cumulative = USD_10000_8DEC + USD_5000_8DEC;
      const expected   = srxEntry(cumulative);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(expected);
      expect(await round.totalAllocated()).to.equal(expected);
    });

    it("emits AllocationUpdated on top-up", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      const first  = srxEntry(USD_10000_8DEC);
      const second = srxEntry(USD_10000_8DEC + USD_5000_8DEC);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await expect(round.connect(admin).addInvestor(investor1.address, USD_5000_8DEC))
        .to.emit(round, "AllocationUpdated")
        .withArgs(investor1.address, first, second);
    });

    it("reverts if vault already deployed (top-up too late)", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).deployVault(investor1.address);
      await expect(
        round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC)
      ).to.be.revertedWithCustomError(round, "VaultAlreadyDeployed");
    });

    it("reverts if resulting SRX would exceed hard cap", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await expect(
        round.connect(admin).addInvestor(investor1.address, USD_EXCEEDS_CAP)
      ).to.be.revertedWithCustomError(round, "HardCapExceeded");
    });

    it("reverts if round is finalized", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).finalize();
      await expect(
        round.connect(admin).addInvestor(investor1.address, USD_1000_8DEC)
      ).to.be.revertedWithCustomError(round, "RoundFinalized");
    });

    it("cumulativeUsd8Dec is updated correctly", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      expect((await round.investors(investor1.address)).cumulativeUsd8Dec).to.equal(USD_10000_8DEC);
      await round.connect(admin).addInvestor(investor1.address, USD_5000_8DEC);
      expect((await round.investors(investor1.address)).cumulativeUsd8Dec)
        .to.equal(USD_10000_8DEC + USD_5000_8DEC);
    });
  });

  describe("updateAllocation()", function () {
    it("adjusts an investor's allocation directly (admin correction)", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      const initial = srxEntry(USD_10000_8DEC);
      const updated = ethers.parseUnits("1500000", 18);

      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).updateAllocation(investor1.address, updated);

      expect((await round.investors(investor1.address)).srxAllocation).to.equal(updated);
      expect(await round.totalAllocated()).to.equal(updated);
    });

    it("emits AllocationUpdated", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      const initial = srxEntry(USD_10000_8DEC);
      const updated = ethers.parseUnits("2000000", 18);

      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await expect(round.connect(admin).updateAllocation(investor1.address, updated))
        .to.emit(round, "AllocationUpdated")
        .withArgs(investor1.address, initial, updated);
    });

    it("reverts if no allocation exists", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await expect(
        round.connect(admin).updateAllocation(investor1.address, ethers.parseUnits("100", 18))
      ).to.be.revertedWithCustomError(round, "NoAllocation");
    });
  });

  describe("removeInvestor()", function () {
    it("removes investor and frees allocation", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);

      await round.connect(admin).addInvestor(investor1.address, USD_5000_8DEC);
      await round.connect(admin).removeInvestor(investor1.address);

      expect((await round.investors(investor1.address)).srxAllocation).to.equal(0n);
      expect(await round.totalAllocated()).to.equal(0n);
      expect(await round.investorCount()).to.equal(0n);
    });

    it("emits InvestorRemoved", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await expect(round.connect(admin).removeInvestor(investor1.address))
        .to.emit(round, "InvestorRemoved")
        .withArgs(investor1.address);
    });

    it("reverts if no allocation", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await expect(
        round.connect(admin).removeInvestor(investor1.address)
      ).to.be.revertedWithCustomError(round, "NoAllocation");
    });
  });

  // ── On-chain: ETH ─────────────────────────────────────────────────────────────

  describe("invest() — ETH via Chainlink oracle", function () {
    it("records correct SRX (including 10% Entry bonus) for 1 ETH at $2500", async function () {
      const { round, investor1 } = await loadFixture(deployFixture);
      await round.connect(investor1).invest({ value: ethers.parseEther("1") });
      expect((await round.investors(investor1.address)).srxAllocation)
        .to.equal(SRX_PER_ETH_1); // 220,000 SRX (200,000 base + 10%)
    });

    it("records correct SRX for 2 ETH (cumulative, same Entry tier)", async function () {
      const { round, investor1 } = await loadFixture(deployFixture);
      await round.connect(investor1).invest({ value: ethers.parseEther("2") });
      const cumUsd = ETH_USD_8DEC * 2n;
      expect((await round.investors(investor1.address)).srxAllocation)
        .to.equal(srxEntry(cumUsd));
    });

    it("SRX adjusts correctly when oracle price changes", async function () {
      const { round, ethFeed, investor1, investor2 } = await loadFixture(deployFixture);

      await round.connect(investor1).invest({ value: ethers.parseEther("1") });
      expect((await round.investors(investor1.address)).srxAllocation)
        .to.equal(SRX_PER_ETH_1); // $2500 ETH, Entry +10%

      // Price rises to $3000 ETH
      await ethFeed.setPrice(3_000n * 10n ** 8n);
      await round.connect(investor2).invest({ value: ethers.parseEther("1") });
      // usd = $3000 → Entry +10% → 3_000_000_000_000 * 1e18 * 11000 / 1_250_000 / 10000
      //      = wait, usd = 1e18 × 3e11 / 1e18 = 3e11 = 300_000_000_000 (8-dec)
      const eth3000Usd = 300_000_000_000n;
      expect((await round.investors(investor2.address)).srxAllocation)
        .to.equal(srxEntry(eth3000Usd));
    });

    it("emits InvestorAdded with correct SRX including bonus", async function () {
      const { round, investor1 } = await loadFixture(deployFixture);
      await expect(round.connect(investor1).invest({ value: ethers.parseEther("1") }))
        .to.emit(round, "InvestorAdded")
        .withArgs(investor1.address, SRX_PER_ETH_1, false);
    });

    it("ETH is held in the contract", async function () {
      const { round, investor1 } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("5");
      await round.connect(investor1).invest({ value: amount });
      expect(await ethers.provider.getBalance(await round.getAddress())).to.equal(amount);
    });

    it("reverts with zero ETH", async function () {
      const { round, investor1 } = await loadFixture(deployFixture);
      await expect(
        round.connect(investor1).invest({ value: 0n })
      ).to.be.revertedWithCustomError(round, "ZeroAmount");
    });

    it("reverts if ETH feed is zero address (disabled)", async function () {
      const { token, mockUsdc, mockUsdt, mockWbtc, btcFeed, admin, investor1 } =
        await loadFixture(deployFixture);
      const PreSaleRound = await ethers.getContractFactory("PreSaleRound");
      const roundNoEth = await PreSaleRound.deploy(
        await token.getAddress(),
        await mockUsdc.getAddress(),
        await mockUsdt.getAddress(),
        await mockWbtc.getAddress(),
        ethers.ZeroAddress,
        await btcFeed.getAddress(),
        admin.address,
        HARD_CAP,
        SRX_PRICE_8DEC
      );
      await expect(
        roundNoEth.connect(investor1).invest({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(roundNoEth, "CurrencyDisabled");
    });

    it("reverts if oracle price is stale", async function () {
      const { round, ethFeed, investor1 } = await loadFixture(deployFixture);
      const staleTime = (await ethers.provider.getBlock("latest")).timestamp - 7201;
      await ethFeed.setUpdatedAt(staleTime);
      await expect(
        round.connect(investor1).invest({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(round, "StalePriceFeed");
    });

    it("accumulates and recalculates allocation on second ETH invest (top-up)", async function () {
      const { round, investor1 } = await loadFixture(deployFixture);
      await round.connect(investor1).invest({ value: ethers.parseEther("1") });
      await round.connect(investor1).invest({ value: ethers.parseEther("1") });
      const cumUsd = ETH_USD_8DEC * 2n;
      const expected = srxEntry(cumUsd);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(expected);
      expect(await round.totalAllocated()).to.equal(expected);
    });

    it("emits AllocationUpdated on ETH top-up", async function () {
      const { round, investor1 } = await loadFixture(deployFixture);
      const after1 = srxEntry(ETH_USD_8DEC);
      const after2 = srxEntry(ETH_USD_8DEC * 2n);
      await round.connect(investor1).invest({ value: ethers.parseEther("1") });
      await expect(
        round.connect(investor1).invest({ value: ethers.parseEther("1") })
      ).to.emit(round, "AllocationUpdated")
        .withArgs(investor1.address, after1, after2);
    });

    it("reverts if vault already deployed (top-up too late)", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(investor1).invest({ value: ethers.parseEther("1") });
      await round.connect(admin).deployVault(investor1.address);
      await expect(
        round.connect(investor1).invest({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(round, "VaultAlreadyDeployed");
    });

    it("reverts if round is finalized", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).finalize();
      await expect(
        round.connect(investor1).invest({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(round, "RoundFinalized");
    });
  });

  // ── On-chain: USDC ────────────────────────────────────────────────────────────

  describe("investWithUSDC()", function () {
    it("records correct SRX (including 10% Entry bonus) for 1 USDC", async function () {
      const { round, mockUsdc, investor1, ONE_USDC } = await loadFixture(deployFixture);
      await mockUsdc.connect(investor1).approve(await round.getAddress(), ONE_USDC);
      await round.connect(investor1).investWithUSDC(ONE_USDC);
      expect((await round.investors(investor1.address)).srxAllocation)
        .to.equal(SRX_PER_USDC_1); // 88 SRX (80 base + 10%)
    });

    it("records correct SRX for 10,000 USDC", async function () {
      const { round, mockUsdc, investor1, ONE_USDC } = await loadFixture(deployFixture);
      const amount = ONE_USDC * 10_000n;
      await mockUsdc.connect(investor1).approve(await round.getAddress(), amount);
      await round.connect(investor1).investWithUSDC(amount);
      // 10,000 USDC = $10,000 in 8-dec = 1_000_000_000_000
      const expected = srxEntry(1_000_000_000_000n);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(expected);
    });

    it("transfers USDC from investor to contract", async function () {
      const { round, mockUsdc, investor1, ONE_USDC } = await loadFixture(deployFixture);
      await mockUsdc.connect(investor1).approve(await round.getAddress(), ONE_USDC);
      await round.connect(investor1).investWithUSDC(ONE_USDC);
      expect(await mockUsdc.balanceOf(await round.getAddress())).to.equal(ONE_USDC);
    });

    it("reverts with zero amount", async function () {
      const { round, investor1 } = await loadFixture(deployFixture);
      await expect(
        round.connect(investor1).investWithUSDC(0n)
      ).to.be.revertedWithCustomError(round, "ZeroAmount");
    });

    it("reverts if USDC is disabled (zero address)", async function () {
      const { token, mockUsdt, mockWbtc, ethFeed, btcFeed, admin, investor1 } =
        await loadFixture(deployFixture);
      const PreSaleRound = await ethers.getContractFactory("PreSaleRound");
      const roundNoUsdc = await PreSaleRound.deploy(
        await token.getAddress(),
        ethers.ZeroAddress,
        await mockUsdt.getAddress(),
        await mockWbtc.getAddress(),
        await ethFeed.getAddress(),
        await btcFeed.getAddress(),
        admin.address,
        HARD_CAP,
        SRX_PRICE_8DEC
      );
      await expect(
        roundNoUsdc.connect(investor1).investWithUSDC(1_000_000n)
      ).to.be.revertedWithCustomError(roundNoUsdc, "CurrencyDisabled");
    });

    it("reverts if round is finalized", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).finalize();
      await expect(
        round.connect(investor1).investWithUSDC(1_000_000n)
      ).to.be.revertedWithCustomError(round, "RoundFinalized");
    });

    it("accumulates and recalculates allocation on second USDC invest (top-up)", async function () {
      const { round, mockUsdc, investor1, ONE_USDC } = await loadFixture(deployFixture);
      await mockUsdc.connect(investor1).approve(await round.getAddress(), ONE_USDC * 2n);
      await round.connect(investor1).investWithUSDC(ONE_USDC);
      await round.connect(investor1).investWithUSDC(ONE_USDC);
      const cumUsd = ONE_USDC_USD_8DEC * 2n;
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(srxEntry(cumUsd));
      expect(await round.totalAllocated()).to.equal(srxEntry(cumUsd));
    });

    it("emits AllocationUpdated on USDC top-up", async function () {
      const { round, mockUsdc, investor1, ONE_USDC } = await loadFixture(deployFixture);
      const after1 = srxEntry(ONE_USDC_USD_8DEC);
      const after2 = srxEntry(ONE_USDC_USD_8DEC * 2n);
      await mockUsdc.connect(investor1).approve(await round.getAddress(), ONE_USDC * 2n);
      await round.connect(investor1).investWithUSDC(ONE_USDC);
      await expect(round.connect(investor1).investWithUSDC(ONE_USDC))
        .to.emit(round, "AllocationUpdated")
        .withArgs(investor1.address, after1, after2);
    });

    it("reverts if vault already deployed (top-up too late)", async function () {
      const { round, mockUsdc, admin, investor1, ONE_USDC } = await loadFixture(deployFixture);
      await mockUsdc.connect(investor1).approve(await round.getAddress(), ONE_USDC * 2n);
      await round.connect(investor1).investWithUSDC(ONE_USDC);
      await round.connect(admin).deployVault(investor1.address);
      await expect(
        round.connect(investor1).investWithUSDC(ONE_USDC)
      ).to.be.revertedWithCustomError(round, "VaultAlreadyDeployed");
    });
  });

  // ── On-chain: USDT ────────────────────────────────────────────────────────────

  describe("investWithUSDT()", function () {
    it("records correct SRX (including 10% Entry bonus) for 1 USDT", async function () {
      const { round, mockUsdt, investor1, ONE_USDC } = await loadFixture(deployFixture);
      await mockUsdt.connect(investor1).approve(await round.getAddress(), ONE_USDC);
      await round.connect(investor1).investWithUSDT(ONE_USDC);
      expect((await round.investors(investor1.address)).srxAllocation)
        .to.equal(SRX_PER_USDC_1); // same rate as USDC
    });

    it("transfers USDT from investor to contract", async function () {
      const { round, mockUsdt, investor1, ONE_USDC } = await loadFixture(deployFixture);
      await mockUsdt.connect(investor1).approve(await round.getAddress(), ONE_USDC);
      await round.connect(investor1).investWithUSDT(ONE_USDC);
      expect(await mockUsdt.balanceOf(await round.getAddress())).to.equal(ONE_USDC);
    });

    it("reverts with zero amount", async function () {
      const { round, investor1 } = await loadFixture(deployFixture);
      await expect(
        round.connect(investor1).investWithUSDT(0n)
      ).to.be.revertedWithCustomError(round, "ZeroAmount");
    });

    it("reverts if USDT is disabled (zero address)", async function () {
      const { token, mockUsdc, mockWbtc, ethFeed, btcFeed, admin, investor1 } =
        await loadFixture(deployFixture);
      const PreSaleRound = await ethers.getContractFactory("PreSaleRound");
      const roundNoUsdt = await PreSaleRound.deploy(
        await token.getAddress(),
        await mockUsdc.getAddress(),
        ethers.ZeroAddress,
        await mockWbtc.getAddress(),
        await ethFeed.getAddress(),
        await btcFeed.getAddress(),
        admin.address,
        HARD_CAP,
        SRX_PRICE_8DEC
      );
      await expect(
        roundNoUsdt.connect(investor1).investWithUSDT(1_000_000n)
      ).to.be.revertedWithCustomError(roundNoUsdt, "CurrencyDisabled");
    });

    it("accumulates and recalculates on USDT top-up", async function () {
      const { round, mockUsdt, investor1, ONE_USDC } = await loadFixture(deployFixture);
      await mockUsdt.connect(investor1).approve(await round.getAddress(), ONE_USDC * 2n);
      await round.connect(investor1).investWithUSDT(ONE_USDC);
      await round.connect(investor1).investWithUSDT(ONE_USDC);
      const cumUsd = ONE_USDC_USD_8DEC * 2n;
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(srxEntry(cumUsd));
      expect(await round.totalAllocated()).to.equal(srxEntry(cumUsd));
    });

    it("emits AllocationUpdated on USDT top-up", async function () {
      const { round, mockUsdt, investor1, ONE_USDC } = await loadFixture(deployFixture);
      const after1 = srxEntry(ONE_USDC_USD_8DEC);
      const after2 = srxEntry(ONE_USDC_USD_8DEC * 2n);
      await mockUsdt.connect(investor1).approve(await round.getAddress(), ONE_USDC * 2n);
      await round.connect(investor1).investWithUSDT(ONE_USDC);
      await expect(round.connect(investor1).investWithUSDT(ONE_USDC))
        .to.emit(round, "AllocationUpdated")
        .withArgs(investor1.address, after1, after2);
    });

    it("reverts if vault already deployed (top-up too late)", async function () {
      const { round, mockUsdt, admin, investor1, ONE_USDC } = await loadFixture(deployFixture);
      await mockUsdt.connect(investor1).approve(await round.getAddress(), ONE_USDC * 2n);
      await round.connect(investor1).investWithUSDT(ONE_USDC);
      await round.connect(admin).deployVault(investor1.address);
      await expect(
        round.connect(investor1).investWithUSDT(ONE_USDC)
      ).to.be.revertedWithCustomError(round, "VaultAlreadyDeployed");
    });
  });

  // ── On-chain: WBTC ────────────────────────────────────────────────────────────

  describe("investWithWBTC() — via Chainlink BTC oracle", function () {
    it("records correct SRX (including 10% Entry bonus) for 1 WBTC at $60,000", async function () {
      const { round, mockWbtc, investor1, ONE_WBTC } = await loadFixture(deployFixture);
      await mockWbtc.connect(investor1).approve(await round.getAddress(), ONE_WBTC);
      await round.connect(investor1).investWithWBTC(ONE_WBTC);
      expect((await round.investors(investor1.address)).srxAllocation)
        .to.equal(SRX_PER_WBTC_1); // 5,280,000 SRX (4,800,000 base + 10%)
    });

    it("SRX adjusts correctly when BTC oracle price changes", async function () {
      const { round, mockWbtc, btcFeed, investor1, investor2, ONE_WBTC } =
        await loadFixture(deployFixture);

      await mockWbtc.connect(investor1).approve(await round.getAddress(), ONE_WBTC);
      await round.connect(investor1).investWithWBTC(ONE_WBTC);
      expect((await round.investors(investor1.address)).srxAllocation).to.equal(SRX_PER_WBTC_1);

      // BTC drops to $50,000 — investor2: usd = $50k in 8-dec = 5_000_000_000_000
      await btcFeed.setPrice(50_000n * 10n ** 8n);
      await mockWbtc.connect(investor2).approve(await round.getAddress(), ONE_WBTC);
      await round.connect(investor2).investWithWBTC(ONE_WBTC);
      const btc50kUsd = 5_000_000_000_000n;
      expect((await round.investors(investor2.address)).srxAllocation)
        .to.equal(srxEntry(btc50kUsd));
    });

    it("transfers WBTC from investor to contract", async function () {
      const { round, mockWbtc, investor1, ONE_WBTC } = await loadFixture(deployFixture);
      await mockWbtc.connect(investor1).approve(await round.getAddress(), ONE_WBTC);
      await round.connect(investor1).investWithWBTC(ONE_WBTC);
      expect(await mockWbtc.balanceOf(await round.getAddress())).to.equal(ONE_WBTC);
    });

    it("reverts if oracle price is stale", async function () {
      const { round, mockWbtc, btcFeed, investor1, ONE_WBTC } = await loadFixture(deployFixture);
      const staleTime = (await ethers.provider.getBlock("latest")).timestamp - 7201;
      await btcFeed.setUpdatedAt(staleTime);
      await mockWbtc.connect(investor1).approve(await round.getAddress(), ONE_WBTC);
      await expect(
        round.connect(investor1).investWithWBTC(ONE_WBTC)
      ).to.be.revertedWithCustomError(round, "StalePriceFeed");
    });

    it("reverts if WBTC is disabled", async function () {
      const { token, mockUsdc, mockUsdt, ethFeed, btcFeed, admin, investor1 } =
        await loadFixture(deployFixture);
      const PreSaleRound = await ethers.getContractFactory("PreSaleRound");
      const roundNoWbtc = await PreSaleRound.deploy(
        await token.getAddress(),
        await mockUsdc.getAddress(),
        await mockUsdt.getAddress(),
        ethers.ZeroAddress,
        await ethFeed.getAddress(),
        await btcFeed.getAddress(),
        admin.address,
        HARD_CAP,
        SRX_PRICE_8DEC
      );
      await expect(
        roundNoWbtc.connect(investor1).investWithWBTC(100_000_000n)
      ).to.be.revertedWithCustomError(roundNoWbtc, "CurrencyDisabled");
    });

    it("reverts with zero amount", async function () {
      const { round, investor1 } = await loadFixture(deployFixture);
      await expect(
        round.connect(investor1).investWithWBTC(0n)
      ).to.be.revertedWithCustomError(round, "ZeroAmount");
    });
  });

  // ── Quote views ───────────────────────────────────────────────────────────────

  describe("Quote views", function () {
    it("quoteETH returns correct SRX including bonus for new investor (1 ETH)", async function () {
      const { round, investor1 } = await loadFixture(deployFixture);
      // New investor: 0 cumulative, Entry tier, 1 ETH = $2500
      expect(await round.quoteETH(ethers.parseEther("1"), investor1.address))
        .to.equal(SRX_PER_ETH_1);
    });

    it("quoteETH accounts for existing cumulative USD (tier upgrade)", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      // Investor already has $95K, about to invest 1 ETH ($2,500) → total $97,500 still Entry
      const USD_95K = USD_10000_8DEC * 9n + USD_5000_8DEC;
      await round.connect(admin).addInvestor(investor1.address, USD_95K);
      const currentSRX = (await round.investors(investor1.address)).srxAllocation;
      const newTotal   = srxEntry(USD_95K + ETH_USD_8DEC);
      expect(await round.quoteETH(ethers.parseEther("1"), investor1.address))
        .to.equal(newTotal - currentSRX);
    });

    it("quoteStable returns correct SRX including bonus for 1 USDC", async function () {
      const { round, investor1, ONE_USDC } = await loadFixture(deployFixture);
      expect(await round.quoteStable(ONE_USDC, investor1.address))
        .to.equal(SRX_PER_USDC_1);
    });

    it("quoteWBTC returns correct SRX including bonus for 1 WBTC", async function () {
      const { round, investor1, ONE_WBTC } = await loadFixture(deployFixture);
      expect(await round.quoteWBTC(ONE_WBTC, investor1.address))
        .to.equal(SRX_PER_WBTC_1);
    });

    it("currentEthPrice returns the oracle price", async function () {
      const { round } = await loadFixture(deployFixture);
      expect(await round.currentEthPrice()).to.equal(ETH_PRICE_8DEC);
    });

    it("currentBtcPrice returns the oracle price", async function () {
      const { round } = await loadFixture(deployFixture);
      expect(await round.currentBtcPrice()).to.equal(BTC_PRICE_8DEC);
    });
  });

  // ── Vault deployment ──────────────────────────────────────────────────────────

  describe("deployVault()", function () {
    it("deploys a VestingVault for the investor", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).deployVault(investor1.address);
      expect(await round.getVault(investor1.address)).to.not.equal(ethers.ZeroAddress);
    });

    it("vault holds correct SRX (including bonus) with seed vesting terms", async function () {
      const { round, token, admin, investor1 } = await loadFixture(deployFixture);
      const expectedSRX = srxEntry(USD_10000_8DEC);

      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).deployVault(investor1.address);

      const VestingVault = await ethers.getContractFactory("VestingVault");
      const vault = VestingVault.attach(await round.getVault(investor1.address));

      expect(await vault.beneficiary()).to.equal(investor1.address);
      expect(await vault.admin()).to.equal(await round.getAddress());
      expect(await vault.cliffDuration()).to.equal(CLIFF);
      expect(await vault.vestingDuration()).to.equal(VESTING);
      expect(await vault.tgeUnlockBps()).to.equal(0n);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(expectedSRX);
    });

    it("emits VaultDeployed with correct SRX amount", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      const expectedSRX = srxEntry(USD_5000_8DEC);
      await round.connect(admin).addInvestor(investor1.address, USD_5000_8DEC);
      const tx      = await round.connect(admin).deployVault(investor1.address);
      const receipt = await tx.wait();

      const parsed = receipt.logs
        .map(log => { try { return round.interface.parseLog(log); } catch { return null; } })
        .find(e => e && e.name === "VaultDeployed");

      expect(parsed.args[0]).to.equal(investor1.address);
      expect(parsed.args[2]).to.equal(expectedSRX);
    });

    it("reverts if vault already deployed", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).deployVault(investor1.address);
      await expect(
        round.connect(admin).deployVault(investor1.address)
      ).to.be.revertedWithCustomError(round, "VaultAlreadyDeployed");
    });

    it("reverts if no allocation", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await expect(
        round.connect(admin).deployVault(investor1.address)
      ).to.be.revertedWithCustomError(round, "NoAllocation");
    });

    it("reverts if not admin", async function () {
      const { round, admin, investor1, stranger } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await expect(
        round.connect(stranger).deployVault(investor1.address)
      ).to.be.revertedWithCustomError(round, "OnlyAdmin");
    });
  });

  describe("batchDeployVaults()", function () {
    it("deploys vaults for all investors", async function () {
      const { round, admin, investor1, investor2, investor3 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).addInvestor(investor2.address, USD_10000_8DEC);
      await round.connect(admin).addInvestor(investor3.address, USD_10000_8DEC);
      await round.connect(admin).batchDeployVaults(0, await round.investorCount());
      expect(await round.getVault(investor1.address)).to.not.equal(ethers.ZeroAddress);
      expect(await round.getVault(investor2.address)).to.not.equal(ethers.ZeroAddress);
      expect(await round.getVault(investor3.address)).to.not.equal(ethers.ZeroAddress);
    });

    it("skips investors who already have a vault", async function () {
      const { round, admin, investor1, investor2 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).addInvestor(investor2.address, USD_10000_8DEC);
      await round.connect(admin).deployVault(investor1.address);
      await round.connect(admin).batchDeployVaults(0, await round.investorCount());
      expect(await round.getVault(investor2.address)).to.not.equal(ethers.ZeroAddress);
    });
  });

  // ── TGE ───────────────────────────────────────────────────────────────────────

  describe("batchTriggerTGE()", function () {
    it("triggers TGE on all deployed vaults", async function () {
      const { round, admin, investor1, investor2 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).addInvestor(investor2.address, USD_10000_8DEC);
      await round.connect(admin).batchDeployVaults(0, await round.investorCount());
      await round.connect(admin).batchTriggerTGE(0, await round.investorCount());

      const VestingVault = await ethers.getContractFactory("VestingVault");
      const v1 = VestingVault.attach(await round.getVault(investor1.address));
      const v2 = VestingVault.attach(await round.getVault(investor2.address));
      expect(await v1.tgeTriggered()).to.be.true;
      expect(await v2.tgeTriggered()).to.be.true;
    });

    it("nothing vested immediately after TGE (0% TGE unlock, before cliff)", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).deployVault(investor1.address);
      await round.connect(admin).batchTriggerTGE(0, await round.investorCount());

      const VestingVault = await ethers.getContractFactory("VestingVault");
      const vault = VestingVault.attach(await round.getVault(investor1.address));
      expect(await vault.vestedAmount()).to.equal(0n);
    });

    it("partially vested after cliff + half vesting period", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      const amount = srxEntry(USD_10000_8DEC);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).deployVault(investor1.address);
      await round.connect(admin).batchTriggerTGE(0, await round.investorCount());

      await time.increase((273 + 365) * 86400);

      const VestingVault = await ethers.getContractFactory("VestingVault");
      const vault = VestingVault.attach(await round.getVault(investor1.address));
      const expected = amount * 365n / 730n;
      expect(await vault.vestedAmount()).to.be.closeTo(expected, ethers.parseUnits("1000", 18));
    });

    it("fully vested after cliff + full vesting period", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      const amount = srxEntry(USD_10000_8DEC);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).deployVault(investor1.address);
      await round.connect(admin).batchTriggerTGE(0, await round.investorCount());
      await time.increase((273 + 730 + 1) * 86400);

      const VestingVault = await ethers.getContractFactory("VestingVault");
      const vault = VestingVault.attach(await round.getVault(investor1.address));
      expect(await vault.vestedAmount()).to.equal(amount);
    });

    it("reverts if not admin", async function () {
      const { round, stranger } = await loadFixture(deployFixture);
      await expect(
        round.connect(stranger).batchTriggerTGE(0, 1)
      ).to.be.revertedWithCustomError(round, "OnlyAdmin");
    });
  });

  // ── Fund withdrawal ───────────────────────────────────────────────────────────

  describe("withdrawETH()", function () {
    it("withdraws all ETH to recipient", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(investor1).invest({ value: ethers.parseEther("3") });
      const before = await ethers.provider.getBalance(admin.address);
      await round.connect(admin).withdrawETH(admin.address);
      expect(await ethers.provider.getBalance(admin.address)).to.be.gt(before);
      expect(await ethers.provider.getBalance(await round.getAddress())).to.equal(0n);
    });

    it("reverts with zero address", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(investor1).invest({ value: ethers.parseEther("1") });
      await expect(
        round.connect(admin).withdrawETH(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(round, "ZeroAddress");
    });

    it("reverts if no ETH balance", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      await expect(
        round.connect(admin).withdrawETH(admin.address)
      ).to.be.revertedWithCustomError(round, "ZeroAmount");
    });
  });

  describe("withdrawUSDC()", function () {
    it("withdraws all USDC to recipient", async function () {
      const { round, mockUsdc, admin, investor1, ONE_USDC } = await loadFixture(deployFixture);
      await mockUsdc.connect(investor1).approve(await round.getAddress(), ONE_USDC);
      await round.connect(investor1).investWithUSDC(ONE_USDC);
      await round.connect(admin).withdrawUSDC(admin.address);
      expect(await mockUsdc.balanceOf(await round.getAddress())).to.equal(0n);
    });
  });

  describe("withdrawUSDT()", function () {
    it("withdraws all USDT to recipient", async function () {
      const { round, mockUsdt, admin, investor1, ONE_USDC } = await loadFixture(deployFixture);
      await mockUsdt.connect(investor1).approve(await round.getAddress(), ONE_USDC);
      await round.connect(investor1).investWithUSDT(ONE_USDC);
      await round.connect(admin).withdrawUSDT(admin.address);
      expect(await mockUsdt.balanceOf(await round.getAddress())).to.equal(0n);
    });
  });

  describe("withdrawWBTC()", function () {
    it("withdraws all WBTC to recipient", async function () {
      const { round, mockWbtc, admin, investor1, ONE_WBTC } = await loadFixture(deployFixture);
      await mockWbtc.connect(investor1).approve(await round.getAddress(), ONE_WBTC);
      await round.connect(investor1).investWithWBTC(ONE_WBTC);
      await round.connect(admin).withdrawWBTC(admin.address);
      expect(await mockWbtc.balanceOf(await round.getAddress())).to.equal(0n);
    });
  });

  // ── Views ─────────────────────────────────────────────────────────────────────

  describe("View helpers", function () {
    it("remainingCap decreases by SRX-with-bonus on allocation", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      const expected = srxEntry(USD_10000_8DEC);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      expect(await round.remainingCap()).to.equal(HARD_CAP - expected);
    });

    it("investorCount reflects additions and removals", async function () {
      const { round, admin, investor1, investor2 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).addInvestor(investor2.address, USD_10000_8DEC);
      expect(await round.investorCount()).to.equal(2n);
      await round.connect(admin).removeInvestor(investor1.address);
      expect(await round.investorCount()).to.equal(1n);
    });

    it("pendingDeployment returns undeployed SRX total (with bonus)", async function () {
      const { round, admin, investor1, investor2 } = await loadFixture(deployFixture);
      const expected = srxEntry(USD_10000_8DEC);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await round.connect(admin).addInvestor(investor2.address, USD_10000_8DEC);
      await round.connect(admin).deployVault(investor1.address);
      expect(await round.pendingDeployment()).to.equal(expected);
    });

    it("getAllVaults returns correct array", async function () {
      const { round, admin, investor1, investor2 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_5000_8DEC);
      await round.connect(admin).addInvestor(investor2.address, USD_5000_8DEC);
      await round.connect(admin).batchDeployVaults(0, await round.investorCount());
      const vaults = await round.getAllVaults();
      expect(vaults.length).to.equal(2);
      expect(vaults[0]).to.not.equal(ethers.ZeroAddress);
      expect(vaults[1]).to.not.equal(ethers.ZeroAddress);
    });
  });

  // ── Admin config ──────────────────────────────────────────────────────────────

  describe("finalize()", function () {
    it("sets finalized = true", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      await round.connect(admin).finalize();
      expect(await round.finalized()).to.be.true;
    });

    it("reverts if already finalized", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      await round.connect(admin).finalize();
      await expect(round.connect(admin).finalize())
        .to.be.revertedWithCustomError(round, "RoundFinalized");
    });
  });

  describe("setSRXPrice()", function () {
    it("updates the SRX price", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      const newPrice = 2_000_000n; // $0.02
      await round.connect(admin).setSRXPrice(newPrice);
      expect(await round.srxPriceUsd8Dec()).to.equal(newPrice);
    });

    it("emits SRXPriceUpdated", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      await expect(round.connect(admin).setSRXPrice(2_000_000n))
        .to.emit(round, "SRXPriceUpdated")
        .withArgs(SRX_PRICE_8DEC, 2_000_000n);
    });

    it("affects ETH quote after price update", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      // At $0.02/SRX, 1 ETH at $2500 with Entry +10%:
      // usd = 250_000_000_000, srx = 250_000_000_000 × 1e18 × 11000 / 2_000_000 / 10000 = 137,500
      await round.connect(admin).setSRXPrice(2_000_000n);
      expect(await round.quoteETH(ethers.parseEther("1"), investor1.address))
        .to.equal(ethers.parseUnits("137500", 18));
    });

    it("reverts if not admin", async function () {
      const { round, stranger } = await loadFixture(deployFixture);
      await expect(
        round.connect(stranger).setSRXPrice(2_000_000n)
      ).to.be.revertedWithCustomError(round, "OnlyAdmin");
    });

    it("reverts with zero price", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      await expect(
        round.connect(admin).setSRXPrice(0n)
      ).to.be.revertedWithCustomError(round, "ZeroAmount");
    });
  });

  describe("setMaxStaleness()", function () {
    it("updates maxStaleness", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      await round.connect(admin).setMaxStaleness(7200n);
      expect(await round.maxStaleness()).to.equal(7200n);
    });

    it("reverts if not admin", async function () {
      const { round, stranger } = await loadFixture(deployFixture);
      await expect(
        round.connect(stranger).setMaxStaleness(7200n)
      ).to.be.revertedWithCustomError(round, "OnlyAdmin");
    });
  });

  // ── Oracle hardening: stablecoin bounds + per-feed staleness ──────────────
  //    Regression tests for SC-OPS-001 (stablecoin price bounds) and
  //    SC-ECON-002 (per-feed staleness overrides) from the Round 4 audit.
  describe("Oracle hardening (SC-OPS-001 / SC-ECON-002)", function () {
    it("setStablecoinPriceBounds reverts when min >= max (both non-zero)", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      await expect(
        round.connect(admin).setStablecoinPriceBounds(200_000_000n, 50_000_000n)
      ).to.be.revertedWithCustomError(round, "InvalidPriceBounds");
    });

    it("setStablecoinPriceBounds stores values and emits", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      await expect(round.connect(admin).setStablecoinPriceBounds(50_000_000n, 200_000_000n))
        .to.emit(round, "StablecoinPriceBoundsUpdated").withArgs(50_000_000n, 200_000_000n);
      expect(await round.minStablePriceUsd8Dec()).to.equal(50_000_000n);
      expect(await round.maxStablePriceUsd8Dec()).to.equal(200_000_000n);
    });

    it("rejects an out-of-bounds stablecoin feed price on investWithUSDC", async function () {
      const { round, admin, investor1, mockUsdc, ONE_USDC } = await loadFixture(deployFixture);
      const MockFeed = await ethers.getContractFactory("MockChainlinkFeed");
      const usdcFeed = await MockFeed.deploy(100_000_000n); // $1.00
      await usdcFeed.waitForDeployment();
      await round.connect(admin).setStablecoinFeeds(await usdcFeed.getAddress(), ethers.ZeroAddress);
      await round.connect(admin).setStablecoinPriceBounds(50_000_000n, 200_000_000n); // [$0.50, $2.00]

      // Feed glitches to $0.10 — below the $0.50 floor
      await usdcFeed.setPrice(10_000_000n);

      await mockUsdc.connect(investor1).approve(await round.getAddress(), ONE_USDC);
      await expect(
        round.connect(investor1).investWithUSDC(ONE_USDC)
      ).to.be.revertedWithCustomError(round, "OraclePriceOutOfBounds");
    });

    it("accepts a healthy stablecoin feed within bounds", async function () {
      const { round, admin, investor1, mockUsdc, ONE_USDC } = await loadFixture(deployFixture);
      const MockFeed = await ethers.getContractFactory("MockChainlinkFeed");
      const usdcFeed = await MockFeed.deploy(100_000_000n); // $1.00
      await usdcFeed.waitForDeployment();
      await round.connect(admin).setStablecoinFeeds(await usdcFeed.getAddress(), ethers.ZeroAddress);
      await round.connect(admin).setStablecoinPriceBounds(50_000_000n, 200_000_000n);

      await mockUsdc.connect(investor1).approve(await round.getAddress(), ONE_USDC);
      await expect(round.connect(investor1).investWithUSDC(ONE_USDC)).to.not.be.reverted;
    });

    it("setFeedStaleness stores per-feed overrides and emits", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      await expect(round.connect(admin).setFeedStaleness(3900n, 3900n, 90n))
        .to.emit(round, "FeedStalenessUpdated").withArgs(3900n, 3900n, 90n);
      expect(await round.ethMaxStaleness()).to.equal(3900n);
      expect(await round.btcMaxStaleness()).to.equal(3900n);
      expect(await round.stableMaxStaleness()).to.equal(90n);
    });

    it("per-feed ETH staleness override is enforced over the global default", async function () {
      const { round, admin, investor1, ethFeed } = await loadFixture(deployFixture);
      // Tight ETH override of 10s (global default is 300s).
      await round.connect(admin).setFeedStaleness(10n, 0n, 0n);
      // Age the ETH feed to ~100s: within the global 300s window, but past the 10s override.
      const nowTs = BigInt(await time.latest());
      await ethFeed.setUpdatedAt(nowTs - 100n);
      await expect(
        round.connect(investor1).invest({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(round, "StalePriceFeed");
    });

    it("setStablecoinPriceBounds / setFeedStaleness are admin-only", async function () {
      const { round, stranger } = await loadFixture(deployFixture);
      await expect(round.connect(stranger).setStablecoinPriceBounds(0n, 0n))
        .to.be.revertedWithCustomError(round, "OnlyAdmin");
      await expect(round.connect(stranger).setFeedStaleness(0n, 0n, 0n))
        .to.be.revertedWithCustomError(round, "OnlyAdmin");
    });
  });

  // ── Round 5 findings: price-lock, bonus-aware updateAllocation, feed-aware quote ──
  describe("Round 5 hardening (R5-02 / R5-03 / R5-04)", function () {
    it("R5-02: setSRXPrice succeeds before the first investor", async function () {
      const { round, admin } = await loadFixture(deployFixture);
      await round.connect(admin).setSRXPrice(2_000_000n);
      expect(await round.srxPriceUsd8Dec()).to.equal(2_000_000n);
    });

    it("R5-02: setSRXPrice reverts once an investor exists (price locked)", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);
      await expect(round.connect(admin).setSRXPrice(2_000_000n))
        .to.be.revertedWithCustomError(round, "PriceLockedAfterFirstInvestor");
    });

    it("R5-03: updateAllocation back-calcs a bonus-aware, tier-consistent USD", async function () {
      const { round, admin, investor1 } = await loadFixture(deployFixture);
      // Seed an investor, then correct their allocation to an Institutional-sized amount.
      await round.connect(admin).addInvestor(investor1.address, USD_10000_8DEC);

      // $500,000 at Institutional (+20%): srx = 500000e8 × 1e18 × 12000 / 1_250_000 / 10000
      const usd = 50_000_000_000_000n;                 // $500k in 8-dec
      const newSrx = srxWithBonus(usd, INSTITUTIONAL_BPS);
      await round.connect(admin).updateAllocation(investor1.address, newSrx);

      // The synthetic USD must map back to the Institutional tier (not an inflated one),
      // and re-running the forward map on it must reproduce the same SRX (round-trip).
      const storedUsd = (await round.investors(investor1.address)).cumulativeUsd8Dec;
      expect(await round.getBonusBps(investor1.address)).to.equal(INSTITUTIONAL_BPS);
      expect(srxWithBonus(storedUsd, INSTITUTIONAL_BPS)).to.be.closeTo(newSrx, newSrx / 100000n);
    });

    it("R5-04: quoteStable matches actual investWithUSDC under a depeg feed", async function () {
      const { round, admin, investor1, mockUsdc, ONE_USDC } = await loadFixture(deployFixture);

      // Configure a USDC/USD feed reporting a 0.87 depeg.
      const MockFeed = await ethers.getContractFactory("MockChainlinkFeed");
      const usdcFeed = await MockFeed.deploy(87_000_000n); // $0.87
      await usdcFeed.waitForDeployment();
      await round.connect(admin).setStablecoinFeeds(await usdcFeed.getAddress(), ethers.ZeroAddress);

      const amount = ONE_USDC * 1000n; // 1,000 USDC
      const quoted = await round.quoteStable(amount, investor1.address);

      await mockUsdc.connect(investor1).approve(await round.getAddress(), amount);
      await round.connect(investor1).investWithUSDC(amount);
      const actual = (await round.investors(investor1.address)).srxAllocation;

      expect(quoted).to.equal(actual); // quote now uses the same feed-aware conversion
    });
  });
});
