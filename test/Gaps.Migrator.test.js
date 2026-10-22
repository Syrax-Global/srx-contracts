// Gap-closing tests for ZkSyncMigrator. Fixture follows test/Migration.test.js.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (n) => ethers.parseUnits(String(n), 18);

async function deployFixture() {
  const [admin, user1, user2, stranger] = await ethers.getSigners();
  const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
  await token.connect(admin).genesis(admin.address);
  await token.connect(admin).transfer(user1.address, E(500_000));
  await token.connect(admin).transfer(user2.address, E(500_000));

  const migrator = await (await ethers.getContractFactory("ZkSyncMigrator")).deploy(await token.getAddress(), admin.address);
  await token.connect(admin).grantRole(await token.BURN_ROLE(), await migrator.getAddress());
  await token.connect(user1).approve(await migrator.getAddress(), ethers.MaxUint256);
  await token.connect(user2).approve(await migrator.getAddress(), ethers.MaxUint256);
  return { token, migrator, admin, user1, user2, stranger };
}

describe("Gaps — ZkSyncMigrator", function () {
  it("M1 after migrate: the migrator holds 0 SRX, a non-migrating holder is untouched, totalSupply fell by the amount", async function () {
    const { token, migrator, admin, user1, user2 } = await loadFixture(deployFixture);
    await migrator.connect(admin).enableMigration();
    const supplyBefore = await token.totalSupply();
    const user2Before = await token.balanceOf(user2.address);
    const user1Before = await token.balanceOf(user1.address);

    await migrator.connect(user1).migrate(E(123_456));

    expect(await token.balanceOf(await migrator.getAddress())).to.equal(0n);
    expect(await token.balanceOf(user2.address)).to.equal(user2Before);
    expect(await token.balanceOf(user1.address)).to.equal(user1Before - E(123_456));
    expect(await token.totalSupply()).to.equal(supplyBefore - E(123_456));
    expect(await migrator.totalMigrated()).to.equal(E(123_456));
  });

  it("M2a enableMigration after closeMigration reverts AlreadyEnabled (it stays enabled; the window cannot be reopened)", async function () {
    const { migrator, admin, user1 } = await loadFixture(deployFixture);
    await migrator.connect(admin).enableMigration();
    await migrator.connect(admin).closeMigration();
    await expect(migrator.connect(admin).enableMigration()).to.be.revertedWithCustomError(migrator, "AlreadyEnabled");
    expect(await migrator.migrationClosed()).to.equal(true);
    // And the closed window really refuses burns.
    await expect(migrator.connect(user1).migrate(E(1))).to.be.revertedWithCustomError(migrator, "MigrationWindowClosed");
  });

  it("M2b closeMigration twice reverts AlreadyClosed", async function () {
    const { migrator, admin } = await loadFixture(deployFixture);
    await migrator.connect(admin).enableMigration();
    await expect(migrator.connect(admin).closeMigration()).to.emit(migrator, "MigrationClosed");
    await expect(migrator.connect(admin).closeMigration()).to.be.revertedWithCustomError(migrator, "AlreadyClosed");
  });

  it("M2c closeMigration by a non-governance caller reverts; governance's identical call works (control)", async function () {
    const { migrator, admin, user1, stranger } = await loadFixture(deployFixture);
    await migrator.connect(admin).enableMigration();
    await expect(migrator.connect(stranger).closeMigration())
      .to.be.revertedWithCustomError(migrator, "AccessControlUnauthorizedAccount");
    await expect(migrator.connect(user1).closeMigration())
      .to.be.revertedWithCustomError(migrator, "AccessControlUnauthorizedAccount");
    expect(await migrator.migrationClosed()).to.equal(false);
    await migrator.connect(admin).closeMigration();
    expect(await migrator.migrationClosed()).to.equal(true);
  });

  it("M3 migrate() reverts EnforcedPause while SRXToken is paused, moving nothing; works after unpause", async function () {
    const { token, migrator, admin, user1 } = await loadFixture(deployFixture);
    await migrator.connect(admin).enableMigration();
    await token.connect(admin).pause();
    const before = await token.balanceOf(user1.address);
    const supply = await token.totalSupply();

    await expect(migrator.connect(user1).migrate(E(1_000))).to.be.revertedWithCustomError(token, "EnforcedPause");
    expect(await token.balanceOf(user1.address)).to.equal(before);
    expect(await token.totalSupply()).to.equal(supply);
    expect(await migrator.totalMigrated()).to.equal(0n);
    expect(await migrator.migrationCount()).to.equal(0n);

    await token.connect(admin).unpause();
    await migrator.connect(user1).migrate(E(1_000));
    expect(await token.balanceOf(user1.address)).to.equal(before - E(1_000));
    expect(await token.totalSupply()).to.equal(supply - E(1_000));
    expect(await migrator.totalMigrated()).to.equal(E(1_000));
  });
});
