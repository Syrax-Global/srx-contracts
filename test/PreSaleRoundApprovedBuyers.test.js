// Approved buyers only (Genesis journey, 25 Sep 2026).
//
// Before this rule, any wallet in the world could pay into the sale contract;
// identity checks and the signed agreement could only be enforced afterwards,
// by refunding. Now a wallet may buy only after the admin (the Safe) approves
// it, which happens once its owner has passed identity checks and accepted a
// purchase agreement, and it is never credited beyond the amount agreed. These
// tests pin that on every payment path, on the admin-recorded path, and across
// refunds, removals, corrections and revocation.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { refFor } = require("./helpers/buyers");

describe("PreSaleRound — approved buyers only", function () {
  const PRICE = 1_250_000n;                                 // $0.0125
  const CAP_SRX = ethers.parseUnits("300000000", 18);       // Genesis: 300M SRX
  const ETH_PRICE = 2_500n * 10n ** 8n;
  const BTC_PRICE = 60_000n * 10n ** 8n;
  const usd = (d) => BigInt(d) * 10n ** 8n;                  // whole dollars → 8-dec USD
  const u6 = (d) => BigInt(d) * 10n ** 6n;                   // whole dollars → 6-dec stablecoin
  const srx = (n) => ethers.parseUnits(String(n), 18);

  async function fixture(flat = true) {
    const [admin, buyer, other, third] = await ethers.getSigners();
    const LZ = await ethers.getContractFactory("MockLZEndpoint");
    const lz = await LZ.deploy(40161);
    const T = await ethers.getContractFactory("SRXToken");
    const token = await T.deploy(await lz.getAddress(), admin.address);
    await token.connect(admin).genesis(admin.address);
    const M = await ethers.getContractFactory("MockERC20");
    const usdc = await M.deploy("USD Coin", "USDC", 6);
    const usdt = await M.deploy("Tether USD", "USDT", 6);
    const wbtc = await M.deploy("Wrapped BTC", "WBTC", 8);
    const F = await ethers.getContractFactory("MockChainlinkFeed");
    const ethFeed = await F.deploy(ETH_PRICE);
    const btcFeed = await F.deploy(BTC_PRICE);
    const R = await ethers.getContractFactory("PreSaleRound");
    const r = await R.deploy(
      token.target, usdc.target, usdt.target, wbtc.target, ethFeed.target, btcFeed.target,
      admin.address, CAP_SRX, PRICE, flat, flat ? 5_000n : 0n,
    );
    await token.connect(admin).transfer(r.target, CAP_SRX);
    for (const w of [buyer, other, third]) {
      await usdc.mint(w.address, u6(1_000_000));
      await usdt.mint(w.address, u6(1_000_000));
      await wbtc.mint(w.address, 10n * 10n ** 8n);
      await usdc.connect(w).approve(r.target, ethers.MaxUint256);
      await usdt.connect(w).approve(r.target, ethers.MaxUint256);
      await wbtc.connect(w).approve(r.target, ethers.MaxUint256);
    }
    const approve = (w, capUsd8Dec) => r.connect(admin).setBuyerApprovals([w.address], [capUsd8Dec], [refFor(w.address)]);
    return { r, token, usdc, usdt, wbtc, admin, buyer, other, third, approve };
  }
  const ladderFixture = () => fixture(false);

  describe("a wallet that was never approved", function () {
    it("cannot buy with ETH, USDC, USDT or WBTC", async function () {
      const { r, buyer } = await loadFixture(fixture);
      await expect(r.connect(buyer).invest({ value: ethers.parseEther("1") }))
        .to.be.revertedWithCustomError(r, "NotApproved").withArgs(buyer.address, ETH_PRICE, 0n);
      await expect(r.connect(buyer).investWithUSDC(u6(2_500)))
        .to.be.revertedWithCustomError(r, "NotApproved").withArgs(buyer.address, usd(2_500), 0n);
      await expect(r.connect(buyer).investWithUSDT(u6(2_500)))
        .to.be.revertedWithCustomError(r, "NotApproved").withArgs(buyer.address, usd(2_500), 0n);
      await expect(r.connect(buyer).investWithWBTC(10n ** 8n))
        .to.be.revertedWithCustomError(r, "NotApproved").withArgs(buyer.address, BTC_PRICE, 0n);
    });

    it("cannot be recorded by the admin either (bank transfer path)", async function () {
      const { r, admin, buyer } = await loadFixture(fixture);
      await expect(r.connect(admin).addInvestor(buyer.address, usd(10_000)))
        .to.be.revertedWithCustomError(r, "NotApproved").withArgs(buyer.address, usd(10_000), 0n);
    });

    it("keeps its money: a refused purchase moves nothing", async function () {
      const { r, usdc, buyer } = await loadFixture(fixture);
      const before = await usdc.balanceOf(buyer.address);
      await expect(r.connect(buyer).investWithUSDC(u6(10_000))).to.be.reverted;
      expect(await usdc.balanceOf(buyer.address)).to.equal(before);
      expect(await usdc.balanceOf(r.target)).to.equal(0n);
    });

    it("is refused in ladder mode too — the rule is for every round", async function () {
      const { r, buyer } = await loadFixture(ladderFixture);
      await expect(r.connect(buyer).investWithUSDC(u6(2_500))).to.be.revertedWithCustomError(r, "NotApproved");
    });
  });

  describe("an approved wallet", function () {
    it("can buy exactly its agreed amount", async function () {
      const { r, buyer, approve } = await loadFixture(fixture);
      await approve(buyer, usd(10_000));
      await r.connect(buyer).investWithUSDC(u6(10_000));
      const inv = await r.investors(buyer.address);
      expect(inv.cumulativeUsd8Dec).to.equal(usd(10_000));
      expect(inv.srxAllocation).to.equal(srx(1_200_000)); // 120 SRX per $1
    });

    it("cannot go one unit above it", async function () {
      const { r, buyer, approve } = await loadFixture(fixture);
      await approve(buyer, usd(10_000));
      await r.connect(buyer).investWithUSDC(u6(10_000));
      // 1 base unit of USDC is $0.000001 = 100 in 8-dec USD
      await expect(r.connect(buyer).investWithUSDC(1n))
        .to.be.revertedWithCustomError(r, "NotApproved").withArgs(buyer.address, usd(10_000) + 100n, usd(10_000));
    });

    it("is capped across several payments and currencies", async function () {
      const { r, buyer, approve } = await loadFixture(fixture);
      await approve(buyer, usd(10_000));
      await r.connect(buyer).investWithUSDC(u6(4_000));
      await r.connect(buyer).investWithUSDT(u6(3_500));
      await r.connect(buyer).invest({ value: ethers.parseEther("1") }); // $2,500 → $10,000 in total
      await expect(r.connect(buyer).investWithUSDC(u6(1))).to.be.revertedWithCustomError(r, "NotApproved");
      expect((await r.investors(buyer.address)).cumulativeUsd8Dec).to.equal(usd(10_000));
    });

    it("an ETH payment worth more than the remaining amount is refused", async function () {
      const { r, buyer, approve } = await loadFixture(fixture);
      await approve(buyer, usd(2_500));
      await expect(r.connect(buyer).invest({ value: ethers.parseEther("1.0001") }))
        .to.be.revertedWithCustomError(r, "NotApproved");
      await r.connect(buyer).invest({ value: ethers.parseEther("1") });
    });

    it("is capped across on-chain payments and admin-recorded amounts together", async function () {
      const { r, admin, buyer, approve } = await loadFixture(fixture);
      await approve(buyer, usd(10_000));
      await r.connect(admin).addInvestor(buyer.address, usd(5_000));
      await r.connect(buyer).investWithUSDC(u6(5_000));
      await expect(r.connect(admin).addInvestor(buyer.address, usd(1)))
        .to.be.revertedWithCustomError(r, "NotApproved");
      await expect(r.connect(buyer).investWithUSDC(u6(1))).to.be.revertedWithCustomError(r, "NotApproved");
    });

    it("does not let another wallet use its approval", async function () {
      const { r, buyer, other, approve } = await loadFixture(fixture);
      await approve(buyer, usd(10_000));
      await expect(r.connect(other).investWithUSDC(u6(2_500))).to.be.revertedWithCustomError(r, "NotApproved");
    });
  });

  describe("setting approvals", function () {
    it("approves several buyers in one batch and records each cap and agreement reference", async function () {
      const { r, admin, buyer, other, third } = await loadFixture(fixture);
      const ws = [buyer, other, third];
      const caps = [usd(2_500), usd(50_000), usd(100_000)];
      const tx = r.connect(admin).setBuyerApprovals(ws.map((w) => w.address), caps, ws.map((w) => refFor(w.address)));
      for (let i = 0; i < 3; i++) {
        await expect(tx).to.emit(r, "BuyerApprovalSet").withArgs(ws[i].address, caps[i], refFor(ws[i].address));
      }
      for (let i = 0; i < 3; i++) {
        const a = await r.buyerApprovals(ws[i].address);
        expect(a.capUsd8Dec).to.equal(caps[i]);
        expect(a.agreementRef).to.equal(refFor(ws[i].address));
      }
    });

    it("is for the admin only", async function () {
      const { r, buyer } = await loadFixture(fixture);
      await expect(r.connect(buyer).setBuyerApprovals([buyer.address], [usd(1)], [refFor(buyer.address)]))
        .to.be.revertedWithCustomError(r, "OnlyAdmin");
    });

    it("refuses mismatched lists, a zero address, or an approval with no agreement reference", async function () {
      const { r, admin, buyer } = await loadFixture(fixture);
      await expect(r.connect(admin).setBuyerApprovals([buyer.address], [usd(1), usd(2)], [refFor(buyer.address)]))
        .to.be.revertedWithCustomError(r, "LengthMismatch");
      await expect(r.connect(admin).setBuyerApprovals([buyer.address], [usd(1)], []))
        .to.be.revertedWithCustomError(r, "LengthMismatch");
      await expect(r.connect(admin).setBuyerApprovals([ethers.ZeroAddress], [usd(1)], [refFor(buyer.address)]))
        .to.be.revertedWithCustomError(r, "ZeroAddress");
      await expect(r.connect(admin).setBuyerApprovals([buyer.address], [usd(1)], [ethers.ZeroHash]))
        .to.be.revertedWithCustomError(r, "ZeroAmount");
    });

    it("cannot lower a cap below what the buyer has already been credited", async function () {
      const { r, admin, buyer, approve } = await loadFixture(fixture);
      await approve(buyer, usd(10_000));
      await r.connect(buyer).investWithUSDC(u6(6_000));
      await expect(approve(buyer, usd(5_999))).to.be.revertedWithCustomError(r, "CapBelowAllocated");
      await expect(r.connect(admin).setBuyerApprovals([buyer.address], [0n], [ethers.ZeroHash]))
        .to.be.revertedWithCustomError(r, "CapBelowAllocated");
    });

    it("stops further purchases when the cap is set to exactly what was credited", async function () {
      const { r, buyer, approve } = await loadFixture(fixture);
      await approve(buyer, usd(10_000));
      await r.connect(buyer).investWithUSDC(u6(6_000));
      await approve(buyer, usd(6_000));
      await expect(r.connect(buyer).investWithUSDC(u6(1))).to.be.revertedWithCustomError(r, "NotApproved");
    });

    it("revokes a buyer with no allocation by setting the cap to 0", async function () {
      const { r, admin, buyer, approve } = await loadFixture(fixture);
      await approve(buyer, usd(10_000));
      await r.connect(admin).setBuyerApprovals([buyer.address], [0n], [ethers.ZeroHash]);
      await expect(r.connect(buyer).investWithUSDC(u6(2_500))).to.be.revertedWithCustomError(r, "NotApproved");
    });

    it("can raise a cap for a buyer who agreed a larger amount", async function () {
      const { r, buyer, approve } = await loadFixture(fixture);
      await approve(buyer, usd(10_000));
      await r.connect(buyer).investWithUSDC(u6(10_000));
      await approve(buyer, usd(25_000));
      await r.connect(buyer).investWithUSDC(u6(15_000));
      expect((await r.investors(buyer.address)).cumulativeUsd8Dec).to.equal(usd(25_000));
    });
  });

  describe("refunds, removals and corrections", function () {
    it("a refunded buyer loses the approval, so cannot quietly buy again, and still gets the refund", async function () {
      const { r, usdc, admin, buyer, approve } = await loadFixture(fixture);
      await approve(buyer, usd(10_000));
      await r.connect(buyer).investWithUSDC(u6(5_000));
      await expect(r.connect(admin).refundInvestor(buyer.address))
        .to.emit(r, "BuyerApprovalSet").withArgs(buyer.address, 0n, ethers.ZeroHash);
      const a = await r.buyerApprovals(buyer.address);
      expect(a.capUsd8Dec).to.equal(0n);
      expect(a.agreementRef).to.equal(ethers.ZeroHash);
      await expect(r.connect(buyer).investWithUSDC(u6(2_500))).to.be.revertedWithCustomError(r, "NotApproved");
      const before = await usdc.balanceOf(buyer.address);
      await r.connect(buyer).claimRefund(usdc.target);
      expect(await usdc.balanceOf(buyer.address)).to.equal(before + u6(5_000));
    });

    it("a removed admin-recorded buyer loses the approval too", async function () {
      const { r, admin, buyer, approve } = await loadFixture(fixture);
      await approve(buyer, usd(10_000));
      await r.connect(admin).addInvestor(buyer.address, usd(10_000));
      await r.connect(admin).removeInvestor(buyer.address);
      expect((await r.buyerApprovals(buyer.address)).capUsd8Dec).to.equal(0n);
      await expect(r.connect(admin).addInvestor(buyer.address, usd(10_000)))
        .to.be.revertedWithCustomError(r, "NotApproved");
    });

    it("a correction cannot take an allocation above the agreed amount", async function () {
      const { r, admin, buyer, approve } = await loadFixture(fixture);
      await approve(buyer, usd(10_000));
      await r.connect(admin).addInvestor(buyer.address, usd(1_000));
      await r.connect(admin).updateAllocation(buyer.address, srx(1_200_000)); // exactly $10,000
      await expect(r.connect(admin).updateAllocation(buyer.address, srx(1_200_120))) // $10,001
        .to.be.revertedWithCustomError(r, "NotApproved");
      expect((await r.investors(buyer.address)).srxAllocation).to.equal(srx(1_200_000));
    });
  });
});
