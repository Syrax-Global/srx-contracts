/**
 * TGE destination controls — the ONE place the TGE allocation list is built and checked.
 *
 * ⛔ WHY THIS MODULE EXISTS. 06_execute_tge.js built its allocation list inline, and
 *    verify_tge_targets.js rebuilt "the exact same list" by copy — with a different
 *    env lookup (it accepted an unsuffixed variable the TGE script would not read).
 *    Worse, 06_execute_tge.js never called the check at all: the documented "last
 *    line of defence" against sending billions of SRX to a wrong address was a
 *    separate command someone had to remember to run.
 *
 * ⭐ Now both scripts call buildTgeAllocations() and assertTgeTargets() from here,
 *    and 06_execute_tge.js sends EXACTLY the list that was checked. Nothing is
 *    reconstructed, so nothing can drift.
 *
 * What is checked, in order (every failure is collected, then all are reported):
 *   1. every destination is set, valid, non-zero, and distinct;
 *   2. the list matches the signed-off manifest deploy/addresses.<network>.json —
 *      destination, amount and vault flag for every label, no missing or extra
 *      labels, the manifest's network and chain id;
 *   3. Σ amounts == MAX_SUPPLY;
 *   4. role holders match the manifest (on a real network an unpinned role FAILS);
 *   5. on chain: every destination except Liquidity has contract code, and every
 *      vesting vault pays out SRX, to the manifest's beneficiary, on the schedule
 *      in 00_config.js.
 *
 * Read-only. It never sends a transaction.
 */
const fs = require("fs");
const path = require("path");
const { getAddress, ZeroAddress, parseUnits, formatUnits } = require("ethers");
const { ALLOCATIONS, VESTING, TESTNET_CHAINS, walletFor } = require("../00_config");

const MAX_SUPPLY = parseUnits("10000000000", 18);

/** Networks where running without a manifest is allowed (in-process, disposable). */
const LOCAL_CHAINS = new Set(["hardhat", "localhost"]);

/** Vesting vault labels → their VESTING schedule key in 00_config.js. */
const VAULT_SCHEDULE = Object.freeze({
  Founders: "founders",
  CoreTeam: "coreTeam",
  SeedInvestors: "seedInvestors",
  Presale: "presale",
  EcosystemDAO: "ecosystem",
});

/** Destinations that may be a plain wallet (no contract code required). */
const MAY_BE_WALLET = new Set(["Liquidity"]);

const ROLE_ENV = Object.freeze({ timelock: "TIMELOCK", governor: "GOVERNOR", guardianModule: "GUARDIAN_MODULE" });

function checksum(value, what) {
  const raw = (value || "").trim();
  if (!raw) throw new Error(`${what} is not set`);
  let addr;
  try { addr = getAddress(raw); }
  catch { throw new Error(`${what} is not a valid checksummed address`); }
  if (addr === ZeroAddress) throw new Error(`${what} is the zero address`);
  return addr;
}

/**
 * The allocation list 06_execute_tge.js sends, built from env + 00_config.js.
 * Only network-suffixed variables are read (e.g. VESTING_FOUNDERS_ETHEREUM), exactly
 * as the TGE script always has. There are no fallbacks: a missing value throws.
 */
function buildTgeAllocations({ networkName, env = process.env }) {
  const NET = networkName.toUpperCase();
  const req = (key) => checksum(env[`${key}_${NET}`], `${key}_${NET}`);

  return [
    { label: "Founders",          destination: req("VESTING_FOUNDERS"),   amount: ALLOCATIONS.founders,      isVestingVault: true  },
    { label: "CoreTeam",          destination: req("VESTING_CORE_TEAM"),  amount: ALLOCATIONS.coreTeam,      isVestingVault: true  },
    { label: "SeedInvestors",     destination: req("VESTING_SEED"),       amount: ALLOCATIONS.seedInvestors, isVestingVault: true  },
    { label: "Presale",           destination: req("VESTING_PRESALE"),    amount: ALLOCATIONS.presale,       isVestingVault: true  },
    { label: "EcosystemDAO",      destination: req("VESTING_ECOSYSTEM"),  amount: ALLOCATIONS.ecosystem,     isVestingVault: true  },
    { label: "Liquidity",         destination: walletFor("liquidity", networkName, env), amount: ALLOCATIONS.liquidity, isVestingVault: false },
    // ⛔ Was `stakingAddr || WALLETS.staking`: with STAKING unset, 1.7B SRX went to a
    //    plain wallet and the incentive pool was silently never registered.
    { label: "Staking",           destination: req("STAKING"),            amount: ALLOCATIONS.staking,       isVestingVault: false },
    { label: "Treasury",          destination: req("TREASURY"),           amount: ALLOCATIONS.treasury,      isVestingVault: false },
    { label: "StabilisationFund", destination: req("STABILISATION_FUND"), amount: ALLOCATIONS.strategic,     isVestingVault: false },
  ];
}

/** Live role holders, resolved the way the deploy scripts resolve them. */
function liveRoles({ networkName, env = process.env }) {
  const NET = networkName.toUpperCase();
  const roles = {};
  try { roles.admin = walletFor("admin", networkName, env); }
  catch (e) { roles.admin = { error: e.message }; }
  for (const [label, key] of Object.entries(ROLE_ENV)) {
    const raw = env[`${key}_${NET}`];
    if (!raw) { roles[label] = null; continue; }
    try { roles[label] = checksum(raw, `${key}_${NET}`); }
    catch (e) { roles[label] = { error: e.message }; }
  }
  return roles;
}

function manifestPathFor(networkName, root = path.join(__dirname, "..", "..", "..")) {
  return path.join(root, "deploy", `addresses.${networkName}.json`);
}

/**
 * Compare the allocation list and role holders with the manifest. Pure: returns a
 * list of failure strings (empty = pass). Never throws on a mismatch.
 */
function checkAgainstManifest({ allocations, manifest, roles, networkName, chainId }) {
  const failures = [];
  const isTestnet = TESTNET_CHAINS.has(networkName);

  if (manifest.network !== networkName) {
    failures.push(`manifest is for network "${manifest.network}", not "${networkName}"`);
  }
  if (chainId !== undefined && BigInt(manifest.chainId ?? -1) !== BigInt(chainId)) {
    failures.push(`manifest chainId ${manifest.chainId} does not match the connected chain ${chainId}`);
  }

  // ── 1. every destination distinct ──────────────────────────────────────────
  const seen = new Map();
  for (const a of allocations) {
    if (seen.has(a.destination)) {
      failures.push(`${a.label} and ${seen.get(a.destination)} share the destination ${a.destination}`);
    } else {
      seen.set(a.destination, a.label);
    }
  }

  // ── 2. each allocation matches the manifest ────────────────────────────────
  const expected = manifest.tgeAllocations || {};
  const liveLabels = new Set(allocations.map((a) => a.label));
  for (const label of Object.keys(expected)) {
    if (label.startsWith("_")) continue;
    if (!liveLabels.has(label)) failures.push(`manifest lists "${label}", which the TGE does not send`);
  }

  let sum = 0n;
  for (const a of allocations) {
    sum += a.amount;
    const exp = expected[a.label];
    if (!exp) { failures.push(`${a.label}: not in the manifest`); continue; }

    let expDest;
    try { expDest = checksum(exp.destination, `manifest ${a.label}.destination`); }
    catch (e) { failures.push(e.message); continue; }

    if (a.destination !== expDest) {
      failures.push(`${a.label} DESTINATION mismatch: live ${a.destination} ≠ manifest ${expDest}`);
    }
    let expAmt;
    try { expAmt = parseUnits(String(exp.amountSRX), 18); }
    catch { failures.push(`${a.label}: manifest amountSRX "${exp.amountSRX}" is not a number`); continue; }
    if (a.amount !== expAmt) {
      failures.push(`${a.label} AMOUNT mismatch: live ${formatUnits(a.amount, 18)} ≠ manifest ${exp.amountSRX}`);
    }
    if (Boolean(exp.isVestingVault) !== a.isVestingVault) {
      failures.push(`${a.label}: manifest isVestingVault=${Boolean(exp.isVestingVault)}, TGE sends it as ${a.isVestingVault}`);
    }
    if (a.isVestingVault && !isTestnet && !exp.beneficiary) {
      failures.push(`${a.label}: manifest does not pin the vault's beneficiary`);
    }
  }

  // ── 3. supply invariant ────────────────────────────────────────────────────
  if (sum !== MAX_SUPPLY) {
    failures.push(`Σ allocations = ${formatUnits(sum, 18)} SRX ≠ MAX_SUPPLY (10,000,000,000)`);
  }

  // ── 4. role holders ────────────────────────────────────────────────────────
  // ⛔ An unpinned role used to be a warning and a skip on every network, so a
  //    mainnet manifest with an empty roles block passed. On a real network it fails.
  for (const label of ["admin", ...Object.keys(ROLE_ENV)]) {
    const pinned = manifest.roles?.[label];
    const unpinned = !pinned || pinned === ZeroAddress;
    const live = roles?.[label];
    if (live && typeof live === "object") { failures.push(`role ${label}: ${live.error}`); continue; }
    if (unpinned) {
      if (!isTestnet) failures.push(`role ${label}: not pinned in the manifest`);
      continue;
    }
    let exp;
    try { exp = checksum(pinned, `manifest roles.${label}`); }
    catch (e) { failures.push(e.message); continue; }
    if (!live) { failures.push(`role ${label}: pinned in the manifest but not set for this network`); continue; }
    if (live !== exp) failures.push(`role ${label} mismatch: live ${live} ≠ manifest ${exp}`);
  }

  return failures;
}

/**
 * On-chain checks. `provider` needs getCode(); `vaultAt(address)` returns an object
 * with token(), beneficiary(), cliffDuration(), vestingDuration(), tgeUnlockBps().
 */
async function checkOnChain({ allocations, manifest, provider, vaultAt, tokenAddress }) {
  const failures = [];
  const token = checksum(tokenAddress, "SRX token address");

  for (const a of allocations) {
    if (MAY_BE_WALLET.has(a.label)) continue;
    const code = await provider.getCode(a.destination);
    if (!code || code === "0x") {
      failures.push(`${a.label}: no contract at ${a.destination}`);
      continue;
    }
    if (!a.isVestingVault) continue;

    const vault = vaultAt(a.destination);
    let vToken, vBen, cliff, vesting, tge;
    try {
      [vToken, vBen, cliff, vesting, tge] = await Promise.all([
        vault.token(), vault.beneficiary(), vault.cliffDuration(),
        vault.vestingDuration(), vault.tgeUnlockBps(),
      ]);
    } catch {
      failures.push(`${a.label}: ${a.destination} does not answer as a VestingVault`);
      continue;
    }
    if (getAddress(vToken) !== token) {
      failures.push(`${a.label}: vault pays out ${getAddress(vToken)}, not SRX ${token}`);
    }
    const pinned = manifest.tgeAllocations?.[a.label]?.beneficiary;
    if (pinned) {
      let exp;
      try { exp = checksum(pinned, `manifest ${a.label}.beneficiary`); }
      catch (e) { failures.push(e.message); exp = null; }
      if (exp && getAddress(vBen) !== exp) {
        failures.push(`${a.label}: vault beneficiary ${getAddress(vBen)} ≠ manifest ${exp}`);
      }
    }
    const sched = VESTING[VAULT_SCHEDULE[a.label]];
    if (sched) {
      if (BigInt(cliff) !== sched.cliffDuration)     failures.push(`${a.label}: vault cliff ${cliff}s ≠ config ${sched.cliffDuration}s`);
      if (BigInt(vesting) !== sched.vestingDuration) failures.push(`${a.label}: vault vesting ${vesting}s ≠ config ${sched.vestingDuration}s`);
      if (BigInt(tge) !== sched.tgeUnlockBps)        failures.push(`${a.label}: vault TGE unlock ${tge} bps ≠ config ${sched.tgeUnlockBps} bps`);
    }
  }
  return failures;
}

/**
 * The whole gate. Returns { allocations, failures, manifestPath, skipped }.
 * Does not throw on a mismatch — the caller decides — but DOES throw if the
 * allocation list itself cannot be built (a missing or invalid address).
 */
async function runTgeTargetChecks({
  networkName, chainId, env = process.env, provider, vaultAt, tokenAddress,
  manifestPath = manifestPathFor(networkName),
}) {
  const allocations = buildTgeAllocations({ networkName, env });

  if (!fs.existsSync(manifestPath)) {
    if (LOCAL_CHAINS.has(networkName)) {
      return { allocations, failures: [], manifestPath, skipped: true };
    }
    return {
      allocations, manifestPath, skipped: false,
      failures: [`no manifest at ${manifestPath} — create it from deploy/addresses.example.json with the FINAL addresses`],
    };
  }

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch { return { allocations, manifestPath, skipped: false, failures: [`manifest ${manifestPath} is not valid JSON`] }; }

  const failures = checkAgainstManifest({
    allocations, manifest, roles: liveRoles({ networkName, env }), networkName, chainId,
  });
  if (provider) {
    failures.push(...await checkOnChain({ allocations, manifest, provider, vaultAt, tokenAddress }));
  } else if (!LOCAL_CHAINS.has(networkName)) {
    failures.push("no provider given — the on-chain checks did not run");
  }
  return { allocations, failures, manifestPath, skipped: false };
}

module.exports = {
  MAX_SUPPLY, LOCAL_CHAINS, VAULT_SCHEDULE,
  buildTgeAllocations, liveRoles, manifestPathFor,
  checkAgainstManifest, checkOnChain, runTgeTargetChecks,
};
