// REG-50 (Jared, 11 Oct 2026; REG-48 step 2, option A + C): SRX rewards come only from
// fixed SRX allocations, never from fees or any non-SRX source.
//
// The legal position these tests carry (law agents' preliminary view REG-0023):
//   (1)/(3) rewards paid in SRX out of a FIXED allocation are not "Income";
//   (4)     a dormant switch that a vote could turn on to pay fee income is itself a
//           contingent entitlement, so it must not exist in the code at all.
// So each contract is proved three ways:
//   - TOTAL: cumulative reward registrations stop at the fixed allocation, and claims
//     or releases never give room back (the rescueStrandedPool path was removed, internal
//     audit L1, 16 Oct 2026: reward SRX leaves only to a successor, after wind-down);
//   - BACKING (Security review, 11 Oct 2026): the SRX that pays for rewards is the SRX
//     the launch distribution recorded delivering, never SRX that arrived any other way
//     (fee revenue, buy-back proceeds, a plain transfer), even within the cap;
//   - SURFACE: the exact set of state-changing functions and events is frozen here. A
//     reintroduced fee intake, pull path or second reward stream changes that set, and
//     this file fails until someone updates it on purpose and says why.
//
// The Command Centre verifies by mutation: a top-up path or a second stream put back
// into either contract must fail a test in this file.
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ALLOCATIONS, SSF, ssfRewardAllocation } = require("../scripts/deploy/00_config");
const { allocationSource } = require("./helpers/allocationSource");

const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;
const MAX = 10_000_000_000n * 10n ** 18n;

function surface(contract) {
  const fns = [], events = [];
  for (const f of contract.interface.fragments) {
    if (f.type === "function" && !["view", "pure"].includes(f.stateMutability)) {
      fns.push(`${f.name}(${f.inputs.map((i) => i.type).join(",")})`);
    } else if (f.type === "event") {
      events.push(f.name);
    }
  }
  return { fns: fns.sort(), events: events.sort() };
}

async function base() {
  const [admin, timelock, alice, bob, recipient, stranger, treasury] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
  await srx.connect(admin).genesis(admin.address);
  await srx.connect(admin).transfer(treasury.address, E(50_000_000)); // stands in for fee SRX held elsewhere
  const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
  return { admin, timelock, alice, bob, recipient, stranger, treasury, srx, usdc };
}

const deployStaking = async (srx, admin, source) => (await ethers.getContractFactory("SRXStaking")).deploy(...[await srx.getAddress(), admin.address, source]);

const deployFund = async (srx, admin, allocation, source) => (await ethers.getContractFactory("StabilisationFund")).deploy(...[await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, allocation, source]);

// ═════════════════════════════════════════════════════════════════════════════
describe("REG-50 end to end: the real launch distribution is the only reward backing", function () {
  it("staking and the fund are backed by exactly what TGEDistributor delivered, nothing sent later", async function () {
    const [admin, timelock, alice, other] = await ethers.getSigners();
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    const dist = await (await ethers.getContractFactory("TGEDistributor")).deploy(await srx.getAddress(), admin.address);
    const da = await dist.getAddress();
    const staking = await deployStaking(srx, admin, da);
    const RA = E(100_000_000);
    const ssf = await deployFund(srx, admin, RA, da);

    // Before distribution nothing can be registered: the backing is unknown.
    await expect(staking.connect(admin).notifyRewardAmount(1n)).to.be.revertedWithCustomError(staking, "DistributionNotComplete");

    await srx.connect(admin).genesis(da);
    await dist.connect(admin).setAllocations([
      { destination: await staking.getAddress(), amount: ALLOCATIONS.staking, isVestingVault: false, label: "Staking" },
      { destination: await ssf.getAddress(), amount: ALLOCATIONS.strategic, isVestingVault: false, label: "StabilisationFund" },
      { destination: other.address, amount: MAX - ALLOCATIONS.staking - ALLOCATIONS.strategic, isVestingVault: false, label: "Rest" },
    ]);
    expect(await dist.allocatedTo(await staking.getAddress())).to.equal(ALLOCATIONS.staking);
    await dist.connect(admin).distribute();

    await expect(staking.syncAllocation()).to.emit(staking, "AllocationSynced")
      .withArgs(da, ALLOCATIONS.staking, ALLOCATIONS.staking);
    await expect(ssf.syncAllocation()).to.emit(ssf, "AllocationSynced").withArgs(da, ALLOCATIONS.strategic, RA);
    // Internal audit M1 (16 Oct 2026): syncAllocation is no longer one-shot. A second call
    // succeeds and leaves the backing exactly where it was (it can only rise).
    await expect(staking.syncAllocation()).to.emit(staking, "AllocationSynced")
      .withArgs(da, ALLOCATIONS.staking, ALLOCATIONS.staking);
    expect(await staking.rewardBacking()).to.equal(ALLOCATIONS.staking);
    await expect(ssf.syncAllocation()).to.emit(ssf, "AllocationSynced").withArgs(da, ALLOCATIONS.strategic, RA);
    expect(await ssf.rewardBacking()).to.equal(RA);

    // Fee-like SRX arrives at both by plain transfer after launch. The backing does not move.
    await srx.connect(other).transfer(await staking.getAddress(), E(1_000_000));
    await srx.connect(other).transfer(await ssf.getAddress(), E(1_000_000));
    expect(await staking.rewardBacking()).to.equal(ALLOCATIONS.staking);
    expect(await ssf.rewardBacking()).to.equal(RA);

    await ssf.connect(admin).grantRole(await ssf.GOVERNANCE_ROLE(), timelock.address);
    await srx.connect(other).transfer(alice.address, E(1_000));
    await srx.connect(alice).approve(await ssf.getAddress(), E(1_000));
    await ssf.connect(alice).contribute(E(1_000));
    await ssf.connect(timelock).notifyRewardAmount(RA);
    await expect(ssf.connect(timelock).notifyRewardAmount(1n)).to.be.revertedWithCustomError(ssf, "RewardAllocationExceeded");
  });

  it("a contract the distribution sent nothing to can never register rewards, whatever it is sent later", async function () {
    const [admin, , , other] = await ethers.getSigners();
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    const dist = await (await ethers.getContractFactory("TGEDistributor")).deploy(await srx.getAddress(), admin.address);
    const staking = await deployStaking(srx, admin, await dist.getAddress());
    await srx.connect(admin).genesis(await dist.getAddress());
    await dist.connect(admin).setAllocations([{ destination: other.address, amount: MAX, isVestingVault: false, label: "All" }]);
    await dist.connect(admin).distribute();
    await srx.connect(other).transfer(await staking.getAddress(), E(5_000_000));
    await expect(staking.connect(admin).notifyRewardAmount(E(5_000_000)))
      .to.be.revertedWithCustomError(staking, "RewardAllocationExceeded").withArgs(0n, E(5_000_000));
  });

  it("a distributor for a different token is refused", async function () {
    const { admin, srx } = await base();
    const lz2 = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const other = await (await ethers.getContractFactory("SRXToken")).deploy(await lz2.getAddress(), admin.address);
    const staking = await deployStaking(srx, admin, await allocationSource(other));
    await expect(staking.syncAllocation()).to.be.revertedWithCustomError(staking, "WrongDistributorToken");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("REG-50 C: SRXStaking pays rewards only from the fixed 1.7B SRX allocation", function () {
  async function fixture() {
    const b = await base();
    const staking = await deployStaking(b.srx, b.admin, await allocationSource(b.srx, ALLOCATIONS.staking));
    const sa = await staking.getAddress();
    for (const u of [b.alice, b.bob]) {
      await b.srx.connect(b.admin).transfer(u.address, E(1_000_000));
      await b.srx.connect(u).approve(sa, ethers.MaxUint256);
    }
    return { ...b, staking, sa };
  }

  it("the ceiling is a constant equal to the staking allocation in the deploy configuration", async function () {
    const { staking } = await loadFixture(fixture);
    expect(await staking.REWARD_ALLOCATION()).to.equal(ALLOCATIONS.staking);
    expect(ALLOCATIONS.staking).to.equal(E(1_700_000_000));
  });

  it("a delivery above the ceiling backs only the ceiling", async function () {
    const { admin, srx } = await base();
    const staking = await deployStaking(srx, admin, await allocationSource(srx, E(2_000_000_000)));
    await staking.syncAllocation();
    expect(await staking.rewardBacking()).to.equal(ALLOCATIONS.staking);
  });

  it("registrations up to the backing succeed in tranches; one wei more reverts, even with SRX to spare", async function () {
    const { admin, srx, staking, sa } = await loadFixture(fixture);
    const CAP = await staking.REWARD_ALLOCATION();
    await srx.connect(admin).transfer(sa, CAP + E(5_000_000)); // the allocation, plus SRX standing in for fees
    await staking.connect(admin).notifyRewardAmount(CAP - E(1_000));
    await staking.connect(admin).notifyRewardAmount(E(1_000));
    expect(await staking.totalRewardsRegistered()).to.equal(CAP);
    await expect(staking.connect(admin).notifyRewardAmount(1n))
      .to.be.revertedWithCustomError(staking, "RewardAllocationExceeded").withArgs(0n, 1n);
  });

  it("BACKING (Security, 11 Oct): SRX sent by plain transfer cannot pay for rewards, even within the cap", async function () {
    const { admin, treasury, srx } = await base();
    // The launch distribution delivered nothing to this contract.
    const staking = await deployStaking(srx, admin, await allocationSource(srx, 0n));
    const sa = await staking.getAddress();
    await expect(staking.connect(admin).notifyRewardAmount(1n)).to.be.reverted; // control
    await srx.connect(treasury).transfer(sa, E(5_000_000));                       // "fee" SRX
    await expect(staking.connect(admin).notifyRewardAmount(E(5_000_000)))
      .to.be.revertedWithCustomError(staking, "RewardAllocationExceeded").withArgs(0n, E(5_000_000));
    expect(await staking.rewardPool()).to.equal(0n);
  });

  it("claimed and released rewards never free room for a later top-up", async function () {
    const { admin, alice, srx, staking, sa } = await loadFixture(fixture);
    const CAP = await staking.REWARD_ALLOCATION();
    await srx.connect(admin).transfer(sa, CAP);
    await staking.connect(admin).notifyRewardAmount(CAP);
    await staking.connect(admin).setRewardRate(E(1));
    await staking.connect(alice).lock(E(1_000), 7 * DAY);
    await time.increase(7 * DAY + 1);
    await staking.connect(alice).unlock();
    // No rescue path exists any more: the unaccrued pool cannot be swept to a wallet.
    expect(staking.interface.fragments.filter((f) => f.name === "rescueStrandedPool")).to.have.length(0);
    await srx.connect(admin).transfer(sa, E(10_000_000));
    await expect(staking.connect(admin).notifyRewardAmount(E(1)))
      .to.be.revertedWithCustomError(staking, "RewardAllocationExceeded");
    expect(await staking.totalRewardsRegistered()).to.equal(CAP);

    // After wind-down the unused allocation moves to a successor; that frees no room either.
    await staking.connect(admin).startWindDown();
    const v2 = await deployStaking(srx, admin, sa);
    await staking.connect(admin).releaseRewardAllocation(await v2.getAddress(), await staking.releasableRewardAllocation());
    await expect(staking.connect(admin).notifyRewardAmount(E(1))).to.be.revertedWithCustomError(staking, "WoundDown");
    expect(await staking.totalRewardsRegistered()).to.equal(CAP);
  });

  it("only SRX ever leaves: a second token sent to the contract is never paid to stakers", async function () {
    const { admin, alice, srx, usdc, staking, sa } = await loadFixture(fixture);
    await usdc.mint(sa, 1_000_000n * 10n ** 6n);
    await srx.connect(admin).transfer(sa, E(1_000_000));
    await staking.connect(admin).notifyRewardAmount(E(1_000_000));
    await staking.connect(admin).setRewardRate(E(1));
    await staking.connect(alice).lock(E(10_000), 7 * DAY);
    await time.increase(DAY);
    await staking.connect(alice).claimRewards();
    await time.increase(7 * DAY);
    await staking.connect(alice).unlock();
    expect(await usdc.balanceOf(alice.address)).to.equal(0n);
    expect(await usdc.balanceOf(sa)).to.equal(1_000_000n * 10n ** 6n);
  });

  it("SURFACE: no bonus stream, no second token, no fee intake (frozen list)", async function () {
    const { staking } = await loadFixture(fixture);
    const { fns, events } = surface(staking);
    expect(fns).to.deep.equal([
      "addToPosition(uint256,uint256)", "claimRewards()", "earlyWithdraw()", "exitAfterWindDown()",
      "grantRole(bytes32,address)", "lock(uint256,uint256)", "notifyRewardAmount(uint256)", "pause()",
      "pokeExpiredPosition(address)", "releaseRewardAllocation(address,uint256)", "renounceRole(bytes32,address)",
      "revokeRole(bytes32,address)", "setMinStakeAmount(uint256)", "setMinTotalStakeForEmission(uint256)",
      "setRewardRate(uint256)", "startWindDown()", "syncAllocation()", "unlock()", "unpause()",
      "updateTierParams(uint8,uint256,uint256)",
    ]);
    expect(events.filter((e) => /bonus|fee/i.test(e))).to.deep.equal([]);
    // Internal audit L1: nothing can send the reward pool to a wallet (function, event and error are gone).
    expect(events).to.not.include("RewardPoolReset");
    expect(staking.interface.fragments.some((f) => f.name === "NoStrandedPool")).to.equal(false);
    expect(staking.interface.fragments.some((f) => /bonus/i.test(f.name || ""))).to.equal(false);
  });

  it("the distributor is fixed at deployment: there is no initialize() or setter to change it", async function () {
    const { staking } = await loadFixture(fixture);
    expect(staking.interface.fragments.some((f) => f.name === "initialize")).to.equal(false);
    expect(staking.interface.fragments.some((f) => /distributor/i.test(f.name || "") && f.type === "function" && f.stateMutability !== "view"))
      .to.equal(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("REG-50 A: StabilisationFund rewards only from its fixed allocation; no fees, no pull (R7-16)", function () {
  const SEED = E(1_500_000_000);
  const ALLOC = E(100_000_000);

  async function fixture() {
    const b = await base();
    const ssf = await deployFund(b.srx, b.admin, ALLOC, await allocationSource(b.srx, SEED));
    const fa = await ssf.getAddress();
    await ssf.connect(b.admin).grantRole(await ssf.GOVERNANCE_ROLE(), b.timelock.address);
    await ssf.connect(b.admin).setDeployTarget(b.recipient.address, true);
    await b.srx.connect(b.admin).transfer(fa, SEED);
    for (const u of [b.alice, b.bob]) {
      await b.srx.connect(b.admin).transfer(u.address, E(1_000_000));
      await b.srx.connect(u).approve(fa, ethers.MaxUint256); // a depositor's unlimited approval
    }
    return { ...b, ssf, fa };
  }

  it("the ceiling is the fund's own launch allocation; initialize refuses anything above it", async function () {
    const { admin, srx, ssf } = await loadFixture(fixture);
    expect(await ssf.MAX_REWARD_ALLOCATION()).to.equal(ALLOCATIONS.strategic);
    expect(await ssf.rewardAllocation()).to.equal(ALLOC);
    const MAXR = await ssf.MAX_REWARD_ALLOCATION();
    const src = await allocationSource(srx, SEED);
    const SSFF = await ethers.getContractFactory("StabilisationFund");
    await expect(deployFund(srx, admin, MAXR + 1n, src))
      .to.be.revertedWithCustomError(SSFF, "RewardAllocationExceeded").withArgs(MAXR, MAXR + 1n);
    expect(await (await deployFund(srx, admin, MAXR, src)).rewardAllocation()).to.equal(MAXR);
  });

  it("the deploy configuration has a testnet placeholder and refuses mainnet until Jared decides", async function () {
    expect(ssfRewardAllocation("sepolia")).to.equal(SSF.REWARD_ALLOCATION.testnet);
    expect(SSF.REWARD_ALLOCATION.mainnet).to.equal(null);
    expect(() => ssfRewardAllocation("ethereum")).to.throw(/reward allocation/);
  });

  it("registrations stop at the backing however much SRX the fund holds", async function () {
    const { timelock, alice, ssf } = await loadFixture(fixture);
    await ssf.connect(alice).contribute(E(1_000));
    await ssf.connect(timelock).notifyRewardAmount(ALLOC - 1n);
    await expect(ssf.connect(timelock).notifyRewardAmount(2n))
      .to.be.revertedWithCustomError(ssf, "RewardAllocationExceeded").withArgs(1n, 2n);
    await ssf.connect(timelock).notifyRewardAmount(1n);
    expect(await ssf.totalRewardsRegistered()).to.equal(ALLOC);
    await expect(ssf.connect(timelock).notifyRewardAmount(1n))
      .to.be.revertedWithCustomError(ssf, "RewardAllocationExceeded").withArgs(0n, 1n);
  });

  it("BACKING (Security, 11 Oct): with no allocation delivered, SRX sent by plain transfer cannot pay for rewards", async function () {
    const { admin, treasury, alice, srx } = await base();
    const ssf = await deployFund(srx, admin, ALLOC, await allocationSource(srx, 0n));
    const fa = await ssf.getAddress();
    await srx.connect(admin).transfer(alice.address, E(1_000));
    await srx.connect(alice).approve(fa, ethers.MaxUint256);
    await ssf.connect(alice).contribute(E(1_000));
    await expect(ssf.connect(admin).notifyRewardAmount(1n)).to.be.reverted; // control
    await srx.connect(treasury).transfer(fa, E(5_000_000));                  // "fee" SRX
    await expect(ssf.connect(admin).notifyRewardAmount(E(5_000_000)))
      .to.be.revertedWithCustomError(ssf, "RewardAllocationExceeded").withArgs(0n, E(5_000_000));
  });

  it("BACKING: the launch SRX backing unregistered rewards cannot be deployed out to be replaced by fee SRX", async function () {
    const { srx, timelock, treasury, recipient, ssf, fa } = await loadFixture(fixture);
    // Everything except the unregistered backing may go; one wei more may not.
    await ssf.connect(timelock).deployLiquidity(recipient.address, await srx.getAddress(), SEED - ALLOC, "out");
    await expect(ssf.connect(timelock).deployLiquidity(recipient.address, await srx.getAddress(), 1n, "more"))
      .to.be.revertedWithCustomError(ssf, "InsufficientFreeBalance").withArgs(0n, 1n);
    // Fee SRX arriving afterwards is free reserve, never reward backing.
    await srx.connect(treasury).transfer(fa, E(1_000_000));
    await ssf.connect(timelock).deployLiquidity(recipient.address, await srx.getAddress(), E(1_000_000), "fees out");
    expect(await ssf.rewardBacking()).to.equal(ALLOC);
  });

  it("governance cannot deploy depositors' principal (bound since 12 Oct 2026)", async function () {
    const { srx, timelock, alice, recipient, ssf } = await loadFixture(fixture);
    await ssf.connect(alice).contribute(E(1_000));
    await ssf.connect(timelock).deployLiquidity(recipient.address, await srx.getAddress(), SEED - ALLOC, "out");
    await expect(ssf.connect(timelock).deployLiquidity(recipient.address, await srx.getAddress(), 1n, "principal"))
      .to.be.revertedWithCustomError(ssf, "InsufficientFreeBalance");
    expect(await ssf.srxBalance()).to.equal(ALLOC + E(1_000));
  });

  it("an allocation of zero means no depositor rewards can ever be registered", async function () {
    const { admin, alice, srx } = await base();
    const zero = await deployFund(srx, admin, 0n, await allocationSource(srx, SEED));
    await srx.connect(admin).transfer(await zero.getAddress(), E(1_000_000));
    await srx.connect(admin).transfer(alice.address, E(1_000));
    await srx.connect(alice).approve(await zero.getAddress(), ethers.MaxUint256);
    await zero.connect(alice).contribute(E(1_000));
    await expect(zero.connect(admin).notifyRewardAmount(1n))
      .to.be.revertedWithCustomError(zero, "RewardAllocationExceeded").withArgs(0n, 1n);
  });

  it("claimed and released rewards never free room for a later top-up", async function () {
    const { srx, admin, timelock, alice, ssf, fa } = await loadFixture(fixture);
    await ssf.connect(alice).contribute(E(1_000));
    await ssf.connect(timelock).notifyRewardAmount(ALLOC);
    await ssf.connect(timelock).setRewardRate(E(1));
    await time.increase(31 * DAY);
    await ssf.connect(alice).withdrawContribution(E(1_000));
    await ssf.connect(alice).claimRewards();
    // No rescue path exists any more: the unaccrued pool cannot be swept to a wallet.
    expect(ssf.interface.fragments.filter((f) => f.name === "rescueStrandedPool")).to.have.length(0);
    await expect(ssf.connect(timelock).notifyRewardAmount(1n))
      .to.be.revertedWithCustomError(ssf, "RewardAllocationExceeded");

    // After wind-down the unused allocation moves to a successor; that frees no room either.
    await ssf.connect(timelock).startWindDown();
    const v2 = await deployFund(srx, admin, ALLOC, fa);
    await ssf.connect(timelock).releaseRewardAllocation(await v2.getAddress(), await ssf.releasableRewardAllocation());
    await expect(ssf.connect(timelock).notifyRewardAmount(1n)).to.be.revertedWithCustomError(ssf, "WoundDown");
    expect(await ssf.totalRewardsRegistered()).to.equal(ALLOC);
  });

  it("depositor rewards are SRX only: stablecoins in the fund never reach a depositor", async function () {
    const { admin, timelock, alice, usdc, ssf, fa } = await loadFixture(fixture);
    // Stablecoins enter only as the treasury's reserve deposit (Security review, 12 Oct).
    await ssf.connect(admin).grantRole(await ssf.TREASURY_ROLE(), admin.address);
    await usdc.mint(admin.address, 1_000n * 10n ** 6n);
    await usdc.connect(admin).approve(fa, ethers.MaxUint256);
    await ssf.connect(admin).depositStableReserve(await usdc.getAddress(), 1_000n * 10n ** 6n);
    await ssf.connect(alice).contribute(E(1_000));
    await ssf.connect(timelock).notifyRewardAmount(E(1_000_000));
    await ssf.connect(timelock).setRewardRate(E(1));
    await time.increase(DAY);
    await ssf.connect(alice).claimRewards();
    expect(await usdc.balanceOf(alice.address)).to.equal(0n);
    expect(await usdc.balanceOf(fa)).to.equal(1_000n * 10n ** 6n);
  });

  it("R7-16: governance cannot take a depositor's SRX beyond what they deposited, whatever their approval", async function () {
    const { srx, timelock, bob, recipient, ssf } = await loadFixture(fixture);
    const before = await srx.balanceOf(bob.address);
    await ssf.connect(timelock).deployLiquidity(recipient.address, await srx.getAddress(), E(1_000), "out");
    expect(await srx.balanceOf(bob.address)).to.equal(before);
    expect(ssf.interface.fragments.some((f) => f.name === "recoverLiquidity")).to.equal(false);
  });

  it("deployed liquidity comes back by its holder sending it, and counts as free SRX again", async function () {
    const { srx, timelock, recipient, ssf, fa } = await loadFixture(fixture);
    await ssf.connect(timelock).deployLiquidity(recipient.address, await srx.getAddress(), E(5_000), "out");
    const before = await ssf.srxBalance();
    await srx.connect(recipient).transfer(fa, E(5_000));
    expect(await ssf.srxBalance()).to.equal(before + E(5_000));
  });

  it("SURFACE: no fee intake, no pull from other addresses, no allocation setter (frozen list)", async function () {
    const { ssf } = await loadFixture(fixture);
    const { fns, events } = surface(ssf);
    expect(fns).to.deep.equal([
      "claimRewards()", "contribute(uint256)",
      "deployLiquidity(address,address,uint256,string)", "depositStableReserve(address,uint256)", "exitAfterWindDown()", "grantRole(bytes32,address)",
      "notifyRewardAmount(uint256)", "pause()", "releaseRewardAllocation(address,uint256)",
      "renounceRole(bytes32,address)", "resolveStressEvent()",
      "revokeRole(bytes32,address)", "setDeployTarget(address,bool)", "setLayerTargetBps(uint256,uint256,uint256)",
      "setMaxDeployerBps(uint256)", "setMaxGuardianBps(uint256)", "setMinContribution(uint256)",
      "setMinTotalForEmission(uint256)", "setRewardRate(uint256)", "setStressCooldownDuration(uint256)", "setWithdrawLockDuration(uint256)",
      "startWindDown()", "syncAllocation()", "triggerStressEvent()", "unpause()",
      "withdrawContribution(uint256)",
    ]);
    expect(events).to.not.include("FeesReceived");
    expect(events).to.not.include("LiquidityRecovered");
    // Internal audit L1: nothing can send the reward pool to a wallet (function, event and error are gone).
    expect(events).to.not.include("RewardPoolReset");
    expect(ssf.interface.fragments.some((f) => f.name === "NoStrandedPool")).to.equal(false);
  });

  it("the allocation and distributor are fixed at deployment: no initialize() or setter exists", async function () {
    const { ssf } = await loadFixture(fixture);
    expect(ssf.interface.fragments.some((f) => f.name === "initialize")).to.equal(false);
    expect(ssf.interface.fragments.some((f) => f.type === "function" && f.stateMutability !== "view"
      && /allocation|distributor/i.test(f.name) && !["syncAllocation", "releaseRewardAllocation"].includes(f.name))).to.equal(false);
  });
});
