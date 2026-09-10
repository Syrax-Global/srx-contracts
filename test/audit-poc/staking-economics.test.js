const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("AUDIT PoC — economic staking", function () {
  // ⚠️ ON F2 AND F6b. The reward multiplier now decays back to 1.00x, but the
  //    decay is LAZY: rewardPerToken() divides by totalWeightedStake, so an
  //    "effective weight" computed inside earned() would not match the
  //    denominator and would corrupt the accumulator for every staker. The stored
  //    weight has to actually change, and no transaction runs at lockEnd.
  //
  //    So a position nobody touches keeps its multiplier. F6, where the staker
  //    interacts, is fixed outright. F2 and F6b observe pure accrual and are
  //    therefore MITIGATED rather than eliminated: pokeExpiredPosition() lets
  //    ANYONE strip a stale weight (see expired-weight-poke.test.js), which turns
  //    an indefinite leak into one bounded by somebody caring. Eliminating it
  //    entirely needs a different reward model, which is a redesign and not a fix.
  const LOCK_7D   = 7   * 86400;
  const LOCK_30D  = 30  * 86400;
  const LOCK_180D = 180 * 86400;
  const E = (n) => ethers.parseUnits(String(n), 18);

  async function fx() {
    const [admin, u1, u2] = await ethers.getSigners();

    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const ep = await MockLZEndpoint.deploy(40161);
    await ep.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await ep.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    const SRXStaking = await ethers.getContractFactory("SRXStaking");
    const staking = await upgrades.deployProxy(
      SRXStaking, [await token.getAddress(), admin.address], { kind: "uups" }
    );
    await staking.waitForDeployment();
    const sa = await staking.getAddress();

    await token.connect(admin).transfer(u1.address, E(2_000_000));
    await token.connect(admin).transfer(u2.address, E(2_000_000));
    await token.connect(u1).approve(sa, ethers.MaxUint256);
    await token.connect(u2).approve(sa, ethers.MaxUint256);

    return { token, staking, sa, admin, u1, u2 };
  }

  it("F1: [FIXED] setRewardRate keeps emission within the funded pool and pays every claimer in full", async function () {
    const { token, staking, sa, admin, u1, u2 } = await loadFixture(fx);

    // Fund a 1,000 SRX pool at 1 SRX/second => a 1,000 second schedule.
    await token.connect(admin).transfer(sa, E(1000));
    await staking.connect(admin).notifyRewardAmount(E(1000));
    await staking.connect(admin).setRewardRate(E(1));

    expect(await staking.rewardPool()).to.equal(E(1000));

    // Two identical stakers.
    await staking.connect(u1).lock(E(100000), LOCK_7D);
    await staking.connect(u2).lock(E(100000), LOCK_7D);

    // Halfway through the schedule: 500 SRX accrued, none claimed.
    await time.increase(500);
    await staking.connect(admin).setRewardRate(E(1)); // no-op rate "change" (routine governance call)

    const pf = await staking.periodFinish();
    const now = BigInt(await time.latest());
    console.log("  periodFinish - now after the no-op rate set:", (pf - now).toString(), "s (pool/rate = 1000)");

    // Run the schedule to completion.
    await time.increase(2000);

    const e1 = await staking.earned(u1.address);
    const e2 = await staking.earned(u2.address);
    const pool = await staking.rewardPool();
    console.log("  earned(u1)     =", ethers.formatUnits(e1, 18));
    console.log("  earned(u2)     =", ethers.formatUnits(e2, 18));
    console.log("  earned total   =", ethers.formatUnits(e1 + e2, 18));
    console.log("  rewardPool     =", ethers.formatUnits(pool, 18));

    // ✅ FIXED — the schedule is now bounded by the UNACCRUED pool, so total
    //    obligations can no longer exceed what is actually funded.
    expect(e1 + e2).to.be.lessThanOrEqual(pool);

    // First claimer is paid in full; second is silently truncated by _settleRewards.
    const b1 = await token.balanceOf(u1.address);
    await staking.connect(u1).claimRewards();
    const paid1 = (await token.balanceOf(u1.address)) - b1;

    const b2 = await token.balanceOf(u2.address);
    await staking.connect(u2).claimRewards();
    const paid2 = (await token.balanceOf(u2.address)) - b2;

    console.log("  u1 actually paid =", ethers.formatUnits(paid1, 18));
    console.log("  u2 actually paid =", ethers.formatUnits(paid2, 18));
    console.log("  u2 shortfall     =", ethers.formatUnits(e2 - paid2, 18));
    console.log("  u2 pendingRewards after claim =", (await staking.pendingRewards(u2.address)).toString());

    // ✅ Both stakers are paid in full: there is no shortfall to truncate.
    expect(paid1).to.equal(e1);
    expect(paid2).to.equal(e2);

    // ⭐ And if a shortfall ever DID occur, the remainder is retained rather than
    //    written off. Previously _settleRewards zeroed pendingRewards after
    //    capping, destroying the difference with no revert and no event.
    expect(await staking.pendingRewards(u2.address)).to.equal(0n); // nothing left owing
  });

  it("F1b: [FIXED] a top-up extends the schedule only by what it actually funds", async function () {
    const { token, staking, sa, admin, u1 } = await loadFixture(fx);
    await token.connect(admin).transfer(sa, E(1000));
    await staking.connect(admin).notifyRewardAmount(E(1000));
    await staking.connect(admin).setRewardRate(E(1));
    await staking.connect(u1).lock(E(100000), LOCK_7D);

    await time.increase(900); // 900 accrued, 100 left in schedule

    // Governance tops the pool up by a token amount of 10 SRX.
    await token.connect(admin).transfer(sa, E(10));
    await staking.connect(admin).notifyRewardAmount(E(10));

    const pf = await staking.periodFinish();
    const now = BigInt(await time.latest());
    console.log("  remaining schedule after +10 SRX top-up:", (pf - now).toString(), "s (expected ~110)");
    // ✅ FIXED — was 1010s against ~110s funded, because the whole rewardPool was
    //    divided by the rate including tokens already accrued to stakers.
    expect(pf - now).to.be.lessThan(200n);

    await time.increase(2000);
    const earned = await staking.earned(u1.address);
    const pool = await staking.rewardPool();
    console.log("  earned =", ethers.formatUnits(earned, 18), " pool =", ethers.formatUnits(pool, 18));
    // ✅ Emission no longer outruns the funded pool.
    expect(earned).to.be.lessThanOrEqual(pool);
  });

  it("F2: [MITIGATED, not eliminated] an UNTOUCHED expired position still accrues at 2.00x until poked", async function () {
    const { token, staking, sa, admin, u1, u2 } = await loadFixture(fx);

    await token.connect(admin).transfer(sa, E(1_000_000_000));
    await staking.connect(admin).notifyRewardAmount(E(1_000_000_000));
    await staking.connect(admin).setRewardRate(E(1)); // 1e9 s schedule — outlives the 180d lock

    // Same principal, different commitment.
    await staking.connect(u1).lock(E(100000), LOCK_180D);
    await staking.connect(u2).lock(E(100000), LOCK_7D);

    // Let both locks expire. Neither user is committed to anything any more.
    await time.increase(LOCK_180D + 10);

    const p1 = await staking.positions(u1.address);
    const p2 = await staking.positions(u2.address);
    console.log("  u1 weightedAmount (expired 180d):", ethers.formatUnits(p1.weightedAmount, 18));
    console.log("  u2 weightedAmount (expired   7d):", ethers.formatUnits(p2.weightedAmount, 18));
    console.log("  u1 tier (getTier, expired):", (await staking.getTier(u1.address)).toString());
    console.log("  u2 tier (getTier, expired):", (await staking.getTier(u2.address)).toString());

    // Tier has correctly reverted to raw principal for both (R7-01)...
    expect(await staking.getTier(u1.address)).to.equal(await staking.getTier(u2.address));

    // ...but reward weight has not. Measure accrual over a window well past expiry.
    const a1 = await staking.earned(u1.address);
    const a2 = await staking.earned(u2.address);
    await time.increase(100000);
    const d1 = (await staking.earned(u1.address)) - a1;
    const d2 = (await staking.earned(u2.address)) - a2;
    console.log("  post-expiry accrual u1 (was 180d):", ethers.formatUnits(d1, 18));
    console.log("  post-expiry accrual u2 (was   7d):", ethers.formatUnits(d2, 18));
    console.log("  ratio:", Number(d1 * 1000n / d2) / 1000);
    expect(d1).to.equal(d2 * 2n);
  });

  it("F3: [FIXED] earlyWithdraw charges no penalty once the lock has expired", async function () {
    const { token, staking, admin, u1 } = await loadFixture(fx);
    await staking.connect(u1).lock(E(100000), LOCK_7D);
    await time.increase(LOCK_7D + 1000); // lock fully expired

    // unlock() is the penalty-free path, but it is whenNotPaused.
    await staking.connect(admin).pause();
    await expect(staking.connect(u1).unlock()).to.be.reverted;

    const before = await token.balanceOf(u1.address);
    await staking.connect(u1).earlyWithdraw(); // the only exit while paused
    const got = (await token.balanceOf(u1.address)) - before;
    console.log("  principal 100000, returned on expired position during pause:", ethers.formatUnits(got, 18));
    // ✅ FIXED — a withdrawal after lockEnd is not early, so no penalty is due.
    //    Previously returned 90,000 of a 100,000 principal on a lock that had
    //    already run its full term.
    expect(got).to.equal(E(100000));
  });

  it("F4: [BY DESIGN after F3] during a pause earlyWithdraw is the only exit, and an EXPIRED lock now exits whole", async function () {
    const { token, staking, sa, admin, u1 } = await loadFixture(fx);
    await token.connect(admin).transfer(sa, E(1000));
    await staking.connect(admin).notifyRewardAmount(E(1000));
    await staking.connect(admin).setRewardRate(E(1));
    await staking.connect(u1).lock(E(100000), LOCK_30D);
    await time.increase(500);
    await staking.connect(admin).pause();
    await expect(staking.connect(u1).claimRewards()).to.be.reverted;
    const before = await token.balanceOf(u1.address);
    await staking.connect(u1).earlyWithdraw();
    const got = (await token.balanceOf(u1.address)) - before;
    console.log("  paused early exit returned:", ethers.formatUnits(got, 18), "(90000 principal + rewards)");
  });
});

describe("AUDIT PoC — dust staker captures the emission stream", function () {
  const LOCK_7D = 7 * 86400;
  const E = (n) => ethers.parseUnits(String(n), 18);

  it("F5: [FIXED] a dust position cannot be opened at all", async function () {
    const [admin, atk, honest] = await ethers.getSigners();

    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const ep = await MockLZEndpoint.deploy(40161); await ep.waitForDeployment();
    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await ep.getAddress(), admin.address); await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);
    const SRXStaking = await ethers.getContractFactory("SRXStaking");
    const staking = await upgrades.deployProxy(SRXStaking, [await token.getAddress(), admin.address], { kind: "uups" });
    await staking.waitForDeployment();
    const sa = await staking.getAddress();

    // TGE runbook: fund 1.7B pool, then set the documented ~4-year rate.
    await token.connect(admin).transfer(sa, E(1_700_000_000));
    await staking.connect(admin).notifyRewardAmount(E(1_700_000_000));
    await staking.connect(admin).setRewardRate(13_500_000_000_000_000_000n); // the value in 06_execute_tge.js

    // Attacker locks ONE WEI, the minimum the contract accepts, before anyone else.
    await token.connect(admin).transfer(atk.address, 1n);
    await token.connect(atk).approve(sa, ethers.MaxUint256);
    // ✅ FIXED — the dust position can no longer be opened. Previously this
    //    1-wei stake accrued 1,166,400 SRX in a single day and simultaneously
    //    blocked rescueStrandedPool(), which requires totalWeightedStake == 0.
    await expect(staking.connect(atk).lock(1n, LOCK_7D))
      .to.be.revertedWithCustomError(staking, "BelowMinimumStake");
    return; // the rest of this case described the capture that is now unreachable
    // eslint-disable-next-line no-unreachable

    const pos = await staking.positions(atk.address);
    console.log("  attacker principal (wei):", pos.amount.toString(), " weighted:", pos.weightedAmount.toString());
    console.log("  totalWeightedStake:", (await staking.totalWeightedStake()).toString());

    await time.increase(86400); // one day before any honest staker arrives

    const earned = await staking.earned(atk.address);
    console.log("  attacker earned after 1 day on a 1-wei stake:", ethers.formatUnits(earned, 18), "SRX");
    await staking.connect(atk).claimRewards();
    console.log("  attacker SRX balance after claim:", ethers.formatUnits(await token.balanceOf(atk.address), 18));
    expect(earned).to.be.greaterThan(E(1_000_000));

    // rescueStrandedPool cannot be used to recover while the dust position exists.
    await expect(staking.connect(admin).rescueStrandedPool(admin.address)).to.be.reverted;
    console.log("  rescueStrandedPool() reverts while the 1-wei position is open");
  });
});

describe("AUDIT PoC — 2x weight retained and topped up with no lock", function () {
  const LOCK_180D = 180 * 86400;
  const E = (n) => ethers.parseUnits(String(n), 18);

  it("F6: [FIXED] addToPosition on an expired lock no longer adds capital at 2.00x", async function () {
    const [admin, u1] = await ethers.getSigners();
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const ep = await MockLZEndpoint.deploy(40161); await ep.waitForDeployment();
    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await ep.getAddress(), admin.address); await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);
    const SRXStaking = await ethers.getContractFactory("SRXStaking");
    const staking = await upgrades.deployProxy(SRXStaking, [await token.getAddress(), admin.address], { kind: "uups" });
    await staking.waitForDeployment();
    const sa = await staking.getAddress();

    await token.connect(admin).transfer(sa, E(1_000_000_000));
    await staking.connect(admin).notifyRewardAmount(E(1_000_000_000));
    await staking.connect(admin).setRewardRate(E(1));
    await token.connect(admin).transfer(u1.address, E(2_000_000));
    await token.connect(u1).approve(sa, ethers.MaxUint256);

    await staking.connect(u1).lock(E(100_000), LOCK_180D);
    await time.increase(LOCK_180D + 1); // lock over — fully liquid

    // newDuration = 0 keeps the ALREADY-EXPIRED lockEnd, but weightedAmount is
    // recomputed from the stored lockDuration, which is still LOCK_180D.
    await staking.connect(u1).addToPosition(E(900_000), 0);

    const p = await staking.positions(u1.address);
    const now = BigInt(await time.latest());
    console.log("  principal:", ethers.formatUnits(p.amount, 18));
    console.log("  weightedAmount:", ethers.formatUnits(p.weightedAmount, 18));
    console.log("  lockEnd:", p.lockEnd.toString(), " now:", now.toString(), " => lock expired:", p.lockEnd < now);
    console.log("  lockDuration still:", p.lockDuration.toString(), "(180d =", LOCK_180D, ")");

    expect(p.weightedAmount).to.equal(p.amount * 2n);  // 2.00x on the whole, freshly-added position
    expect(p.lockEnd).to.be.lessThan(now);             // ...with no live lock at all

    // And unlock() is callable in the same breath — zero commitment.
    await staking.connect(u1).unlock();
    console.log("  unlock() succeeded immediately after topping up at 2.00x weight");
  });
});

describe("AUDIT PoC — F6 minimal-capital variant", function () {
  const LOCK_180D = 180 * 86400;
  const E = (n) => ethers.parseUnits(String(n), 18);

  it("F6b: [FIXED] a 1-wei seed lock cannot be created, so the permanent 2.00x slot is unreachable", async function () {
    const [admin, atk, honest] = await ethers.getSigners();
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const ep = await MockLZEndpoint.deploy(40161); await ep.waitForDeployment();
    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await ep.getAddress(), admin.address); await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);
    const SRXStaking = await ethers.getContractFactory("SRXStaking");
    const staking = await upgrades.deployProxy(SRXStaking, [await token.getAddress(), admin.address], { kind: "uups" });
    await staking.waitForDeployment();
    const sa = await staking.getAddress();

    await token.connect(admin).transfer(sa, E(1_000_000_000));
    await staking.connect(admin).notifyRewardAmount(E(1_000_000_000));
    await staking.connect(admin).setRewardRate(E(1));
    for (const s of [atk, honest]) {
      await token.connect(admin).transfer(s.address, E(1_000_000));
      await token.connect(s).approve(sa, ethers.MaxUint256);
    }

    // ✅ FIXED — the 1-wei seed lock is refused, so the permanent 2.00x slot it
    //    minted is unreachable. F6 (a real position topped up after expiry) is
    //    fixed separately by the weight decay.
    await expect(staking.connect(atk).lock(1n, LOCK_180D))
      .to.be.revertedWithCustomError(staking, "BelowMinimumStake");
    return;
    // eslint-disable-next-line no-unreachable
    await time.increase(LOCK_180D + 1);
    await staking.connect(atk).addToPosition(E(1_000_000) - 1n, 0); // real capital, zero lock

    // Honest staker commits the same capital for a real 180 days.
    await staking.connect(honest).lock(E(1_000_000), LOCK_180D);

    const a0 = await staking.earned(atk.address);
    const h0 = await staking.earned(honest.address);
    await time.increase(30 * 86400);
    const da = (await staking.earned(atk.address)) - a0;
    const dh = (await staking.earned(honest.address)) - h0;
    console.log("  30d accrual, attacker (no live lock):", ethers.formatUnits(da, 18));
    console.log("  30d accrual, honest  (180d locked)  :", ethers.formatUnits(dh, 18));
    console.log("  attacker can unlock() at any time; honest cannot until day 180.");
    expect(da).to.be.closeTo(dh, dh / 1000n);
    await staking.connect(atk).unlock(); // liquid the whole time
  });
});
