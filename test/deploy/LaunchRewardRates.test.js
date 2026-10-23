/**
 * Launch reward rates (Security ruling, 23 Oct 2026): set once in the 06 Safe batch from the
 * published plan, because after the hand-over a rate is a governance vote and governance can
 * pass nothing until holders have delegated 400M SRX.
 *
 *  1. the plan values: staking 13.5 SRX/s on every network; the fund null until Jared confirms;
 *  2. the manifest must state the same values, byte for byte (checkRewardRates);
 *  3. a rate cannot promise more than the funded pool: a too-high rate only ends the period
 *     sooner, and everything ever paid stays within the pool.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { REWARD_RATES, rewardRatesFor } = require("../../scripts/deploy/00_config");
const { checkRewardRates } = require("../../scripts/deploy/lib/tge_targets");
const { allocationSource } = require("../helpers/allocationSource");

const E = (n) => ethers.parseUnits(String(n), 18);
const STAKING_RATE = "13500000000000000000";

describe("Launch reward rates: set once at TGE from the published plan", function () {
  it("the plan: staking 13.5 SRX/s on test networks and mainnet; the fund not set (null) until confirmed", function () {
    expect(REWARD_RATES.staking.mainnet).to.equal(E("13.5"));
    expect(REWARD_RATES.staking.testnet).to.equal(E("13.5"));
    expect(REWARD_RATES.stabilisationFund.mainnet).to.equal(null);
    expect(rewardRatesFor("ethereum").staking.toString()).to.equal(STAKING_RATE);
    // About four years for the 1.7B staking allocation.
    const years = Number(E(1_700_000_000) / E("13.5")) / (365 * 86400);
    expect(years).to.be.within(3.9, 4.1);
  });

  it("the manifest must state the plan exactly (frozen plan): match passes; missing, wrong or extra values fail", function () {
    const ok = { rewardRates: { staking: STAKING_RATE, stabilisationFund: null } };
    expect(checkRewardRates({ manifest: ok, networkName: "ethereum" })).to.deep.equal([]);
    expect(checkRewardRates({ manifest: {}, networkName: "ethereum" })[0]).to.match(/does not state rewardRates/);
    expect(checkRewardRates({ manifest: { rewardRates: { staking: "13500000000000000001", stabilisationFund: null } }, networkName: "ethereum" })[0])
      .to.match(/rewardRates\.staking: the manifest says 13500000000000000001/);
    expect(checkRewardRates({ manifest: { rewardRates: { staking: STAKING_RATE, stabilisationFund: "1" } }, networkName: "ethereum" })[0])
      .to.match(/stabilisationFund: the manifest says 1, the plan .* says null/);
    expect(checkRewardRates({ manifest: { rewardRates: { staking: STAKING_RATE } }, networkName: "ethereum" })[0])
      .to.match(/stabilisationFund is missing/);
    // The committed example manifest states the plan.
    expect(checkRewardRates({ manifest: require("../../deploy/addresses.example.json"), networkName: "ethereum" })).to.deep.equal([]);
  });

  it("a rate cannot promise more than the funded pool: a far-too-high rate only ends the period sooner", async function () {
    const [admin, staker] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await token.genesis(admin.address);
    const POOL = E(1_000_000);
    const src = await allocationSource(token, POOL);
    const staking = await (await ethers.getContractFactory("SRXStaking")).deploy(await token.getAddress(), admin.address, src);
    await token.transfer(await staking.getAddress(), POOL);
    await staking.notifyRewardAmount(POOL);
    await token.transfer(staker.address, E(10_000));
    await token.connect(staker).approve(await staking.getAddress(), E(10_000));
    await staking.connect(staker).lock(E(10_000), 30 * 86400);
    // A rate far too high: the whole pool in about 74 seconds instead of years.
    await staking.setRewardRate(POOL / 74n);
    const finish = await staking.periodFinish();
    expect(finish - BigInt(await time.latest())).to.be.lte(75n); // the period ends when the pool runs out
    await time.increase(365 * 86400);                            // a year later, still nothing more
    const earned = await staking.earned(staker.address);
    expect(earned).to.be.lte(POOL);            // never more than was funded
    expect(earned).to.be.gt((POOL * 99n) / 100n); // and the single staker did receive (almost) all of it
  });
});
