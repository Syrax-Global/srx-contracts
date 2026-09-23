/**
 * adminTx.js — routes an admin-only contract call to wherever the admin actually is.
 *
 * SC-TRUST-002 (finding DEP-01): on mainnet, WALLETS.admin (00_config.js) is the
 * admin Gnosis Safe — a contract, not the deployer EOA. Several deploy scripts sent
 * admin-gated transactions (grantRole, setPeer, genesis, ...) directly from the
 * deployer signer, which reverts whenever the deployer is not the admin. The rule
 * this file exists to enforce: the deployer EOA must never hold any role, not even
 * temporarily — so an admin-only call is either executed by the admin itself
 * (testnets, where the loaded signer commonly IS WALLETS.admin), or it is encoded
 * and queued for the admin Safe to execute as a Gnosis Safe Transaction Builder
 * batch. The caller never has to know which case applies.
 *
 * Usage:
 *   const { createAdminBatch } = require("./lib/adminTx");
 *   const batch = createAdminBatch("05_treasury");
 *   await batch.send(token, "grantRole", [BURN_ROLE, treasuryAddress], "grant BURN_ROLE to Treasury");
 *   ...
 *   await batch.flush(); // writes safe_batch.05_treasury.<network>.json if anything queued
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { WALLETS } = require("../00_config");

/**
 * @param {string} label   Identifies this batch, e.g. "08_guardian". Used to build
 *                         the output filename: safe_batch.<label>.<network>.json
 * @param {object} [options]
 * @param {import("ethers").Signer} [options.signer]  Defaults to ethers.getSigners()[0].
 * @param {string} [options.admin]                     Defaults to WALLETS.admin.
 * @param {string} [options.outDir]                    Defaults to process.cwd().
 */
function createAdminBatch(label, options = {}) {
  const queued = [];
  const outDir = options.outDir || process.cwd();

  let signerPromise = null;
  function loadSigner() {
    if (!signerPromise) {
      signerPromise = options.signer
        ? Promise.resolve(options.signer)
        : ethers.getSigners().then(([s]) => s);
    }
    return signerPromise;
  }

  let adminPromise = null;
  function loadAdmin() {
    if (!adminPromise) {
      adminPromise = Promise.resolve(options.admin || WALLETS.admin).then((a) =>
        ethers.getAddress(a)
      );
    }
    return adminPromise;
  }

  /** True when the loaded signer IS the admin (testnets, mostly). */
  async function isAdmin() {
    const [signer, admin] = await Promise.all([loadSigner(), loadAdmin()]);
    const signerAddress = ethers.getAddress(await signer.getAddress());
    return signerAddress === admin;
  }

  /**
   * Send an admin-only call. Executes immediately if the loaded signer is the
   * admin; otherwise encodes and queues it for the admin Safe.
   *
   * @param {import("ethers").Contract} contract
   * @param {string} fn            Function name on the contract's ABI.
   * @param {any[]}  args
   * @param {string} description   Human-readable line for logs and the Safe batch.
   * @returns {Promise<{executed: boolean, receipt?: any}>}
   */
  async function send(contract, fn, args, description) {
    const signer = await loadSigner();
    if (await isAdmin()) {
      const tx = await contract.connect(signer)[fn](...args);
      const receipt = await tx.wait();
      console.log(`  ✅ ${description}`);
      return { executed: true, receipt };
    }

    const data = contract.interface.encodeFunctionData(fn, args);
    const to = await contract.getAddress();
    queued.push({ to, value: "0", data, description });
    console.log(`  📝 queued for the admin Safe: ${description}`);
    return { executed: false };
  }

  /**
   * Writes the queued transactions as a Gnosis Safe Transaction Builder JSON
   * file, if anything is queued. Returns the file path, or null if nothing
   * was queued (nothing extra is printed in that case).
   */
  async function flush() {
    if (queued.length === 0) return null;

    const { chainId } = await ethers.provider.getNetwork();
    const out = {
      version: "1.0",
      chainId: chainId.toString(),
      createdAt: Math.floor(Date.now() / 1000),
      meta: {
        name: `SRX deploy — ${label} (${network.name})`,
        description:
          `Admin-only transactions queued by ${label}, routed here because the ` +
          `loaded signer is not the admin Safe. Review every transaction before signing.`,
        txBuilderVersion: "1.16.5",
      },
      transactions: queued.map(({ to, value, data }) => ({ to, value, data })),
    };

    const file = path.join(outDir, `safe_batch.${label}.${network.name}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`\n📝 Wrote ${queued.length} transaction(s) for the admin Safe to ${file}`);
    console.log(`   The admin Safe must execute this file before running the next deploy step.`);
    queued.length = 0; // consumed — a later flush() with nothing new queued is a no-op
    return file;
  }

  return { send, flush, isAdmin };
}

module.exports = { createAdminBatch };
