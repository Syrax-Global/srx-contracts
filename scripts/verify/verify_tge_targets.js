/**
 * verify_tge_targets.js — TGE destination-allowlist gate (Round 6 / D2)
 *
 * The single scariest non-code risk in the whole launch: 06_execute_tge.js sends
 * billions of SRX to destinations read from .env / 00_config.js. One wrong env var
 * → 9–17% of supply sent irreversibly to a wrong address. No on-chain code can catch it.
 *
 * ⭐ 06_execute_tge.js now runs these same checks itself, before any transaction,
 *    and stops on any failure. This script is the same gate as a read-only dry run:
 *    use it while preparing the manifest, so the real run holds no surprises.
 *
 * ⛔ It used to rebuild the allocation list by copy, with a different env lookup
 *    (it accepted an unsuffixed variable the TGE script would not read), so the
 *    check and the send could disagree. Both now come from
 *    scripts/deploy/lib/tge_targets.js, and nothing is reconstructed.
 *
 * Setup: cp deploy/addresses.example.json deploy/addresses.<network>.json, fill every
 * field with the FINAL checksummed addresses, keep the authoritative copy in your Safe
 * records. The file is gitignored.
 *
 * Run: npx hardhat run scripts/verify/verify_tge_targets.js --network ethereum
 * Exit code: 0 only when every check passed.
 */
const { ethers, network } = require("hardhat");
const { runTgeTargetChecks } = require("../deploy/lib/tge_targets");
require("dotenv").config();

const VAULT_ABI = [
  "function token() view returns (address)",
  "function beneficiary() view returns (address)",
  "function cliffDuration() view returns (uint256)",
  "function vestingDuration() view returns (uint256)",
  "function tgeUnlockBps() view returns (uint256)",
];

async function main() {
  const NET = network.name.toUpperCase();
  const tokenAddress = process.env[`SRX_TOKEN_${NET}`];
  const { chainId } = await ethers.provider.getNetwork();

  console.log(`\n🎯 TGE target verification — network: ${network.name} (chain ${chainId})`);

  const gate = await runTgeTargetChecks({
    networkName: network.name,
    chainId,
    provider: ethers.provider,
    vaultAt: (addr) => new ethers.Contract(addr, VAULT_ABI, ethers.provider),
    tokenAddress,
  });
  console.log(`   manifest: ${gate.manifestPath}${gate.skipped ? " (absent — allowed on this network only)" : ""}\n`);

  for (const a of gate.allocations) {
    console.log(`   ${a.label.padEnd(18)} ${a.destination}  ${ethers.formatUnits(a.amount, 18)} SRX`);
  }

  console.log(`\n──────────────────────────────────────────────`);
  if (gate.failures.length > 0) {
    for (const f of gate.failures) console.log(`   ❌ ${f}`);
    console.log(`\n❌ ${gate.failures.length} failure(s) — TGE MUST NOT PROCEED. Fix .env / config or the manifest.`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ ALL TGE TARGETS VERIFIED against the manifest and the chain. Safe to proceed.`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
