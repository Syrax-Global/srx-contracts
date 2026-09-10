/**
 * Send Sepolia ETH from deployer to the investor test wallet.
 *
 * Run: npx hardhat run scripts/ops/fund_investor.js --network sepolia
 */
const { ethers } = require("hardhat");
require("dotenv").config();

const AMOUNT_ETH = "0.05"; // 0.05 ETH is plenty for gas on a few test txs

async function main() {
  const [deployer] = await ethers.getSigners();

  if (!process.env.INVESTOR_PRIVATE_KEY) {
    throw new Error("INVESTOR_PRIVATE_KEY not set in .env");
  }

  const investorWallet = new ethers.Wallet(process.env.INVESTOR_PRIVATE_KEY, ethers.provider);
  const recipient = investorWallet.address;

  const deployerBal  = await ethers.provider.getBalance(deployer.address);
  const recipientBal = await ethers.provider.getBalance(recipient);

  console.log(`Deployer:  ${deployer.address} (${ethers.formatEther(deployerBal)} ETH)`);
  console.log(`Recipient: ${recipient} (${ethers.formatEther(recipientBal)} ETH)`);
  console.log(`Sending:   ${AMOUNT_ETH} ETH\n`);

  if (recipientBal >= ethers.parseEther(AMOUNT_ETH)) {
    console.log(`✅ Investor wallet already has sufficient ETH (${ethers.formatEther(recipientBal)}). No transfer needed.`);
    return;
  }

  const tx = await deployer.sendTransaction({
    to: recipient,
    value: ethers.parseEther(AMOUNT_ETH),
  });
  await tx.wait();

  const newBal = await ethers.provider.getBalance(recipient);
  console.log(`✅ Sent. Investor wallet balance: ${ethers.formatEther(newBal)} ETH`);
  console.log(`   Tx: ${tx.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
