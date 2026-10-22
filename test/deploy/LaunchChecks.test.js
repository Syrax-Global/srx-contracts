// V6, launch protection vs vesting (internal review, 7 Oct 2026): the old check compared
// the wallet cap with releasable() at TGE, which is 0 for every launch vault, so it could
// never fail. This proves the deadlock is real on chain and that the new check
// (lib/launch_checks.js) flags it at TGE time, when the old check passed.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { walletCapConflicts, missingExemptions } = require("../../scripts/deploy/lib/launch_checks");

const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86400;

describe("Launch protection vs vesting (V6): the wallet-cap check sees the future, not just today", function () {
  it("pure: flags a non-exempt beneficiary whose remaining entitlement exceeds the cap; ignores exempt ones and cap 0", function () {
    const v = { label: "Founders", beneficiary: "0xF", beneficiaryBalance: 0n, initialAllocation: E(1_000), released: 0n };
    expect(walletCapConflicts({ cap: E(500), vaults: [{ ...v, exempt: false }] })).to.have.length(1);
    expect(walletCapConflicts({ cap: E(500), vaults: [{ ...v, exempt: true }] })).to.deep.equal([]);
    expect(walletCapConflicts({ cap: 0n, vaults: [{ ...v, exempt: false }] })).to.deep.equal([]);
    expect(walletCapConflicts({ cap: E(1_000), vaults: [{ ...v, exempt: false }] })).to.deep.equal([]);
    // what the beneficiary already holds counts too
    expect(walletCapConflicts({ cap: E(1_000), vaults: [{ ...v, exempt: false, beneficiaryBalance: 1n }] })).to.have.length(1);
    // released tokens are no longer owed
    expect(walletCapConflicts({ cap: E(500), vaults: [{ ...v, exempt: false, released: E(600) }] })).to.deep.equal([]);
  });

  it("on chain: the deadlock is real when the cliff ends, and the new check flags it at TGE while the old one could not", async function () {
    const [admin, founder, treasury] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    await token.connect(admin).genesis(admin.address);
    const vault = await (await ethers.getContractFactory("VestingVault"))
      .deploy(await token.getAddress(), founder.address, admin.address, 30 * DAY, 300 * DAY, 0, treasury.address);
    await token.connect(admin).setExemptFromLimits(await vault.getAddress(), true);
    await token.connect(admin).transfer(await vault.getAddress(), E(1_000));
    await vault.connect(admin).declareExpectedAllocation(E(1_000));
    await vault.connect(admin).triggerTGE();
    await token.connect(admin).setMaxWalletBalance(E(100));

    // At TGE nothing is releasable, so the old check (cap vs releasable now) passes...
    expect(await vault.releasable()).to.equal(0n);
    const oldCheckFails = (await token.balanceOf(founder.address)) + (await vault.releasable()) > E(100);
    expect(oldCheckFails).to.equal(false);
    // ...while the new check sees the founder's 1,000 SRX entitlement against a 100 SRX cap.
    const failures = walletCapConflicts({ cap: E(100), vaults: [{
      label: "Founders", beneficiary: founder.address, exempt: await token.isExemptFromLimits(founder.address),
      beneficiaryBalance: await token.balanceOf(founder.address),
      initialAllocation: await vault.initialAllocation(), released: await vault.released(),
    }] });
    expect(failures).to.have.length(1);

    // And it is real: well after the cliff the founder cannot release.
    await time.increase(200 * DAY);
    await expect(vault.connect(founder).release()).to.be.revertedWithCustomError(token, "WalletExceedsMaxBalance");
    // Exempting the beneficiary is the fix the check recommends.
    await token.connect(admin).setExemptFromLimits(founder.address, true);
    await vault.connect(founder).release();
    expect(await token.balanceOf(founder.address)).to.be.gt(E(100));
  });

  it("pure: lists every required address that is not exempt, and nothing when all are", async function () {
    const required = [{ label: "SRXStaking", address: "0x1" }, { label: "0xdEaD", address: "0x2" }];
    const exempt = new Set(["0x1"]);
    const missing = await missingExemptions({ required, isExempt: async (a) => exempt.has(a) });
    expect(missing).to.have.length(1);
    expect(missing[0]).to.match(/0xdEaD/);
    exempt.add("0x2");
    expect(await missingExemptions({ required, isExempt: async (a) => exempt.has(a) })).to.deep.equal([]);
  });
});
