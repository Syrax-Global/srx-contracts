// Boundary gaps, 23 Oct 2026. A mutation sweep flipped each comparison in each guard condition
// (`<` to `<=`, `>` to `>=`, and back) and ran the whole Hardhat suite. For the mutants below,
// every test still passed: nothing checked behaviour EXACTLY at the limit. One `it` per
// surviving mutant, titled with its id (B793, B796, ...). Each test lands a transaction on the
// exact second (time.setNextBlockTimestamp) or uses the exact value, and was run against the
// one mutant it covers and shown to fail there.
//
// Two further flips are equivalent and have no test:
//   B342 FeeController.setFeeDestination `else if (index >= feeDestinationCount)`: the branch
//        before it already handled `index == feeDestinationCount`, so index is never equal here.
//
// Calls that land on a boundary pass an explicit gasLimit, so the node does not estimate gas
// first (an estimate runs against a different clock and could hide or invent a revert).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { approveBuyers } = require("../helpers/buyers");
const { allocationSource } = require("../helpers/allocationSource");

const E = (n) => ethers.parseUnits(String(n), 18);
const usd = (d) => BigInt(d) * 10n ** 8n;
const DAY = 86_400, HOUR = 3_600;
const GAS = { gasLimit: 8_000_000 };
const at = (ts) => time.setNextBlockTimestamp(ts);
const now = async () => BigInt(await time.latest());

async function newToken() {
  const [admin] = await ethers.getSigners();
  const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
  await srx.connect(admin).genesis(admin.address);
  return srx;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SRXAirdrop
// ═══════════════════════════════════════════════════════════════════════════════

describe("Boundary gaps 23 Oct: SRXAirdrop", function () {
  const AMOUNT = E(100);
  const MIN_WINDOW = BigInt(7 * DAY);

  async function airdropFixture() {
    const [admin, user1, user2] = await ethers.getSigners();
    const srx = await newToken();
    const air = await (await ethers.getContractFactory("SRXAirdrop")).deploy(await srx.getAddress(), admin.address);
    await srx.connect(admin).transfer(await air.getAddress(), E(1_000));
    // A one-leaf tree: the root is the leaf and the proof is empty.
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256"], [chainId, user1.address, AMOUNT]));
    const root = ethers.keccak256(inner);
    return { air, srx, root, admin, user1, user2 };
  }

  it("[B793] SRXAirdrop.setMerkleRoot: a deadline equal to now is refused as DeadlineMustBeFuture (not as a short window)", async function () {
    const { air, root, admin } = await loadFixture(airdropFixture);
    const T = (await now()) + 100n;
    await at(T);
    await expect(air.connect(admin).setMerkleRoot(root, T, GAS)).to.be.revertedWithCustomError(air, "DeadlineMustBeFuture");
    // one second ahead is no longer "not the future": it is a too-short window
    await at(T + 10n);
    await expect(air.connect(admin).setMerkleRoot(root, T + 11n, GAS))
      .to.be.revertedWithCustomError(air, "ClaimWindowTooShort");
  });

  it("[B796] SRXAirdrop.setMerkleRoot: while a round is open the same deadline is accepted, one second earlier is refused", async function () {
    const { air, root, admin } = await loadFixture(airdropFixture);
    const D = (await now()) + BigInt(30 * DAY);
    await air.connect(admin).setMerkleRoot(root, D);
    expect(await air.claimDeadline()).to.equal(D);
    await expect(air.connect(admin).setMerkleRoot(root, D - 1n))
      .to.be.revertedWithCustomError(air, "DeadlineCannotMoveEarlier").withArgs(D, D - 1n);
    await expect(air.connect(admin).setMerkleRoot(root, D)).to.emit(air, "AirdropConfigured");
    expect(await air.claimDeadline()).to.equal(D);
  });

  it("[B798] SRXAirdrop.setMerkleRoot: a deadline exactly MIN_CLAIM_WINDOW (7 days) away is accepted, one second less is refused", async function () {
    const { air, root, admin } = await loadFixture(airdropFixture);
    const T = (await now()) + 100n;
    await at(T);
    await expect(air.connect(admin).setMerkleRoot(root, T + MIN_WINDOW - 1n, GAS))
      .to.be.revertedWithCustomError(air, "ClaimWindowTooShort").withArgs(T + MIN_WINDOW - 1n, T + MIN_WINDOW);
    await at(T + 10n);
    await air.connect(admin).setMerkleRoot(root, T + 10n + MIN_WINDOW, GAS);
    expect(await air.claimDeadline()).to.equal(T + 10n + MIN_WINDOW);
  });

  it("[B800] SRXAirdrop.rescueUnclaimed: refused at the deadline second itself (claims still open), allowed one second later", async function () {
    const { air, srx, root, admin, user2 } = await loadFixture(airdropFixture);
    const D = (await now()) + BigInt(10 * DAY);
    await air.connect(admin).setMerkleRoot(root, D);
    await at(D);
    await expect(air.connect(admin).rescueUnclaimed(user2.address, GAS)).to.be.revertedWithCustomError(air, "DeadlineNotPassed");
    await at(D + 1n);
    await expect(air.connect(admin).rescueUnclaimed(user2.address, GAS)).to.emit(air, "UnclaimedRescued").withArgs(user2.address, E(1_000));
    expect(await srx.balanceOf(await air.getAddress())).to.equal(0n);
  });

  it("[B805] SRXAirdrop.claim: a claim landing exactly on the deadline second succeeds, one second later is ClaimExpired", async function () {
    const { air, srx, root, admin, user1, user2 } = await loadFixture(airdropFixture);
    const D = (await now()) + BigInt(10 * DAY);
    await air.connect(admin).setMerkleRoot(root, D);
    await at(D);
    await expect(air.connect(user1).claim(AMOUNT, [], GAS)).to.emit(air, "Claimed").withArgs(user1.address, AMOUNT);
    expect(await srx.balanceOf(user1.address)).to.equal(AMOUNT);
    await at(D + 1n);
    await expect(air.connect(user2).claim(AMOUNT, [], GAS)).to.be.revertedWithCustomError(air, "ClaimExpired");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GuardianModule
// ═══════════════════════════════════════════════════════════════════════════════

describe("Boundary gaps 23 Oct: GuardianModule", function () {
  const SUNSET = 15_552_000;

  async function gmFixture() {
    const [admin, guardian, governance, stranger] = await ethers.getSigners();
    const gm = await (await ethers.getContractFactory("GuardianModule"))
      .deploy(admin.address, guardian.address, governance.address, SUNSET);
    const Stub = await ethers.getContractFactory("PausableStub");
    const tokenStub = await Stub.deploy();
    const stakingStub = await Stub.deploy();
    const MODULE_TOKEN = await gm.MODULE_TOKEN();
    const MODULE_STAKING = await gm.MODULE_STAKING();
    await gm.connect(governance).registerModule(MODULE_TOKEN, await tokenStub.getAddress());
    await gm.connect(governance).registerModule(MODULE_STAKING, await stakingStub.getAddress());
    return { gm, tokenStub, stakingStub, MODULE_TOKEN, MODULE_STAKING, admin, guardian, governance, stranger };
  }

  it("[B145] GuardianModule.notExpired: guardian powers work one second before the sunset and are gone AT the sunset second", async function () {
    const { gm, MODULE_STAKING, guardian } = await loadFixture(gmFixture);
    await gm.connect(guardian).pauseModule(MODULE_STAKING, "early");
    const S = await gm.effectiveSunset();
    await at(S - 1n);
    await gm.connect(guardian).unpauseModule(MODULE_STAKING, "last second", GAS); // control: still the guardian's
    expect(await gm.isModulePaused(MODULE_STAKING)).to.equal(false);
    await at(S);
    await expect(gm.connect(guardian).pauseModule(MODULE_STAKING, "too late", GAS))
      .to.be.revertedWithCustomError(gm, "GuardianExpired").withArgs(S, S);
    expect(await gm.isExpired()).to.equal(true);
  });

  it("[B156] GuardianModule.pauseModule: allowed exactly at the cooldown end (lastPauseTime + 1 hour), refused one second before", async function () {
    const { gm, MODULE_STAKING, guardian } = await loadFixture(gmFixture);
    await gm.connect(guardian).pauseModule(MODULE_STAKING, "first");
    const first = (await gm.modules(MODULE_STAKING)).lastPauseTime;
    await gm.connect(guardian).unpauseModule(MODULE_STAKING, "false alarm");
    const availableAt = first + BigInt(HOUR);
    await at(availableAt - 1n);
    await expect(gm.connect(guardian).pauseModule(MODULE_STAKING, "again", GAS))
      .to.be.revertedWithCustomError(gm, "CooldownActive").withArgs(MODULE_STAKING, availableAt);
    await at(availableAt);
    await expect(gm.connect(guardian).pauseModule(MODULE_STAKING, "again", GAS)).to.emit(gm, "GuardianAction");
    expect((await gm.modules(MODULE_STAKING)).lastPauseTime).to.equal(availableAt);
  });

  it("[B161] GuardianModule.pauseAll: allowed exactly at the pauseAll cooldown end (lastPauseAllTime + 30 minutes), refused one second before", async function () {
    const { gm, guardian } = await loadFixture(gmFixture);
    await gm.connect(guardian).pauseAll("first");
    const first = await gm.lastPauseAllTime();
    const availableAt = first + 1_800n;
    await at(availableAt - 1n);
    await expect(gm.connect(guardian).pauseAll("second", GAS))
      .to.be.revertedWithCustomError(gm, "PauseAllCooldownActive").withArgs(availableAt);
    await at(availableAt);
    await expect(gm.connect(guardian).pauseAll("second", GAS)).to.emit(gm, "GuardianAction");
    expect(await gm.lastPauseAllTime()).to.equal(availableAt);
  });

  it("[B164] GuardianModule.lapseTokenPause: anyone may lapse a token pause exactly at tokenPauseEndsAt, not one second before", async function () {
    const { gm, MODULE_TOKEN, tokenStub, guardian, stranger } = await loadFixture(gmFixture);
    await gm.connect(guardian).pauseModule(MODULE_TOKEN, "pause");
    const ends = await gm.tokenPauseEndsAt();
    await at(ends - 1n);
    await expect(gm.connect(stranger).lapseTokenPause(GAS))
      .to.be.revertedWithCustomError(gm, "TokenPauseNotLapsed").withArgs(ends);
    expect(await tokenStub.paused()).to.equal(true);
    await at(ends);
    await expect(gm.connect(stranger).lapseTokenPause(GAS)).to.emit(gm, "TokenPauseEnded").withArgs(14n * BigInt(DAY), 14n * BigInt(DAY), true);
    expect(await tokenStub.paused()).to.equal(false);
    expect(await gm.tokenPauseEndsAt()).to.equal(0n);
  });

  it("[B166] GuardianModule.releaseAfterSunset: refused one second before the sunset, allowed AT the sunset second (the same second the guardian's powers end)", async function () {
    const { gm, MODULE_STAKING, stakingStub, guardian, stranger } = await loadFixture(gmFixture);
    await gm.connect(guardian).pauseModule(MODULE_STAKING, "left standing");
    const S = await gm.effectiveSunset();
    await at(S - 1n);
    await expect(gm.connect(stranger).releaseAfterSunset(MODULE_STAKING, GAS))
      .to.be.revertedWithCustomError(gm, "GuardianNotExpired").withArgs(S);
    await at(S);
    await expect(gm.connect(stranger).releaseAfterSunset(MODULE_STAKING, GAS))
      .to.emit(gm, "ReleasedAfterSunset").withArgs(MODULE_STAKING, stranger.address);
    expect(await stakingStub.paused()).to.equal(false);
  });

  it("[B173] GuardianModule.reduceSunset: a new sunset equal to now is refused (NewSunsetMustBeFuture); one second ahead is accepted", async function () {
    const { gm, governance } = await loadFixture(gmFixture);
    const T = (await now()) + 100n;
    await at(T);
    await expect(gm.connect(governance).reduceSunset(T, GAS)).to.be.revertedWithCustomError(gm, "NewSunsetMustBeFuture");
    await at(T + 10n);
    await expect(gm.connect(governance).reduceSunset(T + 11n, GAS)).to.emit(gm, "SunsetReduced");
    expect(await gm.effectiveSunset()).to.equal(T + 11n);
  });

  it("[B181] GuardianModule._startTokenPause: the guardian may pause the token again exactly at tokenRepauseAt (7 days after a lapse), not one second before", async function () {
    const { gm, MODULE_TOKEN, tokenStub, guardian, stranger } = await loadFixture(gmFixture);
    await gm.connect(guardian).pauseModule(MODULE_TOKEN, "pause");
    const ends = await gm.tokenPauseEndsAt();
    await at(ends);
    await gm.connect(stranger).lapseTokenPause(GAS);
    const R = await gm.tokenRepauseAt();
    expect(R).to.equal(ends + BigInt(7 * DAY));
    await at(R - 1n);
    await expect(gm.connect(guardian).pauseModule(MODULE_TOKEN, "again", GAS))
      .to.be.revertedWithCustomError(gm, "TokenRepauseBlocked").withArgs(R);
    await at(R);
    await expect(gm.connect(guardian).pauseModule(MODULE_TOKEN, "again", GAS)).to.emit(gm, "TokenPauseStarted");
    expect(await tokenStub.paused()).to.equal(true);
    expect(await gm.tokenPauseEndsAt()).to.equal(R + BigInt(14 * DAY));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SRXTimelock
// ═══════════════════════════════════════════════════════════════════════════════

describe("Boundary gaps 23 Oct: SRXTimelock", function () {
  const DELAY = 172_800;

  it("[B759] SRXTimelock.updateDelay: a delay exactly equal to the floor is accepted (raise it, then lower it back to the floor)", async function () {
    const [proposer] = await ethers.getSigners();
    const tl = await (await ethers.getContractFactory("SRXTimelock"))
      .deploy(DELAY, [proposer.address], [ethers.ZeroAddress], ethers.ZeroAddress);
    const target = await tl.getAddress();
    const run = async (newDelay, salt) => {
      const data = tl.interface.encodeFunctionData("updateDelay", [newDelay]);
      await tl.connect(proposer).schedule(target, 0, data, ethers.ZeroHash, ethers.id(salt), await tl.getMinDelay());
      await time.increase(Number(await tl.getMinDelay()));
      return tl.execute(target, 0, data, ethers.ZeroHash, ethers.id(salt));
    };
    await run(DELAY * 2, "raise");
    expect(await tl.getMinDelay()).to.equal(DELAY * 2);
    await run(DELAY, "back-to-floor");
    expect(await tl.getMinDelay()).to.equal(DELAY);
    // control: one second under the floor is still refused
    await expect(run(DELAY - 1, "under")).to.be.revertedWithCustomError(tl, "DelayBelowFloor").withArgs(DELAY - 1, DELAY);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SRXTreasury
// ═══════════════════════════════════════════════════════════════════════════════

describe("Boundary gaps 23 Oct: SRXTreasury", function () {
  it("[B779] SRXTreasury.withdrawETH: the whole ETH balance can be withdrawn, one wei more is InsufficientBalance", async function () {
    const [admin, timelock, recipient] = await ethers.getSigners();
    const srx = await newToken();
    const treasury = await (await ethers.getContractFactory("SRXTreasury"))
      .deploy(await srx.getAddress(), admin.address, timelock.address);
    await treasury.connect(timelock).grantRole(await treasury.SPENDER_ROLE(), admin.address);
    const addr = await treasury.getAddress();
    await admin.sendTransaction({ to: addr, value: ethers.parseEther("3") });
    const bal = await ethers.provider.getBalance(addr);
    expect(bal).to.equal(ethers.parseEther("3"));
    await expect(treasury.connect(admin).withdrawETH(recipient.address, bal + 1n, "too much"))
      .to.be.revertedWithCustomError(treasury, "InsufficientBalance");
    await expect(treasury.connect(admin).withdrawETH(recipient.address, bal, "everything"))
      .to.emit(treasury, "ETHWithdrawal").withArgs(recipient.address, bal, "everything");
    expect(await ethers.provider.getBalance(addr)).to.equal(0n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PreSaleRound
// ═══════════════════════════════════════════════════════════════════════════════

describe("Boundary gaps 23 Oct: PreSaleRound", function () {
  const TREASURY = ethers.Wallet.createRandom().address;
  const SRX_PRICE = 1_250_000n;
  const ETH_PRICE = 2_500n * 10n ** 8n;
  const BTC_PRICE = 60_000n * 10n ** 8n;
  const HARD_CAP = E(400_000_000);
  const LIMIT = 25 * HOUR;
  const ONE_ETH = ethers.parseEther("1");

  async function roundFixture() {
    const [admin, investor1, investor2] = await ethers.getSigners();
    const token = await newToken();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    const usdt = await MockERC20.deploy("Tether USD", "USDT", 6);
    const wbtc = await MockERC20.deploy("Wrapped BTC", "WBTC", 8);
    const Feed = await ethers.getContractFactory("MockChainlinkFeed");
    const ethFeed = await Feed.deploy(ETH_PRICE);
    const btcFeed = await Feed.deploy(BTC_PRICE);
    const round = await (await ethers.getContractFactory("PreSaleRound")).deploy(
      await token.getAddress(), await usdc.getAddress(), await usdt.getAddress(), await wbtc.getAddress(),
      await ethFeed.getAddress(), await btcFeed.getAddress(), admin.address, HARD_CAP, SRX_PRICE, false, 0, TREASURY);
    await token.connect(admin).transfer(await round.getAddress(), HARD_CAP);
    await approveBuyers(round, admin, [investor1, investor2]);
    return { round, ethFeed, btcFeed, admin, investor1 };
  }

  it("[B589] PreSaleRound.setMaxStaleness: exactly MAX_STALENESS_LIMIT (25 hours) is accepted, one second more is StalenessTooLong", async function () {
    const { round, admin } = await loadFixture(roundFixture);
    expect(await round.MAX_STALENESS_LIMIT()).to.equal(LIMIT);
    await expect(round.connect(admin).setMaxStaleness(LIMIT + 1))
      .to.be.revertedWithCustomError(round, "StalenessTooLong").withArgs(LIMIT + 1, LIMIT);
    await round.connect(admin).setMaxStaleness(LIMIT);
    expect(await round.maxStaleness()).to.equal(LIMIT);
  });

  it("[B595] PreSaleRound.setStablecoinPriceBounds: a minimum equal to the maximum is InvalidPriceBounds; min just below max is accepted", async function () {
    const { round, admin } = await loadFixture(roundFixture);
    await expect(round.connect(admin).setStablecoinPriceBounds(100_000_000n, 100_000_000n))
      .to.be.revertedWithCustomError(round, "InvalidPriceBounds");
    await round.connect(admin).setStablecoinPriceBounds(99_999_999n, 100_000_000n);
    expect(await round.minStablePriceUsd8Dec()).to.equal(99_999_999n);
    expect(await round.maxStablePriceUsd8Dec()).to.equal(100_000_000n);
  });

  it("[B599] PreSaleRound.setFeedStaleness: a BTC override of exactly MAX_STALENESS_LIMIT is accepted, one second more is StalenessTooLong", async function () {
    const { round, admin } = await loadFixture(roundFixture);
    await expect(round.connect(admin).setFeedStaleness(0, LIMIT + 1, 0))
      .to.be.revertedWithCustomError(round, "StalenessTooLong").withArgs(LIMIT + 1, LIMIT);
    await round.connect(admin).setFeedStaleness(0, LIMIT, 0);
    expect(await round.btcMaxStaleness()).to.equal(LIMIT);
  });

  it("[B632] PreSaleRound._readFeed: an oracle answer of exactly 0 is InvalidOraclePrice (not a zero-value purchase)", async function () {
    const { round, ethFeed, investor1 } = await loadFixture(roundFixture);
    await ethFeed.setPrice(0);
    await expect(round.connect(investor1).invest({ value: ONE_ETH })).to.be.revertedWithCustomError(round, "InvalidOraclePrice");
    await ethFeed.setPrice(ETH_PRICE); // control: a real price buys
    await round.connect(investor1).invest({ value: ONE_ETH });
    expect((await round.investors(investor1.address)).cumulativeUsd8Dec).to.equal(ETH_PRICE);
  });

  it("[B636] PreSaleRound._readFeed: a price exactly maxStaleness old is accepted, one second older is StalePriceFeed", async function () {
    const { round, ethFeed, investor1 } = await loadFixture(roundFixture);
    const stale = await round.maxStaleness();
    expect(stale).to.equal(300n);
    const T = (await now()) + 1_000n;
    await ethFeed.setUpdatedAt(T - stale - 1n);
    await at(T);
    await expect(round.connect(investor1).invest({ value: ONE_ETH, ...GAS })).to.be.revertedWithCustomError(round, "StalePriceFeed");
    const T2 = T + 1_000n;
    await ethFeed.setUpdatedAt(T2 - stale);
    await at(T2);
    await round.connect(investor1).invest({ value: ONE_ETH, ...GAS });
    expect((await round.investors(investor1.address)).cumulativeUsd8Dec).to.equal(ETH_PRICE);
  });

  it("[B642] PreSaleRound._readFeed: a price exactly equal to the configured maximum is accepted, one unit above is OraclePriceOutOfBounds", async function () {
    const { round, ethFeed, admin, investor1 } = await loadFixture(roundFixture);
    await round.connect(admin).setOraclePriceBounds(0, ETH_PRICE, 0, 0);
    await ethFeed.setPrice(ETH_PRICE + 1n);
    await expect(round.connect(investor1).invest({ value: ONE_ETH }))
      .to.be.revertedWithCustomError(round, "OraclePriceOutOfBounds").withArgs(ETH_PRICE + 1n, 0, ETH_PRICE);
    await ethFeed.setPrice(ETH_PRICE);
    await round.connect(investor1).invest({ value: ONE_ETH });
    expect((await round.investors(investor1.address)).cumulativeUsd8Dec).to.equal(ETH_PRICE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// StabilisationFund
// ═══════════════════════════════════════════════════════════════════════════════

describe("Boundary gaps 23 Oct: StabilisationFund", function () {
  async function ssfFixture() {
    const [admin, timelock, contributor, oracle] = await ethers.getSigners();
    const srx = await newToken();
    const srxAddr = await srx.getAddress();
    const BACKING = E(10_000_000);
    const SEED = E(1_500_000_000);
    const ssf = await (await ethers.getContractFactory("StabilisationFund")).deploy(
      srxAddr, admin.address, 3_000, 7_000, 30 * DAY, BACKING, await allocationSource(srxAddr, SEED));
    const ssfAddr = await ssf.getAddress();
    await ssf.connect(admin).grantRole(await ssf.GOVERNANCE_ROLE(), timelock.address);
    await ssf.connect(admin).grantRole(await ssf.ORACLE_REPORTER_ROLE(), oracle.address);
    await srx.connect(admin).transfer(ssfAddr, SEED + BACKING);
    await srx.connect(admin).transfer(contributor.address, E(2_000_000));
    await srx.connect(contributor).approve(ssfAddr, ethers.MaxUint256);
    await ssf.connect(contributor).contribute(E(1_000_000));
    return { ssf, srx, admin, timelock, contributor, oracle };
  }

  it("[B399] StabilisationFund.withdrawContribution: allowed exactly at the unlock second, refused one second before", async function () {
    const { ssf, srx, contributor } = await loadFixture(ssfFixture);
    const unlock = await ssf.contributionUnlockAt(contributor.address);
    await at(unlock - 1n);
    await expect(ssf.connect(contributor).withdrawContribution(E(1_000_000), GAS))
      .to.be.revertedWithCustomError(ssf, "WithdrawLockActive").withArgs(unlock);
    await at(unlock);
    await expect(ssf.connect(contributor).withdrawContribution(E(1_000_000), GAS))
      .to.emit(ssf, "ContributionWithdrawn").withArgs(contributor.address, E(1_000_000));
    expect(await srx.balanceOf(contributor.address)).to.equal(E(2_000_000));
  });

  it("[B408] StabilisationFund.triggerStressEvent: a new stress event is allowed exactly when the cooldown ends, refused one second before", async function () {
    const { ssf, timelock, oracle } = await loadFixture(ssfFixture);
    await ssf.connect(oracle).triggerStressEvent();
    await ssf.connect(timelock).resolveStressEvent();
    const endsAt = (await ssf.stressResolvedAt()) + (await ssf.stressCooldownDuration());
    await at(endsAt - 1n);
    await expect(ssf.connect(oracle).triggerStressEvent(GAS))
      .to.be.revertedWithCustomError(ssf, "StressInCooldown").withArgs(endsAt);
    await at(endsAt);
    await expect(ssf.connect(oracle).triggerStressEvent(GAS)).to.emit(ssf, "StressEventTriggered");
    expect(await ssf.stressActive()).to.equal(true);
  });

  it("[B435] StabilisationFund.setMaxDeployerBps: a value equal to maxGuardianBps is accepted, one above is InvalidBps", async function () {
    const { ssf, timelock } = await loadFixture(ssfFixture);
    await expect(ssf.connect(timelock).setMaxDeployerBps(7_001)).to.be.revertedWithCustomError(ssf, "InvalidBps");
    await ssf.connect(timelock).setMaxDeployerBps(7_000);
    expect(await ssf.maxDeployerBps()).to.equal(7_000n);
  });

  it("[B437] StabilisationFund.setMaxGuardianBps: exactly 10,000 (100%) is accepted, 10,001 is InvalidBps", async function () {
    const { ssf, timelock } = await loadFixture(ssfFixture);
    await expect(ssf.connect(timelock).setMaxGuardianBps(10_001)).to.be.revertedWithCustomError(ssf, "InvalidBps");
    await ssf.connect(timelock).setMaxGuardianBps(10_000);
    expect(await ssf.maxGuardianBps()).to.equal(10_000n);
  });

  it("[B439] StabilisationFund.setMaxGuardianBps: a value equal to maxDeployerBps is accepted, one below is InvalidBps", async function () {
    const { ssf, timelock } = await loadFixture(ssfFixture);
    await expect(ssf.connect(timelock).setMaxGuardianBps(2_999)).to.be.revertedWithCustomError(ssf, "InvalidBps");
    await ssf.connect(timelock).setMaxGuardianBps(3_000);
    expect(await ssf.maxGuardianBps()).to.equal(3_000n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SRXStaking
// ═══════════════════════════════════════════════════════════════════════════════

describe("Boundary gaps 23 Oct: SRXStaking", function () {
  const Tier = { None: 0, Slate: 1, Onyx: 2, Obsidian: 3 };

  async function stakingFixture() {
    const [admin, alice, stranger, gov] = await ethers.getSigners();
    const srx = await newToken();
    const staking = await (await ethers.getContractFactory("SRXStaking"))
      .deploy(await srx.getAddress(), admin.address, await allocationSource(srx));
    await staking.connect(admin).grantRole(await staking.GOVERNANCE_ROLE(), gov.address);
    await srx.connect(admin).transfer(await staking.getAddress(), E(10_000_000));
    await srx.connect(admin).transfer(alice.address, E(10_000));
    await srx.connect(alice).approve(await staking.getAddress(), ethers.MaxUint256);
    return { staking, srx, admin, alice, stranger, gov };
  }

  it("[B254] SRXStaking.unlock: allowed exactly at lockEnd, refused one second before", async function () {
    const { staking, srx, alice } = await loadFixture(stakingFixture);
    await staking.connect(alice).lock(E(1_000), 7 * DAY);
    const lockEnd = (await staking.positions(alice.address)).lockEnd;
    await at(lockEnd - 1n);
    await expect(staking.connect(alice).unlock(GAS)).to.be.revertedWithCustomError(staking, "LockNotExpired").withArgs(lockEnd);
    await at(lockEnd);
    await expect(staking.connect(alice).unlock(GAS)).to.emit(staking, "Unlocked").withArgs(alice.address, E(1_000));
    expect(await srx.balanceOf(alice.address)).to.equal(E(10_000));
  });

  it("[B275] SRXStaking.updateTierParams: a Slate discount equal to Onyx's is accepted, one bp above is InvalidBps", async function () {
    const { staking, gov } = await loadFixture(stakingFixture);
    const onyx = (await staking.tierParams(Tier.Onyx)).discountBps;
    const slateMin = (await staking.tierParams(Tier.Slate)).minSRX;
    await expect(staking.connect(gov).updateTierParams(Tier.Slate, slateMin, onyx + 1n)).to.be.revertedWithCustomError(staking, "InvalidBps");
    await staking.connect(gov).updateTierParams(Tier.Slate, slateMin, onyx);
    expect((await staking.tierParams(Tier.Slate)).discountBps).to.equal(onyx);
  });

  it("[B281] SRXStaking.updateTierParams: an Onyx discount equal to Slate's is accepted, one bp below is InvalidBps", async function () {
    const { staking, gov } = await loadFixture(stakingFixture);
    const slate = (await staking.tierParams(Tier.Slate)).discountBps;
    const onyxMin = (await staking.tierParams(Tier.Onyx)).minSRX;
    await expect(staking.connect(gov).updateTierParams(Tier.Onyx, onyxMin, slate - 1n)).to.be.revertedWithCustomError(staking, "InvalidBps");
    await staking.connect(gov).updateTierParams(Tier.Onyx, onyxMin, slate);
    expect((await staking.tierParams(Tier.Onyx)).discountBps).to.equal(slate);
  });

  it("[B286] SRXStaking.updateTierParams: an Obsidian discount equal to Onyx's is accepted, one bp below is InvalidBps", async function () {
    const { staking, gov } = await loadFixture(stakingFixture);
    const onyx = (await staking.tierParams(Tier.Onyx)).discountBps;
    const obsMin = (await staking.tierParams(Tier.Obsidian)).minSRX;
    await expect(staking.connect(gov).updateTierParams(Tier.Obsidian, obsMin, onyx - 1n)).to.be.revertedWithCustomError(staking, "InvalidBps");
    await staking.connect(gov).updateTierParams(Tier.Obsidian, obsMin, onyx);
    expect((await staking.tierParams(Tier.Obsidian)).discountBps).to.equal(onyx);
  });

  it("[B289] SRXStaking.startWindDown: anyone may start it exactly at windDownOpenToAllAt (30 days of pause), not one second before", async function () {
    const { staking, admin, stranger } = await loadFixture(stakingFixture);
    await staking.connect(admin).pause();
    const open = await staking.windDownOpenToAllAt();
    expect(open).to.equal((await staking.pausedSince()) + BigInt(30 * DAY));
    await at(open - 1n);
    await expect(staking.connect(stranger).startWindDown(GAS)).to.be.revertedWithCustomError(staking, "NotAuthorisedToWindDown");
    await at(open);
    await expect(staking.connect(stranger).startWindDown(GAS)).to.emit(staking, "WindDownStarted").withArgs(stranger.address, true);
    expect(await staking.windDown()).to.equal(true);
  });
});
