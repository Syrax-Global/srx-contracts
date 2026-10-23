/**
 * gate_checks.js — launch-gate checks that verify_roles.js and migrate_roles.js share
 * (internal audit 16 Oct 2026, CONTROL-10 and CONTROL-05).
 *
 * verify_roles.js asked "who holds each role" and nothing else. Two things it could not
 * see, both of which let a blocking gate pass on a deployment that was not safe:
 *
 *  • CONTROL-10: the GuardianModule's registry and circuit breaker. Roles can all be
 *    right while a module was never registered (the guardian cannot pause it) or was
 *    registered to the wrong contract (a pause lands on the wrong place), or while the
 *    bridge breaker was never configured (recordBridgeActivity returns silently when
 *    volumeThreshold is 0, so the monitor "works" and nothing ever trips).
 *  • CONTROL-05: Timelock operations that survive the hand-over. During setup the Safe is
 *    briefly a Timelock PROPOSER; anything it scheduled then stays executable by anyone
 *    after the Safe's proposer role is revoked, and hasRole() cannot show it.
 *
 * Both are pure of the process environment: they take contracts and plain values and
 * return failure strings (empty = pass), so they can be unit tested against contracts
 * deployed in-process (test/deploy/LaunchGate.InternalAudit.test.js).
 */
const { ethers } = require("ethers");

// The six module ids, computed from their names rather than read from the contract
// under test: a gate that asks the contract what to expect agrees with whatever it finds.
// test/deploy/LaunchGate.InternalAudit.test.js proves these equal GuardianModule's constants.
const GUARDIAN_MODULES = [
  { label: "MODULE_TOKEN",    id: ethers.id("TOKEN"),              expects: "token" },
  { label: "MODULE_BRIDGE",   id: ethers.id("BRIDGE"),             expects: "token" },   // the bridge is the token's OFT send
  { label: "MODULE_STAKING",  id: ethers.id("STAKING"),            expects: "staking" },
  { label: "MODULE_FEE",      id: ethers.id("FEE_CONTROLLER"),     expects: "fee" },
  { label: "MODULE_TREASURY", id: ethers.id("TREASURY"),           expects: "treasury" },
  { label: "MODULE_SSF",      id: ethers.id("STABILISATION_FUND"), expects: "ssf" },
];
const MODULE_BRIDGE = GUARDIAN_MODULES[1].id;

/**
 * CONTROL-10. Every module is registered to exactly the contract it should pause, and
 * the bridge circuit breaker is configured.
 *
 * @param guardian  a GuardianModule contract (ethers v6)
 * @param expected  { token, staking, fee, treasury, ssf } addresses
 * @returns string[] — one entry per problem; empty means the wiring is right
 */
async function checkGuardianWiring({ guardian, expected }) {
  const failures = [];

  for (const m of GUARDIAN_MODULES) {
    const want = expected[m.expects];
    if (!want) { failures.push(`${m.label}: no expected target was given (${m.expects}), so it cannot be checked`); continue; }
    let cfg;
    try { cfg = await guardian.modules(m.id); }
    catch (e) { failures.push(`${m.label}: the GuardianModule did not answer modules() (${e.shortMessage || e.message})`); continue; }
    // ModuleConfig { target, registered, paused, ... } — read by name, not position.
    if (!cfg.registered) {
      failures.push(`${m.label} is not registered: the guardian cannot pause ${want}, and pauseAll() skips it silently`);
    } else if (ethers.getAddress(cfg.target) !== ethers.getAddress(want)) {
      failures.push(`${m.label} is registered to ${cfg.target}, expected ${ethers.getAddress(want)}: a guardian pause would land on the wrong contract`);
    }
  }

  // Unconfigured, recordBridgeActivity() returns without doing anything, so the monitor
  // reports every transfer and the breaker never trips.
  try {
    const cb = await guardian.circuitBreakers(MODULE_BRIDGE);
    if (cb.volumeThreshold === 0n) failures.push("MODULE_BRIDGE circuit breaker is not configured (volumeThreshold is 0): it can never trip; governance must call configureCircuitBreaker");
    if (cb.windowDuration === 0n) failures.push("MODULE_BRIDGE circuit breaker is not configured (windowDuration is 0): its volume can never drain; governance must call configureCircuitBreaker");
  } catch (e) {
    failures.push(`MODULE_BRIDGE: the GuardianModule did not answer circuitBreakers() (${e.shortMessage || e.message})`);
  }
  return failures;
}

// ── Timelock: operations that outlive the hand-over ──────────────────────────

const OP_ID = /^0x[0-9a-fA-F]{64}$/;

/** "id1, id2" -> ["0x..", "0x.."] (lower case). Throws on a malformed entry: a typo must be loud. */
function parseOpList(raw) {
  const out = [];
  for (const part of String(raw || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!OP_ID.test(part)) throw new Error(`"${part}" is not a Timelock operation id (expected 0x + 64 hex characters)`);
    out.push(part.toLowerCase());
  }
  return out;
}

/** A block number from the environment, or null when it is absent or not a whole number. */
function parseBlock(raw) {
  const s = String(raw ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/**
 * Every operation id that is still pending on the Timelock and is not on the allow-list.
 *
 * It reads CallScheduled from fromBlock to find the ids ever scheduled (one id can have
 * several events, one per call index), then asks isOperationPending(id) for each. That
 * call is the source of truth: it is false once the operation is executed or cancelled,
 * and true again if a cancelled id is scheduled afresh, which replaying
 * CallScheduled/CallExecuted/Cancelled by hand gets wrong.
 *
 * ⛔ fromBlock MUST be the Timelock's deployment block (or earlier). An absence check
 *    that cannot look is not a pass, so a missing fromBlock throws, and so does one that
 *    is later than the deployment (the Timelock already had code the block before it).
 *
 * @returns string[] operation ids (lower case), in the order they were first scheduled
 */
async function pendingTimelockOps({ timelock, fromBlock, allowList = [] }) {
  if (fromBlock === undefined || fromBlock === null || !Number.isInteger(Number(fromBlock)) || Number(fromBlock) < 0) {
    throw new Error("fromBlock (the Timelock's deployment block) was not provided, so pending operations cannot be listed: set TIMELOCK_DEPLOY_BLOCK_<NET>");
  }
  const from = Number(fromBlock);
  const provider = timelock.runner.provider || timelock.runner;
  if (from > 0 && (await provider.getCode(await timelock.getAddress(), from - 1)) !== "0x") {
    throw new Error(`fromBlock ${from} is after the Timelock was deployed (it already has code at block ${from - 1}); operations scheduled before it would be missed. Use the deployment block`);
  }

  const allowed = new Set(allowList.map((id) => id.toLowerCase()));
  const events = await timelock.queryFilter(timelock.filters.CallScheduled(), from);
  const seen = new Set();
  const pending = [];
  for (const ev of events) {
    const id = ev.args.id.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    if (allowed.has(id)) continue;
    if (await timelock.isOperationPending(id)) pending.push(id);
  }
  return pending;
}

/**
 * CONTROL-05 as a gate: failure strings, one per pending operation, or one if the check
 * could not look at all.
 */
async function checkNoPendingTimelockOps({ timelock, fromBlock, allowList = [] }) {
  let pending;
  try { pending = await pendingTimelockOps({ timelock, fromBlock, allowList }); }
  catch (e) { return [`Timelock pending operations could not be checked: ${e.shortMessage || e.message}`]; }
  const out = [];
  for (const id of pending) {
    let ready = "";
    try { ready = ` (executable by anyone from timestamp ${await timelock.getTimestamp(id)})`; } catch { /* the id alone is enough */ }
    out.push(`Timelock operation ${id} is scheduled and still pending${ready}: it survives the Safe losing PROPOSER. Cancel it (CANCELLER_ROLE) or, if it is expected, list it in TIMELOCK_ALLOWED_OPS_<NET>`);
  }
  return out;
}

// ── Where a revoked vault's unvested SRX goes (E-02, review E, 22 Oct 2026) ────────────

const TREASURY_ABI = ["function srxToken() view returns (address)"];
const REVOKE_VAULT_ABI = ["function revokeRecipient() view returns (address)"];
const GENESIS_REVOKE_ABI = [
  "function vaultRevokeRecipient() view returns (address)",
  "function getInvestorList() view returns (address[])",
  "function getVault(address) view returns (address)",
];

/**
 * ⛔ E-02. A VestingVault's `revokeRecipient` and PreSaleRound's `vaultRevokeRecipient` are
 *    immutable, and the documents promise they are the SRXTreasury. The deploy scripts used to
 *    fall back to the WALLET_TREASURY wallet because the Treasury was deployed too late, and
 *    nothing checked the result. Every launch vault, the Genesis contract and (where the
 *    buyers' vaults exist) every Genesis buyer's vault must name the SRXTreasury CONTRACT.
 *
 * @param provider      an ethers provider
 * @param treasury      TREASURY_<NET>, the SRXTreasury address
 * @param tokenAddress  the launch token (the treasury's srxToken() must be this)
 * @param vaults        [{ label, address }] launch vaults
 * @param genesisRound  the PreSaleRound address, or null when there is no Genesis round
 * @returns {{ failures: string[], checked: number }}
 */
async function checkRevokeRecipients({ provider, treasury, tokenAddress, vaults = [], genesisRound = null }) {
  const failures = [];
  let checked = 0;
  let T;
  try { T = ethers.getAddress(treasury); }
  catch { return { failures: [`TREASURY is not set to a valid address (${treasury}), so no revokeRecipient can be checked`], checked: 1 }; }

  checked++;
  if ((await provider.getCode(T)) === "0x") {
    failures.push(`SRXTreasury ${T} has no code: it is not a contract`);
  } else {
    try {
      const t = await new ethers.Contract(T, TREASURY_ABI, provider).srxToken();
      if (tokenAddress && ethers.getAddress(t) !== ethers.getAddress(tokenAddress)) {
        failures.push(`SRXTreasury ${T} belongs to SRX ${ethers.getAddress(t)}, not the launch token ${ethers.getAddress(tokenAddress)}`);
      }
    } catch { failures.push(`${T} does not answer as an SRXTreasury (no srxToken())`); }
  }

  const describe = async (a) => ((await provider.getCode(a)) === "0x" ? "an address with NO CODE, i.e. a plain wallet" : "a contract that is not the SRXTreasury");
  const verdict = async (label, got) => {
    checked++;
    if (ethers.getAddress(got) !== T) {
      failures.push(`${label}: revokeRecipient is ${ethers.getAddress(got)} (${await describe(got)}), expected the SRXTreasury ${T}; ` +
        "it is immutable, so a revoked vault's unvested SRX would go there and no Timelock rule could ever move it");
    }
  };

  for (const v of vaults) {
    try { await verdict(v.label, await new ethers.Contract(v.address, REVOKE_VAULT_ABI, provider).revokeRecipient()); }
    catch { checked++; failures.push(`${v.label}: ${v.address} does not answer revokeRecipient()`); }
  }

  if (genesisRound) {
    const round = new ethers.Contract(genesisRound, GENESIS_REVOKE_ABI, provider);
    let presaleRecipient = null;
    try { presaleRecipient = await round.vaultRevokeRecipient(); }
    catch { checked++; failures.push(`PreSaleRound ${genesisRound} does not answer vaultRevokeRecipient()`); }
    if (presaleRecipient) await verdict("PreSaleRound (Genesis) vaultRevokeRecipient", presaleRecipient);
    // The buyers' vaults exist only after 06b; each one is checked as soon as it does.
    let investors = [];
    try { investors = await round.getInvestorList(); } catch { /* an unanswering contract was reported above */ }
    for (const investor of investors) {
      const vault = await round.getVault(investor);
      if (vault === ethers.ZeroAddress) continue;
      try { await verdict(`Genesis buyer vault ${vault}`, await new ethers.Contract(vault, REVOKE_VAULT_ABI, provider).revokeRecipient()); }
      catch { checked++; failures.push(`Genesis buyer vault ${vault} does not answer revokeRecipient()`); }
    }
  }
  return { failures, checked };
}

// ── The distributor that launches is the one staking and the fund were built for (E-01) ──

const BOUND_DISTRIBUTOR_ABI = ["function tgeDistributor() view returns (address)"];
const DISTRIBUTOR_ABI = ["function token() view returns (address)"];

/**
 * ⛔ E-01. SRXStaking and StabilisationFund fix the TGEDistributor they were deployed
 *    against, immutably, as the only source of their reward backing (REG-50). 03 deploys a
 *    NEW distributor on every run, and the runbook prescribes a re-run after a refund; if
 *    04 / 05b already ran, 06 would launch through a distributor they never trust. The 1.7B
 *    staking allocation then arrives and can never back a reward, and the fund can deploy
 *    no SRX at all. Nothing compared the three addresses.
 *
 * @param provider       an ethers provider
 * @param tgeDistributor TGE_DISTRIBUTOR_<NET>, the distributor 06 will launch through
 * @param tokenAddress   the launch token (the distributor's token() must be this)
 * @param targets        [{ label, address, rerun }] contracts bound to a distributor
 * @returns {{ failures: string[], checked: number }}
 */
async function checkDistributorWiring({ provider, tgeDistributor, tokenAddress, targets = [] }) {
  const failures = [];
  let checked = 0;
  let D;
  try { D = ethers.getAddress(tgeDistributor); }
  catch {
    return { failures: [`TGE_DISTRIBUTOR is not set to a valid address (${tgeDistributor}), so it cannot be confirmed that staking and the Stabilisation Fund were built for the distributor that launches`], checked: 1 };
  }
  checked++;
  if ((await provider.getCode(D)) === "0x") {
    failures.push(`TGEDistributor ${D} has no code: it is not a contract`);
  } else if (tokenAddress) {
    try {
      const t = await new ethers.Contract(D, DISTRIBUTOR_ABI, provider).token();
      if (ethers.getAddress(t) !== ethers.getAddress(tokenAddress)) failures.push(`TGEDistributor ${D} distributes ${ethers.getAddress(t)}, not the launch token ${ethers.getAddress(tokenAddress)}`);
    } catch { failures.push(`${D} does not answer as a TGEDistributor (no token())`); }
  }
  for (const t of targets) {
    checked++;
    let bound;
    try { bound = ethers.getAddress(await new ethers.Contract(t.address, BOUND_DISTRIBUTOR_ABI, provider).tgeDistributor()); }
    catch { failures.push(`${t.label} ${t.address} does not answer tgeDistributor()`); continue; }
    if (bound !== D) {
      failures.push(`${t.label} ${t.address}: tgeDistributor() is ${bound}, but the distributor that launches is ${D}. It counts rewards only from the ` +
        `distributor it was deployed against (immutable), so launching through ${D} would strand its allocation. Re-run ${t.rerun || "its deploy step"} against ${D}`);
    }
  }
  return { failures, checked };
}

// ── Who can propose to, and cancel on, the Timelock; and what the Governor is wired to (E-03) ──

const GOVERNOR_ABI = [
  "function timelock() view returns (address)",
  "function token() view returns (address)",
];

/**
 * The deployment-block rule, shared by every check that replays a contract's events:
 * an absence check that cannot look is not a pass.
 * Throws if `fromBlock` is missing or later than the contract's deployment.
 */
async function requireDeployBlock({ provider, address, fromBlock, envName }) {
  if (fromBlock === undefined || fromBlock === null || !Number.isInteger(Number(fromBlock)) || Number(fromBlock) < 0) {
    throw new Error(`the deployment block of ${address} was not provided, so its events cannot be read from the start: set ${envName}`);
  }
  const from = Number(fromBlock);
  if (from > 0 && (await provider.getCode(address, from - 1)) !== "0x") {
    throw new Error(`${envName} ${from} is after ${address} was deployed (it already has code at block ${from - 1}); grants made before it would be missed. Use the deployment block`);
  }
  return from;
}

/**
 * Every current holder of `role` on an OpenZeppelin AccessControl contract, rebuilt from its
 * RoleGranted / RoleRevoked events from the deployment block (these contracts are not
 * AccessControlEnumerable, so there is no other way to list them), and each confirmed with
 * hasRole(), which is the source of truth.
 */
async function roleHoldersFromEvents({ contract, role, fromBlock, envName = "TIMELOCK_DEPLOY_BLOCK_<NET>" }) {
  const provider = contract.runner.provider || contract.runner;
  const from = await requireDeployBlock({ provider, address: await contract.getAddress(), fromBlock, envName });
  const [granted, revoked] = await Promise.all([
    contract.queryFilter(contract.filters.RoleGranted(role), from),
    contract.queryFilter(contract.filters.RoleRevoked(role), from),
  ]);
  const everHeld = new Set([...granted, ...revoked].map((e) => ethers.getAddress(e.args.account)));
  const holders = [];
  for (const account of everHeld) if (await contract.hasRole(role, account)) holders.push(account);
  return holders;
}

/**
 * ⛔ E-03. verify_roles asked "does the Governor hold PROPOSER" and "does the deployer / the
 *    Safe hold it", and nothing else. Any other address that holds PROPOSER_ROLE (or
 *    CANCELLER_ROLE) on the Timelock passed, so a single key could schedule any operation
 *    (after the delay) and the gate said "Governor only". The holders are now listed from the
 *    Timelock's own events and compared with the allowed set:
 *      PROPOSER_ROLE        exactly the Governor;
 *      CANCELLER_ROLE       the Governor and the admin Safe (its veto), nobody else;
 *      DEFAULT_ADMIN_ROLE   the Timelock itself only (whoever administers the roles can grant any of them).
 *
 * @returns {{ failures: string[], checked: number, holders: object }}
 */
async function checkTimelockRoleHolders({ timelock, fromBlock, governor, admin }) {
  const failures = [];
  const holders = {};
  const self = await timelock.getAddress();
  const rules = [
    { name: "PROPOSER_ROLE",      role: ethers.id("PROPOSER_ROLE"),  allowed: [governor],        describe: "the Governor only",                         power: "can schedule any operation" },
    { name: "CANCELLER_ROLE",     role: ethers.id("CANCELLER_ROLE"), allowed: [governor, admin], describe: "the Governor and the admin Safe (its veto)", power: "can cancel any operation" },
    { name: "DEFAULT_ADMIN_ROLE", role: ethers.ZeroHash,             allowed: [self],            describe: "the Timelock itself",                       power: "can grant itself any Timelock role" },
  ];
  let checked = 0;
  for (const rule of rules) {
    checked++;
    let found;
    try { found = await roleHoldersFromEvents({ contract: timelock, role: rule.role, fromBlock }); }
    catch (e) { failures.push(`Timelock ${rule.name} holders could not be listed: ${e.shortMessage || e.message}`); continue; }
    holders[rule.name] = found;
    const allowed = new Set(rule.allowed.filter(Boolean).map((a) => ethers.getAddress(a)));
    for (const h of found) {
      if (!allowed.has(h)) failures.push(`Timelock ${rule.name} is also held by ${h} (allowed: ${rule.describe}): it ${rule.power}`);
    }
  }
  return { failures, checked, holders };
}

/**
 * ⛔ E-03. The Governor the gate trusts is only an address from the environment. It must be a
 *    contract wired to THIS Timelock and THIS token: a single key (or a Governor of another
 *    deployment) in its place would hold PROPOSER and the gate would still say "Governor".
 */
async function checkGovernorWiring({ provider, governor, timelock, token }) {
  const failures = [];
  let checked = 1;
  if ((await provider.getCode(governor)) === "0x") {
    return { failures: [`GOVERNOR ${governor} has no code: the Timelock's proposer is not a Governor contract`], checked };
  }
  const g = new ethers.Contract(governor, GOVERNOR_ABI, provider);
  for (const [what, call, want] of [["timelock()", () => g.timelock(), timelock], ["token()", () => g.token(), token]]) {
    checked++;
    let got;
    try { got = await call(); } catch { failures.push(`GOVERNOR ${governor} does not answer ${what}: it is not an SRXGovernor`); continue; }
    if (ethers.getAddress(got) !== ethers.getAddress(want)) {
      failures.push(`GOVERNOR ${governor}: ${what} is ${ethers.getAddress(got)}, expected ${ethers.getAddress(want)}`);
    }
  }
  return { failures, checked };
}

// ── The holders the launch topology REQUIRES (E-04) ───────────────────────────

/**
 * ⛔ E-04. The matrix lists who must NOT hold a role, and for most roles who must. For two powers
 *    the Safe is meant to keep, it listed nobody: GuardianModule's GUARDIAN_ROLE (emergency pause)
 *    and the Timelock's CANCELLER_ROLE (the veto). MULTISIG_SPEC: "The admin Safe keeps exactly
 *    three powers on the core contracts: emergency pause, a veto, wind-down". A deployment where
 *    the Safe held neither passed the gate (its pause went to a different key, or its veto had been
 *    revoked, which 08 and the hand-over can both do). Wind-down is already required by the matrix.
 *
 * @returns {{ failures: string[], checked: number }}
 */
async function checkSafePowers({ timelock, guardian, admin }) {
  const failures = [];
  let checked = 0;
  const want = [
    { c: guardian, role: ethers.id("GUARDIAN_ROLE"),   what: "GuardianModule GUARDIAN_ROLE", why: "the Safe cannot pause the protocol in an emergency (MULTISIG_SPEC: emergency pause = the Safe, via GuardianModule)" },
    { c: timelock, role: ethers.id("CANCELLER_ROLE"),  what: "Timelock CANCELLER_ROLE",      why: "the Safe has lost its veto on a hostile proposal (MULTISIG_SPEC: the Safe keeps exactly three powers)" },
  ];
  for (const w of want) {
    checked++;
    if (!(await w.c.hasRole(w.role, admin))) failures.push(`the admin Safe ${ethers.getAddress(admin)} does not hold ${w.what}: ${w.why}`);
  }
  return { failures, checked };
}

/**
 * ⛔ E-04. 08 configures the bridge circuit breaker and grants CIRCUIT_BREAKER_ROLE to
 *    CIRCUIT_BREAKER_ADDRESS, which fell back to the admin Safe when unset. The gate required the
 *    breaker to be configured (CONTROL-10) but not that anyone could report to it: with the role held
 *    by nobody (or by a key nobody named) no bridge volume is ever reported and the breaker, though
 *    configured, can never trip. Once the breaker is configured the stated monitor must hold the role.
 *
 * @param monitor  CIRCUIT_BREAKER_ADDRESS_<NET>, or null when unset
 * @returns {{ failures: string[], checked: number }}
 */
async function checkCircuitBreakerMonitor({ guardian, monitor }) {
  const cb = await guardian.circuitBreakers(MODULE_BRIDGE);
  if (cb.volumeThreshold === 0n) return { failures: [], checked: 0 }; // unconfigured: checkGuardianWiring reports it
  if (!monitor) {
    return {
      failures: ["CIRCUIT_BREAKER_ADDRESS is not set while the bridge circuit breaker is configured: no address is known to hold CIRCUIT_BREAKER_ROLE, so nobody is known to be able to report bridge volume and the breaker may never trip"],
      checked: 1,
    };
  }
  const m = ethers.getAddress(monitor);
  if (!(await guardian.hasRole(ethers.id("CIRCUIT_BREAKER_ROLE"), m))) {
    return { failures: [`CIRCUIT_BREAKER_ADDRESS ${m} does not hold CIRCUIT_BREAKER_ROLE: nobody can report bridge volume, so the configured breaker can never trip`], checked: 1 };
  }
  return { failures: [], checked: 1 };
}

// ── The hub's peers: every chain it trusts is a declared chain at its declared address (E-05) ──

/**
 * Every chain the hub currently trusts, read from the token's own PeerSet events from its
 * deployment block (the peer table is a mapping, so there is no way to list it otherwise),
 * each confirmed with peers(eid), which is the source of truth. A peer set and later zeroed is
 * not a peer.
 * @returns {Promise<{ eid: number, peer: string }[]>}  peer is the bytes32 the hub holds
 */
async function hubPeersFromEvents({ token, fromBlock, envName = "SRX_TOKEN_DEPLOY_BLOCK_<NET>" }) {
  const provider = token.runner.provider || token.runner;
  const from = await requireDeployBlock({ provider, address: await token.getAddress(), fromBlock, envName });
  const events = await token.queryFilter(token.filters.PeerSet(), from);
  const eids = [...new Set(events.map((e) => Number(e.args.eid)))];
  const out = [];
  for (const eid of eids) {
    const peer = await token.peers(eid);
    if (peer !== ethers.ZeroHash) out.push({ eid, peer });
  }
  return out;
}

/**
 * ⛔ E-05. verify_roles checked the DVN configuration only of the chains in LZ_EIDS, and only
 *    where the hub had a peer. A peer on any OTHER endpoint id was never looked at: the hub would
 *    mint SRX on a message from a contract nobody declared, over whatever verifiers (the
 *    LayerZero default is one) that pathway had. Every non-zero peer must now be
 *      1. on a DECLARED chain (lib/bridgeEnv.js);
 *      2. exactly that chain's declared SRXOFTNative (SRX_OFT_NATIVE_<CHAIN>);
 *      3. and its pathway must pass the DVN check (own libraries, at least 2 DVNs each way,
 *         delivery gas enforced), whatever its endpoint id.
 *
 * @param token       the hub SRXToken
 * @param fromBlock   its deployment block (SRX_TOKEN_DEPLOY_BLOCK_<NET>)
 * @param declared    [{ eid, chain, envKey, address|null }] from bridgeEnv.declaredSpokes
 * @param extraEids   endpoint ids to check even if the event listing cannot be read (LZ_EIDS)
 * @param dvnCheck    async ({ eid, label }) => string[] — the pathway's DVN failures
 * @returns {{ failures: string[], checked: number, peers: { eid: number, peer: string }[] }}
 */
async function checkHubPeers({ token, fromBlock, declared = [], extraEids = [], dvnCheck, envName }) {
  const failures = [];
  let checked = 0;
  let peers = [];
  checked++;
  try { peers = await hubPeersFromEvents({ token, fromBlock, envName }); }
  catch (e) { failures.push(`the hub's peers could not be listed: ${e.shortMessage || e.message}`); }

  // The caller's known endpoint ids are checked even when the listing failed.
  const known = new Set(peers.map((p) => p.eid));
  for (const eid of extraEids) {
    if (known.has(Number(eid))) continue;
    const peer = await token.peers(eid);
    if (peer !== ethers.ZeroHash) { peers.push({ eid: Number(eid), peer }); known.add(Number(eid)); }
  }

  for (const { eid, peer } of peers) {
    const d = declared.find((x) => x.eid === eid);
    const label = d ? `hub <-> ${d.chain}` : `hub <-> EID ${eid}`;
    const trusted = ethers.getAddress(ethers.dataSlice(peer, 12));
    checked++;
    if (!d) {
      failures.push(`the hub trusts a peer on EID ${eid} (${trusted}), a chain that is not declared for this environment: it would mint SRX on a message from a contract nobody listed. Remove the peer (a Governor proposal) or declare the chain in lib/bridgeEnv.js`);
    } else if (!d.address) {
      failures.push(`the hub has a peer on ${d.chain} (EID ${eid}, ${trusted}) but ${d.envKey} is not set, so the peer cannot be compared with the declared contract`);
    } else if (ethers.zeroPadValue(ethers.getAddress(d.address), 32).toLowerCase() !== peer.toLowerCase()) {
      failures.push(`the hub's peer on ${d.chain} (EID ${eid}) is ${trusted}, not the declared ${d.envKey} ${ethers.getAddress(d.address)}`);
    }
    // The DVN configuration of EVERY peer, declared or not.
    if (dvnCheck) {
      checked++;
      failures.push(...await dvnCheck({ eid, label }));
    }
  }
  return { failures, checked, peers };
}

module.exports = {
  GUARDIAN_MODULES, MODULE_BRIDGE,
  checkGuardianWiring, pendingTimelockOps, checkNoPendingTimelockOps, parseOpList, parseBlock,
  checkRevokeRecipients, checkDistributorWiring,
  requireDeployBlock, roleHoldersFromEvents, checkTimelockRoleHolders, checkGovernorWiring,
  checkSafePowers, checkCircuitBreakerMonitor,
  hubPeersFromEvents, checkHubPeers,
};
