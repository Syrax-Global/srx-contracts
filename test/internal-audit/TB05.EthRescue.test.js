// Internal audit TB-05 / Aderyn H-1 (22 Oct 2026): native value delivered with a bridge
// message (lzReceive is payable) was stranded on the hub and on every spoke. rescueTokens
// now moves ETH too (token == address(0)), behind the same 48-hour authority as before.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const ONE = ethers.parseEther("1");

async function strand(addr) {
  await network.provider.send("hardhat_setBalance", [addr, ethers.toBeHex(ONE)]);
}

describe("Internal audit TB-05: stranded ETH is rescuable on hub and spoke", function () {
  it("hub: DEFAULT_ADMIN (the Timelock) rescues it; anyone else is refused", async function () {
    const [admin, other, to] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
    const hub = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await strand(await hub.getAddress());
    await expect(hub.connect(other).rescueTokens(ethers.ZeroAddress, to.address, ONE)).to.be.reverted;
    await expect(hub.connect(admin).rescueTokens(ethers.ZeroAddress, to.address, ONE))
      .to.changeEtherBalances([hub, to], [-ONE, ONE]);
  });

  it("spoke: the owner (its Timelock) rescues it; anyone else is refused", async function () {
    const [owner, other, to] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40102);
    const spoke = await (await ethers.getContractFactory("SRXOFTNative"))
      .deploy(await ep.getAddress(), owner.address, 40161, owner.address);
    await strand(await spoke.getAddress());
    await expect(spoke.connect(other).rescueTokens(ethers.ZeroAddress, to.address, ONE))
      .to.be.revertedWithCustomError(spoke, "OwnableUnauthorizedAccount");
    await expect(spoke.connect(owner).rescueTokens(ethers.ZeroAddress, to.address, ONE))
      .to.changeEtherBalances([spoke, to], [-ONE, ONE]);
  });
});
