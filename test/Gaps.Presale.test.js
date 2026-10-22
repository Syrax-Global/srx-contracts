// Gap-closing tests for PreSaleRound: reentrancy on refunds, oracle guards, the refund
// ring-fence on every asset, underfunded refunds, finalisation, caps, vault deployment,
// revocation, SRX recovery, payment-token decimals, and an off-chain top-up of an
// on-chain payer.
//
// Where the code did not do what its own comment said, the test pins what it
// actually does; the comment was corrected on 7 Oct 2026 (REMEDIATION.md R7-13).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { approveBuyers, refFor } = require("./helpers/buyers");

describe("Gaps — PreSaleRound", function () {
  const PRICE = 1_250_000n;                          // $0.0125 per SRX
  const CAP = ethers.parseUnits("300000000", 18);    // Genesis: 300M SRX
  const ETH_PRICE = 2_500n * 10n ** 8n;
  const BTC_PRICE = 60_000n * 10n ** 8n;
  const FLAT_BPS = 5_000n;                           // +50%
  const E = (n) => ethers.parseUnits(String(n), 18);
  const U6 = (n) => BigInt(n) * 10n ** 6n;
  const usd = (d) => BigInt(d) * 10n ** 8n;
  const ZERO = ethers.ZeroAddress;
  // $1 of payment buys 100 SRX base, +50% = 120 SRX per dollar
  const srxFor = (dollars) => E(120) * BigInt(dollars);
  const REENTRANCY_SELECTOR = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);

  /**
   * One fresh round per test (a plain function, not loadFixture, so each test can pass options).
   * funded: SRX placed in the round (default: the whole hard cap).
   */
  async function setup({ funded = CAP, feeds = "mock" } = {}) {
    const [admin, i1, i2, i3, other, recipient] = await ethers.getSigners();
    const LZ = await ethers.getContractFactory("MockLZEndpoint");
    const lz = await LZ.deploy(40161);
    const T = await ethers.getContractFactory("SRXToken");
    const token = await T.deploy(lz.target, admin.address);
    await token.connect(admin).genesis(admin.address);
    const M = await ethers.getContractFactory("MockERC20");
    const usdc = await M.deploy("USD Coin", "USDC", 6);
    const usdt = await M.deploy("Tether USD", "USDT", 6);
    const wbtc = await M.deploy("Wrapped BTC", "WBTC", 8);
    const F = await ethers.getContractFactory(feeds === "round" ? "GapsVRoundFeed" : "MockChainlinkFeed");
    const ethFeed = await F.deploy(ETH_PRICE);
    const btcFeed = await F.deploy(BTC_PRICE);
    const R = await ethers.getContractFactory("PreSaleRound");
    const r = await R.deploy(
      token.target, usdc.target, usdt.target, wbtc.target, ethFeed.target, btcFeed.target,
      admin.address, CAP, PRICE, true, FLAT_BPS, recipient.address, // recipient = the round's vaultRevokeRecipient (internal audit M2)
    );
    if (funded > 0n) await token.connect(admin).transfer(r.target, funded);
    await approveBuyers(r, admin, [i1, i2, i3]);
    for (const w of [i1, i2, i3, admin]) {
      await usdc.mint(w.address, U6(1_000_000));
      await usdt.mint(w.address, U6(1_000_000));
      await wbtc.mint(w.address, 10n * 10n ** 8n);
      await usdc.connect(w).approve(r.target, ethers.MaxUint256);
      await usdt.connect(w).approve(r.target, ethers.MaxUint256);
      await wbtc.connect(w).approve(r.target, ethers.MaxUint256);
    }
    return { r, token, usdc, usdt, wbtc, ethFeed, btcFeed, admin, i1, i2, i3, other, recipient, lz, M, F, R };
  }

  // ── P1 ───────────────────────────────────────────────────────────────────────
  describe("P1 re-entering claimRefund during an ETH refund", function () {
    async function owed() {
      const s = await setup();
      const B = await ethers.getContractFactory("GapsVReentrantBuyer");
      const buyer = await B.deploy(s.r.target);
      await approveBuyers(s.r, s.admin, [buyer.target]);
      await s.usdc.mint(buyer.target, U6(10_000));
      await buyer.buyETH({ value: E(1) });
      await buyer.buyUSDC(s.usdc.target, U6(10_000));
      await s.r.connect(s.admin).refundInvestor(buyer.target);
      // the contract is owed 1 ETH and 10,000 USDC; both are ring-fenced
      expect(await s.r.refundOwed(buyer.target, ZERO)).to.equal(E(1));
      expect(await s.r.refundOwed(buyer.target, s.usdc.target)).to.equal(U6(10_000));
      return { ...s, buyer };
    }

    it("control: a normal refund claim works and pays the claimant exactly what they paid", async function () {
      const { r, i1, usdc, admin } = await setup();
      await r.connect(i1).invest({ value: E(1) });
      await r.connect(i1).investWithUSDC(U6(10_000));
      await r.connect(admin).refundInvestor(i1.address);
      await expect(r.connect(i1).claimRefund(ZERO)).to.changeEtherBalances([r, i1], [-E(1), E(1)]);
      await expect(r.connect(i1).claimRefund(usdc.target)).to.changeTokenBalances(usdc, [r, i1], [-U6(10_000), U6(10_000)]);
      expect(await r.totalRefundOwed(ZERO)).to.equal(0n);
      expect(await r.totalRefundOwed(usdc.target)).to.equal(0n);
    });

    it("the nested claimRefund is refused with ReentrancyGuardReentrantCall; the outer claim pays once and balances stay consistent", async function () {
      const { r, buyer, usdc } = await owed();
      // control for the attack itself: outside a re-entry, the USDC claim is valid (asserted below
      // after the attempt) — so the only thing stopping the nested call is the guard.
      await buyer.arm(usdc.target, false);

      await expect(buyer.claim(ZERO)).to.changeEtherBalances([r, buyer], [-E(1), E(1)]);

      expect(await buyer.reenterAttempts()).to.equal(1n);
      expect(await buyer.lastReenterOk()).to.equal(false);
      expect((await buyer.lastReenterRevert()).slice(0, 10)).to.equal(REENTRANCY_SELECTOR);
      // ETH is paid and cleared; the USDC refund was NOT drained by the nested call
      expect(await r.refundOwed(buyer.target, ZERO)).to.equal(0n);
      expect(await r.totalRefundOwed(ZERO)).to.equal(0n);
      expect(await r.refundOwed(buyer.target, usdc.target)).to.equal(U6(10_000));
      expect(await r.totalRefundOwed(usdc.target)).to.equal(U6(10_000));
      expect(await usdc.balanceOf(buyer.target)).to.equal(0n);
      expect(await usdc.balanceOf(r.target)).to.equal(U6(10_000));
      expect(await ethers.provider.getBalance(r.target)).to.equal(0n);

      // and the USDC refund is still claimable once, normally
      await buyer.disarm();
      await expect(buyer.claim(usdc.target)).to.changeTokenBalances(usdc, [r, buyer], [-U6(10_000), U6(10_000)]);
      expect(await r.totalRefundOwed(usdc.target)).to.equal(0n);
    });

    it("re-entering the same asset is refused too; if the receiver bubbles the refusal the whole claim fails and nothing moves", async function () {
      const { r, buyer } = await owed();
      await buyer.arm(ZERO, true);
      await expect(buyer.claim(ZERO))
        .to.be.revertedWithCustomError(r, "ETHTransferFailed");
      expect(await buyer.reenterAttempts()).to.equal(0n); // reverted txs roll their own writes back
      expect(await r.refundOwed(buyer.target, ZERO)).to.equal(E(1));
      expect(await r.totalRefundOwed(ZERO)).to.equal(E(1));
      expect(await ethers.provider.getBalance(r.target)).to.equal(E(1));

      // control: disarmed, the same claim succeeds
      await buyer.disarm();
      await expect(buyer.claim(ZERO)).to.changeEtherBalances([r, buyer], [-E(1), E(1)]);
    });
  });

  // ── P2 ───────────────────────────────────────────────────────────────────────
  describe("P2 oracle guards", function () {
    it("an ETH price above the maximum reverts OraclePriceOutOfBounds; inside the bounds it works (control)", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).setOraclePriceBounds(usd(100), usd(2_000), 0, 0); // feed says $2,500
      await expect(r.connect(i1).invest({ value: E(1) }))
        .to.be.revertedWithCustomError(r, "OraclePriceOutOfBounds").withArgs(ETH_PRICE, usd(100), usd(2_000));
      await expect(r.currentEthPrice()).to.be.revertedWithCustomError(r, "OraclePriceOutOfBounds");
      expect(await r.investorCount()).to.equal(0n);

      await r.connect(admin).setOraclePriceBounds(usd(100), usd(3_000), 0, 0);
      await r.connect(i1).invest({ value: E(1) });
      expect((await r.investors(i1.address)).cumulativeUsd8Dec).to.equal(ETH_PRICE);
    });

    it("an ETH price below the minimum reverts OraclePriceOutOfBounds; the boundary itself is accepted (control)", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).setOraclePriceBounds(usd(3_000), usd(20_000), 0, 0);
      await expect(r.connect(i1).invest({ value: E(1) }))
        .to.be.revertedWithCustomError(r, "OraclePriceOutOfBounds").withArgs(ETH_PRICE, usd(3_000), usd(20_000));

      await r.connect(admin).setOraclePriceBounds(ETH_PRICE, usd(20_000), 0, 0); // min == price
      await r.connect(i1).invest({ value: E(1) });
      expect(await r.investorCount()).to.equal(1n);
    });

    it("a BTC price outside its bounds refuses WBTC purchases the same way", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).setOraclePriceBounds(0, 0, usd(100_000), usd(500_000)); // feed says $60,000
      await expect(r.connect(i1).investWithWBTC(10n ** 7n))
        .to.be.revertedWithCustomError(r, "OraclePriceOutOfBounds").withArgs(BTC_PRICE, usd(100_000), usd(500_000));
      await r.connect(admin).setOraclePriceBounds(0, 0, usd(10_000), usd(500_000));
      await r.connect(i1).investWithWBTC(10n ** 7n); // 0.1 BTC = $6,000
      expect((await r.investors(i1.address)).cumulativeUsd8Dec).to.equal(usd(6_000));
    });

    it("answeredInRound < roundId reverts IncompleteRound; a complete round works (control)", async function () {
      const { r, ethFeed, i1 } = await setup({ feeds: "round" });
      await ethFeed.setRound(5, 4);
      await expect(r.connect(i1).invest({ value: E(1) })).to.be.revertedWithCustomError(r, "IncompleteRound");
      await expect(r.currentEthPrice()).to.be.revertedWithCustomError(r, "IncompleteRound");
      expect(await r.investorCount()).to.equal(0n);

      await ethFeed.setRound(5, 5);
      await r.connect(i1).invest({ value: E(1) });
      expect(await r.investorCount()).to.equal(1n);
      // a later answer is fine too
      await ethFeed.setRound(5, 6);
      expect(await r.currentEthPrice()).to.equal(ETH_PRICE);
    });

    it("setOraclePriceBounds with min >= max reverts InvalidPriceBounds (ETH and BTC); min < max or a 0 side is accepted (control)", async function () {
      const { r, admin, i1 } = await setup();
      await expect(r.connect(admin).setOraclePriceBounds(usd(2_000), usd(2_000), 0, 0))
        .to.be.revertedWithCustomError(r, "InvalidPriceBounds");
      await expect(r.connect(admin).setOraclePriceBounds(usd(3_000), usd(2_000), 0, 0))
        .to.be.revertedWithCustomError(r, "InvalidPriceBounds");
      await expect(r.connect(admin).setOraclePriceBounds(0, 0, usd(60_000), usd(60_000)))
        .to.be.revertedWithCustomError(r, "InvalidPriceBounds");
      await expect(r.connect(admin).setOraclePriceBounds(0, 0, usd(70_000), usd(60_000)))
        .to.be.revertedWithCustomError(r, "InvalidPriceBounds");
      expect(await r.minEthPriceUsd8Dec()).to.equal(0n);
      expect(await r.maxEthPriceUsd8Dec()).to.equal(0n);

      await expect(r.connect(i1).setOraclePriceBounds(usd(1), usd(2), 0, 0))
        .to.be.revertedWithCustomError(r, "OnlyAdmin");

      await r.connect(admin).setOraclePriceBounds(usd(100), usd(20_000), usd(10_000), usd(500_000));
      expect(await r.minEthPriceUsd8Dec()).to.equal(usd(100));
      expect(await r.maxEthPriceUsd8Dec()).to.equal(usd(20_000));
      expect(await r.minBtcPriceUsd8Dec()).to.equal(usd(10_000));
      expect(await r.maxBtcPriceUsd8Dec()).to.equal(usd(500_000));
      await r.connect(admin).setOraclePriceBounds(usd(100), 0, 0, usd(500_000)); // a 0 side disables that side
    });
  });

  // ── P3 ───────────────────────────────────────────────────────────────────────
  describe("P3 refund ring-fence on every asset", function () {
    async function refunded() {
      const s = await setup();
      const { r, i1, i2, admin } = s;
      // i1 pays in all four assets and is refunded; i2 pays in all four and stays
      await r.connect(i1).invest({ value: E(1) });
      await r.connect(i1).investWithUSDC(U6(10_000));
      await r.connect(i1).investWithUSDT(U6(5_000));
      await r.connect(i1).investWithWBTC(10n ** 7n);       // 0.1 WBTC
      await r.connect(i2).invest({ value: E(2) });
      await r.connect(i2).investWithUSDC(U6(3_000));
      await r.connect(i2).investWithUSDT(U6(2_000));
      await r.connect(i2).investWithWBTC(2n * 10n ** 7n);  // 0.2 WBTC
      await r.connect(admin).refundInvestor(i1.address);
      return s;
    }

    it("withdrawETH leaves exactly the owed ETH; withdrawETHAmount cannot reach into it", async function () {
      const { r, admin, i1 } = await refunded();
      expect(await ethers.provider.getBalance(r.target)).to.equal(E(3));
      expect(await r.totalRefundOwed(ZERO)).to.equal(E(1));

      // more than the free amount (2 ETH) reverts, even though the contract holds 3
      await expect(r.connect(admin).withdrawETHAmount(admin.address, E(2) + 1n))
        .to.be.revertedWithCustomError(r, "ExceedsWithdrawable");
      await expect(r.connect(admin).withdrawETHAmount(admin.address, E(3)))
        .to.be.revertedWithCustomError(r, "ExceedsWithdrawable");
      expect(await ethers.provider.getBalance(r.target)).to.equal(E(3));

      // control: exactly the free amount is withdrawable
      await expect(r.connect(admin).withdrawETHAmount(admin.address, E(2)))
        .to.changeEtherBalances([r, admin], [-E(2), E(2)]);
      expect(await ethers.provider.getBalance(r.target)).to.equal(E(1));
      // nothing free is left, and withdrawETH refuses
      await expect(r.connect(admin).withdrawETH(admin.address)).to.be.revertedWithCustomError(r, "ZeroAmount");
      expect(await ethers.provider.getBalance(r.target)).to.equal(E(1));
      // the refund is still whole
      await expect(r.connect(i1).claimRefund(ZERO)).to.changeEtherBalances([r, i1], [-E(1), E(1)]);
    });

    it("withdrawETH takes everything but the owed ETH", async function () {
      const { r, admin } = await refunded();
      await expect(r.connect(admin).withdrawETH(admin.address)).to.changeEtherBalances([r, admin], [-E(2), E(2)]);
      expect(await ethers.provider.getBalance(r.target)).to.equal(E(1));
    });

    it("withdrawUSDC / withdrawUSDT / withdrawWBTC leave exactly the owed amount", async function () {
      const { r, admin, i1, usdc, usdt, wbtc } = await refunded();
      await expect(r.connect(admin).withdrawUSDC(admin.address)).to.changeTokenBalances(usdc, [r, admin], [-U6(3_000), U6(3_000)]);
      await expect(r.connect(admin).withdrawUSDT(admin.address)).to.changeTokenBalances(usdt, [r, admin], [-U6(2_000), U6(2_000)]);
      await expect(r.connect(admin).withdrawWBTC(admin.address)).to.changeTokenBalances(wbtc, [r, admin], [-2n * 10n ** 7n, 2n * 10n ** 7n]);
      expect(await usdc.balanceOf(r.target)).to.equal(U6(10_000));
      expect(await usdt.balanceOf(r.target)).to.equal(U6(5_000));
      expect(await wbtc.balanceOf(r.target)).to.equal(10n ** 7n);
      // a second withdrawal finds nothing free
      await expect(r.connect(admin).withdrawUSDC(admin.address)).to.be.revertedWithCustomError(r, "ZeroAmount");
      await expect(r.connect(admin).withdrawUSDT(admin.address)).to.be.revertedWithCustomError(r, "ZeroAmount");
      await expect(r.connect(admin).withdrawWBTC(admin.address)).to.be.revertedWithCustomError(r, "ZeroAmount");

      // the refunded investor is paid in full, in every asset
      await expect(r.connect(i1).claimRefund(usdc.target)).to.changeTokenBalance(usdc, i1, U6(10_000));
      await expect(r.connect(i1).claimRefund(usdt.target)).to.changeTokenBalance(usdt, i1, U6(5_000));
      await expect(r.connect(i1).claimRefund(wbtc.target)).to.changeTokenBalance(wbtc, i1, 10n ** 7n);
      await expect(r.connect(i1).claimRefund(ZERO)).to.changeEtherBalances([r, i1], [-E(1), E(1)]);
      for (const a of [ZERO, usdc.target, usdt.target, wbtc.target]) {
        expect(await r.totalRefundOwed(a)).to.equal(0n);
      }
    });

    it("only the admin can withdraw", async function () {
      const { r, i2 } = await refunded();
      await expect(r.connect(i2).withdrawETH(i2.address)).to.be.revertedWithCustomError(r, "OnlyAdmin");
      await expect(r.connect(i2).withdrawETHAmount(i2.address, 1n)).to.be.revertedWithCustomError(r, "OnlyAdmin");
      await expect(r.connect(i2).withdrawUSDT(i2.address)).to.be.revertedWithCustomError(r, "OnlyAdmin");
      await expect(r.connect(i2).withdrawWBTC(i2.address)).to.be.revertedWithCustomError(r, "OnlyAdmin");
    });
  });

  // ── P4 ───────────────────────────────────────────────────────────────────────
  describe("P4 underfunded refunds and third-party claims", function () {
    it("two refunded investors but funds for one: the second refundInvestor reverts RefundUnderfunded, then works once funded", async function () {
      const { r, admin, i1, i2, usdc } = await setup();
      await r.connect(i1).investWithUSDC(U6(10_000));
      await r.connect(i2).investWithUSDC(U6(10_000));
      await r.connect(admin).withdrawUSDC(admin.address);          // the raise leaves: 0 held
      await usdc.connect(admin).transfer(r.target, U6(10_000));    // return only one investor's worth

      await r.connect(admin).refundInvestor(i1.address);           // 10k owed, 10k held: fine
      await expect(r.connect(admin).refundInvestor(i2.address))
        .to.be.revertedWithCustomError(r, "RefundUnderfunded").withArgs(usdc.target, U6(20_000), U6(10_000));
      // the failed refund changed nothing: i2 is still an investor with their payment on the books
      expect(await r.refundOwed(i2.address, usdc.target)).to.equal(0n);
      expect(await r.paidOnChain(i2.address, usdc.target)).to.equal(U6(10_000));
      expect((await r.investors(i2.address)).srxAllocation).to.equal(srxFor(10_000));
      expect(await r.totalRefundOwed(usdc.target)).to.equal(U6(10_000));

      // control: return the second investor's money and the refund goes through
      await usdc.connect(admin).transfer(r.target, U6(10_000));
      await r.connect(admin).refundInvestor(i2.address);
      expect(await r.totalRefundOwed(usdc.target)).to.equal(U6(20_000));
      await expect(r.connect(i1).claimRefund(usdc.target)).to.changeTokenBalance(usdc, i1, U6(10_000));
      await expect(r.connect(i2).claimRefund(usdc.target)).to.changeTokenBalance(usdc, i2, U6(10_000));
    });

    it("a third party calling claimRefund gets nothing and moves nothing; the owner still claims", async function () {
      const { r, admin, i1, other, usdc } = await setup();
      await r.connect(i1).invest({ value: E(1) });
      await r.connect(i1).investWithUSDC(U6(10_000));
      await r.connect(admin).refundInvestor(i1.address);

      for (const asset of [ZERO, usdc.target]) {
        await expect(r.connect(other).claimRefund(asset)).to.be.revertedWithCustomError(r, "ZeroAmount");
      }
      await expect(r.connect(admin).claimRefund(ZERO)).to.be.revertedWithCustomError(r, "ZeroAmount");
      expect(await ethers.provider.getBalance(r.target)).to.equal(E(1));
      expect(await usdc.balanceOf(r.target)).to.equal(U6(10_000));
      expect(await r.refundOwed(i1.address, ZERO)).to.equal(E(1));
      expect(await r.refundOwed(i1.address, usdc.target)).to.equal(U6(10_000));

      // control: the payer claims, and is paid to their own address
      await expect(r.connect(i1).claimRefund(ZERO)).to.changeEtherBalances([r, i1, other], [-E(1), E(1), 0n]);
      await expect(r.connect(i1).claimRefund(usdc.target)).to.changeTokenBalances(usdc, [r, i1, other], [-U6(10_000), U6(10_000), 0n]);
    });

    it("refundInvestor is admin-only and refuses a buyer with no on-chain payment (NoAllocation)", async function () {
      const { r, admin, i1, i2, other } = await setup();
      await r.connect(i1).invest({ value: E(1) });
      await r.connect(admin).addInvestor(i2.address, usd(1_000));  // off-chain only
      await expect(r.connect(other).refundInvestor(i1.address)).to.be.revertedWithCustomError(r, "OnlyAdmin");
      await expect(r.connect(admin).refundInvestor(i2.address)).to.be.revertedWithCustomError(r, "NoAllocation");
      await expect(r.connect(admin).refundInvestor(other.address)).to.be.revertedWithCustomError(r, "NoAllocation");
      await r.connect(admin).refundInvestor(i1.address); // control
    });
  });

  // ── P5 ───────────────────────────────────────────────────────────────────────
  describe("P5 purchases after finalize()", function () {
    it("investWithUSDT and investWithWBTC revert RoundFinalized once finalized; both worked before (control)", async function () {
      const { r, admin, i1, i2, usdt, wbtc } = await setup();
      await r.connect(i1).investWithUSDT(U6(5_000));
      await r.connect(i1).investWithWBTC(10n ** 7n);
      const before = await r.totalAllocated();

      await expect(r.connect(i1).finalize()).to.be.revertedWithCustomError(r, "OnlyAdmin");
      await expect(r.connect(admin).finalize()).to.emit(r, "Finalized");

      await expect(r.connect(i2).investWithUSDT(U6(5_000))).to.be.revertedWithCustomError(r, "RoundFinalized");
      await expect(r.connect(i2).investWithWBTC(10n ** 7n)).to.be.revertedWithCustomError(r, "RoundFinalized");
      // an existing investor is refused too
      await expect(r.connect(i1).investWithUSDT(U6(1_000))).to.be.revertedWithCustomError(r, "RoundFinalized");
      await expect(r.connect(i1).investWithWBTC(10n ** 6n)).to.be.revertedWithCustomError(r, "RoundFinalized");
      expect(await r.totalAllocated()).to.equal(before);
      expect(await usdt.balanceOf(r.target)).to.equal(U6(5_000));
      expect(await wbtc.balanceOf(r.target)).to.equal(10n ** 7n);
      await expect(r.connect(admin).finalize()).to.be.revertedWithCustomError(r, "RoundFinalized");
    });
  });

  // ── P6 ───────────────────────────────────────────────────────────────────────
  describe("P6 setHardCap", function () {
    it("a cap below totalAllocated reverts CapBelowAllocated; exactly totalAllocated is accepted (control)", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      const total = await r.totalAllocated();
      expect(total).to.equal(srxFor(10_000));

      await expect(r.connect(admin).setHardCap(total - 1n)).to.be.revertedWithCustomError(r, "CapBelowAllocated");
      await expect(r.connect(i1).setHardCap(total)).to.be.revertedWithCustomError(r, "OnlyAdmin");
      expect(await r.hardCapSRX()).to.equal(CAP);

      await expect(r.connect(admin).setHardCap(total)).to.emit(r, "HardCapUpdated").withArgs(total);
      expect(await r.hardCapSRX()).to.equal(total);
      expect(await r.remainingCap()).to.equal(0n);
      // the lowered cap is enforced
      await expect(r.connect(admin).addInvestor(i1.address, usd(1))).to.be.revertedWithCustomError(r, "HardCapExceeded");
    });

    it("zero reverts: ZeroAmount on an empty round, CapBelowAllocated once anything is allocated (the below-allocated check runs first)", async function () {
      const { r, admin, i1 } = await setup();
      await expect(r.connect(admin).setHardCap(0n)).to.be.revertedWithCustomError(r, "ZeroAmount");
      await r.connect(admin).setHardCap(1n); // control: any non-zero cap is fine on an empty round
      await r.connect(admin).setHardCap(CAP);

      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await expect(r.connect(admin).setHardCap(0n)).to.be.revertedWithCustomError(r, "CapBelowAllocated");
      expect(await r.hardCapSRX()).to.equal(CAP);
    });
  });

  // ── P7 ───────────────────────────────────────────────────────────────────────
  describe("P7 vault deployment without enough SRX in the round", function () {
    it("deployVault reverts InsufficientSRX and records no vault; works once funded (control)", async function () {
      const { r, admin, i1, token } = await setup({ funded: E(1_000_000) });
      await r.connect(admin).addInvestor(i1.address, usd(10_000));    // 1.2M SRX owed, 1M held
      await expect(r.connect(admin).deployVault(i1.address)).to.be.revertedWithCustomError(r, "InsufficientSRX");
      expect(await r.getVault(i1.address)).to.equal(ZERO);
      expect((await r.investors(i1.address)).vault).to.equal(ZERO);
      expect(await token.balanceOf(r.target)).to.equal(E(1_000_000));

      await token.connect(admin).transfer(r.target, E(200_000));
      await r.connect(admin).deployVault(i1.address);
      expect(await r.getVault(i1.address)).to.not.equal(ZERO);
    });

    it("batchDeployVaults reverts InsufficientSRX as a whole: the investor it could afford gets no vault either", async function () {
      // 1.2M each; the round holds enough for the first but not the second
      const { r, admin, i1, i2, token } = await setup({ funded: E(2_000_000) });
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await r.connect(admin).addInvestor(i2.address, usd(10_000));
      await expect(r.connect(admin).batchDeployVaults(0, 2)).to.be.revertedWithCustomError(r, "InsufficientSRX");
      expect(await r.getVault(i1.address)).to.equal(ZERO);
      expect(await r.getVault(i2.address)).to.equal(ZERO);
      expect(await r.getAllVaults()).to.deep.equal([ZERO, ZERO]);
      expect(await token.balanceOf(r.target)).to.equal(E(2_000_000));
      expect(await r.pendingDeployment()).to.equal(E(2_400_000));

      // control: topped up, the same batch deploys both
      await token.connect(admin).transfer(r.target, E(400_000));
      await r.connect(admin).batchDeployVaults(0, 2);
      const vaults = await r.getAllVaults();
      expect(vaults.every((v) => v !== ZERO)).to.equal(true);
      expect(await r.pendingDeployment()).to.equal(0n);
      expect(await token.balanceOf(vaults[0])).to.equal(E(1_200_000));
      expect(await token.balanceOf(vaults[1])).to.equal(E(1_200_000));
    });
  });

  // ── P8 ───────────────────────────────────────────────────────────────────────
  describe("P8 revokeVault", function () {
    async function withVault() {
      const s = await setup();
      await s.r.connect(s.admin).addInvestor(s.i1.address, usd(10_000));
      await s.r.connect(s.admin).addInvestor(s.i2.address, usd(10_000)); // allocation, but no vault
      await s.r.connect(s.admin).deployVault(s.i1.address);
      const vault = await ethers.getContractAt("VestingVault", await s.r.getVault(s.i1.address));
      return { ...s, vault };
    }

    it("pays the vested part to the buyer and the unvested part to the recipient, summing to the allocation", async function () {
      const { r, admin, i1, recipient, token, vault } = await withVault();
      const alloc = srxFor(10_000);
      await r.connect(admin).batchTriggerTGE(0, 2);
      const tge = await vault.tgeTimestamp();
      const cliff = await r.CLIFF_DURATION();
      const dur = await r.VESTING_DURATION();
      const at = tge + cliff + 100n * 86400n; // exactly 100 days of linear vesting
      await time.setNextBlockTimestamp(at);

      await r.connect(admin).revokeVault(i1.address);
      const vested = (alloc * (100n * 86400n)) / dur;
      expect(await token.balanceOf(i1.address)).to.equal(vested);
      expect(await token.balanceOf(recipient.address)).to.equal(alloc - vested);
      expect(await token.balanceOf(vault.target)).to.equal(0n);
      expect(await vault.revoked()).to.equal(true);
      await expect(r.connect(admin).revokeVault(i1.address))
        .to.be.revertedWithCustomError(vault, "AlreadyRevoked");
    });

    it("is admin-only", async function () {
      const { r, i1, other, recipient } = await withVault();
      await expect(r.connect(other).revokeVault(i1.address)).to.be.revertedWithCustomError(r, "OnlyAdmin");
      await expect(r.connect(i1).revokeVault(i1.address)).to.be.revertedWithCustomError(r, "OnlyAdmin");
    });

    it("an investor with no vault (or no allocation at all) reverts NoAllocation", async function () {
      const { r, admin, i2, other, recipient } = await withVault();
      await expect(r.connect(admin).revokeVault(i2.address)).to.be.revertedWithCustomError(r, "NoAllocation");
      await expect(r.connect(admin).revokeVault(other.address)).to.be.revertedWithCustomError(r, "NoAllocation");
    });

    it("before TGE the vault itself refuses (TGENotTriggered); the recipient is fixed at deployment, so there is none to name or to zero (internal audit M2)", async function () {
      const { r, admin, i1, recipient, vault } = await withVault();
      // revokeVault takes the investor only: no destination can be chosen at revoke time
      expect(r.interface.getFunction("revokeVault").inputs.length).to.equal(1);
      expect(await r.vaultRevokeRecipient()).to.equal(recipient.address);
      expect(await vault.revokeRecipient()).to.equal(recipient.address);
      await expect(r.connect(admin).revokeVault(i1.address))
        .to.be.revertedWithCustomError(vault, "TGENotTriggered");
      await r.connect(admin).batchTriggerTGE(0, 2);
      await r.connect(admin).revokeVault(i1.address); // control
    });

    it("the round refuses a zero or self vaultRevokeRecipient at deployment, and a vault can never be revoked to its buyer (internal audit M2)", async function () {
      const { token, admin, i1, ethFeed, btcFeed, usdc, usdt, wbtc, R } = await setup();
      const deploy = (recipient) => R.deploy(
        token.target, usdc.target, usdt.target, wbtc.target, ethFeed.target, btcFeed.target,
        admin.address, CAP, PRICE, true, FLAT_BPS, recipient,
      );
      await expect(deploy(ZERO)).to.be.revertedWithCustomError(R, "ZeroAddress");
      const self = ethers.getCreateAddress({ from: admin.address, nonce: await ethers.provider.getTransactionCount(admin.address) });
      await expect(deploy(self)).to.be.revertedWithCustomError(R, "ZeroAddress");

      // A round whose recipient IS a buyer cannot create that buyer's vault: the vault refuses
      // the beneficiary as revoke recipient, so a vested grant can never be accelerated by revoking to its owner.
      const r2 = await deploy(i1.address);
      await approveBuyers(r2, admin, [i1]);
      await token.connect(admin).transfer(r2.target, CAP);
      await r2.connect(admin).addInvestor(i1.address, usd(10_000));
      await expect(r2.connect(admin).deployVault(i1.address))
        .to.be.revertedWithCustomError(await ethers.getContractFactory("VestingVault"), "InvalidRevokeRecipient");
    });
  });

  // ── P9 ───────────────────────────────────────────────────────────────────────
  describe("P9 recoverSRX", function () {
    it("moves only the SRX above what investors without a vault are owed (internal audit L6; was SC-TRUST-004)", async function () {
      // ⛔ This used to move the WHOLE balance, owed SRX included, as a documented trust
      //    assumption. Internal audit L6 (16 Oct 2026) ring-fenced it like the withdraw* twins.
      const { r, admin, i1, i2, token, recipient } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await r.connect(admin).addInvestor(i2.address, usd(20_000));
      expect(await r.pendingDeployment()).to.equal(srxFor(30_000)); // owed, but not yet in a vault

      await expect(r.connect(admin).recoverSRX(recipient.address))
        .to.changeTokenBalances(token, [r, recipient], [-(CAP - srxFor(30_000)), CAP - srxFor(30_000)]);
      expect(await token.balanceOf(r.target)).to.equal(srxFor(30_000));
      await r.connect(admin).deployVault(i1.address);               // still fundable
      await expect(r.connect(admin).recoverSRX(recipient.address)).to.be.revertedWithCustomError(r, "ZeroAmount");
    });

    it("with a vault already funded, only the round's remaining SRX moves; the vault's grant is untouched", async function () {
      const { r, admin, i1, token, recipient } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await r.connect(admin).deployVault(i1.address);
      const vault = await r.getVault(i1.address);
      await expect(r.connect(admin).recoverSRX(recipient.address))
        .to.changeTokenBalances(token, [r, recipient], [-(CAP - srxFor(10_000)), CAP - srxFor(10_000)]);
      expect(await token.balanceOf(vault)).to.equal(srxFor(10_000));
    });

    it("is admin-only and refuses the zero address", async function () {
      const { r, admin, i1, other, recipient } = await setup();
      await expect(r.connect(other).recoverSRX(other.address)).to.be.revertedWithCustomError(r, "OnlyAdmin");
      await expect(r.connect(i1).recoverSRX(i1.address)).to.be.revertedWithCustomError(r, "OnlyAdmin");
      await expect(r.connect(admin).recoverSRX(ZERO)).to.be.revertedWithCustomError(r, "ZeroAddress");
      await r.connect(admin).recoverSRX(recipient.address); // control
    });
  });

  // ── P10 ──────────────────────────────────────────────────────────────────────
  describe("P10 payment-token decimals", function () {
    it("a payment token with 19 decimals reverts UnsupportedDecimals in each slot; 18 is accepted (control)", async function () {
      const { token, admin, ethFeed, btcFeed, usdc, usdt, wbtc, recipient, M, R } = await setup();
      const bad = await M.deploy("Bad", "BAD", 19);
      const ok18 = await M.deploy("Ok", "OK18", 18);
      const deploy = (u, t, w) => R.deploy(
        token.target, u, t, w, ethFeed.target, btcFeed.target, admin.address, CAP, PRICE, true, FLAT_BPS, recipient.address,
      );
      await expect(deploy(bad.target, usdt.target, wbtc.target))
        .to.be.revertedWithCustomError(R, "UnsupportedDecimals").withArgs(bad.target, 19);
      await expect(deploy(usdc.target, bad.target, wbtc.target))
        .to.be.revertedWithCustomError(R, "UnsupportedDecimals").withArgs(bad.target, 19);
      await expect(deploy(usdc.target, usdt.target, bad.target))
        .to.be.revertedWithCustomError(R, "UnsupportedDecimals").withArgs(bad.target, 19);

      const r = await deploy(ok18.target, usdt.target, wbtc.target);
      expect(await r.usdcDecimals()).to.equal(18n);
    });
  });

  // ── P11 ──────────────────────────────────────────────────────────────────────
  describe("P11 addInvestor on a buyer who already paid on-chain", function () {
    it("raises the allocation within the approval cap and is refused above it; the on-chain record is untouched", async function () {
      const { r, admin, i1, usdc } = await setup();
      await r.connect(admin).setBuyerApprovals([i1.address], [usd(20_000)], [refFor(i1.address)]);
      await r.connect(i1).investWithUSDC(U6(10_000));
      expect((await r.investors(i1.address)).srxAllocation).to.equal(srxFor(10_000));

      // control for the sibling guards: removeInvestor and updateAllocation DO refuse an on-chain payer
      await expect(r.connect(admin).removeInvestor(i1.address)).to.be.revertedWithCustomError(r, "HasOnChainPayment");
      await expect(r.connect(admin).updateAllocation(i1.address, E(1))).to.be.revertedWithCustomError(r, "HasOnChainPayment");

      // R7-13: an on-chain payer who also pays by wire is topped up through addInvestor, within the
      // approval cap. The header used to say their allocation could not change "any other way" than
      // refundInvestor; it now says it cannot be set or reduced, which is what the guards enforce.
      await r.connect(admin).addInvestor(i1.address, usd(5_000));
      const inv = await r.investors(i1.address);
      expect(inv.srxAllocation).to.equal(srxFor(15_000));
      expect(inv.cumulativeUsd8Dec).to.equal(usd(15_000));
      expect(inv.offChain).to.equal(false);                       // still flagged as an on-chain buyer
      expect(await r.totalAllocated()).to.equal(srxFor(15_000));
      expect(await r.paidOnChain(i1.address, usdc.target)).to.equal(U6(10_000)); // money in is unchanged
      expect(await usdc.balanceOf(r.target)).to.equal(U6(10_000));

      // the approval cap is the only bound
      await r.connect(admin).addInvestor(i1.address, usd(5_000)); // exactly the cap
      await expect(r.connect(admin).addInvestor(i1.address, usd(1)))
        .to.be.revertedWithCustomError(r, "NotApproved").withArgs(i1.address, usd(20_000) + usd(1), usd(20_000));
    });

    it("a later refundInvestor removes the whole allocation but returns only what was paid on-chain", async function () {
      const { r, admin, i1, usdc } = await setup();
      await r.connect(i1).investWithUSDC(U6(10_000));
      await r.connect(admin).addInvestor(i1.address, usd(5_000));
      expect(await r.totalAllocated()).to.equal(srxFor(15_000));

      await r.connect(admin).refundInvestor(i1.address);
      expect(await r.totalAllocated()).to.equal(0n);
      expect((await r.investors(i1.address)).srxAllocation).to.equal(0n);
      expect(await r.refundOwed(i1.address, usdc.target)).to.equal(U6(10_000)); // not 15,000
      await expect(r.connect(i1).claimRefund(usdc.target)).to.changeTokenBalance(usdc, i1, U6(10_000));
    });
  });
});
