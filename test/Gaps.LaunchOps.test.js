// Launch operations: the two Timelock batches that set up the launch vesting vaults
// (scripts/deploy/lib/vaultOps.js) behave as documented on a real SRXTimelock, and the
// testnet market-maker placeholder in 00_config.js is what its comment says it is.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { vaultOps } = require("../scripts/deploy/lib/vaultOps");
const { TGE_PLAN, TESTNET_WALLET_DEFAULTS, WALLETS } = require("../scripts/deploy/00_config");

describe("Gaps — launch operations", function () {
  const DELAY = 60;
  const DAY = 86400n;
  const VAULT_ROWS = TGE_PLAN.filter((r) => r.kind === "vault");

  // Small, distinct amounts per allocation key (the real ones are billions of SRX).
  const AMOUNTS = {};
  VAULT_ROWS.forEach((row, i) => { AMOUNTS[row.allocation] = ethers.parseUnits(String(1_000 * (i + 1)), 18); });

  async function setup() {
    const [admin, executor, treasury, ...rest] = await ethers.getSigners();
    const M = await ethers.getContractFactory("MockERC20");
    const token = await M.deploy("SRX Mock", "SRX", 18);
    await token.mint(admin.address, ethers.parseUnits("1000000", 18));

    // executors [address(0)]: anyone may execute, as in the deployment
    const TL = await ethers.getContractFactory("SRXTimelock");
    const timelock = await TL.deploy(DELAY, [admin.address], [ethers.ZeroAddress], admin.address);

    const V = await ethers.getContractFactory("VestingVault");
    const vaultByLabel = {};
    const vaults = [];
    for (let i = 0; i < VAULT_ROWS.length; i++) {
      const row = VAULT_ROWS[i];
      const v = await V.deploy(token.target, rest[i].address, timelock.target, 30n * DAY, 100n * DAY, 0n, treasury.address);
      await token.connect(admin).transfer(v.target, AMOUNTS[row.allocation]);
      vaultByLabel[row.label] = v.target;
      vaults.push({ row, v });
    }
    const ops = vaultOps(vaultByLabel, AMOUNTS);
    return { admin, executor, treasury, token, timelock, vaults, ops };
  }

  const schedule = (timelock, admin, op) =>
    timelock.connect(admin).scheduleBatch(...op.args, DELAY);
  const execute = (timelock, caller, op) => timelock.connect(caller).executeBatch(...op.args);

  describe("L1 the vault set-up batches on a real SRXTimelock", function () {
    it("the vault admin is the Timelock, so the Safe/admin EOA cannot call the vaults directly (control for the premise)", async function () {
      const { admin, timelock, vaults } = await setup();
      for (const { v } of vaults) {
        expect(await v.admin()).to.equal(timelock.target);
        await expect(v.connect(admin).triggerTGE()).to.be.revertedWithCustomError(v, "OnlyAdmin");
        await expect(v.connect(admin).declareExpectedAllocation(1n)).to.be.revertedWithCustomError(v, "OnlyAdmin");
      }
    });

    it("TRIGGER cannot execute before DECLARE; after both execute in order every vault is declared and triggered", async function () {
      const { admin, executor, timelock, vaults, ops } = await setup();
      expect(ops.trigger.predecessor).to.equal(ops.declare.id);

      await schedule(timelock, admin, ops.declare);
      await schedule(timelock, admin, ops.trigger);
      expect(await timelock.isOperation(ops.declare.id)).to.equal(true);
      expect(await timelock.isOperation(ops.trigger.id)).to.equal(true);

      // too early: neither is ready yet
      await expect(execute(timelock, executor, ops.declare)).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

      await time.increase(DELAY + 1);

      // wrong order: both are ready, but TRIGGER's predecessor (DECLARE) has not run
      await expect(execute(timelock, executor, ops.trigger))
        .to.be.revertedWithCustomError(timelock, "TimelockUnexecutedPredecessor").withArgs(ops.declare.id);
      for (const { v } of vaults) {
        expect(await v.tgeTriggered()).to.equal(false);
        expect(await v.expectedAllocation()).to.equal(0n);
      }

      // control: right order. DECLARE first, executed by anyone (executor is not a proposer)...
      await execute(timelock, executor, ops.declare);
      for (const { row, v } of vaults) {
        expect(await v.expectedAllocation()).to.equal(AMOUNTS[row.allocation]);
        expect(await v.tgeTriggered()).to.equal(false);
      }
      // ...then TRIGGER
      await execute(timelock, executor, ops.trigger);
      for (const { row, v } of vaults) {
        expect(await v.tgeTriggered()).to.equal(true);
        expect(await v.expectedAllocation()).to.equal(AMOUNTS[row.allocation]);
        expect(await v.initialAllocation()).to.equal(AMOUNTS[row.allocation]);
        expect(await v.totalAllocation()).to.equal(AMOUNTS[row.allocation]);
      }
      expect(await timelock.isOperationDone(ops.declare.id)).to.equal(true);
      expect(await timelock.isOperationDone(ops.trigger.id)).to.equal(true);

      // an executed batch cannot be replayed
      await expect(execute(timelock, executor, ops.trigger)).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("one underfunded vault makes the whole TRIGGER batch fail, leaving every vault untriggered", async function () {
      const { admin, executor, treasury, token, timelock, vaults } = await setup();
      // take 1 wei out of a vault is impossible (the Timelock is its admin, the vault has no pull),
      // so build the short vault from scratch: a fresh set whose first vault is funded 1 wei short
      const V = await ethers.getContractFactory("VestingVault");
      const short = await V.deploy(token.target, admin.address, timelock.target, 30n * DAY, 100n * DAY, 0n, treasury.address);
      await token.connect(admin).transfer(short.target, AMOUNTS[VAULT_ROWS[0].allocation] - 1n);
      const byLabel = Object.fromEntries(VAULT_ROWS.map((r, i) => [r.label, vaults[i].v.target]));
      byLabel[VAULT_ROWS[0].label] = short.target;
      const bad = vaultOps(byLabel, AMOUNTS);

      await schedule(timelock, admin, bad.declare);
      await schedule(timelock, admin, bad.trigger);
      await time.increase(DELAY + 1);
      await execute(timelock, executor, bad.declare);
      await expect(execute(timelock, executor, bad.trigger)).to.be.reverted;
      expect(await short.tgeTriggered()).to.equal(false);
      for (let i = 1; i < vaults.length; i++) expect(await vaults[i].v.tgeTriggered()).to.equal(false);
      // control: the failed execution rolled back, so the same TRIGGER is still ready; top up the
      // short vault by the missing 1 wei and it executes for all vaults at once
      await token.connect(admin).transfer(short.target, 1n);
      await execute(timelock, executor, bad.trigger);
      expect(await short.tgeTriggered()).to.equal(true);
      for (const { v } of vaults.slice(1)) expect(await v.tgeTriggered()).to.equal(true);
    });
  });

  describe("L2 the testnet market-maker placeholder", function () {
    it("equals the last 20 bytes of keccak256 of the string quoted in its comment", async function () {
      const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "deploy", "00_config.js"), "utf8");
      const m = src.match(/\/\/\s*keccak256\("([^"]+)"\)\[12:\]/);
      expect(m, "the comment above marketMaker must quote the preimage").to.not.equal(null);
      const preimage = m[1];
      expect(preimage).to.equal("SYRAX TESTNET PLACEHOLDER: MARKET MAKER — no key exists");

      // the comment sits directly above the marketMaker entry of the testnet defaults
      const lines = src.split(/\r?\n/);
      const commentLine = lines.findIndex((l) => l.includes(`keccak256("${preimage}")`));
      expect(lines[commentLine + 1]).to.match(/^\s*marketMaker:\s*"0x[0-9a-fA-F]{40}"/);

      const derived = ethers.getAddress("0x" + ethers.keccak256(ethers.toUtf8Bytes(preimage)).slice(2 + 24));
      expect(TESTNET_WALLET_DEFAULTS.marketMaker).to.equal(derived);
      // and on the hardhat (testnet) network, with no override set, the wallet resolves to it
      if (!process.env.WALLET_MARKET_MAKER) expect(WALLETS.marketMaker).to.equal(derived);
    });
  });
});
