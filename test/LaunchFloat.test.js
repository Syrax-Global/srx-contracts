// The launch-day float (Jared, 28 Sep 2026).
//
// The design every public figure states: 10B SRX; exactly 5% — 500,000,000 — freely
// transferable the moment TGE runs (the 50M pool paired with $1M at $0.02, 200M
// market-maker inventory, the 250M presale launch tranche); seed, founders and team
// 0% at launch; nothing new released in the first 30 days; the 950M liquidity
// reserve locked for 12 months.
//
// ⛔ What the configuration actually did before: 1.55B (15.5%) liquid at launch —
//    the whole 1.2B liquidity bucket to a single-key wallet plus 25% of the presale —
//    while the documents said "12% unlocked … multi-sig" and promised a 12-month
//    lock nothing enforced. These tests pin the design twice: once on the
//    configuration's own arithmetic, and once by running the TGE on a chain with the
//    real contracts and reading the balances.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ALLOCATIONS, VESTING, TGE_PLAN, launchFloat, vestedByDay } = require("../scripts/deploy/00_config");

const SRX = (n) => ethers.parseUnits(String(n), 18);
const MAX_SUPPLY = SRX(10_000_000_000);
const FLOAT = SRX(500_000_000);
const DAY = 86_400;

describe("Launch float — the 5% design", function () {
  describe("the configuration", function () {
    it("allocates exactly 10,000,000,000 SRX", function () {
      const sum = TGE_PLAN.reduce((s, r) => s + ALLOCATIONS[r.allocation], 0n);
      expect(sum).to.equal(MAX_SUPPLY);
    });

    it("every allocation appears in the plan exactly once", function () {
      const used = TGE_PLAN.map((r) => r.allocation).sort();
      expect(used).to.deep.equal(Object.keys(ALLOCATIONS).sort());
    });

    it("puts exactly 500,000,000 SRX — 5% — in circulation at launch", function () {
      expect(launchFloat()).to.equal(FLOAT);
      expect(launchFloat() * 10_000n / MAX_SUPPLY).to.equal(500n); // 5.00%
    });

    it("makes only the pool, the market maker and the presale launch tranche liquid", function () {
      const liquid = Object.fromEntries(TGE_PLAN.filter((r) => r.liquid).map((r) => [r.label, ALLOCATIONS[r.allocation]]));
      expect(liquid).to.deep.equal({
        PresaleLaunch: SRX(250_000_000),
        LiquidityPool: SRX(50_000_000),
        MarketMaker:   SRX(200_000_000),
      });
    });

    it("keeps the published buckets whole: presale 14%, liquidity 12%", function () {
      expect(ALLOCATIONS.presaleLaunch + ALLOCATIONS.presale).to.equal(SRX(1_400_000_000));
      expect(ALLOCATIONS.liquidityPool + ALLOCATIONS.marketMaker + ALLOCATIONS.liquidityReserve).to.equal(SRX(1_200_000_000));
    });

    it("unlocks nothing at launch from any vault — seed, founders and team included", function () {
      for (const row of TGE_PLAN.filter((r) => r.kind === "vault")) {
        expect(VESTING[row.schedule].tgeUnlockBps, row.label).to.equal(0n);
      }
    });

    it("releases nothing new in the first 30 days, and something on day 31", function () {
      for (let d = 0; d <= 30; d++) expect(vestedByDay(d), `day ${d}`).to.equal(0n);
      expect(vestedByDay(31)).to.be.greaterThan(0n);
    });

    it("locks the liquidity reserve for 12 months, then releases it over 24", function () {
      const r = VESTING.liquidityReserve;
      expect(r.cliffDuration).to.equal(365n * 86_400n);
      expect(r.vestingDuration).to.equal(730n * 86_400n);
      expect(ALLOCATIONS.liquidityReserve).to.equal(SRX(950_000_000));
    });

    it("sends launch tokens only to named wallets that must be multi-signature on a real network", function () {
      for (const row of TGE_PLAN.filter((r) => r.liquid)) expect(row.kind, row.label).to.equal("wallet");
    });
  });

  describe("on chain — the real contracts, the real TGE", function () {
    async function launched() {
      const signers = await ethers.getSigners();
      const [admin] = signers;
      const LZ = await ethers.getContractFactory("MockLZEndpoint");
      const lz = await LZ.deploy(40161);
      const T = await ethers.getContractFactory("SRXToken");
      const token = await T.deploy(await lz.getAddress(), admin.address);
      const Vault = await ethers.getContractFactory("VestingVault");
      const TGE = await ethers.getContractFactory("TGEDistributor");
      const tge = await TGE.deploy(await token.getAddress(), admin.address);

      // A distinct address for every beneficiary and every direct destination.
      const who = {};
      let i = 1;
      const next = () => signers[i++].address;
      const vaults = {};
      const allocations = [];
      for (const row of TGE_PLAN) {
        let destination;
        if (row.kind === "vault") {
          const v = VESTING[row.schedule];
          who[row.label] = next(); // beneficiary
          const vault = await Vault.deploy(await token.getAddress(), who[row.label], admin.address,
            v.cliffDuration, v.vestingDuration, v.tgeUnlockBps);
          vaults[row.label] = vault;
          destination = await vault.getAddress();
        } else {
          destination = who[row.label] = next();
        }
        allocations.push({ destination, amount: ALLOCATIONS[row.allocation], isVestingVault: row.kind === "vault", label: row.label });
      }
      await tge.connect(admin).setAllocations(allocations);
      await token.connect(admin).genesis(await tge.getAddress());
      await tge.connect(admin).distribute();
      for (const vault of Object.values(vaults)) await vault.connect(admin).triggerTGE();
      return { token, vaults, who };
    }

    /** What could move right now: liquid wallet balances plus everything vaults could release. */
    async function transferableNow({ token, vaults, who }) {
      let total = 0n;
      for (const row of TGE_PLAN.filter((r) => r.liquid)) total += await token.balanceOf(who[row.label]);
      for (const vault of Object.values(vaults)) total += await vault.releasable();
      return total;
    }

    it("leaves exactly 500,000,000 SRX transferable the moment TGE runs", async function () {
      const f = await loadFixture(launched);
      expect(await transferableNow(f)).to.equal(FLOAT);
      expect(await f.token.totalSupply()).to.equal(MAX_SUPPLY);
    });

    it("adds nothing on day 29, and starts releasing only after day 30", async function () {
      const f = await loadFixture(launched);
      await time.increase(29 * DAY);
      expect(await transferableNow(f)).to.equal(FLOAT);
      await time.increase(2 * DAY); // day 31
      expect(await transferableNow(f)).to.be.greaterThan(FLOAT);
    });

    it("keeps the liquidity reserve untouched until day 365", async function () {
      const f = await loadFixture(launched);
      const reserve = f.vaults.LiquidityReserve;
      await time.increase(364 * DAY);
      expect(await reserve.releasable()).to.equal(0n);
      await time.increase(2 * DAY); // day 366
      expect(await reserve.releasable()).to.be.greaterThan(0n);
    });

    it("holds seed, founders and team at zero releasable through launch week", async function () {
      const f = await loadFixture(launched);
      await time.increase(7 * DAY);
      for (const label of ["Founders", "CoreTeam", "SeedInvestors"]) {
        expect(await f.vaults[label].releasable(), label).to.equal(0n);
      }
    });
  });
});
