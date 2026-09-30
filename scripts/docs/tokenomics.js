/**
 * Generates docs/TOKENOMICS.md from scripts/deploy/00_config.js.
 *
 * ⛔ WHY THIS EXISTS. Every tokenomics figure in this repo used to be typed by hand:
 *    the overview, the listing pack and the site all said "12% unlocked at TGE" and
 *    a multi-sig-held, 12-month-locked liquidity bucket, while the configuration sent
 *    1.2B SRX unlocked to a single-key wallet. Nothing compared the two.
 *
 * ⭐ Now the figures come from the configuration and nowhere else:
 *      node scripts/docs/tokenomics.js          rewrite docs/TOKENOMICS.md
 *      node scripts/docs/tokenomics.js --check  exit 1 if the file is out of date
 *    test/TokenomicsDoc.test.js runs the check with the rest of the suite, so a
 *    changed allocation with a stale document fails CI.
 *
 * Deliberately NOT in this document: any price, valuation or market figure. This
 * repository is mirrored publicly (srx-contracts); those appear only once the
 * official pool exists.
 */
const fs = require("fs");
const path = require("path");
const { formatUnits } = require("ethers");
const { ALLOCATIONS, VESTING, TGE_PLAN, launchFloat, vestedByDay } = require("../deploy/00_config");

const OUT = path.join(__dirname, "..", "..", "docs", "TOKENOMICS.md");
const SUPPLY = TGE_PLAN.reduce((s, r) => s + ALLOCATIONS[r.allocation], 0n);
const DAY = 86_400n;

/** What each row is, in words. Every TGE_PLAN label must be here (checked below). */
const NAMES = {
  Founders:          ["Founders", "Vesting contract"],
  CoreTeam:          ["Core team", "Vesting contract"],
  SeedInvestors:     ["Seed investors", "Vesting contract"],
  PresaleLaunch:     ["Presale: launch tranche", "Multi-signature wallet"],
  Presale:           ["Presale: vesting", "Vesting contract"],
  EcosystemDAO:      ["Ecosystem fund", "Vesting contract"],
  LiquidityPool:     ["Liquidity: official pool", "Multi-signature wallet"],
  MarketMaker:       ["Liquidity: market maker", "Multi-signature wallet"],
  LiquidityReserve:  ["Liquidity: reserve", "Vesting contract"],
  Staking:           ["Staking rewards", "SRXStaking contract (reward pool)"],
  Treasury:          ["Treasury", "SRXTreasury contract (48-hour governance delay)"],
  StabilisationFund: ["Stabilisation fund", "StabilisationFund contract (governance rules)"],
};

const srx = (wei) => {
  const [whole] = formatUnits(wei, 18).split(".");
  return BigInt(whole).toLocaleString("en-US");
};
const pct = (wei) => {
  const bps = (wei * 1_000_000n) / SUPPLY; // hundredths of a basis point
  const s = (Number(bps) / 10_000).toFixed(2);
  return `${s}%`;
};
const days = (sec) => `${sec / DAY} days`;

function schedule(row) {
  if (row.liquid) return "Transferable at launch";
  if (row.kind === "contract") return "Not time-locked; held by the contract";
  const v = VESTING[row.schedule];
  const atTge = v.tgeUnlockBps === 0n ? "0% at launch" : `${Number(v.tgeUnlockBps) / 100}% at launch`;
  const cliff = v.cliffDuration === 0n ? "no hold" : `held ${days(v.cliffDuration)}`;
  return `${atTge}; ${cliff}, then released evenly over ${days(v.vestingDuration)}`;
}

function render() {
  for (const r of TGE_PLAN) if (!NAMES[r.label]) throw new Error(`No description for TGE_PLAN row "${r.label}" in scripts/docs/tokenomics.js`);

  const L = [];
  L.push("# SRX tokenomics");
  L.push("");
  L.push("> **Generated from `scripts/deploy/00_config.js` by `scripts/docs/tokenomics.js`. Do not edit by hand:**");
  L.push("> change the configuration and run `node scripts/docs/tokenomics.js`. A test fails if this file is out of date.");
  L.push(">");
  L.push("> SRX has not been offered, sold or distributed. This describes the contracts and their configuration; it is");
  L.push("> not an offer, and it makes no statement about price or value.");
  L.push("");
  L.push(`**Maximum supply:** ${srx(SUPPLY)} SRX, minted once at genesis. No further SRX can be minted.`);
  L.push("");

  L.push("## Allocation");
  L.push("");
  L.push("| Allocation | SRX | Share | Held by | Schedule |");
  L.push("|---|---:|---:|---|---|");
  for (const r of TGE_PLAN) {
    const a = ALLOCATIONS[r.allocation];
    L.push(`| ${NAMES[r.label][0]} | ${srx(a)} | ${pct(a)} | ${NAMES[r.label][1]} | ${schedule(r)} |`);
  }
  L.push(`| **Total** | **${srx(SUPPLY)}** | **${pct(SUPPLY)}** | | |`);
  L.push("");

  const float = launchFloat();
  L.push("## At launch");
  L.push("");
  L.push(`**${srx(float)} SRX (${pct(float)}) is transferable the moment the token launches**, and nothing else is:`);
  L.push("");
  L.push("| Source | SRX | Share |");
  L.push("|---|---:|---:|");
  for (const r of TGE_PLAN.filter((x) => x.liquid)) {
    const a = ALLOCATIONS[r.allocation];
    L.push(`| ${NAMES[r.label][0]} | ${srx(a)} | ${pct(a)} |`);
  }
  L.push(`| **Total** | **${srx(float)}** | **${pct(float)}** |`);
  L.push("");
  L.push("Every vesting contract releases 0% at launch, including founders, core team and seed investors. Each");
  L.push("transferable allocation goes to a multi-signature wallet: the deployment refuses a single-key wallet.");
  L.push("");

  L.push("## Release calendar");
  L.push("");
  L.push("Cumulative SRX that vesting contracts have released, on top of the launch tranche, by days after launch.");
  L.push("");
  L.push("| Days after launch | Released by vesting contracts | Launch tranche + released | Share of supply |");
  L.push("|---:|---:|---:|---:|");
  const cliffs = new Set([0, 30, 31, 90, 180, 365, 730, 1095, 1460]);
  for (const r of TGE_PLAN.filter((x) => x.kind === "vault")) {
    const v = VESTING[r.schedule];
    cliffs.add(Number(v.cliffDuration / DAY));
    cliffs.add(Number((v.cliffDuration + v.vestingDuration) / DAY));
  }
  for (const d of [...cliffs].sort((a, b) => a - b)) {
    const released = vestedByDay(d);
    L.push(`| ${d} | ${srx(released)} | ${srx(float + released)} | ${pct(float + released)} |`);
  }
  L.push("");
  L.push("Released is not the same as circulating: SRX released to a company-held wallet and not placed on a trading");
  L.push("venue is not circulating (see below). The Treasury, Stabilisation Fund and staking reward pool are not in");
  L.push("this calendar: they are not time-locked, and move only under their contracts' governance rules.");
  L.push("");

  L.push("## Circulating supply");
  L.push("");
  L.push("> **Circulating ≈ vested SRX claimed + liquidity placed on trading venues + airdrop claimed − staking locks − burns.**");
  L.push(">");
  L.push("> Company-held inventory that is not on a trading venue is not circulating.");
  L.push("");
  return L.join("\n");
}

if (require.main === module) {
  const text = render();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== text) {
      console.error("docs/TOKENOMICS.md is out of date — run: node scripts/docs/tokenomics.js");
      process.exit(1);
    }
    console.log("docs/TOKENOMICS.md matches the configuration");
  } else {
    fs.writeFileSync(OUT, text);
    console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
  }
}

module.exports = { render, OUT };
