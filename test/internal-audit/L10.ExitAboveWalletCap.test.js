// Internal audit 16 Oct 2026, L10 (TB-06): under launch protection a staker whose principal
// was above the wallet cap (built in tranches) could not unlock or exit, even through
// exitAfterWindDown while paused. Principal returning from a listed exit is not capped.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { allocationSource } = require("../helpers/allocationSource");

const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;
const DEAD = "0x000000000000000000000000000000000000dEaD";

async function capped() {
  const [admin, whale, other] = await ethers.getSigners();
  const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
  await token.connect(admin).genesis(admin.address);
  const staking = await (await ethers.getContractFactory("SRXStaking"))
    .deploy(token.target, admin.address, await allocationSource(token));
  await token.connect(admin).setExemptFromLimits(staking.target, true);
  await token.connect(admin).setExemptFromLimits(DEAD, true);
  await token.connect(admin).addWindDownExit(staking.target);
  await token.connect(admin).setMaxTransferAmount(E(1_000_000));
  await token.connect(admin).setMaxWalletBalance(E(1_000_000));
  await token.connect(whale).approve(staking.target, ethers.MaxUint256);
  await token.connect(admin).transfer(whale.address, E(1_000_000));
  await staking.connect(whale).lock(E(1_000_000), 7 * DAY);
  await token.connect(admin).transfer(whale.address, E(1_000_000));
  await staking.connect(whale).addToPosition(E(1_000_000), 0);
  return { admin, whale, other, token, staking };
}

describe("Internal audit L10: a staker's own principal comes back whatever the wallet cap", function () {
  it("exitAfterWindDown returns a principal above the cap, while the token is paused", async function () {
    const { admin, whale, token, staking } = await capped();
    await staking.connect(admin).startWindDown();
    await token.connect(admin).pause();
    await staking.connect(whale).exitAfterWindDown();
    expect(await token.balanceOf(whale.address)).to.equal(E(2_000_000));
  });

  it("unlock at the end of the lock returns a principal above the cap", async function () {
    const { whale, token, staking } = await capped();
    await time.increase(8 * DAY);
    await staking.connect(whale).unlock();
    expect(await token.balanceOf(whale.address)).to.equal(E(2_000_000));
  });

  it("control: an ordinary transfer still respects the wallet cap", async function () {
    const { admin, other, token } = await capped();
    await token.connect(admin).transfer(other.address, E(1_000_000));
    await expect(token.connect(admin).transfer(other.address, E(1)))
      .to.be.revertedWithCustomError(token, "WalletExceedsMaxBalance");
  });
});
