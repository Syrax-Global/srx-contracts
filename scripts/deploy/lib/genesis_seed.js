/**
 * genesis_seed.js — the Genesis round is funded from the seed allocation.
 *
 * ⭐ DECISION (Jared, 10 Sep and 30 Sep 2026). The 4% seed allocation (400M SRX)
 *    funds the Genesis round: "The 400M seed pool funds a 100M SRX cornerstone
 *    grant AND this round, so the round itself is capped at 300M"
 *    (10_deploy_presale.js), confirmed 30 Sep: "Fund Genesis from the seed bucket".
 *
 * ⛔ WHY THIS MODULE EXISTS. The launch plan sent all 400M into ONE seed vault, so
 *    the Genesis contract (PreSaleRound) would have held nothing at launch and could
 *    not have created a single buyer's vault. No other bucket could fund it: the
 *    presale's only launch-day tokens (250M) are part of the published 5% float, and
 *    everything else is locked or belongs to a contract.
 *
 * ⭐ HOW. At launch the Genesis contract receives EXACTLY what it sold (its
 *    totalAllocated(), bonus included) and the seed vault receives the rest of the
 *    400M. Both are on the seed schedule (0% at launch, 273 days held, 730 days of
 *    release), so the published allocation, the lock and the 5% float are unchanged.
 *
 * ⛔ WHY EXACTLY, NOT THE 300M CAP. PreSaleRound.recoverSRX() returns its WHOLE
 *    balance, unlocked, to wherever the admin names. Anything it holds beyond what
 *    buyers are owed is therefore liquid in all but name. Sending the cap would have
 *    turned every unsold token into launch-day float.
 *
 * So the round must be CLOSED (finalize()) before step 3: step 3 schedules the seed
 * vault's grant as a Timelock operation, and that amount is final from then on.
 */
const { Contract, getAddress, ZeroAddress, formatUnits } = require("ethers");
const { ALLOCATIONS, VESTING, TGE_PLAN, TESTNET_CHAINS } = require("../00_config");

/** The row the Genesis contract gets in the launch plan, right after the seed vault. */
const GENESIS_ROW = Object.freeze({
  label: "Genesis", allocation: "genesis", kind: "contract", env: "PRESALE_ROUND",
  // Not a launch vault: each buyer's vault is created by the Genesis contract
  // (06b_genesis_vaults.js), on this schedule. Recorded for the float and calendar.
  schedule: "seedInvestors",
});

const PRESALE_ABI = [
  "function srxToken() view returns (address)",
  "function admin() view returns (address)",
  "function finalized() view returns (bool)",
  "function totalAllocated() view returns (uint256)",
  "function pendingDeployment() view returns (uint256)",
  "function investorCount() view returns (uint256)",
  "function getInvestorList() view returns (address[])",
  "function getVault(address) view returns (address)",
  "function CLIFF_DURATION() view returns (uint256)",
  "function VESTING_DURATION() view returns (uint256)",
  "function TGE_UNLOCK_BPS() view returns (uint256)",
];

/**
 * The launch plan and amounts for a Genesis round that sold `genesisSold` SRX.
 * 0 = no Genesis round: the plan is exactly TGE_PLAN.
 */
function launchPlan(genesisSold = 0n) {
  const sold = BigInt(genesisSold);
  if (sold === 0n) return { plan: TGE_PLAN, allocations: ALLOCATIONS };
  if (sold < 0n) throw new Error("Genesis sold amount is negative");
  if (sold >= ALLOCATIONS.seedInvestors) {
    throw new Error(
      `The Genesis round sold ${formatUnits(sold, 18)} SRX, which does not fit inside the ` +
      `${formatUnits(ALLOCATIONS.seedInvestors, 18)} SRX seed allocation that funds it.`);
  }
  const allocations = Object.freeze({
    ...ALLOCATIONS,
    genesis: sold,
    seedInvestors: ALLOCATIONS.seedInvestors - sold,
  });
  const plan = [];
  for (const row of TGE_PLAN) {
    plan.push(row);
    if (row.label === "SeedInvestors") plan.push(GENESIS_ROW);
  }
  return { plan: Object.freeze(plan), allocations };
}

/**
 * What the Genesis round sold, read from the Genesis contract itself.
 *
 * PRESALE_ROUND_<NETWORK> names the Genesis contract, or "none" when there is no
 * round. On a real network it must be set one way or the other: an unset value is an
 * error, never a silent "no Genesis" (which would leave every buyer unfunded).
 *
 * Refuses unless the round is closed, pays out the launch token, and locks each
 * buyer on exactly the seed schedule.
 */
async function readGenesisSold({ networkName, env = process.env, provider, tokenAddress }) {
  const key = `PRESALE_ROUND_${networkName.toUpperCase()}`;
  const raw = (env[key] || "").trim();
  if (!raw || raw.toLowerCase() === "none") {
    if (!raw && !TESTNET_CHAINS.has(networkName)) {
      throw new Error(`${key} is not set. Set it to the Genesis contract, or to "none" if there is no Genesis round.`);
    }
    return { sold: 0n, address: null };
  }
  let address;
  try { address = getAddress(raw); } catch { throw new Error(`${key} is not a valid address`); }
  if (address === ZeroAddress) throw new Error(`${key} is the zero address`);
  if (!provider) throw new Error("readGenesisSold needs a provider");
  if ((await provider.getCode(address)) === "0x") throw new Error(`${key}: no contract at ${address}`);

  const round = new Contract(address, PRESALE_ABI, provider);
  const [token, finalized, sold, cliff, vesting, tgeBps] = await Promise.all([
    round.srxToken(), round.finalized(), round.totalAllocated(),
    round.CLIFF_DURATION(), round.VESTING_DURATION(), round.TGE_UNLOCK_BPS(),
  ]);
  if (tokenAddress && getAddress(token) !== getAddress(tokenAddress)) {
    throw new Error(`The Genesis contract pays out ${getAddress(token)}, not the launch token ${getAddress(tokenAddress)}`);
  }
  const seed = VESTING.seedInvestors;
  if (BigInt(cliff) !== seed.cliffDuration || BigInt(vesting) !== seed.vestingDuration || BigInt(tgeBps) !== seed.tgeUnlockBps) {
    throw new Error("The Genesis contract's lock is not the seed schedule, so it cannot be funded from the seed allocation");
  }
  if (!finalized) {
    throw new Error(
      `The Genesis round (${address}) is still open. Close it with finalize() before step 3: ` +
      "the launch sends it exactly what it sold, so that amount must be final. Nothing was sent.");
  }
  return { sold: BigInt(sold), address, round };
}

/**
 * ⛔ PSR-03 (Jared, 1 Oct 2026): the Genesis round runs on ETHEREUM, the launch chain,
 *    as ONE contract with one cap. The launch funds it by sending to the Genesis
 *    contract on the launch chain, so a round anywhere else could never be funded,
 *    and a second round would be a second cap. Test networks stay open for testing.
 */
function assertGenesisChain(networkName) {
  if (!TESTNET_CHAINS.has(networkName) && networkName !== "ethereum") {
    throw new Error(`The Genesis round runs on Ethereum only (PSR-03); refusing to deploy it on "${networkName}".`);
  }
}

module.exports = { GENESIS_ROW, PRESALE_ABI, launchPlan, readGenesisSold, assertGenesisChain };
