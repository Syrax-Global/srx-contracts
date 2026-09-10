/**
 * test_eth_invest.js
 *
 * Tests the ETH investment path (invest()) on PreSaleRound v2.
 * Uses INVESTOR_PRIVATE_KEY wallet (no vault deployed — eligible to invest).
 *
 * Phase 1.9 setup: invests 0.01 ETH, then the deployer withdraws the ETH via
 * presale_ops.js (action=withdraw_eth).
 *
 * Run:
 *   npx hardhat run scripts/ops/test_eth_invest.js --network sepolia
 */

const { ethers, network } = require("hardhat");
require("dotenv").config();

const ETH_TO_INVEST = ethers.parseEther("0.01"); // 0.01 ETH — small, keeps gas costs low

async function main() {
  const presaleAddr = process.env.PRESALE_ROUND_SEPOLIA;
  if (!presaleAddr) throw new Error("PRESALE_ROUND_SEPOLIA not set in .env");

  // Use INVESTOR_PRIVATE_KEY wallet — deployer's vault is already deployed (would revert)
  let investor;
  if (process.env.INVESTOR_PRIVATE_KEY) {
    investor = new ethers.Wallet(process.env.INVESTOR_PRIVATE_KEY, ethers.provider);
    console.log(`Using INVESTOR_PRIVATE_KEY wallet: ${investor.address}`);
  } else {
    const [deployer] = await ethers.getSigners();
    investor = deployer;
    console.log(`⚠️  No INVESTOR_PRIVATE_KEY — using deployer (may revert if vault deployed)`);
  }

  const presale = await ethers.getContractAt("PreSaleRound", presaleAddr, investor);

  console.log(`\nNetwork:  ${network.name}`);
  console.log(`Investor: ${investor.address}`);
  console.log(`Presale:  ${presaleAddr}\n`);

  // Pre-checks
  const inv = await presale.investors(investor.address);
  if (inv.vault !== ethers.ZeroAddress) {
    console.log(`❌ Investor's vault already deployed — cannot invest more.`);
    console.log(`   VaultAlreadyDeployed would revert. Use a different wallet.`);
    return;
  }

  const ethBal = await ethers.provider.getBalance(investor.address);
  console.log(`Investor ETH balance: ${ethers.formatEther(ethBal)} ETH`);
  if (ethBal < ETH_TO_INVEST + ethers.parseEther("0.005")) {
    console.log(`⚠️  Insufficient ETH. Need at least 0.015 ETH (invest + gas).`);
    return;
  }

  // Get live quote
  const quote = await presale.quoteETH(ETH_TO_INVEST, investor.address);
  const ethPrice = await presale.currentEthPrice();
  console.log(`ETH/USD (Chainlink):  $${(Number(ethPrice) / 1e8).toLocaleString("en-US")}`);
  console.log(`0.01 ETH buys:        ${ethers.formatUnits(quote, 18)} SRX (incl. tier bonus)\n`);

  const allocBefore = inv.srxAllocation;

  // Invest
  console.log(`Investing 0.01 ETH...`);
  const tx      = await presale.invest({ value: ETH_TO_INVEST });
  const receipt = await tx.wait();
  console.log(`✅ ETH invested — tx: ${receipt.hash}`);

  // Verify
  const invAfter  = await presale.investors(investor.address);
  const tierName  = await presale.getTierName(investor.address);
  const ethInPresale = await ethers.provider.getBalance(presaleAddr);

  console.log(`\nAllocation after:   ${ethers.formatUnits(invAfter.srxAllocation, 18)} SRX`);
  console.log(`Delta:              ${ethers.formatUnits(invAfter.srxAllocation - allocBefore, 18)} SRX`);
  console.log(`Tier:               ${tierName}`);
  console.log(`ETH in presale:     ${ethers.formatEther(ethInPresale)} ETH`);
  console.log(`\n✅ ETH investment confirmed. Run presale_ops.js (action=withdraw_eth) to test withdrawal.`);
}

main().catch((err) => {
  console.error("\n💥 Error:", err.message ?? err);
  process.exit(1);
});
