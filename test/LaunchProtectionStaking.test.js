// Launch protection vs staking (internal review, 7 Oct 2026). The transfer cap applies
// unless the sender or recipient is exempt, and the wallet cap applies to any non-exempt
// recipient — including 0xdEaD, which receives early-exit penalties. This proves what
// breaks without the exemptions and that the exemptions verify_tge requires fix it.
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { allocationSource } = require("./helpers/allocationSource");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (n) => ethers.parseUnits(String(n), 18);
const DEAD = "0x000000000000000000000000000000000000dEaD";

describe("Launch protection vs staking: exits need the staking contract and 0xdEaD exempt", function () {
  async function fixture() {
    const [admin, whale, small] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await token.connect(admin).genesis(admin.address);
    const staking = await (await ethers.getContractFactory("SRXStaking")).deploy(...[await token.getAddress(), admin.address, await allocationSource(token)]);
    await token.connect(admin).transfer(whale.address, E(2_000_000));
    await token.connect(admin).transfer(small.address, E(1_000));
    await token.connect(admin).transfer(DEAD, E(950)); // earlier penalties already burned
    for (const u of [whale, small]) await token.connect(u).approve(await staking.getAddress(), ethers.MaxUint256);
    await staking.connect(whale).lock(E(2_000_000), 7 * 86400);
    await staking.connect(small).lock(E(1_000), 7 * 86400);
    // Launch protection on, with no exemptions for staking or 0xdEaD.
    await token.connect(admin).setMaxTransferAmount(E(1_000_000));
    await token.connect(admin).setMaxWalletBalance(E(1_000));
    return { admin, whale, small, token, staking };
  }

  it("without exemptions a large unlock exceeds the transfer cap, and a penalty to 0xdEaD exceeds the wallet cap", async function () {
    const { whale, small, staking, token } = await loadFixture(fixture);
    await expect(staking.connect(small).earlyWithdraw()).to.be.revertedWithCustomError(token, "WalletExceedsMaxBalance");
    await time.increase(7 * 86400 + 1);
    await expect(staking.connect(whale).unlock()).to.be.revertedWithCustomError(token, "TransferExceedsMaxAmount");
  });

  it("with the staking contract and 0xdEaD exempt, both exits work (control)", async function () {
    const { admin, whale, small, staking, token } = await loadFixture(fixture);
    await token.connect(admin).setExemptFromLimits(await staking.getAddress(), true);
    await token.connect(admin).setExemptFromLimits(DEAD, true);
    await staking.connect(small).earlyWithdraw();
    await token.connect(admin).setExemptFromLimits(whale.address, true); // a whale above the wallet cap must be exempt too
    await time.increase(7 * 86400 + 1);
    await staking.connect(whale).unlock();
    expect(await token.balanceOf(whale.address)).to.equal(E(2_000_000));
  });
});
