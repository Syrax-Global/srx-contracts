// The Genesis round is funded from the seed allocation (Jared, 10 and 30 Sep 2026).
//
// ⛔ The launch plan used to send all 400M seed SRX into ONE seed vault, so the
//    Genesis contract would have held nothing at launch and could not have created a
//    single buyer's vault. scripts/deploy/lib/genesis_seed.js now splits the seed
//    allocation: the Genesis contract receives EXACTLY what it sold (anything more
//    could leave unlocked through recoverSRX), the seed vault the rest.
//
// The end-to-end launch with a real Genesis round is rehearsed by
// scripts/ops/rehearse_deploy_suite.js; these tests pin the rules.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { approveBuyers } = require("./helpers/buyers");
const { ALLOCATIONS, VESTING, TGE_PLAN, launchFloat } = require("../scripts/deploy/00_config");
const { launchPlan, readGenesisSold, GENESIS_ROW, assertGenesisChain } = require("../scripts/deploy/lib/genesis_seed");
const { buildTgeAllocations, checkAgainstManifest } = require("../scripts/deploy/lib/tge_targets");
const { vaultOps } = require("../scripts/deploy/lib/vaultOps");

const srx = (n) => ethers.parseUnits(String(n), 18);
const usd = (dollars) => BigInt(dollars) * 10n ** 8n;
const SUPPLY = srx("10000000000");

describe("Genesis funded from the seed allocation", function () {
  describe("launchPlan", function () {
    it("no Genesis sale: the plan is exactly TGE_PLAN", function () {
      const { plan, allocations } = launchPlan(0n);
      expect(plan).to.equal(TGE_PLAN);
      expect(allocations).to.equal(ALLOCATIONS);
    });

    it("splits the seed allocation: Genesis gets what it sold, the seed vault the rest", function () {
      const sold = srx("16800000");
      const { plan, allocations } = launchPlan(sold);
      expect(allocations.genesis).to.equal(sold);
      expect(allocations.seedInvestors).to.equal(ALLOCATIONS.seedInvestors - sold);
      expect(allocations.genesis + allocations.seedInvestors).to.equal(srx("400000000"));
      // Genesis sits right after the seed vault, and nothing else moves.
      const labels = plan.map((r) => r.label);
      expect(labels.indexOf("Genesis")).to.equal(labels.indexOf("SeedInvestors") + 1);
      expect(labels.filter((l) => l !== "Genesis")).to.deep.equal(TGE_PLAN.map((r) => r.label));
      expect(plan.reduce((s, r) => s + allocations[r.allocation], 0n)).to.equal(SUPPLY);
    });

    it("the launch float is still exactly 5%: Genesis buyers get 0% at launch", function () {
      const { plan, allocations } = launchPlan(srx("300000000"));
      expect(launchFloat(plan, allocations)).to.equal(srx("500000000"));
      expect(GENESIS_ROW.liquid).to.equal(undefined);
    });

    it("refuses a sale that does not fit inside the seed allocation", function () {
      expect(() => launchPlan(ALLOCATIONS.seedInvestors)).to.throw(/does not fit/);
      expect(() => launchPlan(ALLOCATIONS.seedInvestors + 1n)).to.throw(/does not fit/);
      expect(() => launchPlan(-1n)).to.throw(/negative/);
    });
  });

  describe("the TGE gate and the vault operations", function () {
    const env = {};
    for (const row of TGE_PLAN) {
      const key = row.kind === "vault" ? row.vaultEnv : row.env;
      if (key) env[`${key}_HARDHAT`] = ethers.Wallet.createRandom().address;
    }
    env.PRESALE_ROUND_HARDHAT = ethers.Wallet.createRandom().address;

    it("sends the Genesis contract exactly what it sold", function () {
      const list = buildTgeAllocations({ networkName: "hardhat", env, genesisSold: srx("16800000") });
      const g = list.find((a) => a.label === "Genesis");
      expect(g.destination).to.equal(env.PRESALE_ROUND_HARDHAT);
      expect(g.amount).to.equal(srx("16800000"));
      expect(g.isVestingVault).to.equal(false);
      expect(list.find((a) => a.label === "SeedInvestors").amount).to.equal(srx("383200000"));
      expect(list.reduce((s, a) => s + a.amount, 0n)).to.equal(SUPPLY);
    });

    it("fails the manifest check when seed vault + Genesis ≠ the seed allocation", function () {
      const list = buildTgeAllocations({ networkName: "hardhat", env, genesisSold: srx("16800000") });
      const manifest = { network: "hardhat", tgeAllocations: {} };
      for (const a of list) manifest.tgeAllocations[a.label] = { destination: a.destination, amountSRX: ethers.formatUnits(a.amount, 18), isVestingVault: a.isVestingVault };
      expect(checkAgainstManifest({ allocations: list, manifest, roles: {}, networkName: "hardhat" }).filter((f) => /seed/.test(f))).to.deep.equal([]);

      // Genesis padded to its 300M cap: the unsold part would be liquid via recoverSRX.
      const padded = list.map((a) => (a.label === "Genesis" ? { ...a, amount: srx("300000000") } : a));
      const failures = checkAgainstManifest({ allocations: padded, manifest, roles: {}, networkName: "hardhat" });
      expect(failures.some((f) => /seed vault \+ Genesis/.test(f))).to.equal(true);
    });

    it("the seed vault's scheduled grant depends on the sale, so a refund after Step 3 makes Step 6 refuse", function () {
      const vaults = Object.fromEntries(TGE_PLAN.filter((r) => r.kind === "vault").map((r) => [r.label, ethers.Wallet.createRandom().address]));
      const at3 = vaultOps(vaults, launchPlan(srx("16800000")).allocations);
      const at6 = vaultOps(vaults, launchPlan(srx("12000000")).allocations); // one buyer refunded
      expect(at6.declare.id).to.not.equal(at3.declare.id);
      expect(vaultOps(vaults, launchPlan(srx("16800000")).allocations).declare.id).to.equal(at3.declare.id);
      expect(vaultOps(vaults).declare.id).to.equal(vaultOps(vaults, launchPlan(0n).allocations).declare.id);
    });
  });

  describe("which chain (PSR-03: Ethereum only)", function () {
    it("allows Ethereum and the test networks, and refuses any other real network", function () {
      expect(() => assertGenesisChain("ethereum")).to.not.throw();
      for (const t of ["hardhat", "localhost", "sepolia", "bscTestnet"]) expect(() => assertGenesisChain(t)).to.not.throw();
      for (const other of ["bsc", "zkSync", "base", "polygon"]) {
        expect(() => assertGenesisChain(other)).to.throw(/Ethereum only/);
      }
    });
  });

  describe("readGenesisSold (from the Genesis contract itself)", function () {
    async function fixture() {
      const [admin, buyer1, buyer2, treasury] = await ethers.getSigners();
      const endpoint = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
      const SRXToken = await ethers.getContractFactory("SRXToken");
      const token = await SRXToken.deploy(await endpoint.getAddress(), admin.address);
      const other = await SRXToken.deploy(await endpoint.getAddress(), admin.address);
      const Feed = await ethers.getContractFactory("MockChainlinkFeed");
      const ethFeed = await Feed.deploy(2_500n * 10n ** 8n);
      const btcFeed = await Feed.deploy(60_000n * 10n ** 8n);
      const round = await (await ethers.getContractFactory("PreSaleRound")).deploy(
        await token.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
        await ethFeed.getAddress(), await btcFeed.getAddress(), admin.address,
        srx("300000000"), 1_250_000n, true, 5_000n, treasury.address);
      await approveBuyers(round, admin, [buyer1, buyer2]);
      await round.connect(admin).addInvestor(buyer1.address, usd(100_000)); // 12,000,000 SRX
      await round.connect(admin).addInvestor(buyer2.address, usd(40_000));  //  4,800,000 SRX
      return { admin, token, other, round };
    }
    const envFor = (round) => ({ PRESALE_ROUND_HARDHAT: round });

    it("refuses while the round is open", async function () {
      const { token, round } = await loadFixture(fixture);
      await expect(readGenesisSold({ networkName: "hardhat", env: envFor(await round.getAddress()), provider: ethers.provider, tokenAddress: await token.getAddress() }))
        .to.be.rejectedWith(/still open/);
    });

    it("returns exactly what was sold, bonus included, once the round is closed", async function () {
      const { admin, token, round } = await loadFixture(fixture);
      await round.connect(admin).finalize();
      const r = await readGenesisSold({ networkName: "hardhat", env: envFor(await round.getAddress()), provider: ethers.provider, tokenAddress: await token.getAddress() });
      expect(r.sold).to.equal(srx("16800000"));
      expect(r.address).to.equal(await round.getAddress());
    });

    it("refuses a Genesis contract that pays out a different token", async function () {
      const { admin, other, round } = await loadFixture(fixture);
      await round.connect(admin).finalize();
      await expect(readGenesisSold({ networkName: "hardhat", env: envFor(await round.getAddress()), provider: ethers.provider, tokenAddress: await other.getAddress() }))
        .to.be.rejectedWith(/not the launch token/);
    });

    it("the Genesis lock is the seed schedule (the premise of funding it from seed)", async function () {
      const { round } = await loadFixture(fixture);
      expect(await round.CLIFF_DURATION()).to.equal(VESTING.seedInvestors.cliffDuration);
      expect(await round.VESTING_DURATION()).to.equal(VESTING.seedInvestors.vestingDuration);
      expect(await round.TGE_UNLOCK_BPS()).to.equal(VESTING.seedInvestors.tgeUnlockBps);
    });

    it("on a real network an unset Genesis address is an error, never a silent 'no round'", async function () {
      await expect(readGenesisSold({ networkName: "ethereum", env: {}, provider: ethers.provider }))
        .to.be.rejectedWith(/PRESALE_ROUND_ETHEREUM is not set/);
      const none = await readGenesisSold({ networkName: "ethereum", env: { PRESALE_ROUND_ETHEREUM: "none" }, provider: ethers.provider });
      expect(none.sold).to.equal(0n);
      const unsetTestnet = await readGenesisSold({ networkName: "hardhat", env: {}, provider: ethers.provider });
      expect(unsetTestnet.sold).to.equal(0n);
    });
  });
});
