// Mutation sweep gaps, 22 Oct 2026. A sweep removed one access modifier or one guard at a time
// from the contracts and ran the whole suite; the mutants below SURVIVED (every test still
// passed with the check removed). One `it` per surviving mutant, titled with its id (M1..M13).
//
// Several guards sit in front of a second, later check that ends in the same revert (for
// example a `== 0` check followed by a `srxDelta == 0` check). A test that only asked for
// "reverts ZeroAmount" would still pass with the first guard removed. So each test below
// is built so that, WITHOUT its guard, the call would fail some other way (a different
// error, or an arithmetic panic) or would succeed. Each one was run against the one mutant
// it covers and shown to fail there; see the report that came with this file.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { approveBuyers } = require("../helpers/buyers");
const { allocationSource } = require("../helpers/allocationSource");

const E = (n) => ethers.parseUnits(String(n), 18);
const usd = (d) => BigInt(d) * 10n ** 8n;
const ZERO = ethers.ZeroAddress;
const SUNSET = 15_552_000;

// ═══════════════════════════════════════════════════════════════════════════════
// M1: SRXToken constructor
// ═══════════════════════════════════════════════════════════════════════════════

describe("Mutation gaps 22 Oct: SRXToken constructor", function () {
  it("M1: deploying SRXToken with an admin of address(0) reverts, and nothing is deployed", async function () {
    const [admin] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const Token = await ethers.getContractFactory("SRXToken");
    // Control: the same deployment with a real admin works and grants that admin the roles.
    const ok = await Token.deploy(await ep.getAddress(), admin.address);
    expect(await ok.hasRole(await ok.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await ok.owner()).to.equal(admin.address);
    // The zero admin is refused. (The base Ownable constructor, which runs before the token's
    // own `ZeroAddress` check, is what actually reverts: see the report for what that means.)
    await expect(Token.deploy(await ep.getAddress(), ZERO)).to.be.reverted;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M2: GuardianModule.freezeBridgeInbound when the token call fails
// ═══════════════════════════════════════════════════════════════════════════════

describe("Mutation gaps 22 Oct: GuardianModule.freezeBridgeInbound", function () {
  async function guardianFixture() {
    const [admin, guardian, governance] = await ethers.getSigners();
    const gm = await (await ethers.getContractFactory("GuardianModule"))
      .deploy(admin.address, guardian.address, governance.address, SUNSET);
    const MODULE_TOKEN = await gm.MODULE_TOKEN();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    return { gm, token, MODULE_TOKEN, admin, guardian, governance };
  }

  it("M2: a failing token call reverts CallFailed(MODULE_TOKEN, data): the module without PAUSER_ROLE on the real token, and a target with no freezeInbound", async function () {
    const { gm, token, MODULE_TOKEN, guardian, governance } = await loadFixture(guardianFixture);

    // (a) A REAL token, but the module has not been given PAUSER_ROLE on it: freezeInbound
    //     reverts inside the token, and the module must surface that, not swallow it.
    await gm.connect(governance).registerModule(MODULE_TOKEN, await token.getAddress());
    // The returned data is the token's AccessControlUnauthorizedAccount(module, PAUSER_ROLE).
    const expectedData = token.interface.encodeErrorResult("AccessControlUnauthorizedAccount", [
      await gm.getAddress(), await token.PAUSER_ROLE(),
    ]);
    await expect(gm.connect(guardian).freezeBridgeInbound(40102, "freeze"))
      .to.be.revertedWithCustomError(gm, "CallFailed").withArgs(MODULE_TOKEN, expectedData);
    expect(await token.inboundFrozen(40102)).to.equal(false);

    // Control: with PAUSER_ROLE the same call works and the chain is frozen.
    await token.grantRole(await token.PAUSER_ROLE(), await gm.getAddress());
    await expect(gm.connect(guardian).freezeBridgeInbound(40102, "freeze")).to.emit(gm, "GuardianAction");
    expect(await token.inboundFrozen(40102)).to.equal(true);

    // (b) A contract that has no freezeInbound at all (a strict pausable stub): empty return data.
    const stub = await (await ethers.getContractFactory("PausableStrictStub")).deploy();
    await gm.connect(governance).updateModuleTarget(MODULE_TOKEN, await stub.getAddress());
    await expect(gm.connect(guardian).freezeBridgeInbound(40106, "freeze"))
      .to.be.revertedWithCustomError(gm, "CallFailed").withArgs(MODULE_TOKEN, "0x");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M3: FeeController.commitFeeDistribution
// ═══════════════════════════════════════════════════════════════════════════════

describe("Mutation gaps 22 Oct: FeeController.commitFeeDistribution", function () {
  it("M3: a caller without GOVERNANCE_ROLE is refused even when the distribution is valid; governance succeeds", async function () {
    const [admin, governance, stranger] = await ethers.getSigners();
    const fee = await (await ethers.getContractFactory("FeeController")).deploy(stranger.address, admin.address);
    const GOV = await fee.GOVERNANCE_ROLE();
    await fee.connect(admin).grantRole(GOV, governance.address);
    // A VALID table (10_000 bps), so that without the role check the stranger's call would succeed.
    await fee.connect(governance).setFeeDestination(0, admin.address, 10_000, true, ethers.encodeBytes32String("Treasury"));
    expect((await fee.validateFeeDistribution())[0]).to.equal(true);

    await expect(fee.connect(stranger).commitFeeDistribution())
      .to.be.revertedWithCustomError(fee, "AccessControlUnauthorizedAccount").withArgs(stranger.address, GOV);

    await expect(fee.connect(governance).commitFeeDistribution())
      .to.emit(fee, "FeeDistributionCommitted").withArgs(10_000n, anyValue);
  });
});

function anyValue() { return true; }

// ═══════════════════════════════════════════════════════════════════════════════
// M4: StabilisationFund.notifyRewardAmount
// ═══════════════════════════════════════════════════════════════════════════════

describe("Mutation gaps 22 Oct: StabilisationFund.notifyRewardAmount", function () {
  async function ssfFixture() {
    const [admin, timelock, contributor, stranger] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await srx.connect(admin).genesis(admin.address);
    const srxAddr = await srx.getAddress();
    const BACKING = E(10_000_000);
    const SEED = E(1_500_000_000);
    const ssf = await (await ethers.getContractFactory("StabilisationFund")).deploy(
      srxAddr, admin.address, 3_000, 7_000, 30 * 86400, BACKING, await allocationSource(srxAddr, SEED));
    const ssfAddr = await ssf.getAddress();
    const GOV = await ssf.GOVERNANCE_ROLE();
    await ssf.connect(admin).grantRole(GOV, timelock.address);
    await srx.connect(admin).transfer(ssfAddr, SEED + BACKING);
    await srx.connect(admin).transfer(contributor.address, E(2_000_000));
    await srx.connect(contributor).approve(ssfAddr, ethers.MaxUint256);
    await ssf.connect(contributor).contribute(E(1_000_000)); // a contributor exists, so a registration is valid
    return { ssf, GOV, BACKING, timelock, stranger };
  }

  it("M4: a caller without GOVERNANCE_ROLE is refused on a state where the call would otherwise succeed; governance succeeds", async function () {
    const { ssf, GOV, BACKING, timelock, stranger } = await loadFixture(ssfFixture);
    await expect(ssf.connect(stranger).notifyRewardAmount(BACKING))
      .to.be.revertedWithCustomError(ssf, "AccessControlUnauthorizedAccount").withArgs(stranger.address, GOV);
    expect(await ssf.rewardPool()).to.equal(0n);

    await expect(ssf.connect(timelock).notifyRewardAmount(BACKING))
      .to.emit(ssf, "RewardPoolFunded").withArgs(BACKING, BACKING);
    expect(await ssf.rewardPool()).to.equal(BACKING);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M5 to M12: PreSaleRound
// ═══════════════════════════════════════════════════════════════════════════════

describe("Mutation gaps 22 Oct: PreSaleRound", function () {
  const TREASURY = ethers.Wallet.createRandom().address;
  const SRX_PRICE = 1_250_000n;                  // $0.0125
  const ETH_PRICE = 2_500n * 10n ** 8n;
  const BTC_PRICE = 60_000n * 10n ** 8n;
  const HARD_CAP = E(400_000_000);

  async function deployRound({ usdc, usdt, wbtc } = {}) {
    const [admin, investor1, investor2, stranger] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await token.connect(admin).genesis(admin.address);

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockUsdc = usdc || await MockERC20.deploy("USD Coin", "USDC", 6);
    const mockUsdt = usdt || await MockERC20.deploy("Tether USD", "USDT", 6);
    const mockWbtc = wbtc || await MockERC20.deploy("Wrapped BTC", "WBTC", 8);
    for (const t of [mockUsdc, mockUsdt]) for (const w of [investor1, investor2]) await t.mint(w.address, 100_000n * 10n ** 6n);
    for (const w of [investor1, investor2]) await mockWbtc.mint(w.address, 100n * 10n ** 8n);

    const Feed = await ethers.getContractFactory("MockChainlinkFeed");
    const ethFeed = await Feed.deploy(ETH_PRICE);
    const btcFeed = await Feed.deploy(BTC_PRICE);

    const round = await (await ethers.getContractFactory("PreSaleRound")).deploy(
      await token.getAddress(), await mockUsdc.getAddress(), await mockUsdt.getAddress(), await mockWbtc.getAddress(),
      await ethFeed.getAddress(), await btcFeed.getAddress(), admin.address, HARD_CAP, SRX_PRICE, false, 0, TREASURY);
    await token.connect(admin).transfer(await round.getAddress(), HARD_CAP);
    await approveBuyers(round, admin, [investor1, investor2, stranger]);
    for (const w of [investor1, investor2]) {
      await mockUsdc.connect(w).approve(await round.getAddress(), ethers.MaxUint256);
      await mockUsdt.connect(w).approve(await round.getAddress(), ethers.MaxUint256);
      await mockWbtc.connect(w).approve(await round.getAddress(), ethers.MaxUint256);
    }
    return { round, token, mockUsdc, mockUsdt, mockWbtc, ethFeed, btcFeed, admin, investor1, investor2, stranger };
  }
  const roundFixture = () => deployRound();

  // An investor recorded off chain whose SRX allocation was then corrected to an amount that
  // does not map back exactly (the stored USD is rounded down). Any later $0 "top-up" would
  // therefore recompute to LESS than the stored allocation and underflow, instead of reverting
  // ZeroAmount: so a test that expects ZeroAmount only passes if the explicit zero guard is hit first.
  async function lossyInvestor(round, admin, who) {
    await round.connect(admin).addInvestor(who.address, usd(1000));
    const srx = E(1_000_000) + 1n;
    await round.connect(admin).updateAllocation(who.address, srx);
    // sanity: inverse then forward loses a little, so the stored allocation is above what $ recomputes to
    const cumUsd = (await round.investors(who.address)).cumulativeUsd8Dec;
    const forward = cumUsd * 10n ** 18n * 11_000n / SRX_PRICE / 10_000n;
    expect(forward).to.be.lt(srx);
  }

  it("M5: setMinContribution by a non-admin is refused (OnlyAdmin); the admin can set it", async function () {
    const { round, admin, stranger } = await loadFixture(roundFixture);
    await expect(round.connect(stranger).setMinContribution(usd(5))).to.be.revertedWithCustomError(round, "OnlyAdmin");
    expect(await round.minContributionUsd8Dec()).to.equal(0n);
    await expect(round.connect(admin).setMinContribution(usd(5))).to.emit(round, "MinContributionSet").withArgs(0n, usd(5));
    expect(await round.minContributionUsd8Dec()).to.equal(usd(5));
  });

  it("M6: setStablecoinFeeds by a non-admin is refused (OnlyAdmin); the admin can set them", async function () {
    const { round, admin, stranger, ethFeed, btcFeed } = await loadFixture(roundFixture);
    const a = await ethFeed.getAddress(), b = await btcFeed.getAddress();   // valid 8-decimal feeds
    await expect(round.connect(stranger).setStablecoinFeeds(a, b)).to.be.revertedWithCustomError(round, "OnlyAdmin");
    expect(await round.usdcUsdFeed()).to.equal(ZERO);
    expect(await round.usdtUsdFeed()).to.equal(ZERO);
    await expect(round.connect(admin).setStablecoinFeeds(a, b)).to.emit(round, "StablecoinFeedsUpdated").withArgs(a, b);
    expect(await round.usdcUsdFeed()).to.equal(a);
    expect(await round.usdtUsdFeed()).to.equal(b);
  });

  it("M7: setHardCap works before finalize and reverts RoundFinalized after it", async function () {
    const { round, admin } = await loadFixture(roundFixture);
    await expect(round.connect(admin).setHardCap(HARD_CAP - 1n)).to.emit(round, "HardCapUpdated").withArgs(HARD_CAP - 1n);
    expect(await round.hardCapSRX()).to.equal(HARD_CAP - 1n);
    await round.connect(admin).finalize();
    await expect(round.connect(admin).setHardCap(HARD_CAP - 2n)).to.be.revertedWithCustomError(round, "RoundFinalized");
    expect(await round.hardCapSRX()).to.equal(HARD_CAP - 1n);
  });

  // The investor below already has a deployed vault. invest/investWith* check the amount BEFORE the
  // vault, so a zero amount gives ZeroAmount; if the zero check were gone the call would fall through
  // to VaultAlreadyDeployed (the control line proves that is where it would go).
  async function investorWithVault() {
    const f = await deployRound();
    await f.round.connect(f.admin).addInvestor(f.investor1.address, usd(1000));
    await f.round.connect(f.admin).deployVault(f.investor1.address);
    return f;
  }

  it("M8: invest() with msg.value 0 reverts ZeroAmount (before the vault check)", async function () {
    const { round, investor1 } = await loadFixture(investorWithVault);
    await expect(round.connect(investor1).invest({ value: 1n })).to.be.revertedWithCustomError(round, "VaultAlreadyDeployed"); // control
    await expect(round.connect(investor1).invest({ value: 0n })).to.be.revertedWithCustomError(round, "ZeroAmount");
  });

  it("M9a: investWithUSDC(0) reverts ZeroAmount (before the vault check)", async function () {
    const { round, investor1 } = await loadFixture(investorWithVault);
    await expect(round.connect(investor1).investWithUSDC(1n)).to.be.revertedWithCustomError(round, "VaultAlreadyDeployed"); // control
    await expect(round.connect(investor1).investWithUSDC(0n)).to.be.revertedWithCustomError(round, "ZeroAmount");
  });

  it("M9b: investWithUSDT(0) reverts ZeroAmount (before the vault check)", async function () {
    const { round, investor1 } = await loadFixture(investorWithVault);
    await expect(round.connect(investor1).investWithUSDT(1n)).to.be.revertedWithCustomError(round, "VaultAlreadyDeployed"); // control
    await expect(round.connect(investor1).investWithUSDT(0n)).to.be.revertedWithCustomError(round, "ZeroAmount");
  });

  it("M9c: investWithWBTC(0) reverts ZeroAmount (before the vault check)", async function () {
    const { round, investor1 } = await loadFixture(investorWithVault);
    await expect(round.connect(investor1).investWithWBTC(1n)).to.be.revertedWithCustomError(round, "VaultAlreadyDeployed"); // control
    await expect(round.connect(investor1).investWithWBTC(0n)).to.be.revertedWithCustomError(round, "ZeroAmount");
  });

  it("M10: a purchase whose USD value rounds to 0 is refused with ZeroAmount, for ETH (1 wei) and for WBTC (1 satoshi at a sub-$1 price)", async function () {
    const { round, admin, investor1, investor2, btcFeed } = await loadFixture(roundFixture);

    // Sanity: at the mock prices one wei is worth 0 in 8-decimal USD, so this is the zero-value case.
    expect(1n * ETH_PRICE / 10n ** 18n).to.equal(0n);
    // For WBTC, one satoshi is worth 0 only if BTC is priced below $1; set the (mock) feed so.
    await btcFeed.setPrice(99_999_999n);
    expect(1n * 99_999_999n / 10n ** 8n).to.equal(0n);

    // (1) A minimum contribution is set: without the zero-USD guard the call would fall through to
    //     the minimum check and revert BelowMinimumContribution instead.
    await round.connect(admin).setMinContribution(usd(1));
    await expect(round.connect(investor1).invest({ value: 1n })).to.be.revertedWithCustomError(round, "ZeroAmount");
    await expect(round.connect(investor1).investWithWBTC(1n)).to.be.revertedWithCustomError(round, "ZeroAmount");

    // (2) No minimum (0), and an investor whose stored allocation is a little above what its USD
    //     recomputes to: without the guard the call would reach the allocation maths and panic
    //     (underflow) instead of reverting ZeroAmount.
    await round.connect(admin).setMinContribution(0);
    await lossyInvestor(round, admin, investor2);
    await expect(round.connect(investor2).invest({ value: 1n })).to.be.revertedWithCustomError(round, "ZeroAmount");
    await expect(round.connect(investor2).investWithWBTC(1n)).to.be.revertedWithCustomError(round, "ZeroAmount");
    // Nothing was recorded for either payer.
    expect(await round.paidOnChain(investor1.address, ZERO)).to.equal(0n);
    expect(await round.paidOnChain(investor2.address, ZERO)).to.equal(0n);
  });

  it("M11: a stablecoin purchase where the contract receives 0 tokens is refused with ZeroAmount (100% fee-on-transfer mock)", async function () {
    const Fee = await ethers.getContractFactory("MockFeeOnTransferERC20");
    const feeUsdc = await Fee.deploy(6, 10_000);   // every transfer burns 100%: nothing arrives
    const feeUsdt = await Fee.deploy(6, 10_000);
    const feeWbtc = await Fee.deploy(8, 10_000);
    const { round, admin, investor1, investor2 } = await deployRound({ usdc: feeUsdc, usdt: feeUsdt, wbtc: feeWbtc });
    for (const t of [feeUsdc, feeUsdt, feeWbtc]) {
      for (const w of [investor1, investor2]) {
        await t.mint(w.address, 10n ** 12n);
        await t.connect(w).approve(await round.getAddress(), ethers.MaxUint256);
      }
    }

    // A minimum contribution is set: without the received==0 guard a stablecoin purchase would be valued
    // at $0 and revert BelowMinimumContribution instead.
    await round.connect(admin).setMinContribution(usd(1));
    await expect(round.connect(investor1).investWithUSDC(10n ** 6n)).to.be.revertedWithCustomError(round, "ZeroAmount");
    await expect(round.connect(investor1).investWithUSDT(10n ** 6n)).to.be.revertedWithCustomError(round, "ZeroAmount");

    // No minimum, and a lossy investor: without the guard it would reach the allocation maths and panic.
    await round.connect(admin).setMinContribution(0);
    await lossyInvestor(round, admin, investor2);
    await expect(round.connect(investor2).investWithUSDC(10n ** 6n)).to.be.revertedWithCustomError(round, "ZeroAmount");
    await expect(round.connect(investor2).investWithUSDT(10n ** 6n)).to.be.revertedWithCustomError(round, "ZeroAmount");
    // WBTC shares the pull guard; it is also backed by the zero-USD check, so this one is a plain behaviour check.
    await expect(round.connect(investor1).investWithWBTC(10n ** 8n)).to.be.revertedWithCustomError(round, "ZeroAmount");

    // Nothing was credited.
    expect(await round.paidOnChain(investor1.address, await feeUsdc.getAddress())).to.equal(0n);
    expect(await round.paidOnChain(investor2.address, await feeUsdt.getAddress())).to.equal(0n);
    expect(await round.investorCount()).to.equal(1n); // only the off-chain one
  });

  it("M12: addInvestor with a zero USD amount reverts ZeroAmount, for a new and for an existing investor", async function () {
    const { round, admin, investor1, investor2 } = await loadFixture(roundFixture);
    await expect(round.connect(admin).addInvestor(investor1.address, 0n)).to.be.revertedWithCustomError(round, "ZeroAmount");

    // An existing investor whose stored allocation sits slightly above what its USD recomputes to:
    // without the guard a $0 top-up would reach the allocation maths and panic instead.
    await lossyInvestor(round, admin, investor2);
    await expect(round.connect(admin).addInvestor(investor2.address, 0n)).to.be.revertedWithCustomError(round, "ZeroAmount");
    expect((await round.investors(investor2.address)).srxAllocation).to.equal(E(1_000_000) + 1n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M13: SRXTreasury.executeBuyAndBurn
// ═══════════════════════════════════════════════════════════════════════════════

describe("Mutation gaps 22 Oct: SRXTreasury", function () {
  it("M13: executeBuyAndBurn(0) reverts ZeroAmount in the treasury itself, before the token is called", async function () {
    const [admin, timelock] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await token.connect(admin).genesis(admin.address);
    const treasury = await (await ethers.getContractFactory("SRXTreasury"))
      .deploy(await token.getAddress(), admin.address, timelock.address);
    const tAddr = await treasury.getAddress();
    await treasury.connect(timelock).grantRole(await treasury.SPENDER_ROLE(), admin.address);
    await token.connect(admin).transfer(tAddr, E(1_000));

    // The treasury does NOT hold BURN_ROLE yet. If its own zero check were gone, the call would reach
    // the token and fail there with AccessControlUnauthorizedAccount, not the treasury's ZeroAmount.
    // (The token's own zero check has the same ZeroAmount selector, so only this ordering tells them apart.)
    await expect(treasury.connect(admin).executeBuyAndBurn(0n)).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    expect(await treasury.totalBurned()).to.equal(0n);

    // Control: a non-zero burn without the role fails at the token; with the role it works.
    await expect(treasury.connect(admin).executeBuyAndBurn(E(1))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    await token.connect(admin).grantRole(await token.BURN_ROLE(), tAddr);
    await expect(treasury.connect(admin).executeBuyAndBurn(0n)).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    await expect(treasury.connect(admin).executeBuyAndBurn(E(1))).to.emit(treasury, "BuyAndBurnExecuted");
    expect(await treasury.totalBurned()).to.equal(E(1));
  });
});
