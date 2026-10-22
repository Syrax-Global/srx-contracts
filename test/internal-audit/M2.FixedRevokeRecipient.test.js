// Internal audit M2 / external report 15 Oct 2026 (#4); Security work order A2, 22 Oct 2026.
// VestingVault.revoke took its recipient as an argument, unvalidated, so the admin could name
// the beneficiary and make a whole locked grant liquid at once (on a Genesis vault, instantly,
// by the Safe). The recipient is now fixed at deployment and can never be the beneficiary.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { approveBuyers } = require("../helpers/buyers");

const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;

async function token() {
  const [admin] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const srx = await (await ethers.getContractFactory("SRXToken")).deploy(lz.target, admin.address);
  await srx.connect(admin).genesis(admin.address);
  return srx;
}

describe("Internal audit M2: a revoke can only send to the recipient fixed at deployment", function () {
  it("a vault refuses the beneficiary, or zero, as its revoke recipient", async function () {
    const [admin, beneficiary] = await ethers.getSigners();
    const srx = await token();
    const F = await ethers.getContractFactory("VestingVault");
    await expect(F.deploy(srx.target, beneficiary.address, admin.address, 365 * DAY, 1095 * DAY, 0, beneficiary.address))
      .to.be.revertedWithCustomError(F, "InvalidRevokeRecipient");
    await expect(F.deploy(srx.target, beneficiary.address, admin.address, 365 * DAY, 1095 * DAY, 0, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(F, "InvalidRevokeRecipient");
  });

  it("revoke() takes no recipient; on day 1 of the cliff the beneficiary gets 0 and the Treasury the grant", async function () {
    const [admin, beneficiary, treasury, other] = await ethers.getSigners();
    const srx = await token();
    const vault = await (await ethers.getContractFactory("VestingVault"))
      .deploy(srx.target, beneficiary.address, admin.address, 365 * DAY, 1095 * DAY, 0, treasury.address);
    expect(vault.interface.getFunction("revoke").inputs.length).to.equal(0);
    await srx.connect(admin).transfer(vault.target, E(1_000_000));
    await vault.connect(admin).declareExpectedAllocation(E(1_000_000));
    await vault.connect(admin).triggerTGE();
    await time.increase(DAY);
    await expect(vault.connect(other).revoke()).to.be.revertedWithCustomError(vault, "OnlyAdmin");
    await vault.connect(admin).revoke();
    expect(await srx.balanceOf(beneficiary.address)).to.equal(0n);
    expect(await srx.balanceOf(treasury.address)).to.equal(E(1_000_000));
    expect(await srx.balanceOf(other.address)).to.equal(0n);
  });

  it("Genesis round: revokeVault sends a buyer's unvested SRX only to the round's fixed recipient", async function () {
    const [admin, b1, treasury] = await ethers.getSigners();
    const srx = await token();
    const M = await ethers.getContractFactory("MockERC20");
    const usdc = await M.deploy("USD Coin", "USDC", 6);
    const usdt = await M.deploy("Tether USD", "USDT", 6);
    const wbtc = await M.deploy("Wrapped BTC", "WBTC", 8);
    const F = await ethers.getContractFactory("MockChainlinkFeed");
    const ethFeed = await F.deploy(2_500n * 10n ** 8n), btcFeed = await F.deploy(60_000n * 10n ** 8n);
    const R = await ethers.getContractFactory("PreSaleRound");
    const args = [srx.target, usdc.target, usdt.target, wbtc.target, ethFeed.target, btcFeed.target,
      admin.address, E(300_000_000), 1_250_000n, true, 5_000n];
    await expect(R.deploy(...args, ethers.ZeroAddress)).to.be.revertedWithCustomError(R, "ZeroAddress");
    const r = await R.deploy(...args, treasury.address);
    expect(r.interface.getFunction("revokeVault").inputs.length).to.equal(1);
    await approveBuyers(r, admin, [b1]);
    await usdc.mint(b1.address, 10_000n * 10n ** 6n);
    await usdc.connect(b1).approve(r.target, ethers.MaxUint256);
    await r.connect(b1).investWithUSDC(10_000n * 10n ** 6n);
    await r.connect(admin).finalize();
    await srx.connect(admin).transfer(r.target, await r.totalAllocated());
    await r.connect(admin).deployVault(b1.address);
    const vault = await ethers.getContractAt("VestingVault", await r.getVault(b1.address));
    expect(await vault.revokeRecipient()).to.equal(treasury.address);
    await r.connect(admin).batchTriggerTGE(0, 1);
    const grant = await srx.balanceOf(vault.target);
    await r.connect(admin).revokeVault(b1.address);
    expect(await srx.balanceOf(b1.address)).to.equal(0n);              // inside the cliff: nothing vested
    expect(await srx.balanceOf(treasury.address)).to.equal(grant);
  });
});
