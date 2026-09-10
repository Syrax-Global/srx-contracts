const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ⭐ migrationId is chain-scoped as of 9 Sep 2026: the chain id occupies the high
//    128 bits and the per-chain counter the low 128. Before this, every chain
//    produced ids 1, 2, 3..., so two deployments emitted byte-identical
//    MigrationRequest payloads and a request could replay across chains. These
//    tests previously hardcoded `1n`; they now derive the expected id the same
//    way the contract does, so they assert the scheme rather than a magic number.
const migId = async (n) =>
  (BigInt((await ethers.provider.getNetwork()).chainId) << 128n) | BigInt(n);

describe("ZkSyncMigrator", function () {

  const MIGRATE_AMOUNT = ethers.parseUnits("100000", 18);
  const DEAD_ADDRESS   = "0x000000000000000000000000000000000000dEaD";

  async function deployFixture() {
    const [admin, user1, user2, oracle] = await ethers.getSigners();

    // ── Token ────────────────────────────────────────────────────────────────
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    await token.connect(admin).transfer(user1.address, MIGRATE_AMOUNT * 5n);
    await token.connect(admin).transfer(user2.address, MIGRATE_AMOUNT * 5n);

    // ── Migrator ─────────────────────────────────────────────────────────────
    const ZkSyncMigrator = await ethers.getContractFactory("ZkSyncMigrator");
    const migrator = await ZkSyncMigrator.deploy(await token.getAddress(), admin.address);
    await migrator.waitForDeployment();

    // Grant oracle role
    const ORACLE_ROLE = await migrator.ORACLE_ROLE();
    await migrator.connect(admin).grantRole(ORACLE_ROLE, oracle.address);

    // Grant BURN_ROLE on SRXToken to the migrator so buyAndBurn() works (M-05 fix)
    const BURN_ROLE = await token.BURN_ROLE();
    await token.connect(admin).grantRole(BURN_ROLE, await migrator.getAddress());

    // Approve migrator — migrate() pulls tokens via safeTransferFrom before burning
    // (A2-H-01 fix: buyAndBurn now burns from msg.sender's balance only).
    const migratorAddress = await migrator.getAddress();
    await token.connect(user1).approve(migratorAddress, ethers.MaxUint256);
    await token.connect(user2).approve(migratorAddress, ethers.MaxUint256);

    return { token, migrator, admin, user1, user2, oracle };
  }

  // ── Deployment ──────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("migration is disabled at deployment", async function () {
      const { migrator } = await loadFixture(deployFixture);
      expect(await migrator.migrationEnabled()).to.be.false;
    });

    it("migration is not closed at deployment", async function () {
      const { migrator } = await loadFixture(deployFixture);
      expect(await migrator.migrationClosed()).to.be.false;
    });
  });

  // ── Enable migration ────────────────────────────────────────────────────────

  describe("enableMigration()", function () {
    it("enables migration when called by governance", async function () {
      const { migrator, admin } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      expect(await migrator.migrationEnabled()).to.be.true;
    });

    it("reverts if called twice", async function () {
      const { migrator, admin } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      await expect(
        migrator.connect(admin).enableMigration()
      ).to.be.revertedWithCustomError(migrator, "AlreadyEnabled");
    });

    it("reverts if not governance", async function () {
      const { migrator, user1 } = await loadFixture(deployFixture);
      await expect(
        migrator.connect(user1).enableMigration()
      ).to.be.reverted;
    });
  });

  // ── Migration ───────────────────────────────────────────────────────────────

  describe("migrate()", function () {
    it("burns SRX via buyAndBurn and increments totalBurned", async function () {
      const { token, migrator, admin, user1 } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();

      const beforeBurned = await token.totalBurned();
      await migrator.connect(user1).migrate(MIGRATE_AMOUNT);

      // Tokens are burned via SRXToken.buyAndBurn() — totalBurned is updated (M-05 fix)
      expect(await token.totalBurned()).to.equal(beforeBurned + MIGRATE_AMOUNT);
      // Dead address receives nothing in the new flow
      expect(await token.balanceOf(DEAD_ADDRESS)).to.equal(0n);
    });

    it("decrements user1 token balance", async function () {
      const { token, migrator, admin, user1 } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();

      const before = await token.balanceOf(user1.address);
      await migrator.connect(user1).migrate(MIGRATE_AMOUNT);

      expect(await token.balanceOf(user1.address)).to.equal(before - MIGRATE_AMOUNT);
    });

    it("increments totalMigrated", async function () {
      const { migrator, admin, user1 } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();

      await migrator.connect(user1).migrate(MIGRATE_AMOUNT);
      expect(await migrator.totalMigrated()).to.equal(MIGRATE_AMOUNT);
    });

    it("tracks user migration amount", async function () {
      const { migrator, admin, user1 } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();

      await migrator.connect(user1).migrate(MIGRATE_AMOUNT);
      await migrator.connect(user1).migrate(MIGRATE_AMOUNT);

      expect(await migrator.getUserMigrated(user1.address)).to.equal(MIGRATE_AMOUNT * 2n);
    });

    it("emits MigrationRequest with correct migrationId", async function () {
      const { migrator, admin, user1 } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();

      // Pin the block time instead of predicting it. "latest + 1" was only true
      // when the tx mined within the same wall-clock second; on a slow CI runner it
      // mined a second later and this test failed intermittently (10 Sep 2026).
      const mintedAt = (await time.latest()) + 60;
      await time.setNextBlockTimestamp(mintedAt);

      await expect(migrator.connect(user1).migrate(MIGRATE_AMOUNT))
        .to.emit(migrator, "MigrationRequest")
        .withArgs(
          await migId(1),
          user1.address,
          MIGRATE_AMOUNT,
          mintedAt,
          BigInt((await ethers.provider.getNetwork()).chainId),
        );
    });

    it("returns sequential migrationId", async function () {
      const { migrator, admin, user1, user2 } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();

      const tx1 = await migrator.connect(user1).migrate(MIGRATE_AMOUNT);
      const receipt1 = await tx1.wait();
      const parsed1 = receipt1.logs
        .map(log => { try { return migrator.interface.parseLog(log); } catch { return null; } })
        .find(e => e && e.name === "MigrationRequest");
      const id1 = parsed1.args[0];

      const tx2 = await migrator.connect(user2).migrate(MIGRATE_AMOUNT);
      const receipt2 = await tx2.wait();
      const parsed2 = receipt2.logs
        .map(log => { try { return migrator.interface.parseLog(log); } catch { return null; } })
        .find(e => e && e.name === "MigrationRequest");
      const id2 = parsed2.args[0];

      expect(id2).to.equal(id1 + 1n);
    });

    it("reverts if migration not enabled", async function () {
      const { migrator, user1 } = await loadFixture(deployFixture);
      await expect(
        migrator.connect(user1).migrate(MIGRATE_AMOUNT)
      ).to.be.revertedWithCustomError(migrator, "MigrationNotEnabled");
    });

    it("reverts with zero amount", async function () {
      const { migrator, admin, user1 } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();

      await expect(
        migrator.connect(user1).migrate(0n)
      ).to.be.revertedWithCustomError(migrator, "ZeroAmount");
    });

    it("reverts if migration window closed", async function () {
      const { migrator, admin, user1 } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      await migrator.connect(admin).closeMigration();

      await expect(
        migrator.connect(user1).migrate(MIGRATE_AMOUNT)
      ).to.be.revertedWithCustomError(migrator, "MigrationWindowClosed");
    });
  });

  // ── Oracle confirmation ──────────────────────────────────────────────────────

  describe("confirmMigration()", function () {
    it("oracle can confirm a migration", async function () {
      const { migrator, admin, user1, oracle } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      await migrator.connect(user1).migrate(MIGRATE_AMOUNT);

      await migrator.connect(oracle).confirmMigration(await migId(1), user1.address);
      expect(await migrator.confirmed(await migId(1))).to.be.true;
    });

    it("emits MigrationConfirmed", async function () {
      const { migrator, admin, user1, oracle } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      await migrator.connect(user1).migrate(MIGRATE_AMOUNT);

      await expect(migrator.connect(oracle).confirmMigration(await migId(1), user1.address))
        .to.emit(migrator, "MigrationConfirmed")
        .withArgs(await migId(1), user1.address);
    });

    it("reverts if already confirmed", async function () {
      const { migrator, admin, user1, oracle } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      await migrator.connect(user1).migrate(MIGRATE_AMOUNT);
      await migrator.connect(oracle).confirmMigration(await migId(1), user1.address);

      await expect(migrator.connect(oracle).confirmMigration(await migId(1), user1.address))
        .to.be.revertedWithCustomError(migrator, "AlreadyConfirmed");
    });

    it("reverts if not oracle role", async function () {
      const { migrator, admin, user1, user2 } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      await migrator.connect(user1).migrate(MIGRATE_AMOUNT);

      await expect(migrator.connect(user2).confirmMigration(await migId(1), user1.address))
        .to.be.reverted;
    });

    it("reverts if confirmed user does not match original migrator (A4-L-01)", async function () {
      // A malicious oracle must not be able to attribute a migration to a wrong address.
      const { migrator, admin, user1, user2, oracle } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      await migrator.connect(user1).migrate(MIGRATE_AMOUNT); // migrationId = 1, user = user1

      // Oracle tries to confirm for user2 instead of user1 — must revert
      await expect(migrator.connect(oracle).confirmMigration(await migId(1), user2.address))
        .to.be.revertedWithCustomError(migrator, "UserMismatch");
    });

    it("stores migrationUser snapshot for each migrate() call", async function () {
      const { migrator, admin, user1, user2 } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      await migrator.connect(user1).migrate(MIGRATE_AMOUNT); // id = 1
      await migrator.connect(user2).migrate(MIGRATE_AMOUNT); // id = 2

      expect(await migrator.migrationUser(await migId(1))).to.equal(user1.address);
      expect(await migrator.migrationUser(await migId(2))).to.equal(user2.address);
    });
  });

  // ── Close migration ──────────────────────────────────────────────────────────

  describe("closeMigration()", function () {
    it("closes migration window", async function () {
      const { migrator, admin } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      await migrator.connect(admin).closeMigration();
      expect(await migrator.migrationClosed()).to.be.true;
    });

    it("emits MigrationClosed", async function () {
      const { migrator, admin } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      await expect(migrator.connect(admin).closeMigration())
        .to.emit(migrator, "MigrationClosed");
    });

    it("reverts if not enabled first", async function () {
      const { migrator, admin } = await loadFixture(deployFixture);
      await expect(migrator.connect(admin).closeMigration())
        .to.be.revertedWithCustomError(migrator, "MigrationNotEnabled");
    });
  });

  // ── Round 6: confirmMigration() invalid ID guard (A6-ZK-01) ─────────────────

  describe("confirmMigration() — invalid migration ID guard (A6-ZK-01)", function () {
    it("reverts when confirming a migrationId that was never created", async function () {
      const { migrator, admin, oracle, user1 } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      // migrationId 999 was never created — migrationUser[999] == address(0)
      await expect(migrator.connect(oracle).confirmMigration(999, user1.address))
        .to.be.revertedWithCustomError(migrator, "InvalidMigrationId");
    });

    it("reverts with InvalidMigrationId even when user is address(0) (pre-poisoning attack prevented)", async function () {
      const { migrator, admin, oracle } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();
      // Attacker tries to confirm future sequential ID with address(0)
      // Previously this would succeed and poison future migrations
      await expect(migrator.connect(oracle).confirmMigration(await migId(1), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(migrator, "InvalidMigrationId");
    });

    it("succeeds for a valid migrationId after migrate() is called", async function () {
      const { migrator, admin, oracle, user1, token } = await loadFixture(deployFixture);
      await migrator.connect(admin).enableMigration();

      const amount = ethers.parseUnits("100", 18);
      await token.connect(user1).approve(await migrator.getAddress(), amount);
      const tx = await migrator.connect(user1).migrate(amount);
      const rcpt = await tx.wait();
      const parsed = migrator.interface.parseLog(
        rcpt.logs.find(l => { try { return migrator.interface.parseLog(l)?.name === "MigrationRequest"; } catch { return false; } })
      );
      const migrationId = parsed.args[0];

      // Oracle confirms with correct user — should succeed
      await expect(migrator.connect(oracle).confirmMigration(migrationId, user1.address))
        .to.emit(migrator, "MigrationConfirmed")
        .withArgs(migrationId, user1.address);
    });
  });
});
