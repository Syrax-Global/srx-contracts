/**
 * vaultOps.js — the two Timelock operations that set up the launch vesting vaults.
 *
 * ⭐ WHY (Jared, 30 Sep 2026): a VestingVault's immutable `admin` can revoke() it at
 *    any moment and send the whole unvested remainder to ANY address. With the admin
 *    Safe as admin, that was an instant power over every locked launch allocation —
 *    the "locked 12 months" liquidity reserve, the ecosystem fund, the team vaults —
 *    at odds with GOV-H1 (every power behind the 48-hour delay). The launch vaults'
 *    admin is now the SRXTimelock, so any revoke is a public governance proposal.
 *
 *    The vault admin also runs the two launch steps. Both now go through the
 *    Timelock as ordinary, public operations:
 *      DECLARE — declareExpectedAllocation(amount) on every vault;
 *      TRIGGER — triggerTGE() on every vault, with DECLARE as its predecessor.
 *    03_deploy_vesting SCHEDULES both (the Safe is Timelock admin until hand-over and
 *    grants itself PROPOSER for this; migrate_roles phase 2 revokes it). 06_execute_tge
 *    EXECUTES both, right after distribute() — execution is open to anyone. On mainnet
 *    the operations are therefore on chain at least 48 hours before launch.
 *
 * Both files build the operations HERE, from TGE_PLAN, so the batch scheduled in 03
 * and the batch executed in 06 are byte-identical (same id) by construction.
 *
 * The seed vault's grant depends on what the Genesis round sold (lib/genesis_seed.js),
 * so 03 and 06 pass the amounts they send. If the round's total changed between the
 * two (a refund after step 3), the ids differ and 06 refuses: nothing is sent.
 */
const { ethers } = require("hardhat");
const { ALLOCATIONS, TGE_PLAN } = require("../00_config");

const DECLARE_SALT = ethers.id("SRX:VestingVault.declareExpectedAllocation:launch");
const TRIGGER_SALT = ethers.id("SRX:VestingVault.triggerTGE:launch");

const VAULT_IFACE = new ethers.Interface([
  "function declareExpectedAllocation(uint256 amount)",
  "function triggerTGE()",
]);

/** OZ TimelockController.hashOperationBatch, off chain. */
function hashBatch(targets, values, payloads, predecessor, salt) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address[]", "uint256[]", "bytes[]", "bytes32", "bytes32"],
    [targets, values, payloads, predecessor, salt]));
}

/**
 * @param {Record<string,string>} vaultByLabel  TGE_PLAN label → vault address
 * @param {Record<string,bigint>} [amounts]     allocation key → amount (default ALLOCATIONS)
 * @returns {{ declare: Op, trigger: Op }} where Op = { targets, values, payloads, predecessor, salt, id, args }
 */
function vaultOps(vaultByLabel, amounts = ALLOCATIONS) {
  const rows = TGE_PLAN.filter((r) => r.kind === "vault");
  const targets = rows.map((r) => {
    const a = vaultByLabel[r.label];
    if (!a) throw new Error(`vaultOps: no address for the ${r.label} vault`);
    return ethers.getAddress(a);
  });
  const values = targets.map(() => 0n);
  const op = (payloads, predecessor, salt) => {
    const id = hashBatch(targets, values, payloads, predecessor, salt);
    return { targets, values, payloads, predecessor, salt, id, args: [targets, values, payloads, predecessor, salt] };
  };
  const declare = op(
    rows.map((r) => VAULT_IFACE.encodeFunctionData("declareExpectedAllocation", [amounts[r.allocation]])),
    ethers.ZeroHash, DECLARE_SALT);
  const trigger = op(rows.map(() => VAULT_IFACE.encodeFunctionData("triggerTGE")), declare.id, TRIGGER_SALT);
  return { declare, trigger };
}

module.exports = { vaultOps, DECLARE_SALT, TRIGGER_SALT };
