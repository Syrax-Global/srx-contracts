// Internal audit 16 Oct 2026.
// M7 (CONTROL-01, CLAIMS-02): unpausing 1 s before a term ended and pausing again in the same
// block gave a fresh 14-day term with no repause block, so the guardian kept the token frozen
// for the whole 30-day budget. Pauses separated by less than TOKEN_REPAUSE_BLOCK are now one
// run, and a run lasts at most TOKEN_PAUSE_MAX_DURATION.
// M12 (CONTROL-06, CLAIMS-01): the guardian could lift a pause governance held, and a pause
// governance made itself once pauseAll had adopted it. Those are now governance's to lift.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;

async function wired() {
  const [admin, guardian, governance, alice, bob] = await ethers.getSigners();
  const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
  await token.connect(admin).genesis(admin.address);
  const gm = await (await ethers.getContractFactory("GuardianModule"))
    .deploy(admin.address, guardian.address, governance.address, 180 * DAY);
  const TOKEN = await gm.MODULE_TOKEN();
  await gm.connect(governance).registerModule(TOKEN, await token.getAddress());
  await token.connect(admin).grantRole(await token.PAUSER_ROLE(), await gm.getAddress());
  await token.connect(admin).transfer(alice.address, E(1000));
  return { admin, guardian, governance, alice, bob, token, gm, TOKEN };
}

/** Unpause and re-pause in ONE block (a Safe MultiSend makes it one transaction). */
async function flipInOneBlock(gm, guardian, TOKEN) {
  await ethers.provider.send("evm_setAutomine", [false]);
  const a = await gm.connect(guardian).unpauseModule(TOKEN, "end", { gasLimit: 500_000 });
  const b = await gm.connect(guardian).pauseModule(TOKEN, "again", { gasLimit: 500_000 });
  await ethers.provider.send("evm_mine", []);
  await ethers.provider.send("evm_setAutomine", [true]);
  return [await ethers.provider.getTransactionReceipt(a.hash), await ethers.provider.getTransactionReceipt(b.hash)];
}

describe("Internal audit M7: a guardian token pause run lasts at most 14 days", function () {
  it("an early unpause and re-pause continues the same run: the token is free again by day 14", async function () {
    const { gm, guardian, TOKEN, token, alice, bob } = await loadFixture(wired);
    await gm.connect(guardian).pauseModule(TOKEN, "incident");
    const start = BigInt(await time.latest());
    await time.increaseTo((await gm.tokenPauseEndsAt()) - 2n);
    const [ra, rb] = await flipInOneBlock(gm, guardian, TOKEN);
    expect(ra.status).to.equal(1);
    expect(rb.status).to.equal(1);
    // The new term is only what is left of the run (about 2 s), not a fresh 14 days.
    expect(await gm.tokenPauseEndsAt()).to.be.lte(start + BigInt(14 * DAY));
    await time.increaseTo(await gm.tokenPauseEndsAt());
    await gm.lapseTokenPause();
    expect(await token.paused()).to.equal(false);
    await token.connect(alice).transfer(bob.address, 1n);
    // A full run starts the 7-day block (checked past the per-module cooldown).
    await time.increase(DAY);
    await expect(gm.connect(guardian).pauseModule(TOKEN, "again"))
      .to.be.revertedWithCustomError(gm, "TokenRepauseBlocked");
  });

  it("a run that is used up blocks a re-pause until 7 days after it ended", async function () {
    const { gm, guardian, TOKEN } = await loadFixture(wired);
    await gm.connect(guardian).pauseModule(TOKEN, "incident");
    await time.increase(14 * DAY - 10);
    await gm.connect(guardian).unpauseModule(TOKEN, "early");  // 10 s short of the term
    await time.increase(DAY);                                     // a 1-day break only
    // Run has ~10 s left: a pause is possible but only for what is left.
    await gm.connect(guardian).pauseModule(TOKEN, "again");
    const t = BigInt(await time.latest());
    expect((await gm.tokenPauseEndsAt()) - t).to.be.lte(10n);
    await time.increaseTo(await gm.tokenPauseEndsAt());
    await gm.lapseTokenPause();
    await time.increase(DAY);                                     // past the per-module cooldown
    await expect(gm.connect(guardian).pauseModule(TOKEN, "third"))
      .to.be.revertedWithCustomError(gm, "TokenRepauseBlocked");
    const [ok] = await gm.tokenPauseAvailable();
    expect(ok).to.equal(false);
  });

  it("control: after a break of 7 days a new run gets a full 14-day term (within the budget)", async function () {
    const { gm, guardian, TOKEN } = await loadFixture(wired);
    await gm.connect(guardian).pauseModule(TOKEN, "incident");
    await time.increase(3 * DAY);
    await gm.connect(guardian).unpauseModule(TOKEN, "false alarm");
    await time.increase(7 * DAY);
    await gm.connect(guardian).pauseModule(TOKEN, "real incident");
    const t = BigInt(await time.latest());
    expect(await gm.tokenPauseEndsAt()).to.equal(t + BigInt(14 * DAY));
  });
});

describe("Internal audit M12: the guardian cannot lift a pause that is governance's", function () {
  it("after governanceHoldTokenPause the guardian's unpause reverts; governance lifts it", async function () {
    const { gm, guardian, governance, TOKEN, token } = await loadFixture(wired);
    await gm.connect(guardian).pauseModule(TOKEN, "incident");
    await gm.connect(governance).governanceHoldTokenPause("exploit still live");
    await expect(gm.connect(guardian).unpauseModule(TOKEN, "override"))
      .to.be.revertedWithCustomError(gm, "GovernanceOnlyUnpause").withArgs(TOKEN);
    expect(await token.paused()).to.equal(true);
    await gm.connect(governance).governanceUnpause(TOKEN, "resolved");
    expect(await token.paused()).to.equal(false);
    expect(await gm.governanceOnlyUnpause(TOKEN)).to.equal(false);
  });

  it("a pause governance made directly, adopted by pauseAll, is not the guardian's to lift", async function () {
    const { gm, admin, guardian, governance, TOKEN, token } = await loadFixture(wired);
    await token.connect(admin).grantRole(await token.PAUSER_ROLE(), governance.address);
    await token.connect(governance).pause();
    await gm.connect(guardian).pauseAll("sync");
    expect(await gm.isModulePaused(TOKEN)).to.equal(true);
    await expect(gm.connect(guardian).unpauseModule(TOKEN, "lift"))
      .to.be.revertedWithCustomError(gm, "GovernanceOnlyUnpause");
    await gm.connect(governance).emergencyUnpauseAll("governance lifts its own pause");
    expect(await token.paused()).to.equal(false);
  });

  it("control: the guardian still lifts its own pause", async function () {
    const { gm, guardian, TOKEN, token } = await loadFixture(wired);
    await gm.connect(guardian).pauseModule(TOKEN, "incident");
    await gm.connect(guardian).unpauseModule(TOKEN, "false alarm");
    expect(await token.paused()).to.equal(false);
  });
});
