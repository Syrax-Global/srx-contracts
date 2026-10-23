/**
 * genesis_chunk.js — how many Genesis buyers' vaults one Safe transaction may create (C5).
 *
 * ⛔ C5 (review E, 22 Oct 2026). 06b queues, per chunk, `batchDeployVaults` and `batchTriggerTGE`
 *    in ONE Safe transaction, and each vault is a contract creation. Measured: about 961,000 gas (960,658 on 12 buyers, 22 Oct 2026; the reviewer saw 954,504)
 *    per buyer for the deploy plus the trigger. Ethereum caps a single transaction at 16,777,216
 *    gas, so the old default of 20 buyers (about 19M) could never be mined: the Safe would sign
 *    a batch that reverts out of gas, on launch day, while the script's own text said
 *    "batches of 20-50". The default is 12 (about 11.5M), and a chunk whose estimate is above
 *    15,000,000 is refused before anything is queued.
 */
const { formatUnits } = require("ethers");

/** Ethereum's per-transaction gas cap (EIP-7825), for the record. */
const TX_GAS_CAP = 16_777_216n;
/** A chunk whose estimate exceeds this is refused: headroom under the cap for the Safe's own overhead. */
const CHUNK_GAS_LIMIT = 15_000_000n;
/** Measured gas per buyer (960,658 on 12 buyers; rounded up) for batchDeployVaults + batchTriggerTGE (a VestingVault creation, its funding and declaration, and the trigger). */
const PER_BUYER_GAS = 961_000n;
/** Safety margin on the model, in basis points (11_000 = +10%). */
const MARGIN_BPS = 11_000n;
const DEFAULT_CHUNK = 12;

/** The model: buyers × the measured per-buyer gas × the margin. */
function modelChunkGas(buyers) {
  return (BigInt(buyers) * PER_BUYER_GAS * MARGIN_BPS) / 10_000n;
}

/**
 * The gas to plan for one chunk [start, end): the larger of the model and the node's own estimate
 * of the deploy call made from the Safe (the trigger cannot be estimated until the vaults exist,
 * so a node estimate of the deploy alone is topped up by the model's trigger share).
 */
async function estimateChunkGas({ round, from, start, end, provider = round.runner?.provider || round.runner }) {
  const buyers = Math.max(0, end - start);
  const model = modelChunkGas(buyers);
  let node = 0n;
  let nodeError = null;
  try {
    // Through the provider, so that `from` can be the Safe (a contract account): a Contract bound to a signer
    // refuses an estimate from any other address.
    const deploy = await provider.estimateGas({
      from, to: await round.getAddress(), data: round.interface.encodeFunctionData("batchDeployVaults", [start, end]),
    });
    // Everything in the measured per-buyer figure that is not the deploy is the trigger; carry
    // that share (about 5%) so the node figure covers both calls.
    node = (BigInt(deploy) * 105n * MARGIN_BPS) / (100n * 10_000n);
  } catch (e) { nodeError = e.shortMessage || e.message; /* some nodes refuse an estimate from a contract account; the model stands */ }
  return { gas: node > model ? node : model, model, node, buyers, nodeError };
}

/** Throws (naming the numbers and the fix) when a chunk is too big for one transaction. */
function assertChunkWithinLimit({ chunk, gas }) {
  if (gas > CHUNK_GAS_LIMIT) {
    throw new Error(
      `A chunk of ${chunk} Genesis buyers is estimated at ${gas} gas, above the ${CHUNK_GAS_LIMIT} this script allows ` +
      `(Ethereum caps one transaction at ${TX_GAS_CAP}; each buyer costs about ${PER_BUYER_GAS}). The Safe could not mine it. ` +
      `Set GENESIS_VAULT_CHUNK to ${maxChunk()} or fewer. Nothing was queued.`);
  }
}

/** The largest chunk the model allows under CHUNK_GAS_LIMIT. */
function maxChunk() {
  let n = 0;
  while (modelChunkGas(n + 1) <= CHUNK_GAS_LIMIT) n++;
  return n;
}

/** GENESIS_VAULT_CHUNK from the environment: a whole number of at least 1, default 12. */
function chunkFromEnv(env = process.env) {
  const raw = env.GENESIS_VAULT_CHUNK;
  const chunk = Number(raw === undefined || raw === "" ? DEFAULT_CHUNK : raw);
  if (!Number.isInteger(chunk) || chunk < 1) throw new Error("GENESIS_VAULT_CHUNK must be a whole number of at least 1");
  return chunk;
}

module.exports = {
  TX_GAS_CAP, CHUNK_GAS_LIMIT, PER_BUYER_GAS, MARGIN_BPS, DEFAULT_CHUNK,
  modelChunkGas, estimateChunkGas, assertChunkWithinLimit, maxChunk, chunkFromEnv,
  describeGas: (g) => `${formatUnits(g, 0)} gas`,
};
