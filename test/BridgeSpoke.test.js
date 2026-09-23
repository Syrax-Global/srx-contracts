// SRXOFTNative (a spoke chain's SRX) — the paths the hub-and-spoke proofs in
// test/audit-poc/pre-external-audit.test.js do not reach: burning on the spoke,
// pausing and unpausing, two-step ownership, and interface reporting.
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
  const [admin, user, other] = await ethers.getSigners();
  const Ep = await ethers.getContractFactory("MockLZEndpoint");
  const ep = await Ep.deploy(SPOKE);
  const N = await ethers.getContractFactory("SRXOFTNative");
  const native = await N.deploy(await ep.getAddress(), admin.address, HUB);
  const hubPeer = b32(admin.address);
  await native.connect(admin).setPeer(HUB, hubPeer);
  const epSigner = await impersonate(await ep.getAddress());
  // Arrive from the hub, the only way SRX exists on a spoke.
  const arrive = (to, amount, nonce = 1) => native.connect(epSigner).lzReceive(
    { srcEid: HUB, sender: hubPeer, nonce }, ethers.ZeroHash, msgTo(to, amount), ethers.ZeroAddress, "0x");
  return { admin, user, other, native, arrive };
}

describe("SRXOFTNative — spoke paths", function () {
  it("rejects a zero hub at deployment", async function () {
    const [admin] = await ethers.getSigners();
    const Ep = await ethers.getContractFactory("MockLZEndpoint");
    const ep = await Ep.deploy(SPOKE);
    const N = await ethers.getContractFactory("SRXOFTNative");
    await expect(N.deploy(await ep.getAddress(), admin.address, 0)).to.be.revertedWithCustomError(N, "NotHub");
  });

  it("buyAndBurn burns only the caller's own SRX, needs BURN_ROLE, and refuses zero", async function () {
    const { admin, user, native, arrive } = await spoke();
    await arrive(admin.address, E(100));
    await arrive(user.address, E(50), 2);

    await expect(native.connect(user).buyAndBurn(E(1))).to.be.revertedWithCustomError(native, "AccessControlUnauthorizedAccount");
    await expect(native.connect(admin).buyAndBurn(0)).to.be.revertedWithCustomError(native, "ZeroAmount");

    await expect(native.connect(admin).buyAndBurn(E(40)))
      .to.emit(native, "BuyAndBurn").withArgs(admin.address, E(40));
    expect(await native.balanceOf(admin.address)).to.equal(E(60));
    expect(await native.balanceOf(user.address)).to.equal(E(50));   // untouched
    expect(await native.totalBurned()).to.equal(E(40));
    expect(await native.totalSupply()).to.equal(E(110));
  });

  it("a pause stops transfers and an unpause restores them; only PAUSER_ROLE can do either", async function () {
    const { admin, user, other, native, arrive } = await spoke();
    await arrive(user.address, E(10));
    await expect(native.connect(user).pause()).to.be.revertedWithCustomError(native, "AccessControlUnauthorizedAccount");
    await native.connect(admin).pause();
    await expect(native.connect(user).transfer(other.address, E(1))).to.be.revertedWithCustomError(native, "EnforcedPause");
    await expect(native.connect(user).unpause()).to.be.revertedWithCustomError(native, "AccessControlUnauthorizedAccount");
    await native.connect(admin).unpause();
    await native.connect(user).transfer(other.address, E(1));
    expect(await native.balanceOf(other.address)).to.equal(E(1));
  });

  it("ownership moves only when the new owner accepts, and cannot be renounced", async function () {
    const { admin, user, native } = await spoke();
    await native.connect(admin).transferOwnership(user.address);
    expect(await native.owner()).to.equal(admin.address);
    expect(await native.pendingOwner()).to.equal(user.address);
    await native.connect(user).acceptOwnership();
    expect(await native.owner()).to.equal(user.address);
    await expect(native.connect(user).renounceOwnership()).to.be.revertedWithCustomError(native, "OwnershipCannotBeRenounced");
  });

  it("reports the AccessControl interface and not an arbitrary one", async function () {
    const { native } = await spoke();
    expect(await native.supportsInterface("0x7965db0b")).to.equal(true);  // IAccessControl
    expect(await native.supportsInterface("0x01ffc9a7")).to.equal(true);  // IERC165
    expect(await native.supportsInterface("0xffffffff")).to.equal(false);
  });
});
