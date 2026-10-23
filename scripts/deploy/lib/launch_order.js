/**
 * launch_order.js — preconditions that depend on the ORDER the deploy scripts run in.
 *
 * The documented order is
 *     01 token → 02 governance → 05 treasury → 10 Genesis round → 03 vesting + distributor
 *     → 04 staking → 05b stabilisation fund → 06 TGE → 06b Genesis vaults → 08 guardian
 *     → migrate_roles → verify_roles
 * (07 bridge wiring is separate; see its header.)
 *
 * ⛔ E-02 (review E, 22 Oct 2026). Step 5 used to run AFTER Steps 3 and 10, but both of those
 *    fix the address the unvested SRX of a revoked vault is sent to, immutably (a
 *    VestingVault's `revokeRecipient`, the Genesis contract's `vaultRevokeRecipient`).
 *    The Treasury did not exist yet, so both scripts fell back to the WALLET_TREASURY
 *    wallet: a plain address, not the SRXTreasury contract, and no Timelock rule can ever
 *    move it. The Treasury is therefore deployed first, and there is NO fallback on any
 *    network.
 *
 * ⛔ E-01. SRXStaking and StabilisationFund fix the launch TGEDistributor immutably
 *    (REG-50), and Step 3 deploys a NEW distributor on every run. A re-run of Step 3 after
 *    Step 4 or 5b leaves them pointing at a distributor that never launches, and the 1.7B
 *    staking allocation is stranded. So Step 3 refuses when either is already declared,
 *    unless the operator states in writing that they will be redeployed; and the TGE gate
 *    (lib/tge_targets.js checkLaunchWiring) refuses to launch unless both name the
 *    distributor that launches.
 */
const { Contract, getAddress, ZeroAddress } = require("ethers");

const TREASURY_ABI = ["function srxToken() view returns (address)"];

/**
 * The SRXTreasury this network's launch vaults and Genesis contract will send revoked SRX to.
 * Throws if TREASURY_<NET> is unset, not a contract, or not an SRXTreasury for this token.
 * @returns {Promise<string>} the checksummed address
 */
async function requireTreasury({ networkName, env = process.env, provider, tokenAddress, forWhat = "this step" }) {
  const key = `TREASURY_${networkName.toUpperCase()}`;
  const raw = (env[key] || "").trim();
  if (!raw) {
    throw new Error(
      `${key} is not set. ${forWhat} fixes the address that a revoked vault's unvested SRX is sent to, ` +
      `and that address can never be changed, so it must be the SRXTreasury contract, which must exist first. ` +
      `Run 05_deploy_treasury.js (right after 02_deploy_governance.js) and set ${key}. ` +
      `There is no fallback to WALLET_TREASURY. Nothing was deployed.`);
  }
  let addr;
  try { addr = getAddress(raw); } catch { throw new Error(`${key} is not a valid checksummed address. Nothing was deployed.`); }
  if (addr === ZeroAddress) throw new Error(`${key} is the zero address. Nothing was deployed.`);
  if (!provider) throw new Error("requireTreasury needs a provider");
  if ((await provider.getCode(addr)) === "0x") {
    throw new Error(`${key}: no contract at ${addr}. The revoke recipient must be the SRXTreasury contract, not a wallet. Nothing was deployed.`);
  }
  if (tokenAddress) {
    let t;
    try { t = await new Contract(addr, TREASURY_ABI, provider).srxToken(); }
    catch { throw new Error(`${key}: ${addr} does not answer as an SRXTreasury (no srxToken()). Nothing was deployed.`); }
    if (getAddress(t) !== getAddress(tokenAddress)) {
      throw new Error(`${key}: the treasury at ${addr} belongs to SRX ${getAddress(t)}, not the launch token ${getAddress(tokenAddress)}. Nothing was deployed.`);
    }
  }
  return addr;
}

/** The flag that acknowledges Step 3 is being re-run after Step 4 / 5b. */
const REDEPLOY_ACK = "ACK_REDEPLOY_STAKING_AND_FUND";

/**
 * Step 3 refuses to run while the staking contract or the Stabilisation Fund is already
 * declared for the network, because both are bound to the distributor Step 3 replaces.
 * With REDEPLOY_ACK=yes it proceeds (returning redeploying: true): the caller must say
 * loudly that 04 and 05b have to be re-run against the new distributor.
 */
function assertStep3MayRun({ networkName, env = process.env }) {
  const NET = networkName.toUpperCase();
  const declared = [`STAKING_${NET}`, `STABILISATION_FUND_${NET}`, `STABILISATION_${NET}`]
    .filter((k) => {
      const v = (env[k] || "").trim().toLowerCase();
      return v && v !== "none";
    });
  if (declared.length === 0) return { redeploying: false, declared };
  if ((env[REDEPLOY_ACK] || "").trim().toLowerCase() === "yes") return { redeploying: true, declared };
  throw new Error(
    `${declared.join(" and ")} ${declared.length > 1 ? "are" : "is"} already declared, so Step 4 / 5b has already run against the current ` +
    `TGEDistributor. Step 3 deploys a NEW TGEDistributor, but SRXStaking and the StabilisationFund fix the distributor they were ` +
    `deployed against and can never change it: re-running Step 3 now would leave them tied to a distributor that never launches, ` +
    `and the 1.7B staking allocation would be stranded. If you really mean to redo Step 3, you must also re-run 04 and 05b against ` +
    `the new distributor (and every address that depends on them). Acknowledge that with ${REDEPLOY_ACK}=yes. Nothing was deployed.`);
}

// ── E-06: one environment variable, one role ─────────────────────────────────

/**
 * ⛔ E-06. GUARDIAN_MULTISIG meant two different roles: 08 gave it to GuardianModule as its
 *    guardian (the emergency-pause holder), while verify_roles required the same value to hold
 *    the StabilisationFund's 70% fast-path GUARDIAN_ROLE. One value cannot be right for both
 *    (they are different contracts and different multisigs), so the gate demanded a role that
 *    was never granted, or the deployer was told to reuse one address for two powers.
 *
 *    It is split, and the old name is refused rather than guessed at:
 *      PAUSE_GUARDIAN         GuardianModule's GUARDIAN_ROLE: the emergency pause. The admin Safe
 *                             (MULTISIG_SPEC: "Emergency pause: Safe, 3 of 5, via GuardianModule").
 *      SSF_GUARDIAN_MULTISIG  StabilisationFund's GUARDIAN_ROLE: the capped 70% fast path. Granted
 *                             after launch by governance; the gate checks it when stated.
 */
const RETIRED_GUARDIAN_NAME = "GUARDIAN_MULTISIG";

/** The retired variable if it is set (bare or network-suffixed), else null. */
function retiredGuardianVariable(env = process.env, networkName = null) {
  const names = [RETIRED_GUARDIAN_NAME, ...(networkName ? [`${RETIRED_GUARDIAN_NAME}_${networkName.toUpperCase()}`] : [])];
  return names.find((n) => (env[n] || "").trim()) || null;
}

/** The text to show when the retired variable is found. */
function retiredGuardianMessage(name = RETIRED_GUARDIAN_NAME) {
  return `${name} is retired: it named two different roles (08 used it for GuardianModule's guardian, verify_roles for the ` +
    `StabilisationFund's 70% fast-path GUARDIAN_ROLE). Remove it and set PAUSE_GUARDIAN (GuardianModule's GUARDIAN_ROLE: the ` +
    `emergency pause, the admin Safe) and, separately, SSF_GUARDIAN_MULTISIG (the StabilisationFund's GUARDIAN_ROLE).`;
}

// ── E-04: a role holder is stated, never defaulted ───────────────────────────

/**
 * ⛔ E-04. 08 defaulted both GuardianModule's guardian and the circuit-breaker monitor to the
 *    admin Safe when their variables were unset, on every network. The role then landed on
 *    whichever address happened to be the Safe, with no statement from the operator, and a
 *    monitor that is the Safe cannot be a running off-chain process. An unset value is now an
 *    error; there is no fallback on any network.
 * @returns the checksummed address
 */
function requireAddressEnv(name, { env = process.env, what }) {
  const raw = (env[name] || "").trim();
  if (!raw) throw new Error(`${name} is not set. It names ${what}, and there is no default (the admin Safe is not assumed). Nothing was deployed.`);
  let a;
  try { a = getAddress(raw); } catch { throw new Error(`${name} is not a valid checksummed address. Nothing was deployed.`); }
  if (a === ZeroAddress) throw new Error(`${name} is the zero address. Nothing was deployed.`);
  return a;
}

// ── E-08: one name per deployed address; the old names are still READ ─────────

/**
 * ⛔ E-08. The deploy scripts print `STABILISATION_FUND_<NET>` (05b) and, for the GuardianModule,
 *    `GUARDIAN_<NET>` (08), while the role scripts read `STABILISATION_<NET>` and
 *    `GUARDIAN_MODULE_<NET>`. Anyone pasting what the scripts printed got "Missing required
 *    address" at the launch gate; the rehearsal papered over it with a hand translation.
 *
 *    The canonical names are the ones TGE_PLAN and the TGE gate already use:
 *      STABILISATION_FUND_<NET>   (05b prints it; every script reads it)
 *      GUARDIAN_MODULE_<NET>      (08 now prints it; every script reads it)
 *    The old spellings are accepted for reading, so an existing .env keeps working.
 */
const ENV_ALIASES = Object.freeze({
  STABILISATION_FUND: ["STABILISATION"],
  GUARDIAN_MODULE: ["GUARDIAN"],
});

/** Every spelling of a deployed-address variable, canonical first. */
function envNamesFor(key) {
  return [key, ...(ENV_ALIASES[key] || [])];
}

/**
 * The value of `key` for a network, trying the canonical name then its aliases, each as
 * `<NAME>_<NET>` then (unless `bare: false`) bare `<NAME>`. Returns { name, value } or null.
 */
function lookupEnv(key, networkName, env = process.env, { bare = true } = {}) {
  const NET = networkName.toUpperCase();
  for (const n of envNamesFor(key)) {
    for (const full of bare ? [`${n}_${NET}`, n] : [`${n}_${NET}`]) {
      const v = (env[full] || "").trim();
      if (v) return { name: full, value: v };
    }
  }
  return null;
}

module.exports = {
  requireTreasury, assertStep3MayRun, REDEPLOY_ACK,
  retiredGuardianVariable, retiredGuardianMessage,
  requireAddressEnv,
  ENV_ALIASES, envNamesFor, lookupEnv,
};
