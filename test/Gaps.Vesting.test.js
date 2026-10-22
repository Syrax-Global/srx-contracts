// Gap-closing tests for VestingVault: the declare / trigger guards, constructor
// validation, the admin surface, donation handling and exact schedule accounting.
//
// Where the code did not do what its own comment said, the test pins what it
// actually does; the comment was corrected on 7 Oct 2026 (REMEDIATION.md R7-13).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("Gaps — VestingVault", function () {
  const DAY = 86400n;
  const ALLOC = ethers.parseUnits("1000000", 18);
  // An allocation that does not divide evenly by the schedule, so rounding is exercised.
  const ODD = 1_000_000_000_000_000_000_007n;

  async function base() {
    const [admin, beneficiary, recipient, other, donor] = await ethers.getSigners();
    const M = await ethers.getContractFactory("MockERC20");
    const token = await M.deploy("SRX Mock", "SRX", 18);
    await token.mint(admin.address, ethers.parseUnits("100000000", 18));
    return { token, admin, beneficiary, recipient, other, donor };
  }

  async function makeVault(ctx, { cliffDays = 0n, vestDays = 100n, bps = 0n, fund = ALLOC } = {}) {
    const V = await ethers.getContractFactory("VestingVault");
    const vault = await V.deploy(
      ctx.token.target, ctx.beneficiary.address, ctx.admin.address, cliffDays * DAY, vestDays * DAY, bps, ctx.recipient.address,
    );
    if (fund > 0n) await ctx.token.connect(ctx.admin).transfer(vault.target, fund);
    return vault;
  }

  async function fixture() { return base(); }

  // ── V1 ───────────────────────────────────────────────────────────────────────
  describe("V1 declareExpectedAllocation guards", function () {
    it("refuses a non-admin; the first admin call succeeds (control)", async function () {
      const ctx = await loadFixture(fixture);
      const v = await makeVault(ctx);
      await expect(v.connect(ctx.other).declareExpectedAllocation(ALLOC))
        .to.be.revertedWithCustomError(v, "OnlyAdmin");
      await expect(v.connect(ctx.beneficiary).declareExpectedAllocation(ALLOC))
        .to.be.revertedWithCustomError(v, "OnlyAdmin");
      expect(await v.expectedAllocation()).to.equal(0n);

      await expect(v.connect(ctx.admin).declareExpectedAllocation(ALLOC))
        .to.emit(v, "ExpectedAllocationDeclared").withArgs(ALLOC);
      expect(await v.expectedAllocation()).to.equal(ALLOC);
    });

    it("refuses a second declaration with AllocationAlreadyDeclared and keeps the first value", async function () {
      const ctx = await loadFixture(fixture);
      const v = await makeVault(ctx);
      await v.connect(ctx.admin).declareExpectedAllocation(ALLOC);
      await expect(v.connect(ctx.admin).declareExpectedAllocation(ALLOC))
        .to.be.revertedWithCustomError(v, "AllocationAlreadyDeclared");
      await expect(v.connect(ctx.admin).declareExpectedAllocation(ALLOC + 1n))
        .to.be.revertedWithCustomError(v, "AllocationAlreadyDeclared");
      expect(await v.expectedAllocation()).to.equal(ALLOC);
    });

    it("refuses a declaration after triggerTGE with TGEAlreadyTriggered (declared or not)", async function () {
      const ctx = await loadFixture(fixture);
      // never declared: the TGE guard fires, not the already-declared one
      const undeclared = await makeVault(ctx);
      await undeclared.connect(ctx.admin).triggerTGE();
      await expect(undeclared.connect(ctx.admin).declareExpectedAllocation(ALLOC))
        .to.be.revertedWithCustomError(undeclared, "TGEAlreadyTriggered");
      expect(await undeclared.expectedAllocation()).to.equal(0n);

      // declared: the TGE guard is checked first
      const declared = await makeVault(ctx);
      await declared.connect(ctx.admin).declareExpectedAllocation(ALLOC);
      await declared.connect(ctx.admin).triggerTGE();
      await expect(declared.connect(ctx.admin).declareExpectedAllocation(ALLOC))
        .to.be.revertedWithCustomError(declared, "TGEAlreadyTriggered");
    });

    it("refuses an amount of 0 (the contract reuses EmptyVault for it)", async function () {
      const ctx = await loadFixture(fixture);
      const v = await makeVault(ctx);
      await expect(v.connect(ctx.admin).declareExpectedAllocation(0n))
        .to.be.revertedWithCustomError(v, "EmptyVault");
      expect(await v.expectedAllocation()).to.equal(0n);
      // control: a non-zero amount is accepted on the same vault
      await v.connect(ctx.admin).declareExpectedAllocation(1n);
      expect(await v.expectedAllocation()).to.equal(1n);
    });
  });

  // ── V2 ───────────────────────────────────────────────────────────────────────
  describe("V2 triggerTGE on an unfunded vault", function () {
    it("reverts EmptyVault, with or without a declaration; works once funded (control)", async function () {
      const ctx = await loadFixture(fixture);
      const v = await makeVault(ctx, { fund: 0n });
      await expect(v.connect(ctx.admin).triggerTGE()).to.be.revertedWithCustomError(v, "EmptyVault");
      expect(await v.tgeTriggered()).to.equal(false);

      await v.connect(ctx.admin).declareExpectedAllocation(ALLOC);
      await expect(v.connect(ctx.admin).triggerTGE()).to.be.revertedWithCustomError(v, "EmptyVault");
      expect(await v.tgeTriggered()).to.equal(false);

      await ctx.token.connect(ctx.admin).transfer(v.target, ALLOC);
      await v.connect(ctx.admin).triggerTGE();
      expect(await v.tgeTriggered()).to.equal(true);
      expect(await v.initialAllocation()).to.equal(ALLOC);
    });

    it("a declared vault holding less than declared reverts VaultUnderfunded(held, declared)", async function () {
      const ctx = await loadFixture(fixture);
      const v = await makeVault(ctx, { fund: ALLOC - 1n });
      await v.connect(ctx.admin).declareExpectedAllocation(ALLOC);
      await expect(v.connect(ctx.admin).triggerTGE())
        .to.be.revertedWithCustomError(v, "VaultUnderfunded").withArgs(ALLOC - 1n, ALLOC);
      await ctx.token.connect(ctx.admin).transfer(v.target, 1n);
      await v.connect(ctx.admin).triggerTGE();
      expect(await v.tgeTriggered()).to.equal(true);
    });
  });

  // ── V3 ───────────────────────────────────────────────────────────────────────
  describe("V3 constructor validation", function () {
    it("each zero address argument reverts ZeroAddress; the valid deployment works (control)", async function () {
      const ctx = await loadFixture(fixture);
      const V = await ethers.getContractFactory("VestingVault");
      const Z = ethers.ZeroAddress;
      const ok = [ctx.token.target, ctx.beneficiary.address, ctx.admin.address, 0n, 100n * DAY, 0n, ctx.recipient.address];
      await V.deploy(...ok); // control

      const withArg = (i, val) => ok.map((x, j) => (j === i ? val : x));
      for (const i of [0, 1, 2]) {
        await expect(V.deploy(...withArg(i, Z))).to.be.revertedWithCustomError(V, "ZeroAddress");
      }
    });

    it("the revoke recipient must be a real address that is not the beneficiary (internal audit M2)", async function () {
      const ctx = await loadFixture(fixture);
      const V = await ethers.getContractFactory("VestingVault");
      const args = (recipient) => [ctx.token.target, ctx.beneficiary.address, ctx.admin.address, 0n, 100n * DAY, 0n, recipient];
      await expect(V.deploy(...args(ethers.ZeroAddress))).to.be.revertedWithCustomError(V, "InvalidRevokeRecipient");
      await expect(V.deploy(...args(ctx.beneficiary.address))).to.be.revertedWithCustomError(V, "InvalidRevokeRecipient");
      const v = await V.deploy(...args(ctx.recipient.address)); // control
      expect(await v.revokeRecipient()).to.equal(ctx.recipient.address);
    });

    it("tgeUnlockBps above 10000 reverts InvalidBps; exactly 10000 is accepted (control)", async function () {
      const ctx = await loadFixture(fixture);
      const V = await ethers.getContractFactory("VestingVault");
      const args = (bps) => [ctx.token.target, ctx.beneficiary.address, ctx.admin.address, 0n, 100n * DAY, bps, ctx.recipient.address];
      await expect(V.deploy(...args(10_001n))).to.be.revertedWithCustomError(V, "InvalidBps");
      await expect(V.deploy(...args(ethers.MaxUint256))).to.be.revertedWithCustomError(V, "InvalidBps");
      const v = await V.deploy(...args(10_000n));
      expect(await v.tgeUnlockBps()).to.equal(10_000n);
    });
  });

  // ── V4 ───────────────────────────────────────────────────────────────────────
  describe("V4 ABI surface", function () {
    it("the only state-changing functions are declareExpectedAllocation, triggerTGE, release, revoke, rescueDonatedTokens", async function () {
      const ctx = await loadFixture(fixture);
      const v = await makeVault(ctx);
      const mutating = v.interface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map((f) => f.name)
        .sort();
      expect(mutating).to.deep.equal(
        ["declareExpectedAllocation", "release", "rescueDonatedTokens", "revoke", "triggerTGE"].sort(),
      );
      // revoke names no destination (internal audit M2): the unvested part only ever goes to the fixed recipient
      expect(v.interface.getFunction("revoke").inputs.length).to.equal(0);
      // no receive / fallback either: the vault cannot be sent ETH
      expect(v.interface.fragments.some((f) => f.type === "receive" || f.type === "fallback")).to.equal(false);
      await expect(ctx.admin.sendTransaction({ to: v.target, value: 1n })).to.be.reverted;
    });
  });

  // ── V5 ───────────────────────────────────────────────────────────────────────
  describe("V5 donation after TGE (declared vault)", function () {
    const DONATION = ethers.parseUnits("777", 18);

    async function partial() {
      const ctx = await base();
      const v = await makeVault(ctx, { vestDays: 100n });
      await v.connect(ctx.admin).declareExpectedAllocation(ALLOC);
      await v.connect(ctx.admin).triggerTGE();
      await time.increase(40n * DAY);
      await v.connect(ctx.beneficiary).release();
      const releasedBefore = await v.released();
      await ctx.token.connect(ctx.admin).transfer(ctx.donor.address, DONATION);
      await ctx.token.connect(ctx.donor).transfer(v.target, DONATION);
      return { ctx, v, releasedBefore };
    }

    it("rescueDonatedTokens returns exactly the donation and leaves the schedule untouched", async function () {
      const { ctx, v, releasedBefore } = await partial();
      expect(releasedBefore).to.be.gt(0n);
      const owed = ALLOC - releasedBefore;
      expect(await ctx.token.balanceOf(v.target)).to.equal(owed + DONATION);

      // releasable() is measured at a fixed block (the donation block) so time cannot move it
      const donationBlock = await ethers.provider.getBlockNumber();
      const blk = await ethers.provider.getBlock(donationBlock);
      const tge = await v.tgeTimestamp();
      const expectedVested = (ALLOC * (BigInt(blk.timestamp) - tge)) / (100n * DAY);
      expect(await v.releasable({ blockTag: donationBlock })).to.equal(expectedVested - releasedBefore);
      expect(await v.totalAllocation()).to.equal(ALLOC);

      await expect(v.connect(ctx.admin).rescueDonatedTokens(ctx.recipient.address))
        .to.changeTokenBalances(ctx.token, [v, ctx.recipient], [-DONATION, DONATION]);

      expect(await ctx.token.balanceOf(v.target)).to.equal(owed);
      expect(await v.totalAllocation()).to.equal(ALLOC);
      expect(await v.initialAllocation()).to.equal(ALLOC);
      expect(await v.released()).to.equal(releasedBefore);
      // nothing left to rescue: a second call reverts, and moves nothing
      await expect(v.connect(ctx.admin).rescueDonatedTokens(ctx.recipient.address))
        .to.be.revertedWithCustomError(v, "NoDonatedTokens");
    });

    it("only the admin can rescue", async function () {
      const { ctx, v } = await partial();
      await expect(v.connect(ctx.other).rescueDonatedTokens(ctx.other.address))
        .to.be.revertedWithCustomError(v, "OnlyAdmin");
      await expect(v.connect(ctx.beneficiary).rescueDonatedTokens(ctx.beneficiary.address))
        .to.be.revertedWithCustomError(v, "OnlyAdmin");
      await expect(v.connect(ctx.admin).rescueDonatedTokens(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(v, "ZeroAddress");
    });

    it("the donation never becomes releasable: at the end the beneficiary gets exactly the grant and the donation stays", async function () {
      const { ctx, v, releasedBefore } = await partial();
      await time.increase(200n * DAY); // far past the end of the schedule
      expect(await v.releasable()).to.equal(ALLOC - releasedBefore);
      await expect(v.connect(ctx.beneficiary).release())
        .to.changeTokenBalance(ctx.token, ctx.beneficiary, ALLOC - releasedBefore);
      expect(await v.released()).to.equal(ALLOC);
      expect(await ctx.token.balanceOf(v.target)).to.equal(DONATION); // still the donor's, rescuable
      await expect(v.connect(ctx.beneficiary).release()).to.be.revertedWithCustomError(v, "NothingToRelease");
      // and it can still be rescued after the schedule has completed
      await expect(v.connect(ctx.admin).rescueDonatedTokens(ctx.recipient.address))
        .to.changeTokenBalance(ctx.token, ctx.recipient, DONATION);
    });
  });

  // ── V6 ───────────────────────────────────────────────────────────────────────
  describe("V6 donation BEFORE triggerTGE (declared vault)", function () {
    const DONATION = ethers.parseUnits("500", 18);

    it("rescueDonatedTokens before TGE reverts VaultNotRevoked; after TGE the same surplus is rescued", async function () {
      const ctx = await loadFixture(fixture);
      const v = await makeVault(ctx, { fund: ALLOC + DONATION });
      await v.connect(ctx.admin).declareExpectedAllocation(ALLOC);

      // R7-13: declareExpectedAllocation's NatSpec used to say the surplus "is recoverable before TGE";
      // rescueDonatedTokens only takes the surplus path when `tgeTriggered && !revoked`; before
      // TGE it falls through to the post-revoke branch and reverts VaultNotRevoked. The surplus is
      // recoverable only AFTER triggerTGE (asserted below as the control).
      await expect(v.connect(ctx.admin).rescueDonatedTokens(ctx.recipient.address))
        .to.be.revertedWithCustomError(v, "VaultNotRevoked");
      expect(await ctx.token.balanceOf(ctx.recipient.address)).to.equal(0n);

      // the surplus stays outside the grant once TGE runs
      await v.connect(ctx.admin).triggerTGE();
      expect(await v.initialAllocation()).to.equal(ALLOC);
      await expect(v.connect(ctx.admin).rescueDonatedTokens(ctx.recipient.address))
        .to.changeTokenBalances(ctx.token, [v, ctx.recipient], [-DONATION, DONATION]);
      expect(await ctx.token.balanceOf(v.target)).to.equal(ALLOC);
    });
  });

  // ── V7 ───────────────────────────────────────────────────────────────────────
  describe("V7 TGE unlock with a cliff", function () {
    it("inside the cliff releasable() is exactly the TGE share and nothing more", async function () {
      const ctx = await loadFixture(fixture);
      const v = await makeVault(ctx, { cliffDays: 30n, vestDays: 100n, bps: 2500n });
      await v.connect(ctx.admin).triggerTGE();
      const tgeShare = (ALLOC * 2500n) / 10_000n;

      expect(await v.releasable()).to.equal(tgeShare);
      await time.increase(15n * DAY);
      expect(await v.releasable()).to.equal(tgeShare);
      await time.increase(14n * DAY); // day ~29, still inside
      expect(await v.releasable()).to.equal(tgeShare);
      expect(await v.vestedAmount()).to.equal(tgeShare);

      // the beneficiary can take exactly that, then nothing until the cliff ends
      await expect(v.connect(ctx.beneficiary).release()).to.changeTokenBalance(ctx.token, ctx.beneficiary, tgeShare);
      expect(await v.releasable()).to.equal(0n);
      await expect(v.connect(ctx.beneficiary).release()).to.be.revertedWithCustomError(v, "NothingToRelease");

      // control: once the cliff has passed, more becomes releasable
      await time.increase(30n * DAY);
      expect(await v.releasable()).to.be.gt(0n);
    });
  });

  // ── V8 ───────────────────────────────────────────────────────────────────────
  describe("V8 exact accounting", function () {
    it("running the whole schedule releases exactly initialAllocation (odd amount, several steps)", async function () {
      const ctx = await loadFixture(fixture);
      const v = await makeVault(ctx, { cliffDays: 10n, vestDays: 97n, bps: 1234n, fund: ODD });
      await v.connect(ctx.admin).triggerTGE();
      expect(await v.initialAllocation()).to.equal(ODD);

      let prev = 0n;
      for (const d of [3n, 8n, 20n, 33n, 40n]) {
        await time.increase(d * DAY);
        await v.connect(ctx.beneficiary).release();
        const r = await v.released();
        expect(r).to.be.gt(prev);
        expect(r).to.be.lte(ODD);
        expect(await ctx.token.balanceOf(ctx.beneficiary.address)).to.equal(r);
        prev = r;
      }
      await time.increase(200n * DAY);
      await v.connect(ctx.beneficiary).release();
      expect(await v.released()).to.equal(ODD);
      expect(await ctx.token.balanceOf(ctx.beneficiary.address)).to.equal(ODD);
      expect(await ctx.token.balanceOf(v.target)).to.equal(0n);
      expect(await v.releasable()).to.equal(0n);
    });

    it("revoking mid-way: beneficiary + recipient receive exactly the allocation, the vault is empty", async function () {
      const ctx = await loadFixture(fixture);
      const v = await makeVault(ctx, { cliffDays: 10n, vestDays: 97n, bps: 1234n, fund: ODD });
      await v.connect(ctx.admin).triggerTGE();
      await time.increase(45n * DAY);
      await v.connect(ctx.beneficiary).release(); // some already claimed before the revoke
      const claimed = await v.released();
      await time.increase(20n * DAY);

      await v.connect(ctx.admin).revoke();
      const b = await ctx.token.balanceOf(ctx.beneficiary.address);
      const r = await ctx.token.balanceOf(ctx.recipient.address);
      expect(b).to.be.gt(claimed);       // vested-but-unclaimed was paid out
      expect(r).to.be.gt(0n);            // and the unvested remainder went back
      expect(b + r).to.equal(ODD);
      expect(await ctx.token.balanceOf(v.target)).to.equal(0n);
      expect(await v.released()).to.equal(b);
      expect(await v.vestedAmount()).to.equal(0n);

      // revocation is final and refuses further calls
      await expect(v.connect(ctx.admin).revoke()).to.be.revertedWithCustomError(v, "AlreadyRevoked");
      await expect(v.connect(ctx.beneficiary).release()).to.be.revertedWithCustomError(v, "VaultRevoked");
    });

    it("a revoke ignores a donation: the donation stays for rescue and the split is still exact", async function () {
      const ctx = await loadFixture(fixture);
      const v = await makeVault(ctx, { vestDays: 100n, fund: ODD });
      await v.connect(ctx.admin).triggerTGE();
      await ctx.token.connect(ctx.admin).transfer(v.target, 55n); // donation, no declaration
      await time.increase(50n * DAY);
      await v.connect(ctx.admin).revoke();
      const b = await ctx.token.balanceOf(ctx.beneficiary.address);
      const r = await ctx.token.balanceOf(ctx.recipient.address);
      expect(b + r).to.equal(ODD);
      expect(await ctx.token.balanceOf(v.target)).to.equal(55n);
      await expect(v.connect(ctx.admin).rescueDonatedTokens(ctx.other.address))
        .to.changeTokenBalance(ctx.token, ctx.other, 55n);
    });
  });
});
