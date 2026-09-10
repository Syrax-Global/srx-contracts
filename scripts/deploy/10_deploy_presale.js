/**
 * Step 10 — Deploy PreSaleRound (Pre-Presale Investor Round)
 *
 * Deploys the SRXToken (if not already deployed) and the PreSaleRound contract.
 *
 * Pricing model:
 *   SRX seed price = $0.0125
 *   ETH and WBTC rates are calculated live via Chainlink oracles — no manual updates needed.
 *   USDC and USDT are treated as $1 each.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/10_deploy_presale.js --network sepolia
 *   npx hardhat run scripts/deploy/10_deploy_presale.js --network ethereum
 */

const { ethers, network } = require("hardhat");
const { LZ_ENDPOINTS, WALLETS } = require("./00_config");

// ── SRX seed price ─────────────────────────────────────────────────────────────
// $0.0125 expressed as 8-decimal fixed point (matching Chainlink format)
// $0.0125 × 10^8 = 1,250,000
const SRX_PRICE_USD_8DEC = 1_250_000n;

// ── Genesis round terms (Jared, 10 Sep 2026) ───────────────────────────────────
// The 400M seed pool funds a 100M SRX cornerstone grant AND this round, so the
// round itself is capped at 300M. Every participant gets one flat +50% founding
// bonus: at $0.0125 that is 120 SRX per $1, so the cap is exactly a $2.5M round.
// Both are fixed at deployment — the contract has no function that changes them.
const HARD_CAP_SRX       = ethers.parseUnits("300000000", 18); // 300M SRX
const FLAT_BONUS_ENABLED = true;
const FLAT_BONUS_BPS     = 5_000n;                             // +50%

// ── Token addresses ────────────────────────────────────────────────────────────
const STABLECOINS = {
  // Ethereum Sepolia testnet
  sepolia: {
    usdc: process.env.USDC_ADDRESS_SEPOLIA  || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    usdt: process.env.USDT_ADDRESS_SEPOLIA  || "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0",
    wbtc: process.env.WBTC_ADDRESS_SEPOLIA  || ethers.ZeroAddress, // No official WBTC on Sepolia
  },
  // Ethereum mainnet
  ethereum: {
    usdc: process.env.USDC_ADDRESS_ETHEREUM || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdt: process.env.USDT_ADDRESS_ETHEREUM || "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    wbtc: process.env.WBTC_ADDRESS_ETHEREUM || "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  },
  // BNB Chain testnet
  // Note: USDC is not widely deployed on BSC testnet — USDT is the dominant stablecoin on BNB Chain
  bscTestnet: {
    usdc: process.env.USDC_ADDRESS_BSCTESTNET || ethers.ZeroAddress,
    usdt: process.env.USDT_ADDRESS_BSCTESTNET || "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
    wbtc: process.env.WBTC_ADDRESS_BSCTESTNET || ethers.ZeroAddress,
  },
  // BNB Chain mainnet
  bsc: {
    usdc: process.env.USDC_ADDRESS_BSC || "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    usdt: process.env.USDT_ADDRESS_BSC || "0x55d398326f99059fF775485246999027B3197955",
    wbtc: process.env.WBTC_ADDRESS_BSC || ethers.ZeroAddress, // WBTC not standard on BSC
  },
};

// ── Chainlink oracle addresses ─────────────────────────────────────────────────
// On BNB Chain, invest() receives BNB (not ETH). The "nativeTokenFeed" slot
// (called ethUsdFeed in the contract) takes the BNB/USD feed on BSC networks.
const CHAINLINK_FEEDS = {
  sepolia: {
    nativeTokenFeed: "0x694AA1769357215DE4FAC081bf1f309aDC325306", // ETH/USD
    btcUsd:          "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43", // BTC/USD
  },
  ethereum: {
    nativeTokenFeed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", // ETH/USD
    btcUsd:          "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", // BTC/USD
  },
  bscTestnet: {
    nativeTokenFeed: "0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526", // BNB/USD
    btcUsd:          "0x5741306c21795FdCBb9b265Ea0255F499DFe515C", // BTC/USD
  },
  bsc: {
    nativeTokenFeed: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE", // BNB/USD
    btcUsd:          "0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf", // BTC/USD
  },
};

// ── Existing token address (optional — leave blank to deploy fresh) ────────────
const EXISTING_TOKEN = {
  sepolia:  process.env.SRX_TOKEN_SEPOLIA  || "",
  ethereum: process.env.SRX_TOKEN_ETHEREUM || "",
};

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;

  if (!STABLECOINS[net] || !CHAINLINK_FEEDS[net]) {
    throw new Error(`Network "${net}" is not configured. Add it to STABLECOINS and CHAINLINK_FEEDS.`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  SRX PreSaleRound Deployment`);
  console.log(`  Network:  ${net}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}\n`);

  const admin = WALLETS.admin;
  console.log(`Admin:     ${admin}`);
  console.log(`SRX Price: $0.0125 (${SRX_PRICE_USD_8DEC} × 10^-8 USD)`);
  console.log(`Hard Cap:  ${ethers.formatUnits(HARD_CAP_SRX, 18)} SRX`);
  console.log(`Bonus:     ${FLAT_BONUS_ENABLED ? `flat +${Number(FLAT_BONUS_BPS) / 100}% for every participant` : "10–20% tier ladder"}\n`);

  // ── Step 1: Deploy or load SRXToken ────────────────────────────────────────

  let tokenAddress = EXISTING_TOKEN[net];

  if (tokenAddress) {
    console.log(`[1/2] Using existing SRXToken at: ${tokenAddress}`);
  } else {
    console.log(`[1/2] Deploying SRXToken...`);
    const lzEndpoint = LZ_ENDPOINTS[net];
    if (!lzEndpoint) throw new Error(`No LayerZero endpoint for network "${net}"`);

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token    = await SRXToken.deploy(lzEndpoint, admin);
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();

    console.log(`  ✅ SRXToken deployed: ${tokenAddress}`);
    console.log(`     Genesis has NOT been called — tokens are not minted yet.`);
    console.log(`     That happens at the full TGE, not during the presale.\n`);
  }

  // ── Step 2: Deploy PreSaleRound ────────────────────────────────────────────

  const { usdc, usdt, wbtc }     = STABLECOINS[net];
  const { nativeTokenFeed, btcUsd } = CHAINLINK_FEEDS[net];

  const isEthChain = ["sepolia", "ethereum"].includes(net);
  const nativeSymbol = isEthChain ? "ETH" : "BNB";

  console.log(`[2/2] Deploying PreSaleRound...`);
  console.log(`  SRX Token:             ${tokenAddress}`);
  console.log(`  USDC:                  ${usdc  === ethers.ZeroAddress ? "disabled" : usdc}`);
  console.log(`  USDT:                  ${usdt  === ethers.ZeroAddress ? "disabled" : usdt}`);
  console.log(`  WBTC:                  ${wbtc  === ethers.ZeroAddress ? "disabled" : wbtc}`);
  console.log(`  ${nativeSymbol}/USD feed:          ${nativeTokenFeed}`);
  console.log(`  BTC/USD feed:          ${btcUsd}`);
  console.log(`  Admin:                 ${admin}`);

  const PreSaleRound = await ethers.getContractFactory("PreSaleRound");
  const presale = await PreSaleRound.deploy(
    tokenAddress,
    usdc  || ethers.ZeroAddress,
    usdt  || ethers.ZeroAddress,
    wbtc  || ethers.ZeroAddress,
    nativeTokenFeed,
    btcUsd,
    admin,
    HARD_CAP_SRX,
    SRX_PRICE_USD_8DEC,
    FLAT_BONUS_ENABLED,
    FLAT_BONUS_BPS
  );
  await presale.waitForDeployment();
  const presaleAddress = await presale.getAddress();

  console.log(`\n  ✅ PreSaleRound deployed: ${presaleAddress}`);

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  DEPLOYMENT COMPLETE`);
  console.log(`${"=".repeat(60)}`);
  console.log(`\n  SRXToken:     ${tokenAddress}`);
  console.log(`  PreSaleRound: ${presaleAddress}`);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  NEXT STEPS`);
  console.log(`${"─".repeat(60)}`);
  console.log(`
  1. Save these addresses to your .env:
       SRX_TOKEN_${net.toUpperCase()}=${tokenAddress}
       PRESALE_ROUND_${net.toUpperCase()}=${presaleAddress}

  2. Fund the PreSaleRound with SRX tokens.
     On testnet: call genesis(presaleAddress) on the SRXToken as admin.
     On mainnet: handled by TGEDistributor (not yet — presale only for now).

  3. Add investors or open for on-chain investment:
       Off-chain: presaleRound.addInvestor(address, usdAmount8Dec)
                  e.g. $100,000 wire = addInvestor(addr, 10_000_000_000_000)
                  Contract calculates SRX + the flat +50% bonus automatically.
       On-chain:  investors call invest() / investWithUSDC() / investWithUSDT() / investWithWBTC()

  4. Deploy vaults when ready:
       presaleRound.batchDeployVaults()

  ⚠️  ETH and WBTC rates update automatically from Chainlink — no manual price updates needed.
  ⚠️  If the SRX price changes (not just ETH/BTC), call setSRXPrice() with the new 8-decimal value.
  ⚠️  Do NOT call batchTriggerTGE() until the full token launch.
  `);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
