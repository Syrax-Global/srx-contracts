/**
 * testnet_activate_voting.js — let the test wallets vote, so governance can be tested on a
 * test network (launch delegation, 23 Oct 2026).
 *
 * SRX counts as votes only once its holder delegates. On the testnet hub nobody had, so the
 * Governor could pass nothing. Each signer this network is configured with that holds SRX and
 * has no delegate yet delegates to itself (one transaction each). It then prints the delegated
 * supply against the quorum.
 *
 * ⛔ Test networks only. On mainnet Syrax-held SRX is never delegated: holders activate their
 *    own votes (launch option 1), or Syrax would hold the vote.
 *
 *   npx hardhat run scripts/ops/testnet_activate_voting.js --network sepolia
 * Env: SRX_TOKEN_<NET>, GOVERNOR_<NET>, SRX_TOKEN_DEPLOY_BLOCK_<NET>.
 */
const { ethers, network } = require("hardhat");
const { TESTNET_CHAINS } = require("../deploy/00_config");
const { delegatedSupply } = require("./lib/delegated_supply");

async function main() {
  if (!TESTNET_CHAINS.has(network.name)) {
    console.error(`Refused: ${network.name} is not a test network. On mainnet holders activate their own votes.`);
    process.exit(1);
  }
  const NET = network.name.toUpperCase();
  const need = (k) => { const v = process.env[`${k}_${NET}`]; if (!v) throw new Error(`${k}_${NET} is not set`); return v; };
  const token = await ethers.getContractAt("SRXToken", need("SRX_TOKEN"));
  const governor = await ethers.getContractAt("SRXGovernor", need("GOVERNOR"));

  for (const s of await ethers.getSigners()) {
    const bal = await token.balanceOf(s.address);
    if (bal === 0n) continue;
    if ((await token.delegates(s.address)) !== ethers.ZeroAddress) { console.log(`  = ${s.address} already delegated`); continue; }
    await (await token.connect(s).delegate(s.address)).wait();
    console.log(`  + ${s.address} delegated to itself (${ethers.formatUnits(bal, 18)} SRX)`);
  }

  const { total } = await delegatedSupply(token, need("SRX_TOKEN_DEPLOY_BLOCK"));
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const quorum = await governor.quorum(now - 1);
  console.log(`\nDelegated supply: ${ethers.formatUnits(total, 18)} SRX; quorum ${ethers.formatUnits(quorum, 18)} SRX` +
    (total >= quorum ? " — a proposal can now reach quorum." : " — below quorum: no proposal can pass yet."));
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
