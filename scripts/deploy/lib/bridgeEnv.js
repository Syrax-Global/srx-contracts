/**
 * bridgeEnv.js — which chains are the hub and the spokes of each bridge environment.
 *
 * ⭐ ONE LIST. 07_deploy_bridge.js deploys and peers from it, and verify_roles.js reads the same
 *    list to decide which peers the hub is ALLOWED to have (E-05, review E, 22 Oct 2026): a hub
 *    peer on any chain not listed here, or at any address other than that chain's declared
 *    SRXOFTNative, is a failure.
 *
 * Hub and spoke (Jared, 23 Sep 2026, N-01): Ethereum (SRXToken) is the hub; each remote chain
 * (SRXOFTNative) is a spoke peered to its own hub only. A network belongs to exactly one
 * environment, and testnet and mainnet entries are never mixed.
 */
const { LZ_EIDS } = require("../00_config");

const ENVIRONMENTS = {
  testnet: {
    hub:    { network: "sepolia",  env: "SRX_TOKEN_SEPOLIA",  eid: LZ_EIDS.sepolia },
    spokes: [
      { network: "bscTestnet",    env: "SRX_OFT_NATIVE_BSCTESTNET",    eid: LZ_EIDS.bscTestnet },
      { network: "zkSyncSepolia", env: "SRX_OFT_NATIVE_ZKSYNCSEPOLIA", eid: LZ_EIDS.zkSyncSepolia },
    ],
  },
  mainnet: {
    hub:    { network: "ethereum", env: "SRX_TOKEN_ETHEREUM", eid: LZ_EIDS.ethereum },
    spokes: [
      { network: "bsc",    env: "SRX_OFT_NATIVE_BSC",    eid: LZ_EIDS.bsc },
      { network: "zkSync", env: "SRX_OFT_NATIVE_ZKSYNC", eid: LZ_EIDS.zkSync },
    ],
  },
};

/** Throws if the network is neither a hub nor a spoke (07's rule). */
function environmentOf(networkName) {
  for (const [name, e] of Object.entries(ENVIRONMENTS)) {
    if (e.hub.network === networkName) return { name, e, role: "hub" };
    const spoke = e.spokes.find((s) => s.network === networkName);
    if (spoke) return { name, e, role: "spoke", spoke };
  }
  throw new Error(`${networkName} is not a hub or spoke in any bridge environment`);
}

/**
 * The chains the HUB on `networkName` may be peered to, with each one's declared SRXOFTNative
 * address (or null when its variable is unset). Empty when the network is not a hub (a local
 * rehearsal chain has no spokes, so any peer on it is undeclared).
 * @returns {{ eid: number, chain: string, envKey: string, address: string|null }[]}
 */
function declaredSpokes(networkName, env = process.env) {
  for (const e of Object.values(ENVIRONMENTS)) {
    if (e.hub.network !== networkName) continue;
    return e.spokes.map((s) => {
      const raw = (env[s.env] || "").trim();
      return { eid: s.eid, chain: s.network, envKey: s.env, address: raw && raw.toLowerCase() !== "none" ? raw : null };
    });
  }
  return [];
}

module.exports = { ENVIRONMENTS, environmentOf, declaredSpokes };
