// REG-53 (Jared, 12 Oct 2026: "Lock them"): SRXStaking, FeeController, StabilisationFund and
// SRXTreasury, the staking and fee-path contracts, are plain contracts. Their code can never
// change and no role can replace it; the pause stays; a fix ships as a new contract that
// holders choose to move to (docs/MIGRATION.md).
//
// Security's requirement (12 Oct): once upgrades are gone, a bug plus a pause must never
// trap users' SRX. So the two contracts that hold users' SRX (SRXStaking, StabilisationFund)
// have an irreversible wind-down: exit-only, exact principal back with no penalty and no
// lock wait, even while paused; accrued rewards stay claimable; nobody's tokens are moved
// for them.
//
// The Command Centre mutates this: re-adding an upgrade path (UUPSUpgradeable /
// _authorizeUpgrade), gating the exit with whenNotPaused, or charging the penalty on exit
// must each fail a test here.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { allocationSource } = require("./helpers/allocationSource");

const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;
const sel = (sig) => ethers.id(sig).slice(0, 10);
const UPGRADE_SELECTORS = {
  "upgradeToAndCall(address,bytes)": sel("upgradeToAndCall(address,bytes)"),
  "upgradeTo(address)": sel("upgradeTo(address)"),
  "proxiableUUID()": sel("proxiableUUID()"),
};

async function suite() {
  const [admin, timelock, safe, alice, bob, carol, stranger] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
  await srx.connect(admin).genesis(admin.address);
  const src = await allocationSource(srx, E(1_700_000_000));
  const f = (n) => ethers.getContractFactory(n);
  const staking  = await (await f("SRXStaking")).deploy(await srx.getAddress(), admin.address, src);
  const fund     = await (await f("StabilisationFund")).deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), src);
  const fee      = await (await f("FeeController")).deploy(await staking.getAddress(), admin.address);
  const treasury = await (await f("SRXTreasury")).deploy(await srx.getAddress(), admin.address, timelock.address);

  for (const c of [staking, fund]) {
    await c.connect(admin).grantRole(await c.GOVERNANCE_ROLE(), timelock.address);
    await c.connect(admin).grantRole(await c.WIND_DOWN_ROLE(), safe.address);
    await srx.connect(admin).transfer(await c.getAddress(), E(20_000_000)); // launch SRX (reward backing)
  }
  for (const u of [alice, bob, carol]) {
    await srx.connect(admin).transfer(u.address, E(1_000_000));
    await srx.connect(u).approve(await staking.getAddress(), ethers.MaxUint256);
    await srx.connect(u).approve(await fund.getAddress(), ethers.MaxUint256);
  }
  const usdc = await (await f("MockERC20")).deploy("USD Coin", "USDC", 6);
  return { admin, timelock, safe, alice, bob, carol, stranger, srx, usdc, staking, fund, fee, treasury };
}

// ═════════════════════════════════════════════════════════════════════════════
describe("REG-53: the staking and fee-path contracts cannot be upgraded", function () {
  for (const key of ["staking", "fund", "fee", "treasury"]) {
    it(`${key}: no upgrade function, no UPGRADER_ROLE, no initialize(), and no upgrade selector in the deployed code`, async function () {
      const ctx = await loadFixture(suite);
      const c = ctx[key];
      const names = c.interface.fragments.map((x) => x.name).filter(Boolean);
      for (const n of ["upgradeToAndCall", "upgradeTo", "proxiableUUID", "UPGRADER_ROLE", "initialize", "UPGRADE_INTERFACE_VERSION"]) {
        expect(names, `${key} exposes ${n}`).to.not.include(n);
      }
      const code = (await ethers.provider.getCode(await c.getAddress())).toLowerCase();
      for (const [sig, s] of Object.entries(UPGRADE_SELECTORS)) {
        expect(code.includes(s.slice(2)), `${key} bytecode contains the ${sig} selector`).to.equal(false);
      }
    });

    it(`${key}: an upgrade call from every role (admin/Safe, Timelock, stranger) reverts and changes nothing`, async function () {
      const ctx = await loadFixture(suite);
      const c = ctx[key];
      const addr = await c.getAddress();
      const codeBefore = await ethers.provider.getCode(addr);
      const impl = await (await ethers.getContractFactory("MockERC20")).deploy("X", "X", 18);
      const data = c.interface.encodeFunctionData !== undefined
        ? new ethers.Interface(["function upgradeToAndCall(address,bytes)"]).encodeFunctionData("upgradeToAndCall", [await impl.getAddress(), "0x"])
        : "0x";
      for (const who of [ctx.admin, ctx.timelock, ctx.safe, ctx.stranger]) {
        await expect(who.sendTransaction({ to: addr, data })).to.be.reverted;
      }
      expect(await ethers.provider.getCode(addr)).to.equal(codeBefore);
    });

    it(`${key}: the pause still works and is the PAUSER_ROLE's alone`, async function () {
      const ctx = await loadFixture(suite);
      const c = ctx[key];
      await expect(c.connect(ctx.stranger).pause()).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
      await c.connect(ctx.admin).pause();
      expect(await c.paused()).to.equal(true);
      await c.connect(ctx.admin).unpause();
      expect(await c.paused()).to.equal(false);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
describe("REG-53 wind-down: SRXStaking is exit-only for good, even while paused", function () {
  async function staked() {
    const ctx = await suite();
    const { staking, timelock, alice, bob, carol } = ctx;
    await staking.connect(timelock).notifyRewardAmount(E(1_000_000));
    await staking.connect(timelock).setRewardRate(E(1));
    await staking.connect(alice).lock(E(10_000), 180 * DAY);
    await staking.connect(bob).lock(E(25_000), 7 * DAY);
    await staking.connect(carol).lock(E(400), 30 * DAY);
    await time.increase(DAY);
    return ctx;
  }

  it("while paused, each staker gets back exactly their principal, with no penalty and no lock wait", async function () {
    const { srx, staking, admin, safe, alice, bob, carol } = await loadFixture(staked);
    await staking.connect(admin).pause();
    await staking.connect(safe).startWindDown();
    for (const [u, p] of [[alice, E(10_000)], [bob, E(25_000)], [carol, E(400)]]) {
      const before = await srx.balanceOf(u.address);
      await expect(staking.connect(u).exitAfterWindDown()).to.emit(staking, "ExitedAfterWindDown").withArgs(u.address, p);
      expect(await srx.balanceOf(u.address)).to.equal(before + p); // exact principal, nothing less, nothing more
    }
    expect(await staking.totalLocked()).to.equal(0n);
  });

  it("nobody can exit twice or take another's principal; new locks and rewards are refused", async function () {
    const { staking, timelock, safe, alice, stranger } = await loadFixture(staked);
    await staking.connect(safe).startWindDown();
    await staking.connect(alice).exitAfterWindDown();
    await expect(staking.connect(alice).exitAfterWindDown()).to.be.revertedWithCustomError(staking, "NoPosition");
    await expect(staking.connect(stranger).exitAfterWindDown()).to.be.revertedWithCustomError(staking, "NoPosition");
    await expect(staking.connect(alice).lock(E(1_000), 7 * DAY)).to.be.revertedWithCustomError(staking, "WoundDown");
    await expect(staking.connect(timelock).notifyRewardAmount(E(1))).to.be.revertedWithCustomError(staking, "WoundDown");
    await expect(staking.connect(timelock).setRewardRate(E(1))).to.be.revertedWithCustomError(staking, "WoundDown");
  });

  it("rewards accrued before the switch stay claimable, even while paused; none accrue after", async function () {
    const { srx, staking, admin, safe, alice } = await loadFixture(staked);
    await staking.connect(admin).pause();
    await staking.connect(safe).startWindDown();
    const owed = await staking.earned(alice.address);
    expect(owed).to.be.greaterThan(0n);
    await time.increase(30 * DAY);
    expect(await staking.earned(alice.address)).to.equal(owed);
    await staking.connect(alice).exitAfterWindDown();
    const before = await srx.balanceOf(alice.address);
    await staking.connect(alice).claimRewards();
    expect(await srx.balanceOf(alice.address)).to.equal(before + owed);
  });

  it("is one-way: there is no function to turn it off, and a second switch reverts", async function () {
    const { staking, safe, timelock } = await loadFixture(staked);
    await staking.connect(safe).startWindDown();
    await expect(staking.connect(timelock).startWindDown()).to.be.revertedWithCustomError(staking, "WoundDown");
    const setters = staking.interface.fragments.filter((x) => x.type === "function" && /wind/i.test(x.name)).map((x) => x.name).sort();
    expect(setters).to.deep.equal(["WIND_DOWN_ROLE", "exitAfterWindDown", "startWindDown", "windDown", "windDownOpenToAllAt"]);
    expect(await staking.windDown()).to.equal(true);
  });

  it("who may switch it: Timelock or guardian Safe at any time; anyone only after 30 days of pause within a run (a re-pause within 7 days continues the run)", async function () {
    const { staking, admin, stranger, timelock } = await loadFixture(staked);
    await expect(staking.connect(stranger).startWindDown()).to.be.revertedWithCustomError(staking, "NotAuthorisedToWindDown");
    await staking.connect(admin).pause();
    const first = await staking.pausedSince();
    await time.increase(10 * DAY);
    await staking.connect(admin).unpause();          // internal audit L2: a break under 7 days does NOT reset the clock
    await staking.connect(admin).pause();
    // SWEEP-03: the run's paused time counts (10 days), the break does not.
    expect(await staking.pausedInRun()).to.be.closeTo(BigInt(10 * DAY), 5n);
    const again = await staking.pausedSince();
    expect(await staking.windDownOpenToAllAt()).to.equal(again + BigInt(30 * DAY) - (await staking.pausedInRun()));
    expect(again - first).to.be.closeTo(BigInt(10 * DAY), 5n);
    await time.increase(19 * DAY);                   // ~29 days of pause in the run
    await expect(staking.connect(stranger).startWindDown()).to.be.revertedWithCustomError(staking, "NotAuthorisedToWindDown");
    await time.increase(DAY);                        // day 30 from the FIRST pause, not from the re-pause
    await expect(staking.connect(stranger).startWindDown()).to.emit(staking, "WindDownStarted").withArgs(stranger.address, true);
    // ...and the Timelock could have done it at any time (here it finds it done)
    await expect(staking.connect(timelock).startWindDown()).to.be.revertedWithCustomError(staking, "WoundDown");
  });

  it("a break of 7 days or more resets the 30-day clock; the Timelock or guardian Safe may still act at any time", async function () {
    const { staking, admin, stranger, safe } = await loadFixture(staked);
    await staking.connect(admin).pause();
    const first = await staking.pausedSince();
    await time.increase(3 * DAY);
    await staking.connect(admin).unpause();
    await time.increase(7 * DAY);                    // a break of 7 days
    await staking.connect(admin).pause();
    const second = await staking.pausedSince();
    expect(second).to.be.gt(first + BigInt(10 * DAY)); // the clock restarted
    await time.increase(29 * DAY);                   // day 39 from the first pause, day ~29 from the new one
    await expect(staking.connect(stranger).startWindDown()).to.be.revertedWithCustomError(staking, "NotAuthorisedToWindDown");
    await staking.connect(safe).startWindDown();     // the guardian Safe, at any time
    expect(await staking.windDown()).to.equal(true);
  });

  it("a stranger can wind down after a break of 7 days or more once the NEW 30 days are served", async function () {
    const { staking, admin, stranger } = await loadFixture(staked);
    await staking.connect(admin).pause();
    await time.increase(3 * DAY);
    await staking.connect(admin).unpause();
    await time.increase(7 * DAY);
    await staking.connect(admin).pause();
    await time.increase(30 * DAY);
    await expect(staking.connect(stranger).startWindDown()).to.emit(staking, "WindDownStarted").withArgs(stranger.address, true);
  });

  it("no role can move a staker's principal after wind-down; earlyWithdraw charges no penalty", async function () {
    const { srx, staking, timelock, safe, admin, alice, bob } = await loadFixture(staked);
    await staking.connect(safe).startWindDown();
    const locked = await staking.totalLocked();
    // Nothing can send the reward pool to a wallet: the rescue is gone and release names only a successor
    expect(staking.interface.fragments.filter((f) => f.name === "rescueStrandedPool")).to.have.length(0);
    await expect(staking.connect(timelock).releaseRewardAllocation(timelock.address, 1n))
      .to.be.revertedWithCustomError(staking, "NotASuccessor").withArgs(timelock.address);
    expect(await staking.totalLocked()).to.equal(locked);
    const before = await srx.balanceOf(alice.address);
    await staking.connect(alice).earlyWithdraw(); // a 180-day lock, mid-lock
    expect(await srx.balanceOf(alice.address)).to.be.greaterThanOrEqual(before + E(10_000));
    expect(await staking.totalPenaltyBurned()).to.equal(0n);
    void admin; void bob;
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("REG-53 wind-down: StabilisationFund is exit-only for depositors, even while paused", function () {
  async function deposited() {
    const ctx = await suite();
    const { fund, timelock, alice, bob, carol } = ctx;
    await fund.connect(alice).contribute(E(5_000));
    await fund.connect(bob).contribute(E(12_000));
    await fund.connect(carol).contribute(E(100));
    await fund.connect(timelock).notifyRewardAmount(E(1_000_000));
    await fund.connect(timelock).setRewardRate(E(1));
    await time.increase(DAY);
    return ctx;
  }

  it("while paused and inside the withdrawal lock, each depositor gets back exactly their principal", async function () {
    const { srx, fund, admin, safe, alice, bob, carol } = await loadFixture(deposited);
    await fund.connect(admin).pause();
    await fund.connect(safe).startWindDown();
    for (const [u, p] of [[alice, E(5_000)], [bob, E(12_000)], [carol, E(100)]]) {
      const before = await srx.balanceOf(u.address);
      await expect(fund.connect(u).exitAfterWindDown()).to.emit(fund, "ExitedAfterWindDown").withArgs(u.address, p);
      expect(await srx.balanceOf(u.address)).to.equal(before + p);
    }
    expect(await fund.totalContributions()).to.equal(0n);
  });

  it("no double exit, no new deposits, rewards or stress; any stress event ends; accrued rewards stay claimable while paused", async function () {
    const { srx, fund, admin, timelock, safe, alice } = await loadFixture(deposited);
    await fund.connect(admin).grantRole(await fund.ORACLE_REPORTER_ROLE(), admin.address);
    await fund.connect(admin).triggerStressEvent();
    await fund.connect(admin).pause();
    await fund.connect(safe).startWindDown();
    expect(await fund.stressActive()).to.equal(false);
    const owed = await fund.earned(alice.address);
    await fund.connect(alice).exitAfterWindDown();
    await expect(fund.connect(alice).exitAfterWindDown()).to.be.revertedWithCustomError(fund, "NoContribution");
    await fund.connect(admin).unpause();
    await expect(fund.connect(alice).contribute(E(100))).to.be.revertedWithCustomError(fund, "WoundDown");
    await expect(fund.connect(timelock).notifyRewardAmount(E(1))).to.be.revertedWithCustomError(fund, "WoundDown");
    await expect(fund.connect(admin).triggerStressEvent()).to.be.revertedWithCustomError(fund, "WoundDown");
    await fund.connect(admin).pause();
    const before = await srx.balanceOf(alice.address);
    await fund.connect(alice).claimRewards();
    expect(await srx.balanceOf(alice.address)).to.equal(before + owed);
  });

  it("governance can still move only FREE SRX after wind-down: never principal, never reward SRX", async function () {
    const { srx, fund, timelock, safe, admin, bob } = await loadFixture(deposited);
    await fund.connect(safe).startWindDown();
    await fund.connect(admin).setDeployTarget(timelock.address, true);
    const bal = await srx.balanceOf(await fund.getAddress());
    const reserved = (await fund.totalContributions()) + (await fund.rewardPool()) + ((await fund.rewardBacking()) - (await fund.totalRewardsRegistered()));
    await expect(fund.connect(timelock).deployLiquidity(timelock.address, await srx.getAddress(), bal - reserved + 1n, "too much"))
      .to.be.revertedWithCustomError(fund, "InsufficientFreeBalance");
    await fund.connect(timelock).deployLiquidity(timelock.address, await srx.getAddress(), bal - reserved, "free SRX to v2");
    const before = await srx.balanceOf(bob.address);
    await fund.connect(bob).exitAfterWindDown();
    expect(await srx.balanceOf(bob.address)).to.equal(before + E(12_000));
  });

  it("pause clock: a re-pause within 7 days continues the 30 days", async function () {
    const { fund, admin, stranger } = await loadFixture(deposited);
    await fund.connect(admin).pause();
    const first = await fund.pausedSince();
    await time.increase(10 * DAY);
    await fund.connect(admin).unpause();
    await fund.connect(admin).pause();
    expect(await fund.pausedInRun()).to.be.closeTo(BigInt(10 * DAY), 5n);  // SWEEP-03: paused time counts
    expect((await fund.pausedSince()) - first).to.be.closeTo(BigInt(10 * DAY), 5n);
    await time.increase(19 * DAY);
    await expect(fund.connect(stranger).startWindDown()).to.be.revertedWithCustomError(fund, "NotAuthorisedToWindDown");
    await time.increase(DAY);
    await expect(fund.connect(stranger).startWindDown()).to.emit(fund, "WindDownStarted").withArgs(stranger.address, true);
  });

  it("pause clock: a break of 7 days or more restarts the 30 days", async function () {
    const { fund, admin, stranger } = await loadFixture(deposited);
    await fund.connect(admin).pause();
    await time.increase(3 * DAY);
    await fund.connect(admin).unpause();
    await time.increase(7 * DAY);
    await fund.connect(admin).pause();
    await time.increase(29 * DAY);                   // day 39 from the first pause, day ~29 from the new one
    await expect(fund.connect(stranger).startWindDown()).to.be.revertedWithCustomError(fund, "NotAuthorisedToWindDown");
    await time.increase(DAY);
    await expect(fund.connect(stranger).startWindDown()).to.emit(fund, "WindDownStarted").withArgs(stranger.address, true);
  });

  it("is one-way, and anyone may switch it only after 30 days of continuous pause", async function () {
    const { fund, admin, stranger, timelock } = await loadFixture(deposited);
    await expect(fund.connect(stranger).startWindDown()).to.be.revertedWithCustomError(fund, "NotAuthorisedToWindDown");
    await fund.connect(admin).pause();
    await time.increase(30 * DAY);
    await expect(fund.connect(stranger).startWindDown()).to.emit(fund, "WindDownStarted").withArgs(stranger.address, true);
    await expect(fund.connect(timelock).startWindDown()).to.be.revertedWithCustomError(fund, "WoundDown");
    const winds = fund.interface.fragments.filter((x) => x.type === "function" && /wind/i.test(x.name)).map((x) => x.name).sort();
    expect(winds).to.deep.equal(["WIND_DOWN_ROLE", "exitAfterWindDown", "startWindDown", "windDown", "windDownOpenToAllAt"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("REG-53 migration: the unused reward allocation moves to a successor, and nothing else does", function () {
  async function ready() {
    const ctx = await suite();
    const { staking, timelock, alice, bob } = ctx;
    await staking.connect(timelock).notifyRewardAmount(E(5_000_000));
    await staking.connect(timelock).setRewardRate(E(1));
    await staking.connect(alice).lock(E(10_000), 30 * DAY);
    await staking.connect(bob).lock(E(20_000), 7 * DAY);
    await time.increase(DAY);
    return ctx;
  }
  const successorOf = async (srx, admin, source) =>
    (await ethers.getContractFactory("SRXStaking")).deploy(await srx.getAddress(), admin.address, source);

  it("before wind-down nothing is releasable; only the Timelock may release; never more than the unused allocation", async function () {
    const { srx, admin, staking, timelock, safe } = await loadFixture(ready);
    const v2 = await successorOf(srx, admin, await staking.getAddress());
    expect(await staking.releasableRewardAllocation()).to.equal(0n);
    await expect(staking.connect(timelock).releaseRewardAllocation(await v2.getAddress(), 1n))
      .to.be.revertedWithCustomError(staking, "ReleaseExceedsUnusedAllocation").withArgs(0n, 1n);
    await staking.connect(safe).startWindDown();
    await expect(staking.connect(safe).releaseRewardAllocation(await v2.getAddress(), 1n))
      .to.be.revertedWithCustomError(staking, "AccessControlUnauthorizedAccount");
    const releasable = await staking.releasableRewardAllocation();
    await expect(staking.connect(timelock).releaseRewardAllocation(await v2.getAddress(), releasable + 1n))
      .to.be.revertedWithCustomError(staking, "ReleaseExceedsUnusedAllocation");
  });

  it("release only to a contract that names this one as its source: never a wallet or an unrelated contract (Security, 12 Oct)", async function () {
    const { srx, usdc, admin, staking, fund, timelock, safe, stranger } = await loadFixture(ready);
    await staking.connect(safe).startWindDown();
    const otherSourced = await successorOf(srx, admin, await fund.getAddress()); // names the fund, not staking
    for (const target of [stranger.address, await usdc.getAddress(), await otherSourced.getAddress()]) {
      await expect(staking.connect(timelock).releaseRewardAllocation(target, 1n))
        .to.be.revertedWithCustomError(staking, "NotASuccessor").withArgs(target);
    }
    const v2 = await successorOf(srx, admin, await staking.getAddress());
    await expect(staking.connect(timelock).releaseRewardAllocation(await v2.getAddress(), 1n))
      .to.emit(staking, "RewardAllocationReleased").withArgs(await v2.getAddress(), 1n);
  });

  it("releasing everything releasable leaves every staker's principal and owed rewards fully payable", async function () {
    const { srx, admin, staking, timelock, safe, alice, bob } = await loadFixture(ready);
    await staking.connect(safe).startWindDown();
    const v2 = await successorOf(srx, admin, await staking.getAddress());
    const owedA = await staking.earned(alice.address), owedB = await staking.earned(bob.address);
    await staking.connect(timelock).releaseRewardAllocation(await v2.getAddress(), await staking.releasableRewardAllocation());
    expect(await staking.releasableRewardAllocation()).to.equal(0n);
    for (const [u, p, owed] of [[alice, E(10_000), owedA], [bob, E(20_000), owedB]]) {
      const before = await srx.balanceOf(u.address);
      await staking.connect(u).exitAfterWindDown();
      await staking.connect(u).claimRewards();
      expect(await srx.balanceOf(u.address)).to.equal(before + p + owed);
    }
  });

  it("fee SRX sent to the old contract is never releasable, so it can never back the successor's rewards", async function () {
    const { srx, admin, timelock, safe, alice } = await loadFixture(ready);
    const st = await (await ethers.getContractFactory("SRXStaking")).deploy(await srx.getAddress(), admin.address, await allocationSource(srx, E(20_000_000)));
    await st.connect(admin).grantRole(await st.WIND_DOWN_ROLE(), safe.address);
    await st.connect(admin).grantRole(await st.GOVERNANCE_ROLE(), timelock.address);
    await srx.connect(admin).transfer(await st.getAddress(), E(20_000_000));
    await st.connect(timelock).notifyRewardAmount(E(5_000_000));
    await st.connect(timelock).setRewardRate(E(1));
    await srx.connect(alice).approve(await st.getAddress(), ethers.MaxUint256);
    await st.connect(alice).lock(E(10_000), 30 * DAY);
    await time.increase(DAY);
    await st.connect(safe).startWindDown();
    const releasable = await st.releasableRewardAllocation();
    expect(releasable).to.be.greaterThan(E(15_000_000));
    await srx.connect(admin).transfer(await st.getAddress(), E(3_000_000)); // "fee" SRX
    expect(await st.releasableRewardAllocation()).to.equal(releasable);
  });

  it("a pool that never registered rewards can still migrate: wind-down reads the allocation first (Security, 12 Oct)", async function () {
    const { srx, admin, safe, timelock } = await loadFixture(ready);
    const st = await (await ethers.getContractFactory("SRXStaking")).deploy(await srx.getAddress(), admin.address, await allocationSource(srx, E(20_000_000)));
    await st.connect(admin).grantRole(await st.GOVERNANCE_ROLE(), timelock.address);
    await srx.connect(admin).transfer(await st.getAddress(), E(20_000_000));
    expect(await st.allocationSynced()).to.equal(false);
    await st.connect(admin).startWindDown();
    expect(await st.allocationSynced()).to.equal(true);
    expect(await st.releasableRewardAllocation()).to.equal(E(20_000_000));
    void safe;
  });

  it("the fund too: one that never registered rewards reads its allocation at wind-down and can release it to a successor (Security, 12 Oct)", async function () {
    const { srx, admin, timelock, alice } = await loadFixture(ready);
    const src = await allocationSource(srx, E(1_500_000_000));
    const F = await ethers.getContractFactory("StabilisationFund");
    const ssf = await F.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), src);
    await ssf.connect(admin).grantRole(await ssf.GOVERNANCE_ROLE(), timelock.address);
    await srx.connect(admin).transfer(await ssf.getAddress(), E(20_000_000));
    await srx.connect(alice).approve(await ssf.getAddress(), ethers.MaxUint256);
    await ssf.connect(alice).contribute(E(1_000));
    expect(await ssf.allocationSynced()).to.equal(false);   // no registration ever happened
    await ssf.connect(admin).startWindDown();
    expect(await ssf.allocationSynced()).to.equal(true);
    const releasable = await ssf.releasableRewardAllocation();
    expect(releasable).to.equal(E(10_000_000));               // the whole reward allocation
    const v2 = await F.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), await ssf.getAddress());
    await expect(ssf.connect(timelock).releaseRewardAllocation(await v2.getAddress(), releasable))
      .to.emit(ssf, "RewardAllocationReleased").withArgs(await v2.getAddress(), releasable);
    const before = await srx.balanceOf(alice.address);
    await ssf.connect(alice).exitAfterWindDown();
    expect(await srx.balanceOf(alice.address)).to.equal(before + E(1_000));
  });

  it("wind-down is never blocked by an allocation source that cannot answer", async function () {
    const { srx, admin, alice } = await loadFixture(ready);
    const src = await (await ethers.getContractFactory("MockTGEAllocationSource")).deploy(await srx.getAddress(), E(1), false); // not distributed: sync reverts
    const st = await (await ethers.getContractFactory("SRXStaking")).deploy(await srx.getAddress(), admin.address, await src.getAddress());
    await srx.connect(alice).approve(await st.getAddress(), ethers.MaxUint256);
    await st.connect(alice).lock(E(1_000), 7 * DAY);
    await expect(st.connect(admin).startWindDown()).to.emit(st, "WindDownStarted");
    expect(await st.allocationSynced()).to.equal(false);
    await st.connect(alice).exitAfterWindDown();
  });

  it("end to end: a successor deployed with the old contract as its source is backed by exactly what was released", async function () {
    const { srx, staking, timelock, safe, admin, alice } = await loadFixture(ready);
    await staking.connect(safe).startWindDown();
    const v2 = await successorOf(srx, admin, await staking.getAddress());
    const amount = E(4_000_000);
    await staking.connect(timelock).releaseRewardAllocation(await v2.getAddress(), amount);
    expect(await staking.allocatedTo(await v2.getAddress())).to.equal(amount);
    await srx.connect(admin).transfer(await v2.getAddress(), E(1_000_000)); // fee-like SRX at the successor
    await expect(v2.syncAllocation()).to.emit(v2, "AllocationSynced").withArgs(await staking.getAddress(), amount, amount);
    await v2.connect(admin).notifyRewardAmount(amount);
    await expect(v2.connect(admin).notifyRewardAmount(1n)).to.be.revertedWithCustomError(v2, "RewardAllocationExceeded");
    await staking.connect(alice).exitAfterWindDown();
    await srx.connect(alice).approve(await v2.getAddress(), ethers.MaxUint256);
    await v2.connect(alice).lock(E(10_000), 30 * DAY);
    expect(await v2.totalLocked()).to.equal(E(10_000));
  });

  it("the fund: release never touches depositors' principal; a successor fund is backed by exactly what was released", async function () {
    const { srx, fund, timelock, safe, admin, alice } = await loadFixture(ready);
    await fund.connect(alice).contribute(E(5_000));
    await fund.connect(timelock).notifyRewardAmount(E(1_000_000));
    await fund.connect(safe).startWindDown();
    const releasable = await fund.releasableRewardAllocation();
    const v2 = await (await ethers.getContractFactory("StabilisationFund")).deploy(
      await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), await fund.getAddress());
    await fund.connect(timelock).releaseRewardAllocation(await v2.getAddress(), releasable);
    await v2.syncAllocation();
    expect(await v2.rewardBacking()).to.equal(releasable);
    const before = await srx.balanceOf(alice.address);
    await fund.connect(alice).exitAfterWindDown();
    expect(await srx.balanceOf(alice.address)).to.equal(before + E(5_000));
  });

  // Security's principal-safety test (bus 20261012T1551Z; caught their W5 mutation), with a
  // real successor contract now that releases to a wallet are refused.
  it("SEC: a source that over-reports its delivery still can never release depositors' principal", async function () {
    const [admin, alice] = await ethers.getSigners();
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    await srx.connect(admin).genesis(admin.address);
    const src = await (await ethers.getContractFactory("MockTGEAllocationSource")).deploy(await srx.getAddress(), E(100_000_000), true);
    const Fund = await ethers.getContractFactory("StabilisationFund");
    const ssf = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(100_000_000), await src.getAddress());
    const fa = await ssf.getAddress();
    await srx.connect(admin).transfer(fa, E(10_000_000));            // only 10M actually arrives
    await srx.connect(admin).transfer(alice.address, E(1_000_000));
    await srx.connect(alice).approve(fa, ethers.MaxUint256);
    await ssf.connect(alice).contribute(E(1_000_000));                 // principal 1M
    await ssf.connect(admin).notifyRewardAmount(1n);                   // syncs the over-reported backing
    await ssf.connect(admin).startWindDown();
    const releasable = await ssf.releasableRewardAllocation();
    expect(releasable).to.be.lte(E(10_000_000));
    const v2 = await Fund.deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(100_000_000), fa);
    await ssf.connect(admin).releaseRewardAllocation(await v2.getAddress(), releasable);
    const before = await srx.balanceOf(alice.address);
    await ssf.connect(alice).exitAfterWindDown();
    expect((await srx.balanceOf(alice.address)) - before).to.equal(E(1_000_000));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("REG-53: every wind-down guard and the stablecoin deposit (CC and Security, 12 Oct)", function () {
  it("staking: addToPosition is refused after wind-down", async function () {
    const { staking, safe, alice } = await loadFixture(suite);
    await staking.connect(alice).lock(E(1_000), 30 * DAY);
    await staking.connect(safe).startWindDown();
    await expect(staking.connect(alice).addToPosition(E(100), 0)).to.be.revertedWithCustomError(staking, "WoundDown");
  });

  it("both: a second startWindDown reverts WoundDown (one-way, and no second banking of rewards)", async function () {
    const { staking, fund, safe, timelock } = await loadFixture(suite);
    for (const c of [staking, fund]) {
      await c.connect(safe).startWindDown();
      await expect(c.connect(timelock).startWindDown()).to.be.revertedWithCustomError(c, "WoundDown");
      await expect(c.connect(safe).startWindDown()).to.be.revertedWithCustomError(c, "WoundDown");
    }
  });

  it("fund: setRewardRate is refused after wind-down", async function () {
    const { fund, safe, timelock } = await loadFixture(suite);
    await fund.connect(safe).startWindDown();
    await expect(fund.connect(timelock).setRewardRate(E(1))).to.be.revertedWithCustomError(fund, "WoundDown");
  });

  it("fund: stablecoins enter only from the treasury role, and not after wind-down (Security, 12 Oct)", async function () {
    const { fund, usdc, admin, safe, alice } = await loadFixture(suite);
    const fa = await fund.getAddress();
    await usdc.mint(alice.address, 1_000_000n);
    await usdc.connect(alice).approve(fa, ethers.MaxUint256);
    await expect(fund.connect(alice).depositStableReserve(await usdc.getAddress(), 1_000_000n))
      .to.be.revertedWithCustomError(fund, "AccessControlUnauthorizedAccount");
    expect(fund.interface.fragments.some((f) => f.name === "contributeStable")).to.equal(false);
    await fund.connect(admin).grantRole(await fund.TREASURY_ROLE(), admin.address);
    await usdc.mint(admin.address, 1_000_000n);
    await usdc.connect(admin).approve(fa, ethers.MaxUint256);
    await expect(fund.connect(admin).depositStableReserve(await usdc.getAddress(), 1_000n)).to.emit(fund, "StableReserveDeposited");
    await fund.connect(safe).startWindDown();
    await expect(fund.connect(admin).depositStableReserve(await usdc.getAddress(), 1_000n)).to.be.revertedWithCustomError(fund, "WoundDown");
  });

  it("no function can send the reward pool to a wallet, and a release never moves a depositor's or staker's principal after wind-down (internal audit L1)", async function () {
    const { srx, admin, staking, fund, safe, timelock, alice, bob } = await loadFixture(suite);
    await fund.connect(alice).contribute(E(5_000));
    await fund.connect(bob).contribute(E(7_000));
    await fund.connect(timelock).notifyRewardAmount(E(100_000));
    await staking.connect(alice).lock(E(3_000), 30 * DAY);
    await staking.connect(bob).lock(E(4_000), 30 * DAY);
    await staking.connect(timelock).notifyRewardAmount(E(100_000));
    for (const c of [staking, fund]) await c.connect(safe).startWindDown();
    // rescueStrandedPool (and its event and error) no longer exist on either contract...
    for (const c of [staking, fund]) {
      expect(c.interface.fragments.filter((f) => ["rescueStrandedPool", "RewardPoolReset", "NoStrandedPool"].includes(f.name))).to.have.length(0);
      // ...and release to a wallet, even the Timelock's own, reverts NotASuccessor
      await expect(c.connect(timelock).releaseRewardAllocation(timelock.address, 1n))
        .to.be.revertedWithCustomError(c, "NotASuccessor").withArgs(timelock.address);
    }
    // A full release to a successor leaves every principal in the contract.
    const f = (n) => ethers.getContractFactory(n);
    const stakingV2 = await (await f("SRXStaking")).deploy(await srx.getAddress(), admin.address, await staking.getAddress());
    const fundV2 = await (await f("StabilisationFund")).deploy(await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, E(10_000_000), await fund.getAddress());
    for (const [c, v2, principal] of [[staking, stakingV2, E(7_000)], [fund, fundV2, E(12_000)]]) {
      const releasable = await c.releasableRewardAllocation();
      expect(releasable + principal).to.be.lte(await srx.balanceOf(await c.getAddress()));
      await c.connect(timelock).releaseRewardAllocation(await v2.getAddress(), releasable);
      expect(await srx.balanceOf(await c.getAddress())).to.be.gte(principal);
    }
    await fund.connect(alice).exitAfterWindDown();
    await staking.connect(alice).exitAfterWindDown();
    // Bob's principal is still whole in both.
    const before = await srx.balanceOf(bob.address);
    await fund.connect(bob).exitAfterWindDown();
    await staking.connect(bob).exitAfterWindDown();
    expect(await srx.balanceOf(bob.address)).to.equal(before + E(7_000) + E(4_000));
  });

  it("windDownOpenToAllAt tells monitoring when the 30-day route opens (alert at day 21)", async function () {
    const { staking, admin } = await loadFixture(suite);
    expect(await staking.windDownOpenToAllAt()).to.equal(0n);
    await staking.connect(admin).pause();
    const since = await staking.pausedSince();
    expect(await staking.windDownOpenToAllAt()).to.equal(since + BigInt(30 * DAY));
    await staking.connect(admin).unpause();
    expect(await staking.windDownOpenToAllAt()).to.equal(0n);
  });
});
