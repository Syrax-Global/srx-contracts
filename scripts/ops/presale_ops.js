/**
 * PreSaleRound Operations Script
 *
 * Use this to interact with a deployed PreSaleRound contract.
 * Set the ACTION variable below, then run:
 *
 *   npx hardhat run scripts/ops/presale_ops.js --network sepolia
 *   npx hardhat run scripts/ops/presale_ops.js --network ethereum
 *
 * ── Available Actions ──────────────────────────────────────────────────────────
 *
 *   "status"            — Print full contract state (balances, investors, live prices)
 *   "fund"              — Mint SRX into the PreSaleRound via genesis() [TESTNET ONLY]
 *   "add_investor"      — Record an off-chain investor (SAFT / wire / SOL / XRP / BNB)
 *   "update_allocation" — Admin correction: override an investor's SRX amount (pre-vault only)
 *   "deploy_vaults"     — Deploy VestingVaults for all investors without one
 *   "trigger_tge"       — Trigger TGE on all deployed vaults (starts vesting clocks)
 *   "withdraw_eth"      — Withdraw all ETH raised to admin wallet
 *   "withdraw_usdc"     — Withdraw all USDC raised to admin wallet
 *   "set_srx_price"     — Update the SRX USD price (e.g. if seed price changes)
 */

const { ethers, network } = require("hardhat");
require("dotenv").config();

// ── SET THIS to what you want to do ───────────────────────────────────────────
const ACTION = "status";

// ── For "add_investor" ────────────────────────────────────────────────────────
// Used for off-chain investors: wire transfer, SOL, XRP, BNB, or any currency
// not accepted on-chain. Pass the INCREMENTAL USD amount in 8-decimal format.
// The contract calculates SRX + tier bonus automatically.
//
// USD 8-decimal format: USD_value × 10^8
// Examples:
//   $50,000  wire   → 50_000 × 1e8  = 5_000_000_000_000
//   $100,000 SAFT   → 100_000 × 1e8 = 10_000_000_000_000
//   $250,000 total  → 250_000 × 1e8 = 25_000_000_000_000  (Priority tier → +17.5%)
//
// Tier thresholds (cumulative):
//   Entry        $0–$99,999        +10%
//   Standard     $100,000–$199,999 +12.5%
//   Enhanced     $200,000–$299,999 +15%
//   Priority     $300,000–$399,999 +17.5%
//   Institutional $400,000+        +20%
const INVESTOR_ADDRESS  = "0x049fea6abBbc88487Ca14A7910d37E1feCdb9236"; // deployer as test investor
const INVESTOR_USD_8DEC = 5_000_000_000_000n; // $50,000 → Entry tier → +10% → ~4,400,000 SRX

// ── For "update_allocation" ──────────────────────────────────────────────────
// Admin correction path — use when an investor's SRX allocation needs to be fixed
// (e.g. off-chain payment amount was entered incorrectly, or price was wrong).
// The investor must have an existing allocation and no vault deployed yet.
// newSrxAmount is in 18-decimal SRX units. cumulativeUsd8Dec is back-calculated
// automatically by the contract from the new SRX amount.
//
// Examples:
//   3,000,000 SRX → ethers.parseUnits("3000000", 18)
//   500,000 SRX   → ethers.parseUnits("500000", 18)
const UPDATE_INVESTOR_ADDRESS = "0x2cffac9dFa76D78C2D62E9d892bCd586408A11de";
const UPDATE_NEW_SRX_AMOUNT   = ethers.parseUnits("3000", 18); // 3,000 SRX (correction test)

// ── For "set_srx_price" ───────────────────────────────────────────────────────
// Only needed if the SRX price itself changes (not ETH/BTC — those are automatic).
// Format: USD price × 10^8. Examples:
//   $0.0125 = 1_250_000
//   $0.0200 = 2_000_000
//   $0.0100 =   100_000  (wait: 0.01 × 1e8 = 1_000_000)
const NEW_SRX_PRICE_8DEC = 1_250_000n; // $0.0125 — change this if the price changes

// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_ADDRESSES = {
  sepolia:    process.env.SRX_TOKEN_SEPOLIA,
  ethereum:   process.env.SRX_TOKEN_ETHEREUM,
  bscTestnet: process.env.SRX_TOKEN_BSCTESTNET,
  bsc:        process.env.SRX_TOKEN_BSC,
};

const PRESALE_ADDRESSES = {
  sepolia:    process.env.PRESALE_ROUND_SEPOLIA,
  ethereum:   process.env.PRESALE_ROUND_ETHEREUM,
  bscTestnet: process.env.PRESALE_ROUND_BSCTESTNET,
  bsc:        process.env.PRESALE_ROUND_BSC,
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;

  const tokenAddress   = TOKEN_ADDRESSES[net];
  const presaleAddress = PRESALE_ADDRESSES[net];

  if (!tokenAddress || !presaleAddress) {
    throw new Error(
      `Missing addresses for network "${net}".\n` +
      `Set SRX_TOKEN_${net.toUpperCase()} and PRESALE_ROUND_${net.toUpperCase()} in .env`
    );
  }

  console.log(`\nNetwork:  ${net}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Action:   ${ACTION}\n`);

  const token   = await ethers.getContractAt("SRXToken",     tokenAddress);
  const presale = await ethers.getContractAt("PreSaleRound", presaleAddress);

  // ── STATUS ──────────────────────────────────────────────────────────────────
  if (ACTION === "status") {
    console.log("── Contract Addresses ───────────────────────────────────");
    console.log(`SRXToken:     ${tokenAddress}`);
    console.log(`PreSaleRound: ${presaleAddress}`);

    const srxBalance     = await token.balanceOf(presaleAddress);
    const totalAllocated = await presale.totalAllocated();
    const hardCap        = await presale.hardCapSRX();
    const srxPrice8Dec   = await presale.srxPriceUsd8Dec();
    const finalized      = await presale.finalized();
    const maxStaleness   = await presale.maxStaleness();
    const genesisComplete = await token.genesisComplete();

    const srxPriceUsd = Number(srxPrice8Dec) / 1e8;

    console.log(`\n── Token ────────────────────────────────────────────────`);
    console.log(`Genesis complete:  ${genesisComplete}`);
    console.log(`SRX in presale:    ${ethers.formatUnits(srxBalance, 18)} SRX`);

    console.log(`\n── Presale Round ────────────────────────────────────────`);
    console.log(`Hard cap:          ${ethers.formatUnits(hardCap, 18)} SRX`);
    console.log(`Total allocated:   ${ethers.formatUnits(totalAllocated, 18)} SRX`);
    console.log(`Remaining:         ${ethers.formatUnits(hardCap - totalAllocated, 18)} SRX`);
    console.log(`Finalized:         ${finalized}`);
    console.log(`Max staleness:     ${maxStaleness}s`);

    console.log(`\n── SRX Price ────────────────────────────────────────────`);
    console.log(`SRX price:         $${srxPriceUsd} (${srxPrice8Dec} × 10^-8 USD)`);

    // Live oracle prices
    console.log(`\n── Live Oracle Prices (Chainlink) ───────────────────────`);
    const nativeSymbol = ["bscTestnet", "bsc"].includes(net) ? "BNB" : "ETH";
    // Quote views take (amount, investorAddress) — pass deployer as reference (fresh investor = Entry tier)
    try {
      const nativePrice = await presale.currentEthPrice();
      const nativeUsd   = Number(nativePrice) / 1e8;
      const nativeQuote = await presale.quoteETH(ethers.parseEther("1"), deployer.address);
      console.log(`${nativeSymbol}/USD:           $${nativeUsd.toLocaleString()}`);
      console.log(`1 ${nativeSymbol} buys:         ${ethers.formatUnits(nativeQuote, 18)} SRX (incl. tier bonus)`);
    } catch { console.log(`${nativeSymbol}:               disabled`); }

    try {
      const btcPrice = await presale.currentBtcPrice();
      const btcUsd   = Number(btcPrice) / 1e8;
      const btcQuote = await presale.quoteWBTC(100_000_000n, deployer.address); // 1 WBTC
      console.log(`BTC/USD:           $${btcUsd.toLocaleString()}`);
      console.log(`1 WBTC buys:       ${ethers.formatUnits(btcQuote, 18)} SRX (incl. tier bonus)`);
    } catch { console.log(`BTC/WBTC:          disabled`); }

    try {
      const stableQuote = await presale.quoteStable(1_000_000n, deployer.address); // 1 USDC/USDT
      console.log(`1 USDC/USDT buys:  ${ethers.formatUnits(stableQuote, 18)} SRX (incl. tier bonus)`);
    } catch {}

    // Investor list
    let i = 0;
    const investors = [];
    try {
      while (true) {
        const addr = await presale.investorList(i);
        const inv  = await presale.investors(addr);
        investors.push({ addr, inv });
        i++;
      }
    } catch {}

    console.log(`\n── Investors (${investors.length}) ──────────────────────────────────────`);
    if (investors.length === 0) {
      console.log(`  No investors yet.`);
    } else {
      for (const { addr, inv } of investors) {
        const tierName = await presale.getTierName(addr);
        const bonusBps = await presale.getBonusBps(addr);
        const bonusPct = (Number(bonusBps) / 100).toFixed(1);
        const cumUsd   = Number(inv.cumulativeUsd8Dec) / 1e8;
        console.log(`  ${addr}`);
        console.log(`    Allocation:   ${ethers.formatUnits(inv.srxAllocation, 18)} SRX`);
        console.log(`    Cumulative:   $${cumUsd.toLocaleString("en-US")} USD`);
        console.log(`    Tier:         ${tierName} (+${bonusPct}% bonus)`);
        console.log(`    Vault:        ${inv.vault === ethers.ZeroAddress ? "Not deployed" : inv.vault}`);
        console.log(`    Source:       ${inv.offChain ? "Off-chain (SAFT/wire/SOL/XRP/BNB)" : "On-chain"}`);
      }
    }

    console.log(`\n── Off-chain Investment Guide ───────────────────────────`);
    console.log(`For SOL, XRP, BNB, wire transfers:`);
    console.log(`  1. Receive payment in your designated wallet for that currency`);
    console.log(`  2. Convert to USD, then express as 8-decimal: USD × 1e8`);
    console.log(`     e.g. $50,000 → set INVESTOR_USD_8DEC = 5_000_000_000_000n`);
    console.log(`  3. Contract calculates SRX + tier bonus automatically`);
    console.log(`  4. Run this script with ACTION = "add_investor"`);
  }

  // ── FUND [TESTNET ONLY] ─────────────────────────────────────────────────────
  else if (ACTION === "fund") {
    if (net === "ethereum") {
      throw new Error("Do NOT call fund on mainnet. Genesis is handled by TGEDistributor.");
    }
    const genesisComplete = await token.genesisComplete();
    if (genesisComplete) {
      const bal = await token.balanceOf(presaleAddress);
      console.log(`Genesis already called.`);
      console.log(`PreSaleRound SRX balance: ${ethers.formatUnits(bal, 18)} SRX`);
      return;
    }
    console.log("Calling genesis() — minting 10B SRX into PreSaleRound for testing...");
    const tx = await token.genesis(presaleAddress);
    await tx.wait();
    const bal = await token.balanceOf(presaleAddress);
    console.log(`✅ Done. Balance: ${ethers.formatUnits(bal, 18)} SRX`);
  }

  // ── ADD INVESTOR ─────────────────────────────────────────────────────────────
  else if (ACTION === "add_investor") {
    if (!INVESTOR_ADDRESS || INVESTOR_ADDRESS === "0x_investor_wallet_address") {
      throw new Error("Set INVESTOR_ADDRESS at the top of this script before running.");
    }

    const usdHuman = (Number(INVESTOR_USD_8DEC) / 1e8).toLocaleString("en-US", { style: "currency", currency: "USD" });

    // Compute expected SRX for display (mirrors contract calculation)
    const srxPrice8Dec = await presale.srxPriceUsd8Dec();
    const existing     = await presale.investors(INVESTOR_ADDRESS);
    const newCumUsd    = existing.cumulativeUsd8Dec + INVESTOR_USD_8DEC;
    const { tierName, bonusBps } = await presale.quoteTier(newCumUsd);
    const bonusPct = (Number(bonusBps) / 100).toFixed(1);

    console.log(`Adding/topping up investor: ${INVESTOR_ADDRESS}`);
    console.log(`Incremental USD:  ${usdHuman} (${INVESTOR_USD_8DEC} × 10^-8)`);
    console.log(`New cumulative:   $${(Number(newCumUsd) / 1e8).toLocaleString("en-US")} USD`);
    console.log(`Tier after:       ${tierName} (+${bonusPct}% bonus)`);

    const tx = await presale.addInvestor(INVESTOR_ADDRESS, INVESTOR_USD_8DEC);
    await tx.wait();

    console.log(`\n✅ Investor recorded.`);
    const inv = await presale.investors(INVESTOR_ADDRESS);
    const tier = await presale.getTierName(INVESTOR_ADDRESS);
    console.log(`Confirmed allocation: ${ethers.formatUnits(inv.srxAllocation, 18)} SRX`);
    console.log(`Confirmed tier:       ${tier}`);
    console.log(`Cumulative USD:       $${(Number(inv.cumulativeUsd8Dec) / 1e8).toLocaleString("en-US")}`);
  }

  // ── DEPLOY VAULTS ────────────────────────────────────────────────────────────
  else if (ACTION === "deploy_vaults") {
    const count = await presale.investorCount();
    console.log(`Deploying VestingVaults for ${count} investors...`);
    const tx      = await presale.batchDeployVaults(0n, count);
    const receipt = await tx.wait();
    console.log(`✅ Done. Gas used: ${receipt.gasUsed.toString()}`);

    let i = 0;
    try {
      while (true) {
        const addr = await presale.investorList(i);
        const inv  = await presale.investors(addr);
        console.log(`  ${addr} → ${inv.vault}`);
        i++;
      }
    } catch {}
  }

  // ── TRIGGER TGE ──────────────────────────────────────────────────────────────
  else if (ACTION === "trigger_tge") {
    const count = await presale.investorCount();
    console.log(`Triggering TGE on vaults for ${count} investors...`);
    const tx      = await presale.batchTriggerTGE(0n, count);
    const receipt = await tx.wait();
    console.log(`✅ Done. Gas used: ${receipt.gasUsed.toString()}`);

    // Verify each vault's tgeTriggered flag
    const VestingVault = await ethers.getContractFactory("VestingVault");
    let i = 0;
    try {
      while (true) {
        const addr    = await presale.investorList(i);
        const inv     = await presale.investors(addr);
        if (inv.vault !== ethers.ZeroAddress) {
          const vault   = VestingVault.attach(inv.vault);
          const triggered = await vault.tgeTriggered();
          const srxBal  = await token.balanceOf(inv.vault);
          console.log(`  ${addr}`);
          console.log(`    Vault:       ${inv.vault}`);
          console.log(`    TGE started: ${triggered}`);
          console.log(`    SRX locked:  ${ethers.formatUnits(srxBal, 18)}`);
        }
        i++;
      }
    } catch {}
  }

  // ── WITHDRAW ETH ──────────────────────────────────────────────────────────────
  else if (ACTION === "withdraw_eth") {
    const bal = await ethers.provider.getBalance(presaleAddress);
    console.log(`ETH in presale: ${ethers.formatEther(bal)} ETH`);
    if (bal === 0n) { console.log("Nothing to withdraw."); return; }
    const tx = await presale.withdrawETH(deployer.address);
    await tx.wait();
    console.log(`✅ Withdrawn to ${deployer.address}`);
  }

  // ── WITHDRAW USDC ─────────────────────────────────────────────────────────────
  else if (ACTION === "withdraw_usdc") {
    const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
    const usdcAddr = await presale.usdc();
    const usdc     = new ethers.Contract(usdcAddr, ERC20_ABI, deployer);
    const bal      = await usdc.balanceOf(presaleAddress);
    console.log(`USDC in presale: ${ethers.formatUnits(bal, 6)} USDC`);
    if (bal === 0n) { console.log("Nothing to withdraw."); return; }
    const tx = await presale.withdrawUSDC(deployer.address);
    await tx.wait();
    console.log(`✅ Withdrawn to ${deployer.address}`);
  }

  // ── UPDATE ALLOCATION ────────────────────────────────────────────────────────
  else if (ACTION === "update_allocation") {
    if (!UPDATE_INVESTOR_ADDRESS || UPDATE_INVESTOR_ADDRESS === ethers.ZeroAddress) {
      throw new Error("Set UPDATE_INVESTOR_ADDRESS at the top of this script before running.");
    }
    if (UPDATE_NEW_SRX_AMOUNT === 0n) {
      throw new Error("UPDATE_NEW_SRX_AMOUNT must be > 0.");
    }

    const invBefore = await presale.investors(UPDATE_INVESTOR_ADDRESS);
    if (invBefore.srxAllocation === 0n) {
      console.log(`❌ No existing allocation for ${UPDATE_INVESTOR_ADDRESS}. Use add_investor instead.`);
      return;
    }
    if (invBefore.vault !== ethers.ZeroAddress) {
      console.log(`❌ Vault already deployed for this investor — cannot update after vault creation.`);
      console.log(`   Vault: ${invBefore.vault}`);
      return;
    }

    const tierBefore = await presale.getTierName(UPDATE_INVESTOR_ADDRESS);
    console.log(`Investor:       ${UPDATE_INVESTOR_ADDRESS}`);
    console.log(`Current alloc:  ${ethers.formatUnits(invBefore.srxAllocation, 18)} SRX`);
    console.log(`Current USD:    $${(Number(invBefore.cumulativeUsd8Dec) / 1e8).toLocaleString("en-US")}`);
    console.log(`Current tier:   ${tierBefore}`);
    console.log(`\nNew alloc:      ${ethers.formatUnits(UPDATE_NEW_SRX_AMOUNT, 18)} SRX`);

    // Back-calculate USD for display (mirrors contract: srxAmount * srxPriceUsd8Dec / 1e18)
    const srxPrice8Dec   = await presale.srxPriceUsd8Dec();
    const newUsd8Dec     = UPDATE_NEW_SRX_AMOUNT * srxPrice8Dec / (10n ** 18n);
    const { tierName }   = await presale.quoteTier(newUsd8Dec);
    console.log(`Implied USD:    $${(Number(newUsd8Dec) / 1e8).toLocaleString("en-US")}`);
    console.log(`Implied tier:   ${tierName}`);

    const tx = await presale.updateAllocation(UPDATE_INVESTOR_ADDRESS, UPDATE_NEW_SRX_AMOUNT);
    await tx.wait();

    const invAfter   = await presale.investors(UPDATE_INVESTOR_ADDRESS);
    const tierAfter  = await presale.getTierName(UPDATE_INVESTOR_ADDRESS);
    const totalAlloc = await presale.totalAllocated();

    console.log(`\n✅ Allocation updated.`);
    console.log(`New allocation:   ${ethers.formatUnits(invAfter.srxAllocation, 18)} SRX`);
    console.log(`New USD (synth):  $${(Number(invAfter.cumulativeUsd8Dec) / 1e8).toLocaleString("en-US")}`);
    console.log(`New tier:         ${tierAfter}`);
    console.log(`Contract total:   ${ethers.formatUnits(totalAlloc, 18)} SRX`);
  }

  // ── SET SRX PRICE ─────────────────────────────────────────────────────────────
  else if (ACTION === "set_srx_price") {
    const current = await presale.srxPriceUsd8Dec();
    console.log(`Current SRX price: $${Number(current) / 1e8}`);
    console.log(`New SRX price:     $${Number(NEW_SRX_PRICE_8DEC) / 1e8}`);

    const tx = await presale.setSRXPrice(NEW_SRX_PRICE_8DEC);
    await tx.wait();
    console.log(`✅ SRX price updated.`);
    console.log(`Note: ETH and BTC rates adjust automatically — no further action needed.`);
  }

  else {
    console.log(`Unknown action: "${ACTION}"`);
    console.log(`Valid actions: status, fund, add_investor, update_allocation, deploy_vaults, trigger_tge, withdraw_eth, withdraw_usdc, set_srx_price`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
