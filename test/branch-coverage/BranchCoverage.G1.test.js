// Branch-coverage tests, group G1: PreSaleRound, VestingVault, TGEDistributor, SRXAirdrop.
//
// Every test drives one specific branch AND asserts the behaviour it encodes (the exact
// custom error, the state change, the event). The branch each test targets is named in
// its title or in the comment above it.
//
// Branches that cannot be reached through the public interface are listed at the bottom
// of this file with the reason, instead of a test that would only execute a line.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { approveBuyers, refFor } = require("../helpers/buyers");

const ZERO = ethers.ZeroAddress;
const E = (n) => ethers.parseUnits(String(n), 18);
const U6 = (n) => BigInt(n) * 10n ** 6n;
const usd = (d) => BigInt(d) * 10n ** 8n;
const DAY = 24 * 60 * 60;

// ════════════════════════════════════════════════════════════════════════════
// PreSaleRound
// ════════════════════════════════════════════════════════════════════════════
describe("BranchCoverage G1 — PreSaleRound", function () {
  const PRICE = 1_250_000n;                       // $0.0125 per SRX
  const CAP = ethers.parseUnits("300000000", 18); // 300M SRX
  const ETH_PRICE = 2_500n * 10n ** 8n;
  const BTC_PRICE = 60_000n * 10n ** 8n;
  // Ladder mode, Entry tier (+10%): $1 buys 80 SRX base + 10% = 88 SRX
  const srxFor = (dollars) => E(88) * BigInt(dollars);

  /**
   * One fresh round per test. SRX is a plain 18-decimal mock so vault funding is unconstrained.
   *   disable : list of "usdc" | "usdt" | "wbtc" | "eth" | "btc" to pass address(0) for
   *   token   : { usdc, usdt, wbtc } overrides (e.g. a fee-on-transfer token)
   */
  async function setup({ price = PRICE, cap = CAP, fund = cap, flat = false, flatBps = 0n,
                         disable = [], token = {} } = {}) {
    const [admin, i1, i2, i3, other, recipient] = await ethers.getSigners();
    const M = await ethers.getContractFactory("MockERC20");
    const srx = await M.deploy("SRX", "SRX", 18);
    const usdc = token.usdc ?? await M.deploy("USD Coin", "USDC", 6);
    const usdt = token.usdt ?? await M.deploy("Tether USD", "USDT", 6);
    const wbtc = token.wbtc ?? await M.deploy("Wrapped BTC", "WBTC", 8);
    const F = await ethers.getContractFactory("MockChainlinkFeed");
    const ethFeed = await F.deploy(ETH_PRICE);
    const btcFeed = await F.deploy(BTC_PRICE);
    const off = (k) => disable.includes(k);
    const R = await ethers.getContractFactory("PreSaleRound");
    const r = await R.deploy(
      srx.target,
      off("usdc") ? ZERO : usdc.target,
      off("usdt") ? ZERO : usdt.target,
      off("wbtc") ? ZERO : wbtc.target,
      off("eth") ? ZERO : ethFeed.target,
      off("btc") ? ZERO : btcFeed.target,
      admin.address, cap, price, flat, flatBps, recipient.address,
    );
    if (fund > 0n) await srx.mint(r.target, fund);
    await approveBuyers(r, admin, [i1, i2, i3]);
    for (const w of [i1, i2, i3]) {
      for (const t of [usdc, usdt, wbtc]) {
        await t.mint(w.address, t === wbtc ? 100n * 10n ** 8n : U6(10_000_000));
        await t.connect(w).approve(r.target, ethers.MaxUint256);
      }
    }
    return { r, srx, usdc, usdt, wbtc, ethFeed, btcFeed, admin, i1, i2, i3, other, recipient, M, F, R };
  }

  // The 12 constructor arguments, overridable by name.
  async function ctorArgs(s, over = {}) {
    const base = {
      srx: s.srx.target, usdc: s.usdc.target, usdt: s.usdt.target, wbtc: s.wbtc.target,
      ethFeed: s.ethFeed.target, btcFeed: s.btcFeed.target, admin: s.admin.address,
      cap: CAP, price: PRICE, flat: false, flatBps: 0n, recipient: s.recipient.address,
    };
    return Object.values({ ...base, ...over });
  }

  // ── Constructor ────────────────────────────────────────────────────────────
  describe("constructor", function () {
    it("a zero admin reverts ZeroAddress (line 411)", async function () {
      const s = await setup();
      await expect(s.R.deploy(...await ctorArgs(s, { admin: ZERO })))
        .to.be.revertedWithCustomError(s.r, "ZeroAddress");
    });

    it("a zero SRX token reverts ZeroAddress (line 410)", async function () {
      const s = await setup();
      await expect(s.R.deploy(...await ctorArgs(s, { srx: ZERO })))
        .to.be.revertedWithCustomError(s.r, "ZeroAddress");
    });

    it("a zero revoke recipient reverts ZeroAddress (line 412, first operand)", async function () {
      const s = await setup();
      await expect(s.R.deploy(...await ctorArgs(s, { recipient: ZERO })))
        .to.be.revertedWithCustomError(s.r, "ZeroAddress");
    });

    it("a revoke recipient equal to the round's own future address reverts ZeroAddress (line 412, second operand)", async function () {
      const s = await setup();
      const nonce = await ethers.provider.getTransactionCount(s.admin.address);
      const future = ethers.getCreateAddress({ from: s.admin.address, nonce });
      await expect(s.R.deploy(...await ctorArgs(s, { recipient: future })))
        .to.be.revertedWithCustomError(s.r, "ZeroAddress");
    });

    it("a zero hard cap reverts ZeroAmount (line 413)", async function () {
      const s = await setup();
      await expect(s.R.deploy(...await ctorArgs(s, { cap: 0n })))
        .to.be.revertedWithCustomError(s.r, "ZeroAmount");
    });

    it("a zero price reverts ZeroAmount (line 414)", async function () {
      const s = await setup();
      await expect(s.R.deploy(...await ctorArgs(s, { price: 0n })))
        .to.be.revertedWithCustomError(s.r, "ZeroAmount");
    });

    it("a flat bonus above the ceiling, and a rate given in ladder mode, both revert InvalidFlatBonus (line 415 both arms)", async function () {
      const s = await setup();
      await expect(s.R.deploy(...await ctorArgs(s, { flat: true, flatBps: 10_001n })))
        .to.be.revertedWithCustomError(s.r, "InvalidFlatBonus");
      await expect(s.R.deploy(...await ctorArgs(s, { flat: false, flatBps: 1n })))
        .to.be.revertedWithCustomError(s.r, "InvalidFlatBonus");
      // control: the ceiling itself is accepted
      const ok = await s.R.deploy(...await ctorArgs(s, { flat: true, flatBps: 10_000n }));
      expect(await ok.flatBonusBps()).to.equal(10_000n);
    });
  });

  // ── Off-chain investor admin: updateAllocation ─────────────────────────────
  describe("updateAllocation", function () {
    it("success path: an off-chain allocation is replaced, USD is back-calculated, totals move, event emitted (line 502 else x2)", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));          // 880,000 SRX
      expect((await r.investors(i1.address)).srxAllocation).to.equal(srxFor(10_000));

      await expect(r.connect(admin).updateAllocation(i1.address, srxFor(5_000)))
        .to.emit(r, "AllocationUpdated").withArgs(i1.address, srxFor(10_000), srxFor(5_000));

      const inv = await r.investors(i1.address);
      expect(inv.srxAllocation).to.equal(srxFor(5_000));
      expect(inv.cumulativeUsd8Dec).to.equal(usd(5_000));   // exact inverse of the Entry-tier map
      expect(await r.totalAllocated()).to.equal(srxFor(5_000));
    });

    it("a non-admin is refused OnlyAdmin and a finalized round RoundFinalized (the two modifiers)", async function () {
      const { r, admin, i1, other } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await expect(r.connect(other).updateAllocation(i1.address, srxFor(1)))
        .to.be.revertedWithCustomError(r, "OnlyAdmin");
      await r.connect(admin).finalize();
      await expect(r.connect(admin).updateAllocation(i1.address, srxFor(1)))
        .to.be.revertedWithCustomError(r, "RoundFinalized");
    });

    it("an investor whose vault is deployed cannot be changed: VaultAlreadyDeployed (line 505)", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await r.connect(admin).deployVault(i1.address);
      await expect(r.connect(admin).updateAllocation(i1.address, srxFor(1)))
        .to.be.revertedWithCustomError(r, "VaultAlreadyDeployed");
      expect((await r.investors(i1.address)).srxAllocation).to.equal(srxFor(10_000));
    });

    it("setting the allocation to zero reverts ZeroAmount (line 506) — removal is a different function", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await expect(r.connect(admin).updateAllocation(i1.address, 0n))
        .to.be.revertedWithCustomError(r, "ZeroAmount");
      expect(await r.totalAllocated()).to.equal(srxFor(10_000));
    });

    it("an allocation that would take the round over its hard cap reverts HardCapExceeded (line 513)", async function () {
      const { r, admin, i1 } = await setup({ cap: srxFor(20_000), fund: srxFor(20_000) });
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await expect(r.connect(admin).updateAllocation(i1.address, srxFor(20_000) + 1n))
        .to.be.revertedWithCustomError(r, "HardCapExceeded");
      // control: exactly the cap is fine
      await r.connect(admin).updateAllocation(i1.address, srxFor(20_000));
      expect(await r.totalAllocated()).to.equal(srxFor(20_000));
    });

    it("an allocation implying more USD than the buyer's approval cap reverts NotApproved", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).setBuyerApprovals([i1.address], [usd(10_000)], [refFor(i1.address)]);
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await expect(r.connect(admin).updateAllocation(i1.address, srxFor(12_000)))
        .to.be.revertedWithCustomError(r, "NotApproved").withArgs(i1.address, usd(12_000), usd(10_000));
    });
  });

  // ── removeInvestor / refundInvestor ────────────────────────────────────────
  describe("removeInvestor and refundInvestor", function () {
    it("removing the middle investor swaps the last into its slot (line 591 else, then match); approvals are cleared and totals drop", async function () {
      const { r, admin, i1, i2, i3 } = await setup();
      for (const w of [i1, i2, i3]) await r.connect(admin).addInvestor(w.address, usd(10_000));
      expect(await r.getInvestorList()).to.deep.equal([i1.address, i2.address, i3.address]);

      await expect(r.connect(admin).removeInvestor(i2.address))
        .to.emit(r, "InvestorRemoved").withArgs(i2.address)
        .and.to.emit(r, "BuyerApprovalSet").withArgs(i2.address, 0, ethers.ZeroHash);

      // i1 did not match (else branch of the loop test), i2 did, i3 was swapped in
      expect(await r.getInvestorList()).to.deep.equal([i1.address, i3.address]);
      expect(await r.totalAllocated()).to.equal(srxFor(20_000));
      expect((await r.buyerApprovals(i2.address)).capUsd8Dec).to.equal(0n);
      expect((await r.investors(i2.address)).srxAllocation).to.equal(0n);
    });

    it("removing the last investor walks past the earlier entries and pops itself", async function () {
      const { r, admin, i1, i2, i3 } = await setup();
      for (const w of [i1, i2, i3]) await r.connect(admin).addInvestor(w.address, usd(10_000));
      await r.connect(admin).removeInvestor(i3.address);
      expect(await r.getInvestorList()).to.deep.equal([i1.address, i2.address]);
    });

    it("removeInvestor: only admin, only before finalize, and a stranger with no allocation is NoAllocation (line 537 + 579)", async function () {
      const { r, admin, i1, other } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await expect(r.connect(other).removeInvestor(i1.address)).to.be.revertedWithCustomError(r, "OnlyAdmin");
      await expect(r.connect(admin).removeInvestor(other.address)).to.be.revertedWithCustomError(r, "NoAllocation");
      await r.connect(admin).finalize();
      await expect(r.connect(admin).removeInvestor(i1.address)).to.be.revertedWithCustomError(r, "RoundFinalized");
    });

    it("an investor with a deployed vault cannot be removed: VaultAlreadyDeployed (line 580)", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await r.connect(admin).deployVault(i1.address);
      await expect(r.connect(admin).removeInvestor(i1.address))
        .to.be.revertedWithCustomError(r, "VaultAlreadyDeployed");
      expect(await r.investorCount()).to.equal(1n);
    });

    // _hasOnChainPayment is an OR over four assets; each test makes a different operand the deciding one
    const assets = [
      ["ETH (first operand)", async (s) => s.r.connect(s.i1).invest({ value: E(1) }), () => ZERO],
      ["USDC (second operand)", async (s) => s.r.connect(s.i1).investWithUSDC(U6(10_000)), (s) => s.usdc.target],
      ["USDT (third operand)", async (s) => s.r.connect(s.i1).investWithUSDT(U6(10_000)), (s) => s.usdt.target],
      ["WBTC (fourth operand)", async (s) => s.r.connect(s.i1).investWithWBTC(10n ** 7n), (s) => s.wbtc.target],
    ];
    for (const [label, pay, assetOf] of assets) {
      it(`${label}: an on-chain payer is HasOnChainPayment for remove and update, and refundInvestor owes exactly what was paid (line 619)`, async function () {
        const s = await setup();
        await pay(s);
        const asset = assetOf(s);
        const paid = await s.r.paidOnChain(s.i1.address, asset);
        expect(paid).to.be.gt(0n);

        await expect(s.r.connect(s.admin).removeInvestor(s.i1.address))
          .to.be.revertedWithCustomError(s.r, "HasOnChainPayment").withArgs(s.i1.address);
        await expect(s.r.connect(s.admin).updateAllocation(s.i1.address, srxFor(1)))
          .to.be.revertedWithCustomError(s.r, "HasOnChainPayment").withArgs(s.i1.address);

        // refundInvestor success path (line 552 else)
        await expect(s.r.connect(s.admin).refundInvestor(s.i1.address))
          .to.emit(s.r, "RefundOwed").withArgs(s.i1.address, asset, paid);
        expect(await s.r.refundOwed(s.i1.address, asset)).to.equal(paid);
        expect(await s.r.totalRefundOwed(asset)).to.equal(paid);
        expect(await s.r.paidOnChain(s.i1.address, asset)).to.equal(0n);
        expect(await s.r.investorCount()).to.equal(0n);
        expect(await s.r.totalAllocated()).to.equal(0n);

        // the payer gets it back, once
        if (asset === ZERO) {
          await expect(s.r.connect(s.i1).claimRefund(asset)).to.changeEtherBalances([s.r, s.i1], [-paid, paid]);
        } else {
          const t = await ethers.getContractAt("MockERC20", asset);
          await expect(s.r.connect(s.i1).claimRefund(asset)).to.changeTokenBalances(t, [s.r, s.i1], [-paid, paid]);
        }
        await expect(s.r.connect(s.i1).claimRefund(asset)).to.be.revertedWithCustomError(s.r, "ZeroAmount");
      });
    }

    it("a round with no on-chain payment at all: removeInvestor takes the all-false path through the OR chain and succeeds", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await r.connect(admin).removeInvestor(i1.address);
      expect(await r.investorCount()).to.equal(0n);
    });

    it("refundInvestor for someone who paid nothing on chain reverts NoAllocation; non-admin is refused", async function () {
      const { r, admin, i1, other } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await expect(r.connect(admin).refundInvestor(i1.address)).to.be.revertedWithCustomError(r, "NoAllocation");
      await expect(r.connect(other).refundInvestor(i1.address)).to.be.revertedWithCustomError(r, "OnlyAdmin");
    });
  });

  // ── Payment paths ──────────────────────────────────────────────────────────
  describe("invest (ETH)", function () {
    it("success path credits SRX at the oracle price and the Entry bonus (line 660 else)", async function () {
      const { r, i1 } = await setup();
      await expect(r.connect(i1).invest({ value: E(1) }))
        .to.emit(r, "PaymentReceived").withArgs(i1.address, ZERO, E(1), usd(2_500));
      expect((await r.investors(i1.address)).srxAllocation).to.equal(srxFor(2_500));
    });

    it("a finalized round reverts RoundFinalized and a paused round PurchasesPaused; unpausing restores it", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).setPaused(true);
      await expect(r.connect(i1).invest({ value: E(1) })).to.be.revertedWithCustomError(r, "PurchasesPaused");
      await r.connect(admin).setPaused(false);
      await r.connect(i1).invest({ value: E(1) });
      await r.connect(admin).finalize();
      await expect(r.connect(i1).invest({ value: E(1) })).to.be.revertedWithCustomError(r, "RoundFinalized");
    });

    it("a wei amount that converts to $0 reverts ZeroAmount and records nothing (line 666)", async function () {
      const { r, i1 } = await setup();
      await expect(r.connect(i1).invest({ value: 1n })).to.be.revertedWithCustomError(r, "ZeroAmount");
      expect(await r.paidOnChain(i1.address, ZERO)).to.equal(0n);
      expect(await r.investorCount()).to.equal(0n);
    });

    it("with no ETH feed the path is CurrencyDisabled, and zero value is ZeroAmount", async function () {
      const off = await setup({ disable: ["eth"] });
      await expect(off.r.connect(off.i1).invest({ value: E(1) })).to.be.revertedWithCustomError(off.r, "CurrencyDisabled");
      const s = await setup();
      await expect(s.r.connect(s.i1).invest({ value: 0n })).to.be.revertedWithCustomError(s.r, "ZeroAmount");
    });

    it("a buyer whose vault exists cannot top up: VaultAlreadyDeployed", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await r.connect(admin).deployVault(i1.address);
      await expect(r.connect(i1).invest({ value: E(1) })).to.be.revertedWithCustomError(r, "VaultAlreadyDeployed");
    });
  });

  describe("investWithUSDC / investWithUSDT", function () {
    it("USDC success path credits $1 per token at the Entry bonus (line 681 else)", async function () {
      const { r, i1 } = await setup();
      await expect(r.connect(i1).investWithUSDC(U6(10_000)))
        .to.emit(r, "PaymentReceived");
      expect((await r.investors(i1.address)).srxAllocation).to.equal(srxFor(10_000));
    });

    it("USDT success path credits $1 per token at the Entry bonus (line 703 else x2)", async function () {
      const { r, usdt, i1 } = await setup();
      await expect(r.connect(i1).investWithUSDT(U6(10_000)))
        .to.emit(r, "PaymentReceived").withArgs(i1.address, usdt.target, U6(10_000), usd(10_000));
      expect((await r.investors(i1.address)).srxAllocation).to.equal(srxFor(10_000));
    });

    it("both refuse a finalized round and a paused round", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).setPaused(true);
      await expect(r.connect(i1).investWithUSDC(U6(1))).to.be.revertedWithCustomError(r, "PurchasesPaused");
      await expect(r.connect(i1).investWithUSDT(U6(1))).to.be.revertedWithCustomError(r, "PurchasesPaused");
      await r.connect(admin).setPaused(false);
      await r.connect(admin).finalize();
      await expect(r.connect(i1).investWithUSDC(U6(1))).to.be.revertedWithCustomError(r, "RoundFinalized");
      await expect(r.connect(i1).investWithUSDT(U6(1))).to.be.revertedWithCustomError(r, "RoundFinalized");
    });

    it("disabled currency, zero amount and an existing vault each revert with their own error", async function () {
      const off = await setup({ disable: ["usdc", "usdt"] });
      await expect(off.r.connect(off.i1).investWithUSDC(U6(1))).to.be.revertedWithCustomError(off.r, "CurrencyDisabled");
      await expect(off.r.connect(off.i1).investWithUSDT(U6(1))).to.be.revertedWithCustomError(off.r, "CurrencyDisabled");

      const { r, admin, i1 } = await setup();
      await expect(r.connect(i1).investWithUSDC(0n)).to.be.revertedWithCustomError(r, "ZeroAmount");
      await expect(r.connect(i1).investWithUSDT(0n)).to.be.revertedWithCustomError(r, "ZeroAmount");
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await r.connect(admin).deployVault(i1.address);
      await expect(r.connect(i1).investWithUSDC(U6(1))).to.be.revertedWithCustomError(r, "VaultAlreadyDeployed");
      await expect(r.connect(i1).investWithUSDT(U6(1))).to.be.revertedWithCustomError(r, "VaultAlreadyDeployed");
    });

    // A token that takes its whole transfer as a fee delivers 0: nothing may be credited (line 643)
    for (const [name, fn, key] of [
      ["USDC", "investWithUSDC", "usdc"],
      ["USDT", "investWithUSDT", "usdt"],
      ["WBTC", "investWithWBTC", "wbtc"],
    ]) {
      it(`${name} that delivers nothing after its fee reverts ZeroAmount and records no payment (line 643)`, async function () {
        const F = await ethers.getContractFactory("MockFeeOnTransferERC20");
        const fee = await F.deploy(key === "wbtc" ? 8 : 6, 10_000); // 100% fee
        const s = await setup({ token: { [key]: fee } });
        await fee.mint(s.i1.address, 10n ** 12n);
        await fee.connect(s.i1).approve(s.r.target, ethers.MaxUint256);
        await expect(s.r.connect(s.i1)[fn](10n ** 9n)).to.be.revertedWithCustomError(s.r, "ZeroAmount");
        expect(await s.r.paidOnChain(s.i1.address, fee.target)).to.equal(0n);
        expect(await s.r.investorCount()).to.equal(0n);
      });
    }
  });

  describe("investWithWBTC", function () {
    it("success path: 1 BTC at $60,000 credits $60,000 (line 727 else x2)", async function () {
      const { r, wbtc, i1 } = await setup();
      await expect(r.connect(i1).investWithWBTC(10n ** 8n))
        .to.emit(r, "PaymentReceived").withArgs(i1.address, wbtc.target, 10n ** 8n, usd(60_000));
      expect((await r.investors(i1.address)).srxAllocation).to.equal(srxFor(60_000));
    });

    it("refuses a paused and a finalized round", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).setPaused(true);
      await expect(r.connect(i1).investWithWBTC(1n)).to.be.revertedWithCustomError(r, "PurchasesPaused");
      await r.connect(admin).setPaused(false);
      await r.connect(admin).finalize();
      await expect(r.connect(i1).investWithWBTC(1n)).to.be.revertedWithCustomError(r, "RoundFinalized");
    });

    it("WBTC token set but BTC feed missing is CurrencyDisabled (line 728, second operand)", async function () {
      const s = await setup({ disable: ["btc"] });
      expect(await s.r.wbtc()).to.equal(s.wbtc.target);
      await expect(s.r.connect(s.i1).investWithWBTC(1n)).to.be.revertedWithCustomError(s.r, "CurrencyDisabled");
    });

    it("no WBTC token is CurrencyDisabled (line 728, first operand); zero amount is ZeroAmount", async function () {
      const off = await setup({ disable: ["wbtc"] });
      await expect(off.r.connect(off.i1).investWithWBTC(1n)).to.be.revertedWithCustomError(off.r, "CurrencyDisabled");
      const s = await setup();
      await expect(s.r.connect(s.i1).investWithWBTC(0n)).to.be.revertedWithCustomError(s.r, "ZeroAmount");
    });

    it("an investor whose vault exists cannot top up: VaultAlreadyDeployed (line 730)", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await r.connect(admin).deployVault(i1.address);
      await expect(r.connect(i1).investWithWBTC(1n)).to.be.revertedWithCustomError(r, "VaultAlreadyDeployed");
    });

    it("a deposit that converts to $0 at a very low (but valid) oracle price reverts ZeroAmount and the tokens do not move (line 735)", async function () {
      const { r, wbtc, btcFeed, i1 } = await setup();
      await btcFeed.setPrice(1n); // 1e-8 USD per BTC: 1 satoshi -> 0 in 8-decimal USD
      const before = await wbtc.balanceOf(i1.address);
      await expect(r.connect(i1).investWithWBTC(1n)).to.be.revertedWithCustomError(r, "ZeroAmount");
      expect(await wbtc.balanceOf(i1.address)).to.equal(before);
    });
  });

  describe("_processInvestment", function () {
    it("an amount that buys 0 SRX reverts ZeroAmount instead of creating an empty investor (line 1199)", async function () {
      // A price so high that $0.00000001 rounds to zero SRX
      const { r, admin, i1 } = await setup({ price: 10n ** 30n });
      await expect(r.connect(admin).addInvestor(i1.address, 1n)).to.be.revertedWithCustomError(r, "ZeroAmount");
      expect(await r.investorCount()).to.equal(0n);
      // control: a larger amount is credited
      await r.connect(admin).addInvestor(i1.address, 10n ** 20n);
      expect(await r.investorCount()).to.equal(1n);
    });
  });

  // ── Vault deployment and TGE ───────────────────────────────────────────────
  describe("batchDeployVaults / batchTriggerTGE / rescueVaultSurplus", function () {
    async function threeInvestors() {
      const s = await setup();
      for (const w of [s.i1, s.i2, s.i3]) await s.r.connect(s.admin).addInvestor(w.address, usd(10_000));
      return s;
    }

    it("an end index past the list is clamped and an investor whose vault already exists is skipped (lines 780, 782, 787)", async function () {
      const s = await threeInvestors();
      await s.r.connect(s.admin).deployVault(s.i1.address);
      const v1 = await s.r.getVault(s.i1.address);

      const tx = await s.r.connect(s.admin).batchDeployVaults(0, 99);
      const rc = await tx.wait();
      const deployed = rc.logs.map((l) => { try { return s.r.interface.parseLog(l); } catch { return null; } })
        .filter((p) => p && p.name === "VaultDeployed");
      expect(deployed.map((p) => p.args.investor)).to.deep.equal([s.i2.address, s.i3.address]);

      expect(await s.r.getVault(s.i1.address)).to.equal(v1);          // untouched
      expect(await s.r.getVault(s.i2.address)).to.not.equal(ZERO);
      expect(await s.r.getVault(s.i3.address)).to.not.equal(ZERO);
      expect(await s.srx.balanceOf(await s.r.getVault(s.i2.address))).to.equal(srxFor(10_000));
    });

    it("a batch the round cannot fund reverts InsufficientSRX and deploys nothing", async function () {
      const s = await setup({ fund: srxFor(10_000) }); // enough for one investor only
      for (const w of [s.i1, s.i2]) await s.r.connect(s.admin).addInvestor(w.address, usd(10_000));
      await expect(s.r.connect(s.admin).batchDeployVaults(0, 2)).to.be.revertedWithCustomError(s.r, "InsufficientSRX");
      expect(await s.r.getVault(s.i1.address)).to.equal(ZERO);
    });

    it("batchDeployVaults is admin-only", async function () {
      const s = await threeInvestors();
      await expect(s.r.connect(s.other).batchDeployVaults(0, 3)).to.be.revertedWithCustomError(s.r, "OnlyAdmin");
    });

    it("batchTriggerTGE clamps its end index and skips investors with no vault or an already-triggered vault (lines 820, 826)", async function () {
      const s = await threeInvestors();
      await s.r.connect(s.admin).deployVault(s.i1.address);
      await expect(s.r.connect(s.admin).batchTriggerTGE(0, 99)).to.emit(s.r, "TGETriggeredForAll").withArgs(1);

      await s.r.connect(s.admin).batchDeployVaults(0, 3);
      // i1 is already triggered (skipped); i2 and i3 are new
      await expect(s.r.connect(s.admin).batchTriggerTGE(0, 99)).to.emit(s.r, "TGETriggeredForAll").withArgs(2);
      for (const w of [s.i1, s.i2, s.i3]) {
        const v = await ethers.getContractAt("VestingVault", await s.r.getVault(w.address));
        expect(await v.tgeTriggered()).to.equal(true);
      }
      // nothing left to do: a third run triggers none and does not revert
      await expect(s.r.connect(s.admin).batchTriggerTGE(0, 99)).to.emit(s.r, "TGETriggeredForAll").withArgs(0);
    });

    it("rescueVaultSurplus: NoAllocation without a vault (line 848), non-admin refused, VaultNotRevoked before TGE, then the surplus moves after TGE (line 846 else)", async function () {
      const s = await threeInvestors();
      await expect(s.r.connect(s.admin).rescueVaultSurplus(s.i1.address, s.other.address))
        .to.be.revertedWithCustomError(s.r, "NoAllocation");

      await s.r.connect(s.admin).deployVault(s.i1.address);
      const vaultAddr = await s.r.getVault(s.i1.address);
      const vault = await ethers.getContractAt("VestingVault", vaultAddr);
      await s.srx.mint(vaultAddr, E(5));                 // a mistaken transfer into the vault

      await expect(s.r.connect(s.other).rescueVaultSurplus(s.i1.address, s.other.address))
        .to.be.revertedWithCustomError(s.r, "OnlyAdmin");
      // before TGE the declared-allocation surplus path is closed and the vault is not revoked
      await expect(s.r.connect(s.admin).rescueVaultSurplus(s.i1.address, s.other.address))
        .to.be.revertedWithCustomError(vault, "VaultNotRevoked");

      await s.r.connect(s.admin).batchTriggerTGE(0, 1);
      const before = await s.srx.balanceOf(s.other.address);
      await expect(s.r.connect(s.admin).rescueVaultSurplus(s.i1.address, s.other.address))
        .to.emit(s.r, "VaultSurplusRescued").withArgs(s.i1.address, vaultAddr, s.other.address);
      expect(await s.srx.balanceOf(s.other.address) - before).to.equal(E(5));
      expect(await s.srx.balanceOf(vaultAddr)).to.equal(srxFor(10_000));   // the grant is intact
    });
  });

  // ── Admin configuration ────────────────────────────────────────────────────
  describe("admin configuration", function () {
    it("setSRXPrice success path emits and stores the price, and is then locked by the first investor (line 881)", async function () {
      const { r, admin, i1 } = await setup();
      await expect(r.connect(admin).setSRXPrice(2_000_000n))
        .to.emit(r, "SRXPriceUpdated").withArgs(PRICE, 2_000_000n);
      expect(await r.srxPriceUsd8Dec()).to.equal(2_000_000n);
      await expect(r.connect(admin).setSRXPrice(0n)).to.be.revertedWithCustomError(r, "ZeroAmount");
      await r.connect(admin).addInvestor(i1.address, usd(1_000));
      await expect(r.connect(admin).setSRXPrice(PRICE)).to.be.revertedWithCustomError(r, "PriceLockedAfterFirstInvestor");
      await r.connect(admin).finalize();
      await expect(r.connect(admin).setSRXPrice(PRICE)).to.be.revertedWithCustomError(r, "RoundFinalized");
    });

    it("setMaxStaleness: zero reverts ZeroAmount (line 893), above 25h reverts StalenessTooLong, a valid value is stored", async function () {
      const { r, admin } = await setup();
      await expect(r.connect(admin).setMaxStaleness(0)).to.be.revertedWithCustomError(r, "ZeroAmount");
      await expect(r.connect(admin).setMaxStaleness(25 * 3600 + 1))
        .to.be.revertedWithCustomError(r, "StalenessTooLong").withArgs(25 * 3600 + 1, 25 * 3600);
      await expect(r.connect(admin).setMaxStaleness(3600)).to.emit(r, "MaxStalenessUpdated").withArgs(3600);
      expect(await r.maxStaleness()).to.equal(3600n);
    });

    it("setMinContribution success path stores the minimum; an on-chain buy below it reverts, an admin-recorded one is exempt (line 941 else)", async function () {
      const { r, admin, i1 } = await setup();
      await expect(r.connect(admin).setMinContribution(usd(2_500)))
        .to.emit(r, "MinContributionSet").withArgs(0, usd(2_500));
      expect(await r.minContributionUsd8Dec()).to.equal(usd(2_500));
      await expect(r.connect(i1).investWithUSDC(U6(100)))
        .to.be.revertedWithCustomError(r, "BelowMinimumContribution").withArgs(usd(100), usd(2_500));
      await r.connect(admin).addInvestor(i1.address, usd(100));          // off-chain exempt
      expect((await r.investors(i1.address)).srxAllocation).to.equal(srxFor(100));
    });

    it("setStablecoinFeeds success path stores both feeds and rejects a non-8-decimal feed (line 946 else)", async function () {
      const { r, admin, F, ethFeed } = await setup();
      const a = await F.deploy(10n ** 8n);
      const b = await F.deploy(10n ** 8n);
      await expect(r.connect(admin).setStablecoinFeeds(a.target, b.target))
        .to.emit(r, "StablecoinFeedsUpdated").withArgs(a.target, b.target);
      expect(await r.usdcUsdFeed()).to.equal(a.target);
      expect(await r.usdtUsdFeed()).to.equal(b.target);
      await ethFeed.setDecimals(18);
      await expect(r.connect(admin).setStablecoinFeeds(ethFeed.target, b.target))
        .to.be.revertedWithCustomError(r, "UnsupportedFeedDecimals").withArgs(ethFeed.target, 18);
      // address(0) switches a feed back to the $1 default
      await r.connect(admin).setStablecoinFeeds(ZERO, ZERO);
      expect(await r.usdcUsdFeed()).to.equal(ZERO);
    });

    it("setFeedStaleness rejects each of the three values above 25h with its own value in the error (lines 979, 980, 981)", async function () {
      const { r, admin } = await setup();
      const L = 25 * 3600;
      await expect(r.connect(admin).setFeedStaleness(L + 1, 0, 0))
        .to.be.revertedWithCustomError(r, "StalenessTooLong").withArgs(L + 1, L);
      await expect(r.connect(admin).setFeedStaleness(0, L + 2, 0))
        .to.be.revertedWithCustomError(r, "StalenessTooLong").withArgs(L + 2, L);
      await expect(r.connect(admin).setFeedStaleness(0, 0, L + 3))
        .to.be.revertedWithCustomError(r, "StalenessTooLong").withArgs(L + 3, L);
      await expect(r.connect(admin).setFeedStaleness(L, 1, 2)).to.emit(r, "FeedStalenessUpdated").withArgs(L, 1, 2);
      expect(await r.btcMaxStaleness()).to.equal(1n);
      expect(await r.stableMaxStaleness()).to.equal(2n);
    });

    it("setHardCap success path stores the new cap; below what is allocated reverts CapBelowAllocated (line 988 else)", async function () {
      const { r, admin, i1 } = await setup();
      await r.connect(admin).addInvestor(i1.address, usd(10_000));
      await expect(r.connect(admin).setHardCap(srxFor(10_000) - 1n)).to.be.revertedWithCustomError(r, "CapBelowAllocated");
      await expect(r.connect(admin).setHardCap(srxFor(10_000))).to.emit(r, "HardCapUpdated").withArgs(srxFor(10_000));
      expect(await r.hardCapSRX()).to.equal(srxFor(10_000));
      expect(await r.remainingCap()).to.equal(0n);
    });
  });

  // ── Withdrawals ────────────────────────────────────────────────────────────
  describe("withdrawals", function () {
    it("withdrawETH to a contract that rejects ETH reverts ETHTransferFailed and keeps the funds (line 1003)", async function () {
      const { r, srx, admin, i1 } = await setup();
      await r.connect(i1).invest({ value: E(2) });
      await expect(r.connect(admin).withdrawETH(srx.target)).to.be.revertedWithCustomError(r, "ETHTransferFailed");
      expect(await ethers.provider.getBalance(r.target)).to.equal(E(2));
    });

    it("withdrawETH ring-fences ETH owed to refunded investors", async function () {
      const { r, admin, i1, i2, other } = await setup();
      await r.connect(i1).invest({ value: E(1) });
      await r.connect(i2).invest({ value: E(2) });
      await r.connect(admin).refundInvestor(i1.address);
      await expect(r.connect(admin).withdrawETH(other.address))
        .to.changeEtherBalances([r, other], [-E(2), E(2)]);
      expect(await ethers.provider.getBalance(r.target)).to.equal(E(1)); // i1's refund remains
    });

    it("withdrawETHAmount: zero address (1017), zero amount (1018 first operand), more than withdrawable (1018 second operand), rejecting receiver (1020), then success", async function () {
      const { r, srx, admin, i1, i2, other } = await setup();
      await r.connect(i1).invest({ value: E(1) });
      await r.connect(i2).invest({ value: E(2) });
      await r.connect(admin).refundInvestor(i1.address);              // 1 ETH ring-fenced, 2 ETH withdrawable

      await expect(r.connect(admin).withdrawETHAmount(ZERO, E(1))).to.be.revertedWithCustomError(r, "ZeroAddress");
      await expect(r.connect(admin).withdrawETHAmount(other.address, 0n)).to.be.revertedWithCustomError(r, "ZeroAmount");
      await expect(r.connect(admin).withdrawETHAmount(other.address, E(2) + 1n)).to.be.revertedWithCustomError(r, "ExceedsWithdrawable");
      await expect(r.connect(admin).withdrawETHAmount(srx.target, E(1))).to.be.revertedWithCustomError(r, "ETHTransferFailed");
      const before = await ethers.provider.getBalance(other.address);
      await expect(r.connect(admin).withdrawETHAmount(other.address, E(2)))
        .to.emit(r, "ETHWithdrawn").withArgs(other.address, E(2));
      expect(await ethers.provider.getBalance(other.address) - before).to.equal(E(2));
      expect(await ethers.provider.getBalance(r.target)).to.equal(E(1));
    });

    it("withdrawETH with nothing to take is ZeroAmount and a zero address is ZeroAddress", async function () {
      const { r, admin, other } = await setup();
      await expect(r.connect(admin).withdrawETH(ZERO)).to.be.revertedWithCustomError(r, "ZeroAddress");
      await expect(r.connect(admin).withdrawETH(other.address)).to.be.revertedWithCustomError(r, "ZeroAmount");
    });

    const stableCases = [
      ["withdrawUSDC", "investWithUSDC", "usdc", "USDCWithdrawn", 1025, 1026],
      ["withdrawUSDT", "investWithUSDT", "usdt", "USDTWithdrawn", 1034, 1035],
      ["withdrawWBTC", "investWithWBTC", "wbtc", "WBTCWithdrawn", 1043, 1044],
    ];
    for (const [fn, invest, key, evt, okLine, zeroLine] of stableCases) {
      it(`${fn}: pays out everything except refunds owed (line ${okLine} else); zero address (line ${zeroLine}) and an empty balance are refused`, async function () {
        const s = await setup();
        const token = s[key];
        const amt = key === "wbtc" ? 10n ** 7n : U6(10_000);
        await s.r.connect(s.i1)[invest](amt);
        await s.r.connect(s.i2)[invest](amt);
        await s.r.connect(s.admin).refundInvestor(s.i1.address);     // amt ring-fenced

        await expect(s.r.connect(s.admin)[fn](ZERO)).to.be.revertedWithCustomError(s.r, "ZeroAddress");
        await expect(s.r.connect(s.other)[fn](s.other.address)).to.be.revertedWithCustomError(s.r, "OnlyAdmin");
        const before = await token.balanceOf(s.other.address);
        await expect(s.r.connect(s.admin)[fn](s.other.address))
          .to.emit(s.r, evt).withArgs(s.other.address, amt);
        expect(await token.balanceOf(s.other.address) - before).to.equal(amt);
        expect(await token.balanceOf(s.r.target)).to.equal(amt);     // i1's refund stays
        await expect(s.r.connect(s.admin)[fn](s.other.address)).to.be.revertedWithCustomError(s.r, "ZeroAmount");
      });
    }
  });

  // ── Quote and price views ──────────────────────────────────────────────────
  describe("views on a round with currencies disabled", function () {
    it("quoteETH, currentEthPrice and currentBtcPrice revert CurrencyDisabled when their feed is absent (lines 1071, 1103, 1109)", async function () {
      const s = await setup({ disable: ["eth", "btc"] });
      await expect(s.r.quoteETH(E(1), s.i1.address)).to.be.revertedWithCustomError(s.r, "CurrencyDisabled");
      await expect(s.r.currentEthPrice()).to.be.revertedWithCustomError(s.r, "CurrencyDisabled");
      await expect(s.r.currentBtcPrice()).to.be.revertedWithCustomError(s.r, "CurrencyDisabled");
    });

    it("quoteWBTC reverts CurrencyDisabled when the token is missing (1093 first operand) and when only the BTC feed is missing (1093 second operand)", async function () {
      const noToken = await setup({ disable: ["wbtc"] });
      await expect(noToken.r.quoteWBTC(10n ** 8n, noToken.i1.address)).to.be.revertedWithCustomError(noToken.r, "CurrencyDisabled");
      const noFeed = await setup({ disable: ["btc"] });
      await expect(noFeed.r.quoteWBTC(10n ** 8n, noFeed.i1.address)).to.be.revertedWithCustomError(noFeed.r, "CurrencyDisabled");
    });

    it("control: on a fully enabled round the same views return the oracle prices and the quotes match what a purchase credits", async function () {
      const s = await setup();
      expect(await s.r.currentEthPrice()).to.equal(ETH_PRICE);
      expect(await s.r.currentBtcPrice()).to.equal(BTC_PRICE);
      expect(await s.r.quoteETH(E(1), s.i1.address)).to.equal(srxFor(2_500));
      expect(await s.r.quoteWBTC(10n ** 8n, s.i1.address)).to.equal(srxFor(60_000));
      expect(await s.r.quoteStable(U6(10_000), s.i1.address)).to.equal(srxFor(10_000));
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// VestingVault
// ════════════════════════════════════════════════════════════════════════════
describe("BranchCoverage G1 — VestingVault", function () {
  const ALLOC = E(1_000_000);

  async function setup({ cliff = 100 * DAY, vesting = 200 * DAY, tgeBps = 0, fund = ALLOC, declare = false } = {}) {
    const [admin, beneficiary, treasury, other] = await ethers.getSigners();
    const M = await ethers.getContractFactory("MockERC20");
    const token = await M.deploy("SRX", "SRX", 18);
    const V = await ethers.getContractFactory("VestingVault");
    const vault = await V.deploy(token.target, beneficiary.address, admin.address, cliff, vesting, tgeBps, treasury.address);
    if (fund > 0n) await token.mint(vault.target, fund);
    if (declare) await vault.connect(admin).declareExpectedAllocation(ALLOC);
    return { vault, token, admin, beneficiary, treasury, other, V, M };
  }

  it("vestingDuration == 0: nothing but the TGE share vests inside the cliff, everything vests the moment the cliff ends (line 236, first operand)", async function () {
    const s = await setup({ cliff: 100 * DAY, vesting: 0, tgeBps: 2_000 });
    await s.vault.connect(s.admin).triggerTGE();
    expect(await s.vault.vestedAmount()).to.equal(ALLOC * 2_000n / 10_000n);   // 20% at TGE, cliff still running

    await time.increase(100 * DAY);
    expect(await s.vault.vestedAmount()).to.equal(ALLOC);                       // no division by zero: all at once
    await expect(s.vault.connect(s.beneficiary).release())
      .to.emit(s.vault, "Released").withArgs(s.beneficiary.address, ALLOC);
    expect(await s.token.balanceOf(s.beneficiary.address)).to.equal(ALLOC);
    expect(await s.vault.releasable()).to.equal(0n);
  });

  it("a fully released vault can still be revoked: nothing is owed to anyone, no transfer and no Revoked event (lines 304 else, 305 else, 315 else)", async function () {
    const s = await setup({ cliff: 0, vesting: 100 * DAY });
    await s.vault.connect(s.admin).triggerTGE();
    await time.increase(101 * DAY);
    await s.vault.connect(s.beneficiary).release();
    expect(await s.vault.released()).to.equal(ALLOC);                           // released == initialAllocation

    await expect(s.vault.connect(s.admin).revoke())
      .to.not.emit(s.vault, "Revoked")
      .and.to.not.emit(s.vault, "Released");
    expect(await s.vault.revoked()).to.equal(true);
    expect(await s.token.balanceOf(s.treasury.address)).to.equal(0n);
    expect(await s.token.balanceOf(s.beneficiary.address)).to.equal(ALLOC);
  });

  it("revoking a vault that is vested in full but unclaimed pays the beneficiary everything and the treasury nothing (line 305 else, 315 else)", async function () {
    const s = await setup({ cliff: 0, vesting: 100 * DAY });
    await s.vault.connect(s.admin).triggerTGE();
    await time.increase(101 * DAY);
    await expect(s.vault.connect(s.admin).revoke())
      .to.emit(s.vault, "Released").withArgs(s.beneficiary.address, ALLOC)
      .and.to.not.emit(s.vault, "Revoked");
    expect(await s.token.balanceOf(s.beneficiary.address)).to.equal(ALLOC);
    expect(await s.token.balanceOf(s.treasury.address)).to.equal(0n);
  });

  it("control: a mid-vesting revoke splits vested to the beneficiary and unvested to the treasury, summing to the allocation", async function () {
    const s = await setup({ cliff: 0, vesting: 100 * DAY });
    await s.vault.connect(s.admin).triggerTGE();
    await time.increase(50 * DAY);
    await s.vault.connect(s.admin).revoke();
    const toBeneficiary = await s.token.balanceOf(s.beneficiary.address);
    const toTreasury = await s.token.balanceOf(s.treasury.address);
    expect(toBeneficiary).to.be.gt(0n);
    expect(toTreasury).to.be.gt(0n);
    expect(toBeneficiary + toTreasury).to.equal(ALLOC);
  });

  it("constructor refuses each zero address, a recipient equal to the beneficiary, and bps above 10000", async function () {
    const s = await setup();
    const a = (over) => {
      const base = [s.token.target, s.beneficiary.address, s.admin.address, 0, 0, 0, s.treasury.address];
      Object.entries(over).forEach(([i, v]) => { base[i] = v; });
      return base;
    };
    await expect(s.V.deploy(...a({ 0: ZERO }))).to.be.revertedWithCustomError(s.vault, "ZeroAddress");
    await expect(s.V.deploy(...a({ 1: ZERO }))).to.be.revertedWithCustomError(s.vault, "ZeroAddress");
    await expect(s.V.deploy(...a({ 2: ZERO }))).to.be.revertedWithCustomError(s.vault, "ZeroAddress");
    await expect(s.V.deploy(...a({ 6: ZERO }))).to.be.revertedWithCustomError(s.vault, "InvalidRevokeRecipient");
    await expect(s.V.deploy(...a({ 6: s.beneficiary.address }))).to.be.revertedWithCustomError(s.vault, "InvalidRevokeRecipient");
    await expect(s.V.deploy(...a({ 5: 10_001 }))).to.be.revertedWithCustomError(s.vault, "InvalidBps");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TGEDistributor
// ════════════════════════════════════════════════════════════════════════════
describe("BranchCoverage G1 — TGEDistributor", function () {
  const MAX_SUPPLY = ethers.parseUnits("10000000000", 18);

  async function setup() {
    const [admin, a, b, stranger] = await ethers.getSigners();
    const M = await ethers.getContractFactory("MockERC20");
    const token = await M.deploy("SRX", "SRX", 18);
    const D = await ethers.getContractFactory("TGEDistributor");
    const dist = await D.deploy(token.target, admin.address);
    return { token, dist, D, admin, a, b, stranger };
  }

  it("a zero token reverts ZeroAddress (line 78, first operand)", async function () {
    const { D, dist, admin } = await setup();
    await expect(D.deploy(ZERO, admin.address)).to.be.revertedWithCustomError(dist, "ZeroAddress");
  });

  it("a zero admin reverts ZeroAddress even with a valid token (line 78, second operand)", async function () {
    const { D, dist, token } = await setup();
    await expect(D.deploy(token.target, ZERO)).to.be.revertedWithCustomError(dist, "ZeroAddress");
  });

  it("control: a valid token and admin deploy, and the immutables are stored", async function () {
    const { dist, token, admin } = await setup();
    expect(await dist.token()).to.equal(token.target);
    expect(await dist.admin()).to.equal(admin.address);
  });

  it("control for the unreachable line 163: a two-row distribution pays exactly MAX_SUPPLY, emits DistributionComplete and leaves the distributor empty", async function () {
    const { dist, token, admin, a, b } = await setup();
    await token.mint(dist.target, MAX_SUPPLY);
    await dist.connect(admin).setAllocations([
      { destination: a.address, amount: MAX_SUPPLY / 4n, isVestingVault: false, label: "a" },
      { destination: b.address, amount: MAX_SUPPLY - MAX_SUPPLY / 4n, isVestingVault: false, label: "b" },
    ]);
    await expect(dist.connect(admin).distribute()).to.emit(dist, "DistributionComplete");
    expect(await token.balanceOf(a.address)).to.equal(MAX_SUPPLY / 4n);
    expect(await token.balanceOf(b.address)).to.equal(MAX_SUPPLY - MAX_SUPPLY / 4n);
    expect(await token.balanceOf(dist.target)).to.equal(0n);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SRXAirdrop
// ════════════════════════════════════════════════════════════════════════════
describe("BranchCoverage G1 — SRXAirdrop", function () {
  async function setup() {
    const [admin, claimant, other] = await ethers.getSigners();
    const M = await ethers.getContractFactory("MockERC20");
    const token = await M.deploy("SRX", "SRX", 18);
    const A = await ethers.getContractFactory("SRXAirdrop");
    const airdrop = await A.deploy(token.target, admin.address);
    return { token, airdrop, A, admin, claimant, other };
  }

  it("a zero token reverts ZeroAddress (line 111)", async function () {
    const { A, airdrop, admin } = await setup();
    await expect(A.deploy(ZERO, admin.address)).to.be.revertedWithCustomError(airdrop, "ZeroAddress");
  });

  it("a zero admin reverts ZeroAddress (line 112)", async function () {
    const { A, airdrop, token } = await setup();
    await expect(A.deploy(token.target, ZERO)).to.be.revertedWithCustomError(airdrop, "ZeroAddress");
  });

  it("claiming zero reverts ZeroAmount before any proof is checked, and does not mark the caller as claimed (line 194)", async function () {
    const { airdrop, admin, claimant } = await setup();
    const root = ethers.id("any-root");
    const deadline = (await time.latest()) + 30 * DAY;
    await airdrop.connect(admin).setMerkleRoot(root, deadline);

    await expect(airdrop.connect(claimant).claim(0, [])).to.be.revertedWithCustomError(airdrop, "ZeroAmount");
    expect(await airdrop.claimed(claimant.address)).to.equal(false);
    expect(await airdrop.totalClaimed()).to.equal(0n);
    // control: a non-zero amount with a bad proof fails on the proof, not on the amount
    await expect(airdrop.connect(claimant).claim(1, [])).to.be.revertedWithCustomError(airdrop, "InvalidProof");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Unreachable branches (no test: a test could only execute the line)
//
//  TGEDistributor.sol:163  `if (totalSent != MAX_SUPPLY) revert SupplyMismatch` —
//    unreachable. distribute() sums the same stored `allocations[i].amount` values that
//    setAllocations() already required to total MAX_SUPPLY exactly, and `allocations` can
//    only be written by setAllocations() (which re-checks) and not after `distributed`.
//    A failing token transfer reverts the whole call before this line, so totalSent can
//    only equal MAX_SUPPLY here. It is a deliberate belt-and-braces check.
//
//  PreSaleRound.sol:787 second operand `inv.srxAllocation == 0` evaluating TRUE —
//    unreachable. An address is in investorList only after _processInvestment gave it a
//    non-zero allocation, updateAllocation refuses 0, and _removeInvestor drops it from the
//    list when it zeroes the record. (The operand IS evaluated, and false, in the batch
//    tests above, so its "else" side is covered.)
// ════════════════════════════════════════════════════════════════════════════
