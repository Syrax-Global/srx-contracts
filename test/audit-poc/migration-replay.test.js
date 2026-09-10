const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("MIGRATION LENS PoC", function () {
  const E = (n) => ethers.parseUnits(String(n), 18);

  async function fx() {
    const [admin, timelock, oracle, user] = await ethers.getSigners();
    const EP = await ethers.getContractFactory("MockLZEndpoint");
    const ep = await EP.deploy(40161); await ep.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    // Two independent "chains" simulated by two token+migrator pairs
    const tokenA = await SRXToken.deploy(await ep.getAddress(), admin.address);
    await tokenA.waitForDeployment();
    await tokenA.connect(admin).genesis(admin.address);
    const tokenB = await SRXToken.deploy(await ep.getAddress(), admin.address);
    await tokenB.waitForDeployment();
    await tokenB.connect(admin).genesis(admin.address);

    const M = await ethers.getContractFactory("ZkSyncMigrator");
    const migA = await M.deploy(await tokenA.getAddress(), admin.address); await migA.waitForDeployment();
    const migB = await M.deploy(await tokenB.getAddress(), admin.address); await migB.waitForDeployment();

    return { admin, timelock, oracle, user, tokenA, tokenB, migA, migB };
  }

  // ✅ FIXED 9 Sep 2026 in scripts/deploy/09_deploy_migrator.js.
  //    ⚠️ This case REPLICATES the script's role logic inline rather than running
  //    the script, so it does not track script edits on its own. It is updated
  //    deliberately alongside the fix; if the script changes again this must be
  //    revisited, which is the honest cost of simulating a script in a unit test.
  it("PoC-1: [FIXED] the deployment key does not retain GOVERNANCE_ROLE", async function () {
    const { admin, timelock, migA } = await loadFixture(fx);
    const GOV = await migA.GOVERNANCE_ROLE();

    // replicate the CORRECTED scripts/deploy/09_deploy_migrator.js step 5
    await migA.connect(admin).grantRole(GOV, timelock.address);
    const deployer = admin; // the scripts require the deployer to BE WALLETS.admin
    for (const holder of new Set([deployer.address, admin.address])) {
      if (holder.toLowerCase() === timelock.address.toLowerCase()) continue;
      if (await migA.hasRole(GOV, holder)) {
        await migA.connect(admin).revokeRole(GOV, holder);
      }
    }

    expect(await migA.hasRole(GOV, timelock.address)).to.equal(true);
    // ⭐ The old condition was `&& deployer !== WALLETS.admin`, which skipped the
    //    revoke in exactly the configuration these scripts require.
    expect(await migA.hasRole(GOV, admin.address)).to.equal(false);

    // ...so the admin can no longer unilaterally close the migration window.
    await expect(migA.connect(admin).enableMigration()).to.be.reverted;

    // ⚠️ NOT A GUARANTEE, AND SAID SO PLAINLY: admin still holds
    //    DEFAULT_ADMIN_ROLE, and no role's admin is set via _setRoleAdmin
    //    anywhere in this suite, so it can re-grant GOVERNANCE_ROLE to itself in
    //    one transaction. This is a starting posture, not an on-chain control.
    await migA.connect(admin).grantRole(GOV, admin.address);
    expect(await migA.hasRole(GOV, admin.address)).to.equal(true);
  });

  // ✅ FIXED 9 Sep 2026 — 09_deploy_migrator.js now grants BURN_ROLE as step 4,
  //    and exits non-zero if the deployer cannot. Same replication caveat as PoC-1.
  it("PoC-2: [FIXED] migrate() works once the deploy script grants BURN_ROLE", async function () {
    const { admin, user, tokenA, migA } = await loadFixture(fx);

    // Without the grant it reverts -- this is what shipped.
    await tokenA.connect(admin).transfer(user.address, E(1000));
    await tokenA.connect(user).approve(await migA.getAddress(), ethers.MaxUint256);
    await migA.connect(admin).enableMigration();
    await expect(migA.connect(user).migrate(E(1000))).to.be.reverted;

    // The corrected script performs exactly this.
    await tokenA.connect(admin).grantRole(await tokenA.BURN_ROLE(), await migA.getAddress());

    await expect(migA.connect(user).migrate(E(1000))).to.not.be.reverted;
    expect(await migA.totalMigrated()).to.equal(E(1000));
  });

  it("PoC-3: [FIXED] the migration id is chain-scoped, so a request cannot replay across chains", async function () {
    const { admin, user, tokenA, tokenB, migA, migB } = await loadFixture(fx);
    const BURN = await tokenA.BURN_ROLE();
    await tokenA.connect(admin).grantRole(BURN, await migA.getAddress());
    await tokenB.connect(admin).grantRole(BURN, await migB.getAddress());
    await migA.connect(admin).enableMigration();
    await migB.connect(admin).enableMigration();
    for (const [t, m] of [[tokenA, migA], [tokenB, migB]]) {
      await t.connect(admin).transfer(user.address, E(1000));
      await t.connect(user).approve(await m.getAddress(), E(1000));
    }
    const r1 = await (await migA.connect(user).migrate(E(1000))).wait();
    const r2 = await (await migB.connect(user).migrate(E(1000))).wait();
    const dec = (r, m) => r.logs.filter(l => l.address === m.target)
      .map(l => m.interface.parseLog(l)).filter(Boolean)
      .find(p => p.name === "MigrationRequest");
    const a = dec(r1, migA), b = dec(r2, migB);
    console.log("      chainA MigrationRequest:", a.args[0].toString(), a.args[1], a.args[2].toString());
    console.log("      chainB MigrationRequest:", b.args[0].toString(), b.args[1], b.args[2].toString());
    // ✅ FIXED — the id now carries the chain in its high 128 bits.
    //
    // ⚠️ HARNESS LIMIT, STATED RATHER THAN GLOSSED: both "chains" here are two
    //    contracts on ONE hardhat instance, so block.chainid is identical for
    //    each and this test cannot produce a genuine cross-chain collision. What
    //    it CAN prove is the structural property that makes a collision
    //    impossible: the id provably contains the chain id, so two chains cannot
    //    mint the same one. That is the guarantee, and it is checked directly.
    const MASK = (1n << 128n) - 1n;
    const chainId = BigInt((await ethers.provider.getNetwork()).chainId);

    expect(a.args[0] >> 128n).to.equal(chainId);   // high half is the chain
    expect(a.args[0] & MASK).to.equal(1n);         // low half is the local counter
    expect(b.args[0] >> 128n).to.equal(chainId);
    expect(b.args[0] & MASK).to.equal(1n);

    // The same request on any other chain therefore lands on a different id.
    const onAnotherChain = ((chainId + 1n) << 128n) | 1n;
    expect(onAnotherChain).to.not.equal(a.args[0]);

    // The event also states the source chain outright, so a consumer never has
    // to decode the id to know where a request came from.
    expect(a.args[4]).to.equal(chainId);

    expect(a.args[1]).to.equal(b.args[1]);    // same user
    expect(a.args[2]).to.equal(b.args[2]);    // same amount
  });

  it("PoC-4: [FIXED] stray tokens are recoverable by governance, and only by governance", async function () {
    const { admin, user, tokenA, migA } = await loadFixture(fx);
    await tokenA.connect(admin).transfer(user.address, E(500));
    await tokenA.connect(user).transfer(await migA.getAddress(), E(500));
    expect(await tokenA.balanceOf(await migA.getAddress())).to.equal(E(500));
    // ✅ FIXED — governance can now recover stray tokens. Safe for SRX because
    //    migrate() pulls and burns in the SAME transaction, so this contract is
    //    never a custodian between calls and any balance here is by definition
    //    stray. There is no user position to drain.
    const fns = migA.interface.fragments.filter(f => f.type === "function").map(f => f.name);
    expect(fns.some(n => /rescue|sweep|withdraw|recover/i.test(n))).to.equal(true);

    const before = await tokenA.balanceOf(admin.address);
    await migA.connect(admin).rescueTokens(await tokenA.getAddress(), admin.address);
    expect(await tokenA.balanceOf(await migA.getAddress())).to.equal(0n);
    expect((await tokenA.balanceOf(admin.address)) - before).to.equal(E(500));

    // ⛔ And it is governance-only: a random caller cannot sweep it.
    await tokenA.connect(admin).transfer(await migA.getAddress(), E(1));
    await expect(migA.connect(user).rescueTokens(await tokenA.getAddress(), user.address))
      .to.be.reverted;
  });

  // ✅ ADDRESSED 10 Sep 2026 — 09_deploy_migrator.js now exempts the migrator from
  //    launch protection (step 4b), and rescueTokens() can clear a stranded
  //    balance. The migrator is a burn address in practice, never a holder, so a
  //    wallet cap has no meaning for it.
  //
  // ⚠️ The FIX IS IN THE DEPLOY SCRIPT, not the contract, so this test replicates
  //    the exemption rather than proving the script ran. The post-deploy checklist
  //    carries it as an explicit item for that reason.
  it("PoC-5: [ADDRESSED] exempting the migrator unbricks migrate()", async function () {
    const { admin, user, tokenA, migA } = await loadFixture(fx);
    const BURN = await tokenA.BURN_ROLE();
    await tokenA.connect(admin).grantRole(BURN, await migA.getAddress());
    await migA.connect(admin).enableMigration();
    await tokenA.connect(admin).setMaxWalletBalance(E(1000));
    await tokenA.connect(admin).setExemptFromLimits(admin.address, true);

    // a griefer strands exactly the cap in the migrator
    await tokenA.connect(admin).transfer(await migA.getAddress(), E(1000));
    await tokenA.connect(admin).transfer(user.address, E(10));
    await tokenA.connect(user).approve(await migA.getAddress(), E(10));

    // Unexempt, this is the brick: every migration reverts, for every user.
    await expect(migA.connect(user).migrate(E(10)))
      .to.be.revertedWithCustomError(tokenA, "WalletExceedsMaxBalance");

    // What the deploy script now does.
    await tokenA.connect(admin).setExemptFromLimits(await migA.getAddress(), true);
    await expect(migA.connect(user).migrate(E(10))).to.not.be.reverted;

    // ...and the stranded balance is recoverable either way.
    await migA.connect(admin).rescueTokens(await tokenA.getAddress(), admin.address);
    expect(await tokenA.balanceOf(await migA.getAddress())).to.equal(0n);
  });
});
