// Gap-closing tests for TGEDistributor. Fixture follows test/TGE.test.js.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const MAX_SUPPLY = ethers.parseUnits("10000000000", 18);
const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86400n;

async function deployFixture() {
  const [admin, stranger, walletA, walletB, recipient] = await ethers.getSigners();
  const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
  const Vault = await ethers.getContractFactory("VestingVault");
  const mkVault = async (cliffDays, vestingDays, tgeBps) =>
    Vault.deploy(await token.getAddress(), admin.address, admin.address, BigInt(cliffDays) * DAY, BigInt(vestingDays) * DAY, BigInt(tgeBps), recipient.address);
  const vaultA = await mkVault(365, 1095, 0);
  const vaultB = await mkVault(0, 180, 2500); // a vault with a TGE unlock: it is the one most worth checking
  const distributor = await (await ethers.getContractFactory("TGEDistributor")).deploy(await token.getAddress(), admin.address);

  const alloc = (destination, amount, isVestingVault, label) => ({ destination, amount, isVestingVault, label });
  const allocations = [
    alloc(await vaultA.getAddress(), E(1_000_000_000), true, "Founders"),
    alloc(await vaultB.getAddress(), E(1_400_000_000), true, "Presale"),
    alloc(walletA.address, E(3_600_000_000), false, "Liquidity"),
    alloc(walletB.address, E(4_000_000_000), false, "Strategic"),
  ];
  return { admin, stranger, walletA, walletB, recipient, token, vaultA, vaultB, distributor, allocations, alloc };
}

async function distributed(ctx) {
  const { admin, token, distributor, allocations } = ctx;
  await distributor.connect(admin).setAllocations(allocations);
  await token.connect(admin).genesis(await distributor.getAddress());
  await distributor.connect(admin).distribute();
}

describe("Gaps — TGEDistributor", function () {
  it("D1 setAllocations emits AllocationsSet(count, total, timestamp) every time it is called", async function () {
    const { admin, stranger, distributor, allocations, alloc, walletA, walletB } = await loadFixture(deployFixture);
    const parse = (rc) => rc.logs.map((l) => distributor.interface.parseLog(l)).find((p) => p && p.name === "AllocationsSet");

    // Control: only the admin may call it.
    await expect(distributor.connect(stranger).setAllocations(allocations)).to.be.revertedWithCustomError(distributor, "OnlyAdmin");

    const rc1 = await (await distributor.connect(admin).setAllocations(allocations)).wait();
    const ev1 = parse(rc1);
    expect(ev1.args.count).to.equal(4n);
    expect(ev1.args.totalAmount).to.equal(MAX_SUPPLY);
    expect(ev1.args.timestamp).to.equal(BigInt((await ethers.provider.getBlock(rc1.blockNumber)).timestamp));

    // A second, different set overwrites the first and is announced again.
    const second = [alloc(walletA.address, E(6_000_000_000), false, "A"), alloc(walletB.address, E(4_000_000_000), false, "B")];
    const rc2 = await (await distributor.connect(admin).setAllocations(second)).wait();
    const ev2 = parse(rc2);
    expect(ev2.args.count).to.equal(2n);
    expect(ev2.args.totalAmount).to.equal(MAX_SUPPLY);
    expect(ev2.args.timestamp).to.equal(BigInt((await ethers.provider.getBlock(rc2.blockNumber)).timestamp));
    expect(ev2.args.timestamp).to.be.gt(ev1.args.timestamp);
    // The overwrite really happened (this is what the event makes visible).
    expect((await distributor.allocations(0)).label).to.equal("A");
    await expect(distributor.allocations(2)).to.be.reverted;
  });

  it("D2 right after distribute(), every VestingVault has tgeTriggered() == false; triggerTGE then flips it (control)", async function () {
    const ctx = await loadFixture(deployFixture);
    const { admin, token, vaultA, vaultB, distributor } = ctx;
    await distributed(ctx);
    expect(await distributor.distributed()).to.equal(true);
    // The vaults hold their allocation but their clocks have not started.
    expect(await token.balanceOf(await vaultA.getAddress())).to.equal(E(1_000_000_000));
    expect(await token.balanceOf(await vaultB.getAddress())).to.equal(E(1_400_000_000));
    expect(await vaultA.tgeTriggered()).to.equal(false);
    expect(await vaultB.tgeTriggered()).to.equal(false);

    await vaultB.connect(admin).triggerTGE();
    expect(await vaultB.tgeTriggered()).to.equal(true);
    expect(await vaultA.tgeTriggered()).to.equal(false); // untouched
  });

  it("D3 after distribution, a stray ERC-20 (and a stray SRX) sent to the distributor is fully recovered to the recipient", async function () {
    const ctx = await loadFixture(deployFixture);
    const { admin, stranger, recipient, walletA, token, distributor } = ctx;
    const distAddr = await distributor.getAddress();
    const Mock = await ethers.getContractFactory("MockERC20");
    const usdc = await Mock.deploy("USD Coin", "USDC", 6);
    await usdc.mint(distAddr, 1_234_567n);

    // Control: before distribution recovery is refused, even for the admin.
    await expect(distributor.connect(admin).recoverToken(await usdc.getAddress(), recipient.address))
      .to.be.revertedWithCustomError(distributor, "NotDistributed");

    await distributed(ctx);
    expect(await token.balanceOf(distAddr)).to.equal(0n);

    // Access control and zero-address guards.
    await expect(distributor.connect(stranger).recoverToken(await usdc.getAddress(), stranger.address))
      .to.be.revertedWithCustomError(distributor, "OnlyAdmin");
    await expect(distributor.connect(admin).recoverToken(await usdc.getAddress(), ethers.ZeroAddress))
      .to.be.revertedWithCustomError(distributor, "ZeroAddress");
    expect(await usdc.balanceOf(distAddr)).to.equal(1_234_567n);

    await distributor.connect(admin).recoverToken(await usdc.getAddress(), recipient.address);
    expect(await usdc.balanceOf(recipient.address)).to.equal(1_234_567n);
    expect(await usdc.balanceOf(distAddr)).to.equal(0n);

    // A stray SRX (sent by a holder after distribution) is recovered in full too, and
    // genesis supply accounting is untouched.
    await token.connect(walletA).transfer(distAddr, E(777));
    expect(await token.balanceOf(distAddr)).to.equal(E(777));
    await distributor.connect(admin).recoverToken(await token.getAddress(), recipient.address);
    expect(await token.balanceOf(recipient.address)).to.equal(E(777));
    expect(await token.balanceOf(distAddr)).to.equal(0n);
    expect(await token.totalSupply()).to.equal(MAX_SUPPLY);
  });
});
