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
 * Launch configuration (pre-external-audit sweep, 23 Sep 2026):
 *   PSR-04 — the contract's defaults are not a launch configuration: a 5-minute
 *   staleness blocks the ETH/BNB path (Chainlink's heartbeat is an hour), price
 *   bounds are off, and stablecoins are assumed to be $1. This script now sets all
 *   of them, plus the $2,500 minimum, from PRESALE_CONFIG below — directly if the
 *   deployer is the admin (testnets), otherwise as a Safe Transaction Builder file
 *   for the admin Safe to sign. Every feed's on-chain description is checked
 *   first, so a wrong address stops the script instead of pricing SRX.
 *   PSR-11 — the admin is immutable. On mainnet the script refuses unless the
 *   admin is a contract (the Safe): an EOA admin could never be replaced.
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

// ── Launch configuration (PSR-04). All prices 8-decimal USD. ──────────────────
// Feed addresses and descriptions checked on-chain 23 Sep 2026; the script
// re-checks the description at run time. Stablecoin feeds are Ethereum and BNB
// Chain mainnet only — on testnets the contract's $1 default stands.
const USD8 = (n) => BigInt(Math.round(n * 1e8));
const BOUNDS = {
  ETH: [USD8(100), USD8(20_000)],
  BNB: [USD8(10), USD8(5_000)],
  BTC: [USD8(10_000), USD8(500_000)],
  STABLE: [USD8(0.5), USD8(2)],
};
const STALENESS = { native: 3_900, btc: 3_900, stable: 90_000 }; // heartbeat + margin (1h, 1h, 24h)
const MIN_CONTRIBUTION_USD8 = USD8(2_500);                         // the Genesis page's stated minimum
const STABLE_FEEDS = {
  ethereum: { usdc: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", usdt: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D" },
  bsc:      { usdc: "0x51597f405303C4377E36123cBc172b13269EA163", usdt: "0xB97Ad0E74fa7d920791E90258A6E2085088b4320" },
};
const MAINNETS = ["ethereum", "bsc"];

async function requireFeed(address, expected) {
  const feed = new ethers.Contract(address, ["function description() view returns (string)"], ethers.provider);
  const got = await feed.description();
  if (got !== expected) throw new Error(`Feed ${address} describes itself as "${got}", expected "${expected}"`);
  console.log(`  ✓ ${address} is "${got}"`);
}

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
  // PSR-11: the presale admin is immutable. On mainnet it must be the Safe.
  if (MAINNETS.includes(net) && (await ethers.provider.getCode(admin)) === "0x") {
    throw new Error(`Admin ${admin} has no code. On ${net} the presale admin must be the admin Safe — it can never be changed.`);
  }
  console.log(`Admin:     ${admin}`);
  console.log(`SRX Price: $0.0125 (${SRX_PRICE_USD_8DEC} × 10^-8 USD)`);
  console.log(`Hard Cap:  ${ethers.formatUnits(HARD_CAP_SRX, 18)} SRX`);
  console.log(`Bonus:     ${FLAT_BONUS_ENABLED ? `flat +${Number(FLAT_BONUS_BPS) / 100}% for every participant` : "10–20% tier ladder"}\n`);

  // ── Step 1: Deploy or load SRXToken ────────────────────────────────────────

  let tokenAddress = EXISTING_TOKEN[net];

  if (tokenAddress) {
    console.log(`[1/3] Using existing SRXToken at: ${tokenAddress}`);
  } else {
    console.log(`[1/3] Deploying SRXToken...`);
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

  console.log(`[2/3] Deploying PreSaleRound...`);
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

  // ── Step 3: Launch configuration (PSR-04) ──────────────────────────────────
  console.log(`\n[3/3] Launch configuration — checking feeds...`);
  await requireFeed(nativeTokenFeed, `${nativeSymbol} / USD`);
  await requireFeed(btcUsd, "BTC / USD");
  const stable = STABLE_FEEDS[net];
  if (stable) {
    await requireFeed(stable.usdc, "USDC / USD");
    await requireFeed(stable.usdt, "USDT / USD");
  }
  const calls = [
    ["setFeedStaleness", [STALENESS.native, STALENESS.btc, STALENESS.stable]],
    ["setOraclePriceBounds", [...BOUNDS[nativeSymbol], ...BOUNDS.BTC]],
    ["setStablecoinPriceBounds", BOUNDS.STABLE],
    ...(stable ? [["setStablecoinFeeds", [stable.usdc, stable.usdt]]] : []),
    ["setMinContribution", [MIN_CONTRIBUTION_USD8]],
  ];
  if (MAINNETS.includes(net) && !stable) throw new Error(`No stablecoin feeds configured for ${net}`);

  if (ethers.getAddress(admin) === ethers.getAddress(deployer.address)) {
    for (const [fn, args] of calls) {
      await (await presale[fn](...args)).wait();
      console.log(`  ✅ ${fn}(${args.join(", ")})`);
    }
  } else {
    const fs = require("fs");
    const file = `presale_config.${net}.json`;
    fs.writeFileSync(file, JSON.stringify({
      version: "1.0",
      chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      createdAt: Math.floor(Date.now() / 1000),
      meta: { name: `PreSaleRound launch configuration (${net})`, description: "PSR-04: staleness, price bounds, stablecoin feeds, minimum contribution. Sign BEFORE opening the round." },
      transactions: calls.map(([fn, args]) => ({ to: presaleAddress, value: "0", data: presale.interface.encodeFunctionData(fn, args) })),
    }, null, 2));
    console.log(`  📝 The admin Safe must sign ${calls.length} configuration calls: ${file}`);
    console.log(`  ⛔ Do not open the round until they have executed.`);
  }

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
     On mainnet: OPEN DECISION (PSR-03) — the funding source and which chain(s)
     carry the round are not settled. The cap is per contract, so a round on two
     chains is two caps.

  3. Add investors or open for on-chain investment:
       Off-chain: presaleRound.addInvestor(address, usdAmount8Dec)
                  e.g. $100,000 wire = addInvestor(addr, 10_000_000_000_000)
                  Contract calculates SRX + the flat +50% bonus automatically.
       On-chain:  investors call invest() / investWithUSDC() / investWithUSDT() / investWithWBTC()

  4. Deploy vaults when ready, in batches of 20-50:
       presaleRound.batchDeployVaults(startIndex, endIndex)
     ⛔ BEFORE SRXToken's maxWalletBalance is switched on (PSR-09): a new vault
        cannot be exempted in advance, so a large allocation would revert.

  ⚠️  ETH and WBTC rates update automatically from Chainlink — no manual price updates needed.
  ⚠️  The SRX price is locked once the first investor exists (R5-02). To change it,
      finalize this round and deploy a new one. setSRXPrice() only works before that.
  ⚠️  A failed KYC on someone who paid on-chain: refundInvestor(addr), never removeInvestor.
  ⚠️  Do NOT call batchTriggerTGE() until the full token launch.
  `);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
