/**
 * record_build.js — write deployments/<network>.builds.json: which compiled build produced each
 * deployed contract, pinned by sha256 (scripts/deploy/lib/build_record.js). Run straight after a
 * deployment, from the same clean checkout that deployed it. The Syrax Chain's base-token
 * registration gate pins the SRX hub's buildInfoSha256 from this file (Chain, 23 Oct 2026).
 *
 *   npx hardhat run scripts/ops/record_build.js --network <network>
 *
 * ⛔ On a real network it refuses when contracts/ has uncommitted changes, or when any deployed
 *    contract does not match its artifact: the record must describe what is actually on chain.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { buildRecord } = require("../deploy/lib/build_record");

const LOCAL = new Set(["hardhat", "localhost"]);

async function main() {
  const net = hre.network.name;
  const depPath = path.join(hre.config.paths.root, "deployments", `${net}.json`);
  if (!fs.existsSync(depPath)) throw new Error(`no deployments/${net}.json: run this after the deployment that wrote it`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const rec = await buildRecord(hre, dep.contracts || {});
  const mismatched = Object.entries(rec.contracts).filter(([, c]) => !c.matchesArtifact).map(([n]) => n);
  if (!LOCAL.has(net)) {
    if (!rec.contractsClean) throw new Error("contracts/ has uncommitted changes: the record would not describe a committed build");
    if (mismatched.length) throw new Error(`on-chain code does not match the local build for: ${mismatched.join(", ")}`);
  }
  const out = { network: net, chainId: dep.chainId, deploymentCommit: dep.commit || null, ...rec };
  const file = path.join(hre.config.paths.root, "deployments", `${net}.builds.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`✅ deployments/${net}.builds.json — ${Object.keys(rec.contracts).length} contracts` +
    (mismatched.length ? `; ⚠️ not matching the local build: ${mismatched.join(", ")}` : "; all match their artifacts"));
  if (rec.contracts.SRXToken) console.log(`   SRXToken buildInfoSha256 ${rec.contracts.SRXToken.buildInfoSha256}`);
}

main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
