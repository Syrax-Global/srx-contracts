// SRXTimelock: the 48-hour delay is enforced by the contract, not only by the deploy script
// (internal review, 7 Oct 2026), and the role rules the docs state are tested.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const DELAY = 172_800; // 48 hours

describe("SRXTimelock — the delay floor and who may do what", function () {
  async function fixture() {
    const [proposer, safe, stranger] = await ethers.getSigners();
    const T = await ethers.getContractFactory("SRXTimelock");
    // Proposer (the Governor in production); executors open; no admin.
    const tl = await T.deploy(DELAY, [proposer.address], [ethers.ZeroAddress], ethers.ZeroAddress);
    // The Safe keeps CANCELLER only (veto), as 02_deploy_governance sets up.
    await tl.connect(proposer).schedule(
      await tl.getAddress(), 0,
      tl.interface.encodeFunctionData("grantRole", [await tl.CANCELLER_ROLE(), safe.address]),
      ethers.ZeroHash, ethers.id("grant-canceller"), DELAY);
    await time.increase(DELAY);
    await tl.execute(await tl.getAddress(), 0,
      tl.interface.encodeFunctionData("grantRole", [await tl.CANCELLER_ROLE(), safe.address]),
      ethers.ZeroHash, ethers.id("grant-canceller"));
    return { tl, proposer, safe, stranger };
  }

  async function viaTimelock(tl, proposer, data, salt) {
    const target = await tl.getAddress();
    await tl.connect(proposer).schedule(target, 0, data, ethers.ZeroHash, salt, await tl.getMinDelay());
    await time.increase(Number(await tl.getMinDelay()));
    return tl.execute(target, 0, data, ethers.ZeroHash, salt);
  }

  it("records the deployed delay as the floor", async function () {
    const { tl } = await loadFixture(fixture);
    expect(await tl.minDelayFloor()).to.equal(DELAY);
    expect(await tl.getMinDelay()).to.equal(DELAY);
  });

  it("a passed proposal cannot lower the delay below the floor (updateDelay(0) is refused)", async function () {
    const { tl, proposer } = await loadFixture(fixture);
    const data = tl.interface.encodeFunctionData("updateDelay", [0]);
    await expect(viaTimelock(tl, proposer, data, ethers.id("to-zero")))
      .to.be.revertedWithCustomError(tl, "DelayBelowFloor").withArgs(0, DELAY);
    expect(await tl.getMinDelay()).to.equal(DELAY);
  });

  it("raising the delay through a proposal still works (control)", async function () {
    const { tl, proposer } = await loadFixture(fixture);
    await viaTimelock(tl, proposer, tl.interface.encodeFunctionData("updateDelay", [259_200]), ethers.id("to-72h"));
    expect(await tl.getMinDelay()).to.equal(259_200);
  });

  it("nobody can call updateDelay directly", async function () {
    const { tl, stranger } = await loadFixture(fixture);
    await expect(tl.connect(stranger).updateDelay(DELAY * 2)).to.be.revertedWithCustomError(tl, "TimelockUnauthorizedCaller");
  });

  it("only the proposer can schedule; the Safe (canceller only) cannot", async function () {
    const { tl, safe, stranger } = await loadFixture(fixture);
    const args = [await tl.getAddress(), 0, "0x", ethers.ZeroHash, ethers.id("x"), DELAY];
    await expect(tl.connect(safe).schedule(...args)).to.be.revertedWithCustomError(tl, "AccessControlUnauthorizedAccount");
    await expect(tl.connect(stranger).schedule(...args)).to.be.revertedWithCustomError(tl, "AccessControlUnauthorizedAccount");
  });

  it("an operation cannot execute before the delay; the Safe can cancel it", async function () {
    const { tl, proposer, safe } = await loadFixture(fixture);
    const target = await tl.getAddress();
    const data = tl.interface.encodeFunctionData("updateDelay", [DELAY * 2]);
    await tl.connect(proposer).schedule(target, 0, data, ethers.ZeroHash, ethers.id("early"), DELAY);
    await time.increase(DELAY - 10);
    await expect(tl.execute(target, 0, data, ethers.ZeroHash, ethers.id("early")))
      .to.be.revertedWithCustomError(tl, "TimelockUnexpectedOperationState");
    const id = await tl.hashOperation(target, 0, data, ethers.ZeroHash, ethers.id("early"));
    await tl.connect(safe).cancel(id);
    expect(await tl.isOperation(id)).to.equal(false);
  });
});
