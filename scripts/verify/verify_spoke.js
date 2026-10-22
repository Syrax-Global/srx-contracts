/**
 * verify_spoke.js — run on a spoke chain after 07 steps D and E (SPOKE-01).
 *
 * Passes only if: the spoke's owner AND its LayerZero delegate are the spoke's own
 * Timelock; the Timelock enforces at least the network's required delay, has the Safe
 * as proposer, open execution and no admin; and the spoke's only peer is the hub token
 * fixed at deployment; and the spoke uses its own send and receive libraries with at
 * least two DVNs each way (lib/dvnCheck.js). Read-only; exits 1 on any failure.
 *
 *   npx hardhat run scripts/verify/verify_spoke.js --network bscTestnet
 */
const { ethers, network } = require("hardhat");
const { LZ_EIDS, GOVERNANCE, TESTNET_CHAINS, walletFor } = require("../deploy/00_config");
const { checkSpoke } = require("../deploy/lib/spokeOps");
const { checkDvnConfig, checkEnforcedOptions, ENDPOINT_ABI } = require("../deploy/lib/dvnCheck");

async function main() {
  const NET = network.name.toUpperCase();
  const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
  const testnet = TESTNET_CHAINS.has(network.name);
  const hubEnv = testnet ? "SRX_TOKEN_SEPOLIA" : "SRX_TOKEN_ETHEREUM";
  const hubEid = testnet ? LZ_EIDS.sepolia : LZ_EIDS.ethereum;

  const spoke = await ethers.getContractAt("SRXOFTNative", need(`SRX_OFT_NATIVE_${NET}`));
  const timelock = await ethers.getContractAt("SRXTimelock", need(`SPOKE_TIMELOCK_${NET}`));
  const failures = await checkSpoke({
    spoke, timelock,
    hubAddress: need(hubEnv), hubEid,
    safe: walletFor("admin", network.name),
    requiredDelay: GOVERNANCE.timelockDelayFor(network.name),
  });
  // Which messages from the hub this spoke believes: its own libraries, at least 2 DVNs.
  const lz = new ethers.Contract(await spoke.endpoint(), ENDPOINT_ABI, ethers.provider);
  failures.push(...await checkDvnConfig({ endpoint: lz, oapp: await spoke.getAddress(), remoteEid: hubEid, label: "spoke <-> hub" }));
  failures.push(...await checkEnforcedOptions({ oapp: spoke, remoteEid: hubEid, label: "spoke -> hub" }));

  console.log(`\nSpoke ${network.name}: ${await spoke.getAddress()} · Timelock ${await timelock.getAddress()}`);
  if (failures.length === 0) {
    console.log("✅ SPOKE VERIFIED — owner and delegate are the spoke Timelock; the only peer is the hub");
  } else {
    for (const f of failures) console.log(`❌ ${f}`);
    console.log(`❌ SPOKE VERIFICATION FAILED — ${failures.length} check(s)`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
