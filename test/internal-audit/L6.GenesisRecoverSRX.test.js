// Internal audit 16 Oct 2026, L6 (DIST-03): PreSaleRound.recoverSRX took the whole SRX balance,
// including what buyers without a vault yet are owed, while its withdraw* twins keep refunds
// owed. A 1-wei donation then forced the operator through it. It now recovers only the surplus.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { approveBuyers } = require("../helpers/buyers");

const U6 = (n) => BigInt(n) * 10n ** 6n;

async function genesisRound() {
  const [admin, b1, b2, outsider, treasury] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(lz.target, admin.address);
  await token.connect(admin).genesis(admin.address);
  const M = await ethers.getContractFactory("MockERC20");
  const usdc = await M.deploy("USD Coin", "USDC", 6);
  const usdt = await M.deploy("Tether USD", "USDT", 6);
  const wbtc = await M.deploy("Wrapped BTC", "WBTC", 8);
  const F = await ethers.getContractFactory("MockChainlinkFeed");
  const ethFeed = await F.deploy(2_500n * 10n ** 8n);
  const btcFeed = await F.deploy(60_000n * 10n ** 8n);
  const r = await (await ethers.getContractFactory("PreSaleRound")).deploy(
    token.target, usdc.target, usdt.target, wbtc.target, ethFeed.target, btcFeed.target,
    admin.address, ethers.parseUnits("300000000", 18), 1_250_000n, true, 5_000n, treasury.address);
  await approveBuyers(r, admin, [b1, b2]);
  for (const w of [b1, b2]) {
    await usdc.mint(w.address, U6(1_000_000));
    await usdc.connect(w).approve(r.target, ethers.MaxUint256);
  }
  await r.connect(b1).investWithUSDC(U6(10_000));
  await r.connect(b2).investWithUSDC(U6(20_000));
  await r.connect(admin).finalize();
  const sold = await r.totalAllocated();
  await token.connect(admin).transfer(r.target, sold);
  return { r, token, admin, b1, outsider, sold };
}

describe("Internal audit L6: recoverSRX never takes what buyers are owed", function () {
  it("after a 1-wei donation, recoverSRX returns exactly the 1 wei and every vault can still be funded", async function () {
    const { r, token, admin, b1, outsider } = await genesisRound();
    await token.connect(admin).transfer(outsider.address, 1n);
    await token.connect(outsider).transfer(r.target, 1n);
    await expect(r.connect(admin).recoverSRX(admin.address))
      .to.changeTokenBalances(token, [r, admin], [-1n, 1n]);
    expect(await token.balanceOf(r.target)).to.equal(await r.pendingDeployment());
    await r.connect(admin).deployVault(b1.address);
  });

  it("with nothing above what buyers are owed, recoverSRX recovers nothing", async function () {
    const { r, admin } = await genesisRound();
    await expect(r.connect(admin).recoverSRX(admin.address)).to.be.revertedWithCustomError(r, "ZeroAmount");
  });
});
