/**
 * Test: USDC and USDT investment paths in PreSaleRound (Sepolia testnet)
 *
 * Investors may call investWithUSDC/USDT multiple times — each call tops up
 * their cumulative allocation. Tier bonuses are recalculated on every investment
 * and retroactively upgraded if the cumulative USD crosses a tier boundary.
 *
 * Set INVESTOR_PRIVATE_KEY in .env to test with a specific wallet, or leave
 * unset to use the deployer (which already has an off-chain allocation —
 * the investment will be treated as a top-up).
 *
 * Prerequisites:
 *  - PRESALE_ROUND_SEPOLIA set in .env
 *  - INVESTOR_PRIVATE_KEY set in .env (recommended — separate investor wallet)
 *  - Investor wallet holds Sepolia USDC (faucet: https://faucet.circle.com)
 *  - Investor wallet holds Sepolia USDT (faucet: https://staging.aave.com/#/faucet)
 *  - Investor wallet holds some Sepolia ETH for gas
 *
 * Run: npx hardhat run scripts/ops/test_usdc_invest.js --network sepolia
 */
const { ethers, network } = require("hardhat");
require("dotenv").config();

const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const USDT_SEPOLIA = "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0";

// Amount to invest (both USDC and USDT use 6 decimals)
// Circle testnet faucet gives 20 USDC per 2-hour window — keep under that.
const INVEST_AMOUNT_6DEC = 10_000_000n; // 10 USDC / 10 USDT

async function main() {
  const signers = await ethers.getSigners();

  // Use INVESTOR_PRIVATE_KEY signer if set, otherwise fall back to deployer.
  // Note: the deployer (0x049f...) already has an off-chain allocation and
  // WILL revert with AlreadyInvested — you must use a different wallet.
  let investor;
  if (process.env.INVESTOR_PRIVATE_KEY) {
    investor = new ethers.Wallet(process.env.INVESTOR_PRIVATE_KEY, ethers.provider);
    console.log(`Using INVESTOR_PRIVATE_KEY wallet: ${investor.address}`);
  } else {
    investor = signers[0];
    console.log(`⚠️  No INVESTOR_PRIVATE_KEY set — using deployer: ${investor.address}`);
    console.log(`   If deployer already has an allocation, this will be a top-up (no revert).`);
    console.log(`   Set INVESTOR_PRIVATE_KEY=<wallet private key> in .env to use a different wallet.\n`);
  }

  const presaleAddr = process.env.PRESALE_ROUND_SEPOLIA;
  if (!presaleAddr) throw new Error("PRESALE_ROUND_SEPOLIA not set in .env");

  const presale = await ethers.getContractAt("PreSaleRound", presaleAddr, investor);

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
  ];
  const usdc = new ethers.Contract(USDC_SEPOLIA, ERC20_ABI, investor);
  const usdt = new ethers.Contract(USDT_SEPOLIA, ERC20_ABI, investor);

  console.log(`\nNetwork:  ${network.name}`);
  console.log(`Investor: ${investor.address}`);
  console.log(`Presale:  ${presaleAddr}\n`);

  // Pre-check: show existing allocation (top-ups are allowed)
  const existing = await presale.investors(investor.address);
  if (existing.srxAllocation > 0n) {
    const tierName = await presale.getTierName(investor.address);
    console.log(`ℹ️  Wallet already has ${ethers.formatUnits(existing.srxAllocation, 18)} SRX (${tierName} tier) — this will be a top-up.`);
  } else {
    console.log(`✅ Wallet has no existing allocation — this will be a new investment.`);
  }

  // ── USDC quote ──────────────────────────────────────────────────────────────
  let usdcQuote;
  try {
    usdcQuote = await presale.quoteStable(INVEST_AMOUNT_6DEC, investor.address);
    const investAmt = Number(INVEST_AMOUNT_6DEC) / 1e6;
    console.log(`${investAmt} USDC buys: ${ethers.formatUnits(usdcQuote, 18)} SRX (incl. tier bonus)`);
  } catch (e) {
    console.log(`quoteStable() failed: ${e.message.slice(0, 80)}`);
    console.log("(USDC/USDT may not be enabled on this PreSaleRound deployment)");
    return;
  }

  // ── USDC investment ─────────────────────────────────────────────────────────
  const usdcBal = await usdc.balanceOf(investor.address);
  console.log(`\nInvestor USDC balance: ${ethers.formatUnits(usdcBal, 6)} USDC`);

  if (usdcBal >= INVEST_AMOUNT_6DEC) {
    const allocBefore = (await presale.investors(investor.address)).srxAllocation;
    console.log(`Allocation before: ${ethers.formatUnits(allocBefore, 18)} SRX`);

    console.log(`Approving ${Number(INVEST_AMOUNT_6DEC) / 1e6} USDC...`);
    await (await usdc.approve(presaleAddr, INVEST_AMOUNT_6DEC)).wait();

    // PreSaleRound uses investWithUSDC(), not a unified invest(token, amount)
    console.log(`Investing ${Number(INVEST_AMOUNT_6DEC) / 1e6} USDC...`);
    const tx = await presale.investWithUSDC(INVEST_AMOUNT_6DEC);
    const receipt = await tx.wait();
    console.log(`✅ USDC invested — tx: ${receipt.hash}`);

    const inv = await presale.investors(investor.address);
    console.log(`Allocation after:  ${ethers.formatUnits(inv.srxAllocation, 18)} SRX`);
    console.log(`Delta:             ${ethers.formatUnits(inv.srxAllocation - allocBefore, 18)} SRX`);
  } else {
    console.log(`⚠️  Insufficient USDC (need ${Number(INVEST_AMOUNT_6DEC) / 1e6}, have ${ethers.formatUnits(usdcBal, 6)})`);
    console.log("   Get Sepolia USDC at: https://faucet.circle.com");
  }

  // ── USDT investment ─────────────────────────────────────────────────────────
  const usdtBal = await usdt.balanceOf(investor.address);
  console.log(`\nInvestor USDT balance: ${ethers.formatUnits(usdtBal, 6)} USDT`);

  if (usdtBal >= INVEST_AMOUNT_6DEC) {
    const allocBefore = (await presale.investors(investor.address)).srxAllocation;

    console.log(`Approving ${Number(INVEST_AMOUNT_6DEC) / 1e6} USDT...`);
    await (await usdt.approve(presaleAddr, INVEST_AMOUNT_6DEC)).wait();

    // PreSaleRound uses investWithUSDT(), not a unified invest(token, amount)
    console.log(`Investing ${Number(INVEST_AMOUNT_6DEC) / 1e6} USDT...`);
    const tx = await presale.investWithUSDT(INVEST_AMOUNT_6DEC);
    const receipt = await tx.wait();
    console.log(`✅ USDT invested — tx: ${receipt.hash}`);

    const inv = await presale.investors(investor.address);
    console.log(`Allocation after:  ${ethers.formatUnits(inv.srxAllocation, 18)} SRX`);
    console.log(`Delta:             ${ethers.formatUnits(inv.srxAllocation - allocBefore, 18)} SRX`);
  } else {
    console.log(`⚠️  Insufficient USDT (need ${Number(INVEST_AMOUNT_6DEC) / 1e6}, have ${ethers.formatUnits(usdtBal, 6)})`);
    console.log("   Get Sepolia USDT at: https://staging.aave.com/#/faucet");
  }

  // ── Note on pause ──────────────────────────────────────────────────────────
  // PreSaleRound does not implement PausableUpgradeable — it has no pause().
  // Pause coverage is provided at the GuardianModule level (Step 8).

  console.log("\n✅ USDC/USDT investment test complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
