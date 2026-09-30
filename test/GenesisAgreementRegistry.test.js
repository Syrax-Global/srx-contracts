// GenesisAgreementRegistry — the on-chain record that a wallet accepted its
// Genesis purchase agreement (Syrax Chain; holds no funds, has no admin).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("GenesisAgreementRegistry", function () {
  // The commitment the backend builds: the document never goes on chain.
  const commitmentFor = (documentText, salt) =>
    ethers.solidityPackedKeccak256(
      ["string", "bytes32", "bytes32"],
      ["SYRAX-GENESIS-AGREEMENT-V1", ethers.sha256(ethers.toUtf8Bytes(documentText)), salt],
    );

  async function fixture() {
    const [invitee, other] = await ethers.getSigners();
    const R = await ethers.getContractFactory("GenesisAgreementRegistry");
    const registry = await R.deploy();
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const doc = `Genesis purchase agreement v1 · wallet ${invitee.address} · $10,000`;
    return { registry, invitee, other, salt, doc, commitment: commitmentFor(doc, salt) };
  }

  it("records the caller, the commitment and the time, and emits AgreementAccepted", async function () {
    const { registry, invitee, commitment } = await loadFixture(fixture);
    const tx = await registry.connect(invitee).accept(commitment);
    const at = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;
    await expect(tx).to.emit(registry, "AgreementAccepted").withArgs(invitee.address, commitment, at);
    expect(await registry.acceptedAt(invitee.address, commitment)).to.equal(at);
  });

  it("proves this exact document was accepted — and only with the salt", async function () {
    const { registry, invitee, commitment, doc, salt } = await loadFixture(fixture);
    await registry.connect(invitee).accept(commitment);
    expect(await registry.acceptedAt(invitee.address, commitmentFor(doc, salt))).to.be.greaterThan(0n);
    // One character different, or a different salt: no record.
    expect(await registry.acceptedAt(invitee.address, commitmentFor(doc + " ", salt))).to.equal(0n);
    expect(await registry.acceptedAt(invitee.address, commitmentFor(doc, ethers.ZeroHash))).to.equal(0n);
  });

  it("is per wallet: another wallet's acceptance is not the invitee's", async function () {
    const { registry, invitee, other, commitment } = await loadFixture(fixture);
    await registry.connect(other).accept(commitment);
    expect(await registry.acceptedAt(invitee.address, commitment)).to.equal(0n);
    expect(await registry.acceptedAt(other.address, commitment)).to.be.greaterThan(0n);
  });

  it("cannot be accepted twice, so the first time stands", async function () {
    const { registry, invitee, commitment } = await loadFixture(fixture);
    await registry.connect(invitee).accept(commitment);
    const first = await registry.acceptedAt(invitee.address, commitment);
    await time.increase(3600);
    await expect(registry.connect(invitee).accept(commitment))
      .to.be.revertedWithCustomError(registry, "AlreadyAccepted").withArgs(invitee.address, commitment);
    expect(await registry.acceptedAt(invitee.address, commitment)).to.equal(first);
  });

  it("an amended agreement is a new commitment, accepted separately", async function () {
    const { registry, invitee, commitment, salt } = await loadFixture(fixture);
    await registry.connect(invitee).accept(commitment);
    const amended = commitmentFor(`Genesis purchase agreement v2 · wallet ${invitee.address} · $25,000`, salt);
    await registry.connect(invitee).accept(amended);
    expect(await registry.acceptedAt(invitee.address, amended)).to.be.greaterThan(0n);
  });

  it("refuses an empty commitment", async function () {
    const { registry, invitee } = await loadFixture(fixture);
    await expect(registry.connect(invitee).accept(ethers.ZeroHash))
      .to.be.revertedWithCustomError(registry, "ZeroCommitment");
  });

  it("has no admin and no way to change or remove a record", async function () {
    const { registry } = await loadFixture(fixture);
    const writes = registry.interface.fragments
      .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f) => f.name);
    expect(writes).to.deep.equal(["accept"]);
  });
});
