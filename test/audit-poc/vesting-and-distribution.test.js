const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("AUDIT PoC — vesting / airdrop", function () {
  const DAY = 86400;
  const TOTAL = ethers.parseUnits("1000000", 18);
  const F = (x) => Number(ethers.formatUnits(x, 18));

  async function fx() {
    const [admin, beneficiary, treasury, other] = await ethers.getSigners();
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const ep = await MockLZEndpoint.deploy(40161);
    await ep.waitForDeployment();
    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await ep.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);
    return { token, admin, beneficiary, treasury, other };
  }

  async function vaultWith(cliffDays, vestDays, bps) {
    const { token, admin, beneficiary, treasury, other } = await loadFixture(fx);
    const V = await ethers.getContractFactory("VestingVault");
    const vault = await V.deploy(
      await token.getAddress(), beneficiary.address, admin.address,
      BigInt(cliffDays) * BigInt(DAY), BigInt(vestDays) * BigInt(DAY), BigInt(bps)
    );
    await vault.waitForDeployment();
    await token.connect(admin).transfer(await vault.getAddress(), TOTAL);
    return { vault, token, admin, beneficiary, treasury, other };
  }

  it("V1: [FIXED] release() at the midpoint yields the scheduled amount, not the whole allocation", async function () {
    // Founders: 0% TGE, 365d cliff, 1095d linear. Full unlock should be day 1460.
    const { vault, token, admin, beneficiary } = await vaultWith(365, 1095, 0);
    await vault.connect(admin).triggerTGE();

    // Jump to cliff + 50% of the vesting period => day 365 + 547.5 ~= 912
    await time.increase((365 + 548) * DAY);

    const scheduled = await vault.vestedAmount(); // what the schedule says, released == 0
    console.log("      scheduled at day 913 :", F(scheduled));

    // Beneficiary simply calls release() in a loop. No special privilege.
    const va = await vault.getAddress();
    let calls = 0;
    for (let i = 0; i < 400; i++) {
      const r = await vault.releasable();
      if (r === 0n || r > (await token.balanceOf(va))) break; // release() reverts past this
      await vault.connect(beneficiary).release();
      calls++;
    }

    const got = await token.balanceOf(beneficiary.address);
    console.log("      actually extracted   :", F(got), `in ${calls} release() calls`);
    console.log("      vault balance left   :", F(await token.balanceOf(await vault.getAddress())));

    // ✅ FIXED — extraction now tracks the schedule instead of exceeding it.
    //    Before: 999,855 of 1,000,000 in nine calls at the midpoint.
    //    After : 500,456 in one call, against a scheduled 500,456.
    //    Tolerance is one part in 10,000 for the seconds that elapse between
    //    the schedule being computed and release() mining.
    const drift = got > scheduled ? got - scheduled : scheduled - got;
    expect(drift).to.be.lt(scheduled / 10_000n);
    expect(got).to.be.lt((TOTAL * 51n) / 100n); // nowhere near the full allocation

    // ✅ The residual is no longer stranded. Previously releasable() exceeded the
    //    balance forever, so release() and revoke() both reverted permanently.
    //    Now the vault still holds the unvested remainder and revoke() works.
    expect(await token.balanceOf(va)).to.be.gt((TOTAL * 49n) / 100n);
    await expect(vault.connect(admin).revoke(admin.address)).to.not.be.reverted;
  });

  it("V2: [FIXED] presale vault yields exactly its 25% TGE unlock", async function () {
    const { vault, token, admin, beneficiary } = await vaultWith(0, 180, 2500);
    await vault.connect(admin).triggerTGE();

    for (let i = 0; i < 60; i++) {
      if ((await vault.releasable()) === 0n) break;
      await vault.connect(beneficiary).release();
    }
    const got = await token.balanceOf(beneficiary.address);
    console.log("      TGE unlock is 25%    :", F(TOTAL / 4n));
    console.log("      actually extracted   :", F(got));
    // ✅ FIXED — the presale vault now yields its stated 25% at the TGE instant,
    //    not 33%. Asserted as a band so block timing cannot make it flaky.
    expect(got).to.be.gt((TOTAL * 249n) / 1000n);
    expect(got).to.be.lt((TOTAL * 251n) / 1000n);
  });

  it("V3: [FIXED] totalAllocation() is invariant across a claim", async function () {
    const { vault, admin, beneficiary } = await vaultWith(0, 180, 2500);
    await vault.connect(admin).triggerTGE();
    const before = await vault.totalAllocation();
    await vault.connect(beneficiary).release();
    const after = await vault.totalAllocation();
    console.log("      totalAllocation before:", F(before), " after:", F(after));
    // ✅ FIXED — totalAllocation() is now invariant across a claim, which is
    //    what "total allocation" has to mean. It grew 1,000,000 -> 1,250,000 before.
    expect(after).to.equal(before);
  });

  it("V4: [FIXED] revoke() still works after the beneficiary has released", async function () {
    const { vault, token, admin, beneficiary, treasury } = await vaultWith(0, 365, 0);
    await vault.connect(admin).triggerTGE();
    await time.increase(220 * DAY); // ~60% through the linear vest

    const va2 = await vault.getAddress();
    for (let i = 0; i < 400; i++) {
      const r = await vault.releasable();
      if (r === 0n || r > (await token.balanceOf(va2))) break;
      await vault.connect(beneficiary).release();
    }
    console.log("      beneficiary took     :", F(await token.balanceOf(beneficiary.address)));
    console.log("      stranded in vault    :", F(await token.balanceOf(va2)));
    // Admin now tries to claw back. Vault is empty but vestedAmount() still
    // computes a positive releasableNow off the inflated totalAllocation().
    // ✅ FIXED — revoke() is no longer bricked by prior releases, because the
    //    vault no longer believes it owes more than it holds.
    await expect(vault.connect(admin).revoke(treasury.address)).to.not.be.reverted;
  });

  // ✅ FIXED 10 Sep 2026 via declareExpectedAllocation(), which is OPT-IN so
  //    existing deployments are unaffected. Both paths are asserted below: the
  //    undeclared one still absorbs a donation, which is why the deploy script
  //    now declares. A fix nobody calls is not a fix.
  it("V5: [FIXED] a declared allocation keeps a pre-TGE donation out of the grant", async function () {
    const DONATION = ethers.parseUnits("50000", 18);

    // ── Path 1: no declaration — unchanged, and this is the hazard ──────────
    {
      const { vault, token, admin, other } = await vaultWith(0, 180, 0);
      await token.connect(admin).transfer(other.address, DONATION);
      await token.connect(other).transfer(await vault.getAddress(), DONATION);
      await vault.connect(admin).triggerTGE();
      // the donation became part of the grant
      expect(await vault.initialAllocation()).to.equal(TOTAL + DONATION);
    }

    // ── Path 2: allocation declared — the donation stays outside the grant ──
    const { vault, token, admin, beneficiary, other } = await vaultWith(0, 180, 0);
    await vault.connect(admin).declareExpectedAllocation(TOTAL);

    await token.connect(admin).transfer(other.address, DONATION);
    await token.connect(other).transfer(await vault.getAddress(), DONATION);
    await vault.connect(admin).triggerTGE();

    console.log("      declared allocation  :", F(await vault.initialAllocation()));
    expect(await vault.initialAllocation()).to.equal(TOTAL);        // NOT TOTAL + DONATION

    // ...and the surplus is returnable without revoking the vault, which was the
    // only previous route and destroys the vesting schedule to fix a typo.
    const before = await token.balanceOf(other.address);
    await vault.connect(admin).rescueDonatedTokens(other.address);
    expect((await token.balanceOf(other.address)) - before).to.equal(DONATION);

    // The grant itself is untouched by the rescue.
    expect(await vault.totalAllocation()).to.equal(TOTAL);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(TOTAL);

    // ⭐ And an underfunded vault now fails at SETUP rather than shorting the
    //    beneficiary silently at claim time.
    const v2 = await vaultWith(0, 180, 0);
    await v2.vault.connect(admin).declareExpectedAllocation(TOTAL * 2n);
    await expect(v2.vault.connect(admin).triggerTGE())
      .to.be.revertedWithCustomError(v2.vault, "VaultUnderfunded");
  });
});

describe("AUDIT PoC — vesting x launch protection", function () {
  // ⚠️ NOT A CONTRACT BUG, AND DELIBERATELY NOT "FIXED". maxWalletBalance caps the
  //    RECIPIENT and ignores the sender, so a vesting vault paying out is capped
  //    like any other transfer even though the vault itself is exempt. Set the cap
  //    below a vault's releasable amount and the beneficiary cannot claim at all.
  //
  //    It CANNOT be fixed by skipping the cap when the sender is exempt:
  //    SRXToken.sol:82-88 REQUIRES DEX pool addresses to be exempt, so that change
  //    would let every purchase from the pool bypass the cap and would defeat
  //    launch protection outright — a worse outcome than the one being fixed.
  //
  // ⭐ So the incompatibility is real and is now CAUGHT rather than designed away:
  //    scripts/ops/verify_tge.js fails if any beneficiary's releasable amount
  //    would breach the wallet cap. This test keeps the behaviour visible.
  const DAY = 86400;
  it("V6: [CONFIG HAZARD, now checked] the wallet cap blocks a claim, because it caps the RECIPIENT", async function () {
    const [admin, beneficiary] = await ethers.getSigners();
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const ep = await MockLZEndpoint.deploy(40161); await ep.waitForDeployment();
    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await ep.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    // Presale category vault, exactly as scripts/deploy/00_config.js configures it:
    // 1.4B SRX, 0 cliff, 180d vest, 2500 bps TGE unlock => 350M SRX at TGE.
    const ALLOC = ethers.parseUnits("1400000000", 18);
    const V = await ethers.getContractFactory("VestingVault");
    const vault = await V.deploy(
      await token.getAddress(), beneficiary.address, admin.address,
      0n, BigInt(180 * DAY), 2500n
    );
    await vault.waitForDeployment();
    const va = await vault.getAddress();

    // Exempt the vault, per SRXToken's documented exemption list.
    await token.connect(admin).setExemptFromLimits(va, true);
    await token.connect(admin).transfer(va, ALLOC);
    await vault.connect(admin).triggerTGE();

    // Launch protection at the values SRXToken's own natspec suggests.
    await token.connect(admin).setMaxTransferAmount(ethers.parseUnits("50000000", 18));
    await token.connect(admin).setMaxWalletBalance(ethers.parseUnits("100000000", 18));

    console.log("      releasable at TGE   :", Number(ethers.formatUnits(await vault.releasable(), 18)));
    await expect(vault.connect(beneficiary).release())
      .to.be.revertedWithCustomError(token, "WalletExceedsMaxBalance");
  });
});
describe("V7 revoke clawback leak", function () {
  it("[FIXED] a prior release() no longer diverts the treasury clawback", async function () {
    const [admin, ben, tre] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await token.connect(admin).genesis(admin.address);
    const TOTAL = ethers.parseUnits("1000000", 18);
    const vault = await (await ethers.getContractFactory("VestingVault")).deploy(
      await token.getAddress(), ben.address, admin.address, 0n, BigInt(365*86400), 0n);
    await token.connect(admin).transfer(await vault.getAddress(), TOTAL);
    await vault.connect(admin).triggerTGE();
    await time.increase(219 * 86400);              // 60% of the vest
    await vault.connect(ben).release();            // ONE ordinary claim
    await vault.connect(admin).revoke(tre.address);// admin claws back
    const F = (x)=>Number(ethers.formatUnits(x,18));
    console.log("      beneficiary total :", F(await token.balanceOf(ben.address)), " (schedule says ~600000)");
    console.log("      treasury got      :", F(await token.balanceOf(tre.address)), " (schedule says ~400000)");

    // ⛔ THIS TEST HAD NO ASSERTIONS AT ALL -- only the two logs above -- so it
    //    passed no matter what the contract did. It reported a real leak
    //    (beneficiary 960,000 against a ~600,000 schedule; treasury 39,999
    //    against ~400,000) purely as console output that a human had to notice.
    // ✅ FIXED by the totalAllocation change, and now actually asserted.
    const benBal = await token.balanceOf(ben.address);
    const treBal = await token.balanceOf(tre.address);
    const near = (actual, want) => {
      const d = actual > want ? actual - want : want - actual;
      expect(d).to.be.lt(want / 1000n); // within 0.1%
    };
    near(benBal, ethers.parseUnits("600000", 18));
    near(treBal, ethers.parseUnits("400000", 18));
    expect(benBal + treBal).to.equal(TOTAL); // nothing created or stranded
  });
});
describe("AUDIT PoC — TGEDistributor", function () {
  // ✅ FIXED 9 Sep 2026 — distribute() now refuses an empty allocation set and
  //    re-checks that it actually moved MAX_SUPPLY. Previously it ran with no
  //    allocations, burned the one-shot flag, and left recoverToken() sweeping
  //    all 10,000,000,000 SRX to one address as the only remaining move.
  it("[FIXED] distribute() refuses to run before setAllocations, and the TGE stays possible", async function () {
    const [admin, x, a1, a2] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    const dist = await (await ethers.getContractFactory("TGEDistributor")).deploy(await token.getAddress(), admin.address);
    const da = await dist.getAddress();
    await token.connect(admin).genesis(da);          // 10B SRX minted to the distributor

    // setAllocations() has NOT been called: distribute() must refuse.
    await expect(dist.connect(admin).distribute())
      .to.be.revertedWithCustomError(dist, "NoAllocationsSet");

    // ⭐ The one-shot flag is INTACT, so the real TGE is still possible. This is
    //    the part that mattered: the old behaviour closed the door permanently.
    expect(await dist.distributed()).to.be.false;

    const MAX = await dist.MAX_SUPPLY();
    await dist.connect(admin).setAllocations([
      { destination: a1.address, amount: MAX / 2n, isVestingVault: false, label: "A" },
      { destination: a2.address, amount: MAX / 2n, isVestingVault: false, label: "B" },
    ]);
    await expect(dist.connect(admin).distribute()).to.not.be.reverted;

    expect(await dist.distributed()).to.be.true;
    expect(await token.balanceOf(a1.address)).to.equal(MAX / 2n);
    expect(await token.balanceOf(a2.address)).to.equal(MAX / 2n);
    expect(await token.balanceOf(da)).to.equal(0n);   // nothing left to sweep
  });
});
