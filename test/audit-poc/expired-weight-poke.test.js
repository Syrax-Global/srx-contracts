const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
describe("poke closes the expired-multiplier window", function () {
  it("a third party can strip a stale 2.00x weight", async function () {
    const [admin, u1, keeper] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await token.connect(admin).genesis(admin.address);
    const S = await ethers.getContractFactory("SRXStaking");
    const { upgrades } = require("hardhat");
    const st = await upgrades.deployProxy(S, [await token.getAddress(), admin.address], { kind: "uups" });
    await token.connect(admin).transfer(u1.address, ethers.parseUnits("100000", 18));
    await token.connect(u1).approve(await st.getAddress(), ethers.MaxUint256);
    await st.connect(u1).lock(ethers.parseUnits("100000", 18), 180 * 86400);
    const before = (await st.positions(u1.address)).weightedAmount;
    await time.increase(181 * 86400);
    console.log("      weight while locked      :", ethers.formatUnits(before, 18));
    await st.connect(keeper).pokeExpiredPosition(u1.address);
    const after = (await st.positions(u1.address)).weightedAmount;
    console.log("      weight after 3rd-party poke:", ethers.formatUnits(after, 18));
    expect(before).to.equal(ethers.parseUnits("200000", 18)); // 2.00x
    expect(after).to.equal(ethers.parseUnits("100000", 18));  // back to principal
    expect(await st.totalWeightedStake()).to.equal(after);
  });
});
