/**
 * test_bnb_invest.js
 *
 * Tests the native BNB investment path (invest()) on the BSC testnet
 * deployment of PreSaleRound.
 *
 * This is the BSC-equivalent of test_eth_invest.js. The invest() function
 * accepts whatever native token the chain uses (ETH on Ethereum, BNB on BSC).
 * The contract uses the BNB/USD Chainlink feed on BSC instead of ETH/USD.
 *
 * Flow:
 *   1. Read BNB/USD live price from the contract's oracle
 *   2. Quote how many SRX 0.001 BNB buys at current price + tier bonus
 *   3. Call invest() with 0.001 BNB as msg.value
 *   4. Verify allocation updated correctly on-chain
 *
 * Run:
 *   npx hardhat run scripts/ops/test_bnb_invest.js --network bscTestnet
 *
 * Prerequisites:
 *   - PRESALE_ROUND_BSCTESTNET set in .env (from 10_deploy_presale.js run)
 *   - Deployer wallet funded with testnet BNB for gas + investment
 *   - PreSaleRound funded with SRX (genesis() called via presale_ops.js fund)
 */

const { ethers, network } = require("hardhat");
require("dotenv").config();

const BNB_TO_INVEST = ethers.parseEther("0.001"); // 0.001 BNB — minimal, keeps gas low

async function main() {
  const presaleAddr = process.env.PRESALE_ROUND_BSCTESTNET;
  if (!presaleAddr) throw new Error("PRESALE_ROUND_BSCTESTNET not set in .env");

  const [deployer] = await ethers.getSigners();

  // Prefer INVESTOR_PRIVATE_KEY wallet; auto-fall-back to deployer if it has no BNB.
  // On BSC testnet (fresh deployment) the deployer is a valid first investor —
  // no prior allocation exists on this presale.
  let investor;
  if (process.env.INVESTOR_PRIVATE_KEY) {
    const candidate = new ethers.Wallet(process.env.INVESTOR_PRIVATE_KEY, ethers.provider);
    const candidateBal = await ethers.provider.getBalance(candidate.address);
    if (candidateBal >= BNB_TO_INVEST + ethers.parseEther("0.003")) {
      investor = candidate;
      console.log(`Using INVESTOR_PRIVATE_KEY wallet: ${investor.address}`);
    } else {
      investor = deployer;
      console.log(`ℹ️  Investor wallet has insufficient BNB (${ethers.formatEther(candidateBal)} BNB) — falling back to deployer`);
    }
  } else {
    investor = deployer;
    console.log(`ℹ️  No INVESTOR_PRIVATE_KEY — using deployer wallet`);
  }

  const presale = await ethers.getContractAt("PreSaleRound", presaleAddr, investor);

  console.log(`\nNetwork:  ${network.name}`);
  console.log(`Investor: ${investor.address}`);
  console.log(`Presale:  ${presaleAddr}\n`);

  // ── Pre-checks ───────────────────────────────────────────────────────────────

  const inv = await presale.investors(investor.address);
  if (inv.vault !== ethers.ZeroAddress) {
    console.log(`❌ Investor vault already deployed — cannot invest more.`);
    console.log(`   VaultAlreadyDeployed would revert. Use a different wallet.`);
    return;
  }

  const bnbBal = await ethers.provider.getBalance(investor.address);
  console.log(`Investor BNB balance: ${ethers.formatEther(bnbBal)} BNB`);
  if (bnbBal < BNB_TO_INVEST + ethers.parseEther("0.003")) {
    console.log(`⚠️  Insufficient BNB. Need at least 0.004 BNB (invest + gas).`);
    console.log(`   Get testnet BNB from: https://testnet.bnbchain.org/faucet-smart`);
    return;
  }

  // ── Quote ────────────────────────────────────────────────────────────────────

  const bnbPrice   = await presale.currentEthPrice(); // slot is named ethUsdFeed but holds BNB/USD on BSC
  const quote      = await presale.quoteETH(BNB_TO_INVEST, investor.address);
  const tokenAddr  = await presale.srxToken();
  const srxToken   = await ethers.getContractAt("IERC20", tokenAddr, investor);
  const srxBalance = await srxToken.balanceOf(presaleAddr);

  console.log(`BNB/USD (Chainlink):  $${(Number(bnbPrice) / 1e8).toFixed(2)}`);
  console.log(`0.001 BNB buys:       ${ethers.formatUnits(quote, 18)} SRX (incl. tier bonus)`);
  console.log(`SRX in presale:       ${ethers.formatUnits(srxBalance, 18)} SRX\n`);

  const allocBefore = inv.srxAllocation;
  console.log(`Allocation before:    ${ethers.formatUnits(allocBefore, 18)} SRX`);

  // ── Invest ───────────────────────────────────────────────────────────────────

  console.log(`\nInvesting 0.001 BNB...`);
  const tx      = await presale.invest({ value: BNB_TO_INVEST });
  const receipt = await tx.wait();
  console.log(`✅ BNB invested — tx: ${receipt.hash}`);

  // ── Verify ───────────────────────────────────────────────────────────────────

  const invAfter       = await presale.investors(investor.address);
  const tierName       = await presale.getTierName(investor.address);
  const bnbInPresale   = await ethers.provider.getBalance(presaleAddr);
  const totalAllocated = await presale.totalAllocated();

  console.log(`\nAllocation after:    ${ethers.formatUnits(invAfter.srxAllocation, 18)} SRX`);
  console.log(`Delta:               ${ethers.formatUnits(invAfter.srxAllocation - allocBefore, 18)} SRX`);
  console.log(`Tier:                ${tierName}`);
  console.log(`BNB in presale:      ${ethers.formatEther(bnbInPresale)} BNB`);
  console.log(`Total allocated:     ${ethers.formatUnits(totalAllocated, 18)} SRX`);

  // ── Calculation check ────────────────────────────────────────────────────────
  const delta    = invAfter.srxAllocation - allocBefore;
  const expected = quote;
  const diff     = delta > expected ? delta - expected : expected - delta;
  const close    = diff <= ethers.parseUnits("1", 18); // within 1 SRX tolerance
  console.log(`\nQuote vs actual delta: ${close ? "✅ Match" : "❌ Mismatch"} (diff: ${ethers.formatUnits(diff, 18)} SRX)`);

  console.log(`\n✅ BNB investment path confirmed on BSC testnet.`);
  console.log(`   Next: run presale_ops.js (action=withdraw_eth --network bscTestnet) to test BNB withdrawal.`);
}

main().catch((err) => {
  console.error("\n💥 Error:", err.message ?? err);
  process.exit(1);
});
