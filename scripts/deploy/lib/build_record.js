/**
 * build_record.js — which compiled build produced a deployment (Chain, 23 Oct 2026).
 *
 * The Syrax Chain's base-token registration gate must check the SRX hub against the build
 * that was actually deployed after the audit, pinned by sha256. A later recompile produces a
 * different build-info file (and, since 22 Oct, SRXToken and PreSaleRound use per-file optimizer
 * settings), so the record is taken at deploy time and the gate reads it by hash, never from
 * whatever `hardhat compile` produces later.
 *
 * Per contract it records:
 *   buildInfoSha256   sha256 of artifacts/build-info/<id>.json, the exact compiler input+output
 *   artifactCodeHash  keccak256 of the artifact's deployedBytecode
 *   onChainCodeHash   keccak256 of the code at the deployed address
 *   matchesArtifact   true if the on-chain code equals the artifact once its immutables
 *                     (constructor-set values) are zeroed, using the build's immutableReferences
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

/** On-chain runtime code with every immutable slot zeroed, as the artifact holds it. */
function zeroImmutables(code, immutableReferences) {
  let hex = code.startsWith("0x") ? code.slice(2) : code;
  for (const refs of Object.values(immutableReferences || {})) {
    for (const { start, length } of refs) {
      hex = hex.slice(0, start * 2) + "00".repeat(length) + hex.slice((start + length) * 2);
    }
  }
  return "0x" + hex;
}

/**
 * @param hre        the Hardhat runtime (artifacts, ethers provider, config)
 * @param contracts  { Name: address } as in deployments/<net>.json
 */
async function buildRecord(hre, contracts) {
  const root = hre.config.paths.root;
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
  const out = {
    // A checkout with no commit yet prints "HEAD" here: record no commit rather than that.
    commit: /^[0-9a-f]{40}$/.test(git(["rev-parse", "HEAD"])) ? git(["rev-parse", "HEAD"]) : null,
    contractsClean: git(["status", "--porcelain", "--", "contracts"]) === "",
    recordedAt: new Date().toISOString(),
    contracts: {},
  };
  for (const [name, address] of Object.entries(contracts)) {
    if (!address) continue;
    const artifact = await hre.artifacts.readArtifact(name);
    const fqn = `${artifact.sourceName}:${artifact.contractName}`;
    const buildInfo = await hre.artifacts.getBuildInfo(fqn);
    const buildInfoPath = path.join(hre.config.paths.artifacts, "build-info", `${buildInfo.id}.json`);
    const buildInfoSha256 = crypto.createHash("sha256").update(fs.readFileSync(buildInfoPath)).digest("hex");
    const evm = buildInfo.output.contracts[artifact.sourceName][artifact.contractName].evm;
    const onChain = await hre.ethers.provider.getCode(address);
    out.contracts[name] = {
      address,
      sourceName: artifact.sourceName,
      buildInfoId: buildInfo.id,
      buildInfoSha256,
      solcVersion: buildInfo.solcVersion,
      optimizer: buildInfo.input.settings.optimizer,
      viaIR: !!buildInfo.input.settings.viaIR,
      artifactCodeHash: ethers.keccak256(artifact.deployedBytecode),
      onChainCodeHash: onChain === "0x" ? null : ethers.keccak256(onChain),
      matchesArtifact: onChain !== "0x" &&
        zeroImmutables(onChain, evm.deployedBytecode.immutableReferences).toLowerCase() === artifact.deployedBytecode.toLowerCase(),
    };
  }
  return out;
}

module.exports = { buildRecord, zeroImmutables };
