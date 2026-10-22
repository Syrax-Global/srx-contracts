// Gap-closing tests for StabilisationFund: fast-path cap ordering, free-balance guard, lock reset on top-up.
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { allocationSource } = require("./helpers/allocationSource");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const e18 = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;

describe("Gaps: StabilisationFund", function () {
  const SEED = e18(1_500_000_000);   // 1.5B SRX, the TGE seed
  const BPS = 10_000n;

  async function fixture() {
    const [admin, timelock, guardian, deployer, both, oracle, c1, c2, recipient] = await ethers.getSigners();
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    await srx.connect(admin).genesis(admin.address);
    const ssf = await (await ethers.getContractFactory("StabilisationFund")).deploy(...[await srx.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, ethers.parseUnits("10000000", 18), await allocationSource(srx, ethers.parseUnits("1500000000", 18))]);
    const ssfAddr = await ssf.getAddress();

    await ssf.connect(admin).grantRole(await ssf.GOVERNANCE_ROLE(), timelock.address);
    await ssf.connect(admin).grantRole(await ssf.GUARDIAN_ROLE(), guardian.address);
    await ssf.connect(admin).grantRole(await ssf.DEPLOYER_ROLE(), deployer.address);
    await ssf.connect(admin).grantRole(await ssf.GUARDIAN_ROLE(), both.address);   // `both` holds BOTH fast-path roles
    await ssf.connect(admin).grantRole(await ssf.DEPLOYER_ROLE(), both.address);
    await ssf.connect(admin).grantRole(await ssf.ORACLE_REPORTER_ROLE(), oracle.address);
    await ssf.connect(admin).setDeployTarget(recipient.address, true);

    // REG-50: 10M of the delivered launch SRX backs depositor rewards and is reserved, so
    // the fund receives SEED + 10M and the free (deployable) SRX is exactly SEED.
    await srx.connect(admin).transfer(ssfAddr, SEED + e18(10_000_000));
    for (const c of [c1, c2]) {
      await srx.connect(admin).transfer(c.address, e18(1_000_000));
      await srx.connect(c).approve(ssfAddr, ethers.MaxUint256);
    }
    const deploy = (who, amt, reason = "support") =>
      ssf.connect(who).deployLiquidity(recipient.address, srx.target, amt, reason);
    return { admin, timelock, guardian, deployer, both, oracle, c1, c2, recipient, srx, ssf, ssfAddr, deploy };
  }

  // ── SF1 ────────────────────────────────────────────────────────────────────
  describe("SF1: fast-path cap ordering", function () {
    it("guardian deploys 40% of the snapshot first; the deployer's 30% cap then leaves 0 (DeployerCapExceeded(0, x)); control: the deployer alone could have used 30%", async function () {
      const { oracle, guardian, deployer, ssf, deploy } = await loadFixture(fixture);
      await ssf.connect(oracle).triggerStressEvent();
      expect(await ssf.stressStartSRXBalance()).to.equal(SEED);

      const forty = (SEED * 4_000n) / BPS; // 600M
      await deploy(guardian, forty);
      expect(await ssf.guardianSRXUsed()).to.equal(forty);
      // The deployer's own 30% cap (450M) counts guardian usage, so it is already exhausted.
      expect(await ssf.getDeployerCapRemaining()).to.equal(0n);
      await expect(deploy(deployer, 1n))
        .to.be.revertedWithCustomError(ssf, "DeployerCapExceeded").withArgs(0n, 1n);
      await expect(deploy(deployer, e18(1)))
        .to.be.revertedWithCustomError(ssf, "DeployerCapExceeded").withArgs(0n, e18(1));
      expect(await ssf.deployerSRXUsed()).to.equal(0n);

      // The guardian still has 30% of headroom (70% combined cap, 40% used).
      expect(await ssf.getGuardianCapRemaining()).to.equal((SEED * 3_000n) / BPS);
    });

    it("control: with no guardian usage the deployer alone may deploy exactly 30%, and 1 wei more is refused with the remaining amount", async function () {
      const { oracle, deployer, ssf, deploy } = await loadFixture(fixture);
      await ssf.connect(oracle).triggerStressEvent();
      const thirty = (SEED * 3_000n) / BPS; // 450M
      await expect(deploy(deployer, thirty + 1n))
        .to.be.revertedWithCustomError(ssf, "DeployerCapExceeded").withArgs(thirty, thirty + 1n);
      await deploy(deployer, thirty);
      expect(await ssf.deployerSRXUsed()).to.equal(thirty);
      await expect(deploy(deployer, 1n))
        .to.be.revertedWithCustomError(ssf, "DeployerCapExceeded").withArgs(0n, 1n);
    });

    it("an account holding both roles is capped at 70% combined (not 30%): deployer 30% + both-roles account 40% reaches the cap, then GuardianCapExceeded(0, 1)", async function () {
      const { oracle, deployer, both, ssf, deploy } = await loadFixture(fixture);
      await ssf.connect(oracle).triggerStressEvent();
      const thirty = (SEED * 3_000n) / BPS;
      const forty = (SEED * 4_000n) / BPS;
      const seventy = (SEED * 7_000n) / BPS;

      await deploy(deployer, thirty);
      // The dual-role account takes the (higher) guardian path: it may exceed 30% in one go, up to the combined 70%.
      await expect(deploy(both, forty + 1n))
        .to.be.revertedWithCustomError(ssf, "GuardianCapExceeded").withArgs(forty, forty + 1n);
      await deploy(both, forty);
      expect(await ssf.deployerSRXUsed() + await ssf.guardianSRXUsed()).to.equal(seventy);
      await expect(deploy(both, 1n))
        .to.be.revertedWithCustomError(ssf, "GuardianCapExceeded").withArgs(0n, 1n);
      expect(await ssf.getGuardianCapRemaining()).to.equal(0n);
    });
  });

  // ── SF2 ────────────────────────────────────────────────────────────────────
  describe("SF2: free-balance guard after the snapshot", function () {
    it("when governance deploys most free SRX after the trigger, a guardian request within its cap but above free SRX reverts InsufficientFreeBalance; a request equal to free succeeds", async function () {
      const { oracle, guardian, timelock, c1, srx, ssf, deploy } = await loadFixture(fixture);
      await ssf.connect(c1).contribute(e18(1_000_000));           // principal that must stay backed
      await ssf.connect(oracle).triggerStressEvent();
      expect(await ssf.stressStartSRXBalance()).to.equal(SEED);   // snapshot = free SRX (principal + reward backing excluded)
      const cap = (SEED * 7_000n) / BPS;                          // 1.05B guardian cap

      // Governance deploys all but 10M of the free SRX. (Before REG-50 this test
      // registered it as rewards instead; reward SRX is now reserved from the start,
      // so registering it no longer changes what is free.)
      const free = e18(10_000_000);
      await deploy(timelock, SEED - free, "governance move");
      const backing = e18(10_000_000);
      const balance = await srx.balanceOf(await ssf.getAddress());
      expect(balance - (await ssf.totalContributions()) - (await ssf.rewardPool()) - backing).to.equal(free);

      const ask = e18(20_000_000);
      expect(ask).to.be.lt(cap);                                  // within the guardian's cap ...
      expect(await ssf.getGuardianCapRemaining()).to.equal(cap);
      await expect(deploy(guardian, ask))                         // ... but more than is free
        .to.be.revertedWithCustomError(ssf, "InsufficientFreeBalance").withArgs(free, ask);
      expect(await ssf.guardianSRXUsed()).to.equal(0n);

      // Control: exactly the free amount goes through; principal and reward backing are untouched.
      await deploy(guardian, free);
      expect(await srx.balanceOf(await ssf.getAddress())).to.equal(e18(1_000_000) + backing);
      expect(await ssf.rewardBacking()).to.equal(backing);
      await expect(deploy(guardian, 1n))
        .to.be.revertedWithCustomError(ssf, "InsufficientFreeBalance").withArgs(0n, 1n);
    });

    it("governance (the 48h path) is bound by the free-balance check too (REG-50, 12 Oct 2026)", async function () {
      // ⛔ Until 12 Oct 2026 governance could deploy depositors' principal and reward SRX.
      const { oracle, timelock, c1, ssf, deploy } = await loadFixture(fixture);
      await ssf.connect(c1).contribute(e18(1_000_000));
      await ssf.connect(oracle).triggerStressEvent();
      await deploy(timelock, SEED, "all free SRX");
      await expect(deploy(timelock, 1n, "principal or reward SRX"))
        .to.be.revertedWithCustomError(ssf, "InsufficientFreeBalance").withArgs(0n, 1n);
    });
  });

  // ── SF3 ────────────────────────────────────────────────────────────────────
  describe("SF3: a top-up restarts the full withdrawal lock", function () {
    it("contribute, wait 29 days, top up: withdrawContribution reverts WithdrawLockActive until a further full lock period from the top-up", async function () {
      const { c1, c2, srx, ssf } = await loadFixture(fixture);
      const LOCK = 30 * DAY;
      const amt = e18(1_000);

      await ssf.connect(c1).contribute(amt);
      await ssf.connect(c2).contribute(amt);                       // control account: never tops up
      const t0 = BigInt((await ssf.contributions(c1.address)).depositTime);
      const t0c2 = BigInt((await ssf.contributions(c2.address)).depositTime);

      await time.increaseTo(t0 + BigInt(29 * DAY));
      await ssf.connect(c1).contribute(amt);                       // top-up on day 29
      const t1 = BigInt((await ssf.contributions(c1.address)).depositTime);
      expect(t1).to.be.gte(t0 + BigInt(29 * DAY));
      expect((await ssf.contributions(c1.address)).srxAmount).to.equal(amt * 2n);

      // Day 30 from the ORIGINAL deposit: the un-topped-up account is free to leave ...
      await time.increaseTo(t0c2 + BigInt(LOCK));
      await expect(ssf.connect(c2).withdrawContribution(amt)).to.emit(ssf, "ContributionWithdrawn").withArgs(c2.address, amt);
      // ... but the topped-up account's whole principal is locked again until t1 + 30 days.
      await expect(ssf.connect(c1).withdrawContribution(amt * 2n))
        .to.be.revertedWithCustomError(ssf, "WithdrawLockActive").withArgs(t1 + BigInt(LOCK));
      await expect(ssf.connect(c1).withdrawContribution(amt))      // a partial withdrawal is locked too
        .to.be.revertedWithCustomError(ssf, "WithdrawLockActive").withArgs(t1 + BigInt(LOCK));

      // Still locked one day before the new unlock time (i.e. 59 days after the first deposit).
      await time.increaseTo(t1 + BigInt(LOCK) - BigInt(DAY));
      await expect(ssf.connect(c1).withdrawContribution(amt * 2n))
        .to.be.revertedWithCustomError(ssf, "WithdrawLockActive").withArgs(t1 + BigInt(LOCK));

      // A full lock period after the top-up it opens, and the whole principal comes back.
      await time.increaseTo(t1 + BigInt(LOCK));
      const before = await srx.balanceOf(c1.address);
      await expect(ssf.connect(c1).withdrawContribution(amt * 2n))
        .to.emit(ssf, "ContributionWithdrawn").withArgs(c1.address, amt * 2n);
      expect((await srx.balanceOf(c1.address)) - before).to.equal(amt * 2n);
      expect((await ssf.contributions(c1.address)).srxAmount).to.equal(0n);
    });
  });
});
