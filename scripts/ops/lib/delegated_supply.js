/**
 * delegated_supply.js — the SRX that can vote right now (internal audit M9; launch delegation,
 * option 1, 23 Oct 2026).
 *
 * SRX counts as votes only once its holder chooses a delegate (ERC20Votes), so the quorum
 * question is not "how much SRX exists" but "how much is delegated". Nothing on chain sums
 * that, but every change to a delegate's votes emits
 *   DelegateVotesChanged(delegate, previousVotes, newVotes)
 * so a running sum of (newVotes - previousVotes) from the token's deployment block is exactly
 * the sum of getVotes() over every delegate. One log query per poll; spot-check the largest
 * delegates with getVotes().
 *
 * Pure apart from the reads it is given: no environment, no network choice.
 */
const { ethers } = require("ethers");

const DELEGATE_VOTES_CHANGED = "event DelegateVotesChanged(address indexed delegate, uint256 previousVotes, uint256 newVotes)";

/**
 * @param token      an ethers Contract for SRXToken (any runner with a provider)
 * @param fromBlock  the token's deployment block (SRX_TOKEN_DEPLOY_BLOCK_<NET>); required, so the
 *                   sum cannot silently start late and read low
 * @returns {{ total: bigint, byDelegate: Map<string, bigint>, events: number }}
 */
async function delegatedSupply(token, fromBlock) {
  if (fromBlock === undefined || fromBlock === null || !Number.isInteger(Number(fromBlock)) || Number(fromBlock) < 0) {
    throw new Error("delegatedSupply: the token's deployment block is required (SRX_TOKEN_DEPLOY_BLOCK_<NET>)");
  }
  const iface = new ethers.Interface([DELEGATE_VOTES_CHANGED]);
  const filter = { address: await token.getAddress(), topics: [iface.getEvent("DelegateVotesChanged").topicHash] };
  const provider = token.runner.provider || token.runner;
  const logs = await provider.getLogs({ ...filter, fromBlock: Number(fromBlock), toBlock: "latest" });
  const byDelegate = new Map();
  let total = 0n;
  for (const log of logs) {
    const { args } = iface.parseLog(log);
    const d = ethers.getAddress(args.delegate);
    total += args.newVotes - args.previousVotes;
    byDelegate.set(d, args.newVotes);
  }
  return { total, byDelegate, events: logs.length };
}

/**
 * Security's relayer condition 5 (23 Oct 2026): a delegate gaining more than 10% of quorum
 * within a day is the sign of a phishing or vote-buying campaign, so the watch WARNS on it.
 *
 * @param before   byDelegate from a read about a day earlier
 * @param after    byDelegate now
 * @param quorum   the Governor's quorum (bigint)
 * @returns [{ delegate, gained }] for every delegate whose votes rose by more than quorum / 10
 */
function concentrationWarnings(before, after, quorum) {
  const limit = quorum / 10n;
  const out = [];
  for (const [delegate, now] of after) {
    const gained = now - (before.get(delegate) || 0n);
    if (gained > limit) out.push({ delegate, gained });
  }
  return out;
}

module.exports = { delegatedSupply, concentrationWarnings, DELEGATE_VOTES_CHANGED };
