// External report, 14 Oct 2026 (board 585533e0, Security verdict: valid, Low).
// SRX at the spoke's own address could never leave. Fix: an ordinary transfer to the
// spoke is refused, a bridge arrival addressed to it is still accepted (reverting in
// _credit would strand the LayerZero message), and the owner (this chain's Timelock)
// can rescue it.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseUnits(String(n), 18);
const HUB = 40161, SPOKE = 40102;
const b32 = (a) => ethers.zeroPadValue(a, 32);
const msgTo = (to, amountLD) => ethers.concat([b32(to), ethers.toBeHex(amountLD / 10n ** 12n, 8)]);

async function impersonate(addr) {
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  await ethers.provider.send("hardhat_setBalance", [addr, "0x21e19e0c9bab2400000"]);
  return ethers.getSigner(addr);
}

async function spoke() {
  const [owner, user, other] = await ethers.getSigners();
  const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(SPOKE);
  const native = await (await ethers.getContractFactory("SRXOFTNative"))
    .deploy(await ep.getAddress(), owner.address, HUB, owner.address);
  const hubPeer = b32(owner.address);
  await native.connect(owner).setPeer(HUB, hubPeer);
  const epSigner = await impersonate(await ep.getAddress());
  const arrive = (to, amount, nonce = 1) => native.connect(epSigner).lzReceive(
    { srcEid: HUB, sender: hubPeer, nonce }, ethers.ZeroHash, msgTo(to, amount), ethers.ZeroAddress, "0x");
  return { owner, user, other, native, arrive };
}

describe("EXT 14 Oct: SRX stranded at the spoke's own address (585533e0)", function () {
  it("an ordinary transfer to the spoke is refused, by transfer and by transferFrom", async function () {
    const { user, other, native, arrive } = await spoke();
    await arrive(user.address, E(10));
    const self = await native.getAddress();
    await expect(native.connect(user).transfer(self, E(1)))
      .to.be.revertedWithCustomError(native, "TransferToTokenContract");
    await native.connect(user).approve(other.address, E(1));
    await expect(native.connect(other).transferFrom(user.address, self, E(1)))
      .to.be.revertedWithCustomError(native, "TransferToTokenContract");
    expect(await native.balanceOf(self)).to.equal(0);
  });

  it("a bridge arrival addressed to the spoke is still delivered, not reverted", async function () {
    const { native, arrive } = await spoke();
    const self = await native.getAddress();
    await arrive(self, E(7));
    expect(await native.balanceOf(self)).to.equal(E(7));
  });

  it("the owner rescues SRX held at the spoke; the supply is unchanged", async function () {
    const { owner, other, native, arrive } = await spoke();
    const self = await native.getAddress();
    await arrive(self, E(7));
    const supply = await native.totalSupply();
    await expect(native.connect(owner).rescueTokens(self, other.address, E(7)))
      .to.emit(native, "TokenRescued").withArgs(self, other.address, E(7));
    expect(await native.balanceOf(other.address)).to.equal(E(7));
    expect(await native.balanceOf(self)).to.equal(0);
    expect(await native.totalSupply()).to.equal(supply);
    expect(await native.totalBurned()).to.equal(0);
  });

  it("the owner rescues a foreign ERC-20 sent to the spoke", async function () {
    const { owner, other, native } = await spoke();
    const t = await (await ethers.getContractFactory("MockERC20")).deploy("T", "T", 18);
    await t.mint(await native.getAddress(), E(3));
    await native.connect(owner).rescueTokens(await t.getAddress(), other.address, E(3));
    expect(await t.balanceOf(other.address)).to.equal(E(3));
  });

  it("only the owner may rescue; zero, self and zero-amount are refused", async function () {
    const { owner, user, native, arrive } = await spoke();
    const self = await native.getAddress();
    await arrive(self, E(2));
    await expect(native.connect(user).rescueTokens(self, user.address, E(1)))
      .to.be.revertedWithCustomError(native, "OwnableUnauthorizedAccount");
    await expect(native.connect(owner).rescueTokens(self, ethers.ZeroAddress, E(1)))
      .to.be.revertedWithCustomError(native, "ZeroAddress");
    await expect(native.connect(owner).rescueTokens(self, self, E(1)))
      .to.be.revertedWithCustomError(native, "ZeroAddress");
    await expect(native.connect(owner).rescueTokens(self, user.address, 0))
      .to.be.revertedWithCustomError(native, "ZeroAmount");
  });

  it("a rescue waits while the spoke is paused, like every transfer", async function () {
    const { owner, other, native, arrive } = await spoke();
    const self = await native.getAddress();
    await arrive(self, E(2));
    await native.connect(owner).pause();
    await expect(native.connect(owner).rescueTokens(self, other.address, E(2)))
      .to.be.revertedWithCustomError(native, "EnforcedPause");
    await native.connect(owner).unpause();
    await native.connect(owner).rescueTokens(self, other.address, E(2));
    expect(await native.balanceOf(other.address)).to.equal(E(2));
  });

  it("control: an ordinary holder-to-holder transfer still works", async function () {
    const { user, other, native, arrive } = await spoke();
    await arrive(user.address, E(5));
    await native.connect(user).transfer(other.address, E(5));
    expect(await native.balanceOf(other.address)).to.equal(E(5));
  });
});
