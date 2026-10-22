// Internal audit 16 Oct 2026, L15 (CONTROL-09, CLAIMS-07): a guardian pause still standing at the
// sunset could only be lifted by a vote. After the sunset anyone may now lift a pause the
// guardian left; a pause that is governance's stays governance's.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const DAY = 86_400;

async function wired() {
  const [admin, guardian, governance, stranger] = await ethers.getSigners();
  const gm = await (await ethers.getContractFactory("GuardianModule"))
    .deploy(admin.address, guardian.address, governance.address, 30 * DAY);
  const stub = await (await ethers.getContractFactory("PausableStub")).deploy();
  const STAKING = await gm.MODULE_STAKING();
  const TREASURY = await gm.MODULE_TREASURY();
  const stub2 = await (await ethers.getContractFactory("PausableStrictStub")).deploy();
  await gm.connect(governance).registerModule(STAKING, await stub.getAddress());
  await gm.connect(governance).registerModule(TREASURY, await stub2.getAddress());
  return { gm, stub, stub2, guardian, governance, stranger, STAKING, TREASURY };
}

describe("Internal audit L15: a guardian pause does not outlive the guardian", function () {
  it("after the sunset a stranger lifts a pause the guardian made just before it", async function () {
    const { gm, stub, guardian, stranger, STAKING } = await wired();
    await time.increaseTo((await gm.effectiveSunset()) - 60n);
    await gm.connect(guardian).pauseModule(STAKING, "late pause");
    await expect(gm.connect(stranger).releaseAfterSunset(STAKING))
      .to.be.revertedWithCustomError(gm, "GuardianNotExpired");
    await time.increaseTo(await gm.effectiveSunset());
    await expect(gm.connect(guardian).unpauseModule(STAKING, "too late")).to.be.revertedWithCustomError(gm, "GuardianExpired");
    await gm.connect(stranger).releaseAfterSunset(STAKING);
    expect(await stub.paused()).to.equal(false);
    expect(await gm.isModulePaused(STAKING)).to.equal(false);
  });

  it("a pause adopted from outside stays governance's after the sunset", async function () {
    const { gm, stub2, guardian, stranger, TREASURY } = await wired();
    await stub2.pause();                                   // paused outside the module
    await gm.connect(guardian).pauseAll("sync");           // adopted by reconcile
    await time.increaseTo(await gm.effectiveSunset());
    await expect(gm.connect(stranger).releaseAfterSunset(TREASURY))
      .to.be.revertedWithCustomError(gm, "GovernanceOnlyUnpause");
  });
});
