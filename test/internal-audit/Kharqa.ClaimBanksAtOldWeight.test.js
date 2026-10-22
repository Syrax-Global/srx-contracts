// kharqa's report (16 Oct 2026, against the public copy): claimBonusRewards decayed an expired
// lock's weight BEFORE banking the SRX rewards accrued since the last checkpoint, so part of
// them (up to half, on a 180-day lock) was lost. REG-50 removed the bonus stream, and the
// decay now runs at the end of _updateReward, after the accrual is banked at the old weight.
// Pinned: an untouched expired lock is paid every reward it earned, at its old weight.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { allocationSource } = require("../helpers/allocationSource");

const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;

describe("kharqa: a claim on an expired lock banks rewards at the old weight before the decay", function () {
  for (const [days, mult] of [[30, "1.25"], [90, "1.5"], [180, "2"]]) {
    it(`${days}-day lock: the claim pays exactly what earned() showed, then the weight drops to principal`, async function () {
      const [admin, alice, bob] = await ethers.getSigners();
      const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
      const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
      await srx.connect(admin).genesis(admin.address);
      const staking = await (await ethers.getContractFactory("SRXStaking"))
        .deploy(await srx.getAddress(), admin.address, await allocationSource(srx));
      await srx.connect(admin).transfer(await staking.getAddress(), E(10_000_000));
      await staking.connect(admin).notifyRewardAmount(E(1_000_000));
      await staking.connect(admin).setRewardRate(E("0.01"));
      for (const u of [alice, bob]) {
        await srx.connect(admin).transfer(u.address, E(10_000));
        await srx.connect(u).approve(await staking.getAddress(), ethers.MaxUint256);
      }
      await staking.connect(alice).lock(E(1_000), days * DAY);
      await staking.connect(bob).lock(E(1_000), 7 * DAY);
      expect((await staking.positions(alice.address)).weightedAmount).to.equal(E(1_000) * BigInt(Number(mult) * 100) / 100n);
      await time.increase((days + 5) * DAY);                    // expired, untouched
      const owed = await staking.earned(alice.address);         // at the old weight
      const before = await srx.balanceOf(alice.address);
      await staking.connect(alice).claimRewards();
      const paid = (await srx.balanceOf(alice.address)) - before;
      // One more second of accrual happens in the claim's own block, at the old weight.
      expect(paid).to.be.gte(owed);
      expect(paid - owed).to.be.lte(E("0.01") * 2n);
      expect((await staking.positions(alice.address)).weightedAmount).to.equal(E(1_000));
    });
  }
});
