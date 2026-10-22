// Gap-closing tests for FeeController governance access control.
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { allocationSource } = require("./helpers/allocationSource");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("Gaps: FeeController governance setters", function () {
  async function fixture() {
    const [admin, stranger, gateway, pauser, newStaking, recipient] = await ethers.getSigners();
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    const staking = await (await ethers.getContractFactory("SRXStaking")).deploy(...[await srx.getAddress(), admin.address, await allocationSource(srx)]);
    const fee = await (await ethers.getContractFactory("FeeController")).deploy(...[await staking.getAddress(), admin.address]);
    const GOVERNANCE = await fee.GOVERNANCE_ROLE();
    await fee.connect(admin).grantRole(await fee.GATEWAY_ROLE(), gateway.address);
    await fee.connect(admin).grantRole(await fee.PAUSER_ROLE(), pauser.address);
    // One routing destination so setFeeDestinationActive has something to act on.
    await fee.connect(admin).setFeeDestination(0, recipient.address, 10_000, true, ethers.encodeBytes32String("Treasury"));
    return { admin, stranger, gateway, pauser, newStaking, recipient, fee, staking, GOVERNANCE };
  }

  // Each case: how to call it, and how to observe that it took effect.
  const cases = (ctx) => [
    { name: "setCryptoFeeMultiplier", call: (f, s) => f.connect(s).setCryptoFeeMultiplier(5_000),
      before: async () => ctx.fee.cryptoFeeMultiplierBps(), expectBefore: 7_500n, expectAfter: 5_000n,
      event: "CryptoMultiplierUpdated" },
    { name: "setStakingContract", call: (f, s) => f.connect(s).setStakingContract(ctx.newStaking.address),
      before: async () => ctx.fee.stakingContract(), expectBefore: null, expectAfter: ctx.newStaking.address,
      event: "StakingContractUpdated" },
    { name: "setFeeDestinationActive", call: (f, s) => f.connect(s).setFeeDestinationActive(0, false),
      before: async () => (await ctx.fee.feeDestinations(0)).active, expectBefore: true, expectAfter: false,
      event: "FeeDestinationUpdated" },
  ];

  for (const name of ["setCryptoFeeMultiplier", "setStakingContract", "setFeeDestinationActive"]) {
    it(`${name}: a stranger, a GATEWAY_ROLE holder and a PAUSER_ROLE holder are refused and nothing changes; GOVERNANCE_ROLE succeeds`, async function () {
      const ctx = await loadFixture(fixture);
      const { fee, admin, stranger, gateway, pauser, GOVERNANCE } = ctx;
      const c = cases(ctx).find(x => x.name === name);
      const expectBefore = c.expectBefore === null ? await fee.stakingContract() : c.expectBefore;

      for (const who of [stranger, gateway, pauser]) {
        await expect(c.call(fee, who))
          .to.be.revertedWithCustomError(fee, "AccessControlUnauthorizedAccount").withArgs(who.address, GOVERNANCE);
      }
      expect(await c.before()).to.deep.equal(expectBefore);

      // Control: the identical call from GOVERNANCE_ROLE (the admin holds it from initialize) is accepted.
      expect(await fee.hasRole(GOVERNANCE, admin.address)).to.equal(true);
      await expect(c.call(fee, admin)).to.emit(fee, c.event);
      expect(await c.before()).to.deep.equal(c.expectAfter);
    });
  }

  it("control: a stranger granted GOVERNANCE_ROLE by the admin can then call all three", async function () {
    const { fee, admin, stranger, newStaking, GOVERNANCE } = await loadFixture(fixture);
    await fee.connect(admin).grantRole(GOVERNANCE, stranger.address);
    await fee.connect(stranger).setCryptoFeeMultiplier(6_000);
    await fee.connect(stranger).setStakingContract(newStaking.address);
    await fee.connect(stranger).setFeeDestinationActive(0, false);
    expect(await fee.cryptoFeeMultiplierBps()).to.equal(6_000n);
    expect(await fee.maxFeeBps()).to.equal(500n); // REG-54: even full governance cannot move it
    expect(await fee.stakingContract()).to.equal(newStaking.address);
    expect((await fee.feeDestinations(0)).active).to.equal(false);
  });
});
