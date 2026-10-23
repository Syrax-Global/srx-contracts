/**
 * The build record (scripts/deploy/lib/build_record.js) pins which compiled build produced a
 * deployment, so the Syrax Chain's registration gate can check the hub against the AUDITED build
 * by sha256, never against a later recompile (Chain, 23 Oct 2026).
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildRecord } = require("../../scripts/deploy/lib/build_record");

describe("Build record: the deployed build, pinned by sha256", function () {
  it("records the build-info sha256 and code hashes, and the deployed code matches its artifact once immutables are zeroed", async function () {
    const [admin] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    const timelock = await (await ethers.getContractFactory("SRXTimelock")).deploy(172800, [], [ethers.ZeroAddress], admin.address);
    const rec = await buildRecord(hre, { SRXToken: await token.getAddress(), SRXTimelock: await timelock.getAddress() });

    const t = rec.contracts.SRXToken;
    expect(t.matchesArtifact, "SRXToken has immutables (the LayerZero endpoint): zeroed, it equals the artifact").to.equal(true);
    expect(rec.contracts.SRXTimelock.matchesArtifact).to.equal(true);
    // The sha256 is of the exact build-info file the artifact points at.
    const file = path.join(hre.config.paths.artifacts, "build-info", `${t.buildInfoId}.json`);
    expect(t.buildInfoSha256).to.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    // SRXToken is built with its size override (runs: 1); the record says so.
    expect(t.optimizer).to.deep.equal({ enabled: true, runs: 1 });
    expect(t.viaIR).to.equal(true);
    expect(t.onChainCodeHash).to.not.equal(t.artifactCodeHash); // immutables differ on chain, as expected
    // A full commit hash, or null in a checkout with no commit yet (never the text "HEAD").
    if (rec.commit !== null) expect(rec.commit).to.match(/^[0-9a-f]{40}$/);
    expect(typeof rec.contractsClean).to.equal("boolean");
  });

  it("a different contract at the address does not match (the check can fail)", async function () {
    const [admin] = await ethers.getSigners();
    const timelock = await (await ethers.getContractFactory("SRXTimelock")).deploy(172800, [], [ethers.ZeroAddress], admin.address);
    const rec = await buildRecord(hre, { SRXToken: await timelock.getAddress() });
    expect(rec.contracts.SRXToken.matchesArtifact).to.equal(false);
    const none = await buildRecord(hre, { SRXToken: ethers.Wallet.createRandom().address });
    expect(none.contracts.SRXToken.onChainCodeHash).to.equal(null);
    expect(none.contracts.SRXToken.matchesArtifact).to.equal(false);
  });
});
