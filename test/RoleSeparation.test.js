// SC-TRUST-001, enforced in code (board 45d8fd15, 1 Oct 2026).
//
// ⛔ The contracts documented upgrade and spending authority as "Timelock only" and
//    "SEPARATED", but every role was administered by DEFAULT_ADMIN_ROLE. Whoever held
//    that (the admin Safe until the launch hand-over) could grant itself SPENDER_ROLE
//    and empty the treasury, or re-grant UPGRADER_ROLE, with no delay. Only the role
//    gate (verify_roles.js) checked the end state.
//
// ⭐ Now SPENDER_ROLE (treasury) administers itself: DEFAULT_ADMIN_ROLE cannot hand it
//    out. (UPGRADER_ROLE no longer exists: REG-53 made the contracts non-upgradeable.)
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { allocationSource } = require("./helpers/allocationSource");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("Role separation (SC-TRUST-001): the spending right administers itself", function () {
  async function fixture() {
    const [admin, timelock, stranger] = await ethers.getSigners();
    const endpoint = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await endpoint.getAddress(), admin.address);
    const srxAddr = await srx.getAddress();
    const proxy = async (name, args) => (await ethers.getContractFactory(name)).deploy(...args);

    const treasury = await proxy("SRXTreasury", [srxAddr, admin.address, timelock.address]);
    const staking  = await proxy("SRXStaking", [srxAddr, admin.address, await allocationSource(srxAddr)]);
    const fund     = await proxy("StabilisationFund", [srxAddr, admin.address, 3_000, 7_000, 30 * 86400, ethers.parseUnits("10000000", 18), await allocationSource(srxAddr, ethers.parseUnits("1500000000", 18))]);
    const fee      = await proxy("FeeController", [await staking.getAddress(), admin.address]);
    return { admin, timelock, stranger, treasury, staking, fund, fee };
  }

  it("the admin cannot grant itself or anyone the treasury's spending right; the Timelock can", async function () {
    const { admin, timelock, stranger, treasury } = await loadFixture(fixture);
    const SPENDER = await treasury.SPENDER_ROLE();
    expect(await treasury.getRoleAdmin(SPENDER)).to.equal(SPENDER);
    expect(await treasury.hasRole(SPENDER, admin.address)).to.equal(false);
    await expect(treasury.connect(admin).grantRole(SPENDER, admin.address))
      .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
    await expect(treasury.connect(admin).grantRole(SPENDER, stranger.address))
      .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
    await expect(treasury.connect(timelock).grantRole(SPENDER, stranger.address)).to.not.be.reverted;
  });

  // REG-53 (12 Oct 2026): this contract is no longer upgradeable, so the upgrade-authority
  // tests that stood here were removed. That no upgrade is possible, by any role, is proved
  // in test/REG53.NotUpgradeable.test.js.
});

