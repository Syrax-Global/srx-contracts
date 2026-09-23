const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAdminBatch } = require("../../scripts/deploy/lib/adminTx");

describe("adminTx (SC-TRUST-002 helper)", function () {
  let token, admin, deployer, other;
  let tmpDir;

  beforeEach(async function () {
    [deployer, admin, other] = await ethers.getSigners();

    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint = await MockLZEndpoint.deploy(30101);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    token = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "admintx-test-"));
  });

  afterEach(function () {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("queues the call and writes a Safe Transaction Builder file when the signer is not the admin", async function () {
    const BURN_ROLE = await token.BURN_ROLE();
    expect(await token.hasRole(BURN_ROLE, other.address)).to.equal(false);

    // The loaded signer (deployer) is NOT the admin here — every mainnet
    // deployment shape this helper exists for.
    const batch = createAdminBatch("test_burn_role", {
      signer: deployer,
      admin: admin.address,
      outDir: tmpDir,
    });

    expect(await batch.isAdmin()).to.equal(false);

    const result = await batch.send(
      token,
      "grantRole",
      [BURN_ROLE, other.address],
      "SRXToken.grantRole(BURN_ROLE, other)"
    );
    expect(result.executed).to.equal(false);

    // Nothing changed on-chain yet — the deployer never held any role.
    expect(await token.hasRole(BURN_ROLE, other.address)).to.equal(false);

    const file = await batch.flush();
    expect(file).to.be.a("string");
    expect(fs.existsSync(file)).to.equal(true);
    expect(path.basename(file)).to.match(/^safe_batch\.test_burn_role\..+\.json$/);

    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed.version).to.equal("1.0");
    expect(parsed.transactions).to.have.lengthOf(1);
    expect(parsed.transactions[0].value).to.equal("0");
    expect(ethers.getAddress(parsed.transactions[0].to)).to.equal(await token.getAddress());

    const expectedData = token.interface.encodeFunctionData("grantRole", [BURN_ROLE, other.address]);
    expect(parsed.transactions[0].data).to.equal(expectedData);

    // A second flush with nothing newly queued is a no-op.
    expect(await batch.flush()).to.equal(null);

    // The admin Safe now executes the queued transaction itself.
    const tx = await admin.sendTransaction({ to: parsed.transactions[0].to, data: parsed.transactions[0].data });
    await tx.wait();

    expect(await token.hasRole(BURN_ROLE, other.address)).to.equal(true);
  });

  it("executes immediately, with no file written, when the signer IS the admin", async function () {
    const BURN_ROLE = await token.BURN_ROLE();

    const batch = createAdminBatch("test_burn_role_direct", {
      signer: admin,
      admin: admin.address,
      outDir: tmpDir,
    });

    expect(await batch.isAdmin()).to.equal(true);

    const result = await batch.send(
      token,
      "grantRole",
      [BURN_ROLE, other.address],
      "SRXToken.grantRole(BURN_ROLE, other)"
    );
    expect(result.executed).to.equal(true);
    expect(result.receipt).to.not.equal(undefined);

    // Executed immediately — no Safe batch needed.
    expect(await token.hasRole(BURN_ROLE, other.address)).to.equal(true);

    const file = await batch.flush();
    expect(file).to.equal(null);
    expect(fs.readdirSync(tmpDir)).to.have.lengthOf(0);
  });

  it("defaults to getSigners()[0] and WALLETS.admin when no options are given", async function () {
    // Sanity check for the injection contract only — createAdminBatch() with no
    // options must not throw, and must resolve isAdmin() without an explicit
    // signer/admin. We don't assert a specific outcome here since WALLETS.admin
    // depends on env/.env in this environment; we only assert it resolves cleanly.
    const batch = createAdminBatch("test_defaults", { outDir: tmpDir });
    const result = await batch.isAdmin();
    expect(typeof result).to.equal("boolean");
  });
});
