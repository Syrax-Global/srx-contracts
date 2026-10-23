/**
 * Step 9 — RETIRED (decision CH-13, Jared, 22 Oct 2026).
 *
 * ZkSyncMigrator is not deployed. It burned SRX on Ethereum and relied on a Syrax-run
 * oracle to "mint native SRX on the Syrax Chain". On this kind of chain, SRX exists only
 * as SRX locked in the Ethereum vault, so that oracle would have needed a funded reserve
 * and a hot key, and every migration would have shrunk supply twice (bus
 * 20261022T1530Z, Chain finding 03-F5).
 *
 * Instead, holders move SRX onto Syrax Chain through the chain's own bridge: one deposit
 * the holder signs, locked 1:1 in the Ethereum vault and withdrawable any time. Holders on
 * BNB Chain or ZKsync Era first return to the Ethereum hub over the OFT bridge. Any helper
 * built later must be stateless, hold no funds and hold no roles (CH-13).
 *
 * The contract source and its tests stay in the repository as history. Nothing in the
 * launch path deploys it, and verify_roles.js fails a network that declares one.
 */
console.error("Step 9 (ZkSyncMigrator) is retired by decision CH-13: SRX moves onto Syrax Chain through the chain's own bridge. Nothing was deployed.");
process.exit(1);
