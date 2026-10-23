// Review E, 22 Oct 2026 (fixes): who the blocking role gate (verify_roles.js) lets through.
//
//  E-03  Timelock PROPOSER / CANCELLER holders were never listed, and GOVERNOR_<NET> was taken on trust.
//  E-04  The admin Safe's two powers (emergency pause, veto) and the circuit-breaker monitor were not required.
//  E-05  The hub's peers were checked only for the chains in a fixed list.
//  E-06  GUARDIAN_MULTISIG named two different roles in two scripts.
//
// The checking logic lives in lib modules and runs here against real contracts deployed in-process, so each
// test can be made to fail by breaking the thing it checks.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const {
  checkTimelockRoleHolders, checkGovernorWiring, roleHoldersFromEvents,
} = require("../../scripts/deploy/lib/gate_checks");

const ROOT = path.join(__dirname, "..", "..");
const src = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const NL = String.fromCharCode(10);
const rand = () => ethers.Wallet.createRandom().address;

/** The launch topology after the hand-over: Governor proposes and cancels, the Safe has its veto, the Timelock administers itself. */
async function governanceWorld() {
  const [deployer, safe, outsider, other] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), safe.address);
  const timelock = await (await ethers.getContractFactory("SRXTimelock")).deploy(60, [], [ethers.ZeroAddress], safe.address);
  const deployBlock = (await timelock.deploymentTransaction().wait()).blockNumber;
  const governor = await (await ethers.getContractFactory("SRXGovernor")).deploy(await token.getAddress(), await timelock.getAddress());
  const PROPOSER = await timelock.PROPOSER_ROLE();
  const CANCELLER = await timelock.CANCELLER_ROLE();
  await timelock.connect(safe).grantRole(PROPOSER, await governor.getAddress());
  await timelock.connect(safe).grantRole(CANCELLER, await governor.getAddress());
  await timelock.connect(safe).grantRole(CANCELLER, safe.address); // the veto
  await timelock.connect(safe).renounceRole(ethers.ZeroHash, safe.address); // phase 2: the Safe gives up Timelock admin
  return { deployer, safe, outsider, other, lz, token, timelock, governor, deployBlock, PROPOSER, CANCELLER };
}

// These groups run deploy scripts in a child `hardhat run`. Under coverage a child process
// rebuilds the project and the instrumented hit counts are lost (measured 23 Oct 2026: 87% with
// them, 96% without), so they are skipped there; they test the scripts, not the contracts.
const describeSpawning = require("hardhat").__SOLIDITY_COVERAGE_RUNNING ? describe.skip : describe;

describe("E-03: the Timelock's proposers and cancellers are listed, not assumed", function () {
  const run = (w, over = {}) => checkTimelockRoleHolders({
    timelock: w.timelock, fromBlock: w.deployBlock, governor: w.governor.target, admin: w.safe.address, ...over,
  });

  it("passes the launch topology: PROPOSER = Governor, CANCELLER = Governor + Safe, admin = the Timelock", async function () {
    const w = await governanceWorld();
    const r = await run(w);
    expect(r.failures).to.deep.equal([]);
    expect(r.checked).to.equal(3);
    expect(r.holders.PROPOSER_ROLE).to.deep.equal([ethers.getAddress(await w.governor.getAddress())]);
    expect(r.holders.CANCELLER_ROLE.sort()).to.deep.equal([ethers.getAddress(await w.governor.getAddress()), w.safe.address].sort());
    expect(r.holders.DEFAULT_ADMIN_ROLE).to.deep.equal([ethers.getAddress(await w.timelock.getAddress())]);
  });

  async function asTimelock(w, fn) {
    const a = await w.timelock.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [a]);
    await ethers.provider.send("hardhat_setBalance", [a, "0x56BC75E2D63100000"]);
    await fn(await ethers.getSigner(a));
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [a]);
  }

  it("fails on any PROPOSER other than the Governor (the reviewer's E-2d: a single key beside the Governor)", async function () {
    const w = await governanceWorld();
    // The Timelock administers itself, so such a grant arrives as the execution of a scheduled operation.
    await asTimelock(w, (tl) => w.timelock.connect(tl).grantRole(w.PROPOSER, w.outsider.address));
    const r = await run(w);
    expect(r.failures).to.have.length(1);
    expect(r.failures[0]).to.include(`PROPOSER_ROLE is also held by ${w.outsider.address}`);
    expect(r.failures[0]).to.match(/can schedule any operation/);
  });

  it("fails on any CANCELLER other than the Governor and the Safe", async function () {
    const w = await governanceWorld();
    await asTimelock(w, (tl) => w.timelock.connect(tl).grantRole(w.CANCELLER, w.outsider.address));
    const r = await run(w);
    expect(r.failures).to.have.length(1);
    expect(r.failures[0]).to.include(`CANCELLER_ROLE is also held by ${w.outsider.address}`);
  });

  it("fails on a second holder of the Timelock's admin role (who could grant itself PROPOSER)", async function () {
    const w = await governanceWorld();
    await asTimelock(w, (tl) => w.timelock.connect(tl).grantRole(ethers.ZeroHash, w.outsider.address));
    const r = await run(w);
    expect(r.failures.join(NL)).to.include(`DEFAULT_ADMIN_ROLE is also held by ${w.outsider.address}`);
  });

  it("does not fail for a holder who was granted and then revoked (the event history is replayed through hasRole)", async function () {
    const w = await governanceWorld();
    await asTimelock(w, async (tl) => {
      await w.timelock.connect(tl).grantRole(w.PROPOSER, w.outsider.address);
      await w.timelock.connect(tl).revokeRole(w.PROPOSER, w.outsider.address);
    });
    expect((await run(w)).failures).to.deep.equal([]);
  });

  it("fails the Safe's temporary PROPOSER if it was never revoked (the hand-over's phase 2)", async function () {
    const w = await governanceWorld();
    await asTimelock(w, (tl) => w.timelock.connect(tl).grantRole(w.PROPOSER, w.safe.address));
    expect((await run(w)).failures.join(NL)).to.include(`PROPOSER_ROLE is also held by ${w.safe.address}`);
  });

  it("an absence check that cannot look is not a pass: no block, or one after deployment, is a failure", async function () {
    const w = await governanceWorld();
    const none = await run(w, { fromBlock: null });
    expect(none.failures.join(NL)).to.match(/PROPOSER_ROLE holders could not be listed: the deployment block .* was not provided/);
    await ethers.provider.send("evm_mine", []);
    const late = await run(w, { fromBlock: w.deployBlock + 1 });
    expect(late.failures.join(NL)).to.match(/is after .* was deployed/);
    // and an earlier block is fine
    expect((await run(w, { fromBlock: 0 })).failures).to.deep.equal([]);
  });

  it("roleHoldersFromEvents lists exactly the holders hasRole confirms", async function () {
    const w = await governanceWorld();
    const holders = await roleHoldersFromEvents({ contract: w.timelock, role: w.CANCELLER, fromBlock: w.deployBlock });
    for (const h of holders) expect(await w.timelock.hasRole(w.CANCELLER, h)).to.equal(true);
    expect(holders).to.have.length(2);
  });

  describe("checkGovernorWiring", function () {
    it("passes a Governor wired to this Timelock and this token", async function () {
      const w = await governanceWorld();
      const r = await checkGovernorWiring({ provider: ethers.provider, governor: await w.governor.getAddress(), timelock: await w.timelock.getAddress(), token: await w.token.getAddress() });
      expect(r).to.deep.equal({ failures: [], checked: 3 });
    });

    it("fails a single key in the Governor's place (the reviewer's E-2e)", async function () {
      const w = await governanceWorld();
      const r = await checkGovernorWiring({ provider: ethers.provider, governor: w.outsider.address, timelock: await w.timelock.getAddress(), token: await w.token.getAddress() });
      expect(r.failures.join(NL)).to.match(/has no code: the Timelock's proposer is not a Governor contract/);
    });

    it("fails a contract that is not a Governor, and a Governor wired to another Timelock or another token", async function () {
      const w = await governanceWorld();
      const tl = await w.timelock.getAddress();
      const tk = await w.token.getAddress();
      const notGov = await checkGovernorWiring({ provider: ethers.provider, governor: tk, timelock: tl, token: tk });
      expect(notGov.failures.join(NL)).to.match(/does not answer timelock\(\): it is not an SRXGovernor/);

      const otherTl = await (await ethers.getContractFactory("SRXTimelock")).deploy(60, [], [ethers.ZeroAddress], w.safe.address);
      const wrongTl = await (await ethers.getContractFactory("SRXGovernor")).deploy(tk, await otherTl.getAddress());
      const r1 = await checkGovernorWiring({ provider: ethers.provider, governor: await wrongTl.getAddress(), timelock: tl, token: tk });
      expect(r1.failures.join(NL)).to.match(/timelock\(\) is .*, expected/);

      const otherTk = await (await ethers.getContractFactory("SRXToken")).deploy(await w.lz.getAddress(), w.safe.address);
      const wrongTk = await (await ethers.getContractFactory("SRXGovernor")).deploy(await otherTk.getAddress(), tl);
      const r2 = await checkGovernorWiring({ provider: ethers.provider, governor: await wrongTk.getAddress(), timelock: tl, token: tk });
      expect(r2.failures.join(NL)).to.match(/token\(\) is .*, expected/);
    });
  });

  it("verify_roles.js runs both checks (tripwire for the wiring; the rehearsal exercises them end to end)", function () {
    const s = src("scripts/verify/verify_roles.js");
    expect(s).to.match(/await checkGovernorWiring\(/);
    expect(s).to.match(/await checkTimelockRoleHolders\(/);
  });

  void rand;
});

// ── E-06 ─────────────────────────────────────────────────────────────────────

describeSpawning("E-06: one environment value names one role (GUARDIAN_MULTISIG is retired)", function () {
  this.timeout(120_000);
  const { retiredGuardianVariable, retiredGuardianMessage } = require("../../scripts/deploy/lib/launch_order");

  it("finds the retired variable, bare or network-suffixed, and ignores blanks", function () {
    expect(retiredGuardianVariable({}, "ethereum")).to.equal(null);
    expect(retiredGuardianVariable({ GUARDIAN_MULTISIG: "  " }, "ethereum")).to.equal(null);
    expect(retiredGuardianVariable({ GUARDIAN_MULTISIG: rand() }, "ethereum")).to.equal("GUARDIAN_MULTISIG");
    expect(retiredGuardianVariable({ GUARDIAN_MULTISIG_ETHEREUM: rand() }, "ethereum")).to.equal("GUARDIAN_MULTISIG_ETHEREUM");
    expect(retiredGuardianVariable({ GUARDIAN_MULTISIG_BSC: rand() }, "ethereum")).to.equal(null);
  });

  it("the message names both replacement variables and both roles", function () {
    const m = retiredGuardianMessage();
    expect(m).to.include("PAUSE_GUARDIAN");
    expect(m).to.include("SSF_GUARDIAN_MULTISIG");
    expect(m).to.match(/GuardianModule/);
    expect(m).to.match(/StabilisationFund/);
  });

  it("08_deploy_guardian.js refuses to run while GUARDIAN_MULTISIG is set, before anything is deployed or asked", function () {
    const r = runScript08({ GUARDIAN_MULTISIG: rand(), PAUSE_GUARDIAN: rand() });
    expect(r.code).to.not.equal(0);
    expect(r.out).to.match(/GUARDIAN_MULTISIG is retired/);
    expect(r.out).to.not.match(/About to|GuardianModule: 0x/);
  });

  it("08 reads PAUSE_GUARDIAN for GuardianModule's guardian; verify_roles reads SSF_GUARDIAN_MULTISIG for the fund's", function () {
    const s08 = src("scripts/deploy/08_deploy_guardian.js");
    const vr = src("scripts/verify/verify_roles.js");
    expect(s08).to.match(/requireAddressEnv\("PAUSE_GUARDIAN"/);
    expect(s08).to.not.match(/process\.env\.GUARDIAN_MULTISIG\b/);
    expect(vr).to.match(/envAddr\("SSF_GUARDIAN_MULTISIG"/);
    expect(vr).to.not.match(/envAddr\("GUARDIAN_MULTISIG"/);
    expect(src("scripts/verify/verify_all.js")).to.not.match(/process\.env\.GUARDIAN_MULTISIG\b/);
  });

  it("MULTISIG_SPEC.md has the variable table, with the two roles under two names", function () {
    const spec = src("MULTISIG_SPEC.md");
    expect(spec).to.match(/\| `PAUSE_GUARDIAN` \| `GUARDIAN_ROLE` on \*\*GuardianModule\*\*/);
    expect(spec).to.match(/\| `SSF_GUARDIAN_MULTISIG` \| `GUARDIAN_ROLE` on the \*\*StabilisationFund\*\*/);
    expect(spec).to.match(/`GUARDIAN_MULTISIG` is \*\*retired\*\*/);
  });
});

function runScript08(env) {
  const { spawnSync } = require("child_process");
  const clean = { ...process.env };
  delete clean.HARDHAT_NETWORK;
  const a = rand();
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "hardhat", "internal", "cli", "cli.js"), "run", "scripts/deploy/08_deploy_guardian.js", "--network", "hardhat"], {
    cwd: ROOT, encoding: "utf8", input: "no\n", maxBuffer: 32 * 1024 * 1024,
    env: {
      ...clean, SRX_TOKEN_HARDHAT: a, TIMELOCK_HARDHAT: a, STAKING_HARDHAT: a, FEE_CONTROLLER_HARDHAT: a, TREASURY_HARDHAT: a, STABILISATION_FUND_HARDHAT: a,
      PAUSE_GUARDIAN: "", GUARDIAN_MULTISIG: "", CIRCUIT_BREAKER_ADDRESS: "", ...env,
    },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// ── E-04 ─────────────────────────────────────────────────────────────────────

describeSpawning("E-04: the holders the topology requires, and no defaulting of them to the Safe", function () {
  this.timeout(120_000);
  const { checkSafePowers, checkCircuitBreakerMonitor, GUARDIAN_MODULES } = require("../../scripts/deploy/lib/gate_checks");
  const { requireAddressEnv } = require("../../scripts/deploy/lib/launch_order");
  const E = (n) => ethers.parseUnits(String(n), 18);

  async function powersWorld({ guardian = "safe", safeVeto = true, breaker = true } = {}) {
    const w = await governanceWorld();
    const [, , , , , monitor, governance] = await ethers.getSigners();
    const gm = await (await ethers.getContractFactory("GuardianModule")).deploy(
      w.safe.address, guardian === "safe" ? w.safe.address : w.other.address, governance.address, 90 * 86400);
    for (const m of GUARDIAN_MODULES) await gm.connect(governance).registerModule(m.id, rand());
    if (breaker) await gm.connect(governance).configureCircuitBreaker(GUARDIAN_MODULES[1].id, E(1_000_000), 3600);
    if (!safeVeto) {
      const a = await w.timelock.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [a]);
      await ethers.provider.send("hardhat_setBalance", [a, "0x56BC75E2D63100000"]);
      await w.timelock.connect(await ethers.getSigner(a)).revokeRole(w.CANCELLER, w.safe.address);
    }
    return { ...w, gm, monitor };
  }

  describe("checkSafePowers (the Safe keeps its emergency pause and its veto)", function () {
    it("passes when the Safe is GuardianModule's guardian and holds the Timelock's CANCELLER_ROLE", async function () {
      const w = await powersWorld();
      expect(await checkSafePowers({ timelock: w.timelock, guardian: w.gm, admin: w.safe.address })).to.deep.equal({ failures: [], checked: 2 });
    });

    it("fails when the guardian is another key (the reviewer's E-2b: the gate passed a deployment where the Safe could not pause)", async function () {
      const w = await powersWorld({ guardian: "other" });
      const r = await checkSafePowers({ timelock: w.timelock, guardian: w.gm, admin: w.safe.address });
      expect(r.failures).to.have.length(1);
      expect(r.failures[0]).to.match(/does not hold GuardianModule GUARDIAN_ROLE: the Safe cannot pause/);
    });

    it("fails when the Safe has lost its veto (the reviewer's E-2c)", async function () {
      const w = await powersWorld({ safeVeto: false });
      const r = await checkSafePowers({ timelock: w.timelock, guardian: w.gm, admin: w.safe.address });
      expect(r.failures).to.have.length(1);
      expect(r.failures[0]).to.match(/does not hold Timelock CANCELLER_ROLE: the Safe has lost its veto/);
    });
  });

  describe("checkCircuitBreakerMonitor (a configured breaker needs someone who can report to it)", function () {
    it("says nothing when the breaker is not configured (the wiring check reports that)", async function () {
      const w = await powersWorld({ breaker: false });
      expect(await checkCircuitBreakerMonitor({ guardian: w.gm, monitor: null })).to.deep.equal({ failures: [], checked: 0 });
    });

    it("fails when the breaker is configured and no monitor address is stated", async function () {
      const w = await powersWorld();
      const r = await checkCircuitBreakerMonitor({ guardian: w.gm, monitor: null });
      expect(r.failures.join(NL)).to.match(/CIRCUIT_BREAKER_ADDRESS is not set while the bridge circuit breaker is configured/);
    });

    it("fails when the stated monitor does not hold CIRCUIT_BREAKER_ROLE (the reviewer's E-2f), and passes once it does", async function () {
      const w = await powersWorld();
      const bad = await checkCircuitBreakerMonitor({ guardian: w.gm, monitor: w.monitor.address });
      expect(bad.failures.join(NL)).to.match(/does not hold CIRCUIT_BREAKER_ROLE: nobody can report bridge volume/);
      await w.gm.connect(w.safe).grantRole(await w.gm.CIRCUIT_BREAKER_ROLE(), w.monitor.address);
      expect(await checkCircuitBreakerMonitor({ guardian: w.gm, monitor: w.monitor.address })).to.deep.equal({ failures: [], checked: 1 });
    });
  });

  describe("08 states both holders, with no default", function () {
    it("requireAddressEnv refuses unset, blank, zero and malformed values, and returns a checksummed address", function () {
      expect(() => requireAddressEnv("PAUSE_GUARDIAN", { env: {}, what: "x" })).to.throw(/PAUSE_GUARDIAN is not set[\s\S]*no default/);
      expect(() => requireAddressEnv("PAUSE_GUARDIAN", { env: { PAUSE_GUARDIAN: "  " }, what: "x" })).to.throw(/is not set/);
      expect(() => requireAddressEnv("PAUSE_GUARDIAN", { env: { PAUSE_GUARDIAN: ethers.ZeroAddress }, what: "x" })).to.throw(/zero address/);
      expect(() => requireAddressEnv("PAUSE_GUARDIAN", { env: { PAUSE_GUARDIAN: "0x12" }, what: "x" })).to.throw(/not a valid checksummed/);
      const a = rand();
      expect(requireAddressEnv("PAUSE_GUARDIAN", { env: { PAUSE_GUARDIAN: a.toLowerCase() }, what: "x" })).to.equal(a);
    });

    it("08_deploy_guardian.js refuses to run when either holder is unset, and its source has no WALLETS.admin default", function () {
      for (const unset of ["PAUSE_GUARDIAN", "CIRCUIT_BREAKER_ADDRESS"]) {
        const r = runScript08({ PAUSE_GUARDIAN: rand(), CIRCUIT_BREAKER_ADDRESS: rand(), [unset]: "" });
        expect(r.code, unset).to.not.equal(0);
        expect(r.out, unset).to.match(new RegExp(unset + " is not set[\\s\\S]*no default"));
      }
      const s = src("scripts/deploy/08_deploy_guardian.js");
      expect(s).to.not.match(/process\.env\.(PAUSE_GUARDIAN|CIRCUIT_BREAKER_ADDRESS)\s*\|\|/);
    });
  });

  it("verify_roles.js requires the Safe's powers and the monitor (tripwire; the rehearsal exercises them end to end)", function () {
    const s = src("scripts/verify/verify_roles.js");
    expect(s).to.match(/await checkSafePowers\(/);
    expect(s).to.match(/await checkCircuitBreakerMonitor\(/);
  });
});

// ── E-05 ─────────────────────────────────────────────────────────────────────

describe("E-05: every peer the hub has is a declared chain at its declared contract, and gets the DVN check", function () {
  this.timeout(120_000);
  const { checkHubPeers, hubPeersFromEvents } = require("../../scripts/deploy/lib/gate_checks");
  const { declaredSpokes, environmentOf } = require("../../scripts/deploy/lib/bridgeEnv");
  const { LZ_EIDS } = require("../../scripts/deploy/00_config");
  const pad = (a) => ethers.zeroPadValue(a, 32);

  async function hubWorld() {
    const [safe, other] = await ethers.getSigners();
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), safe.address);
    const deployBlock = (await token.deploymentTransaction().wait()).blockNumber;
    return { safe, other, token, deployBlock };
  }
  const bsc = (address) => ({ eid: LZ_EIDS.bsc, chain: "bsc", envKey: "SRX_OFT_NATIVE_BSC", address });
  /** A DVN check that records which pathways it was asked about. */
  const spy = (failuresFor = {}) => {
    const asked = [];
    const fn = async ({ eid, label }) => { asked.push({ eid, label }); return failuresFor[eid] || []; };
    fn.asked = asked;
    return fn;
  };

  describe("hubPeersFromEvents", function () {
    it("lists the peers that are set now, not ones set and then removed", async function () {
      const w = await hubWorld();
      await w.token.connect(w.safe).setPeer(30102, pad(rand()));
      await w.token.connect(w.safe).setPeer(30110, pad(rand()));
      await w.token.connect(w.safe).setPeer(30110, ethers.ZeroHash);
      const peers = await hubPeersFromEvents({ token: w.token, fromBlock: w.deployBlock });
      expect(peers.map((p) => p.eid)).to.deep.equal([30102]);
    });

    it("cannot look without the deployment block, or from after it: that is a failure, not a pass", async function () {
      const w = await hubWorld();
      await expect(hubPeersFromEvents({ token: w.token, fromBlock: null })).to.be.rejectedWith(/deployment block .* was not provided/);
      await ethers.provider.send("evm_mine", []);
      await expect(hubPeersFromEvents({ token: w.token, fromBlock: w.deployBlock + 1 })).to.be.rejectedWith(/is after .* was deployed/);
    });
  });

  describe("checkHubPeers", function () {
    it("passes a hub with no peers, and one peered to the declared spoke (and asks the DVN check about it)", async function () {
      const w = await hubWorld();
      const spoke = rand();
      const none = spy();
      const r0 = await checkHubPeers({ token: w.token, fromBlock: w.deployBlock, declared: [bsc(spoke)], dvnCheck: none });
      expect(r0.failures).to.deep.equal([]);
      expect(none.asked).to.deep.equal([]);

      await w.token.connect(w.safe).setPeer(LZ_EIDS.bsc, pad(spoke));
      const dvn = spy();
      const r1 = await checkHubPeers({ token: w.token, fromBlock: w.deployBlock, declared: [bsc(spoke)], dvnCheck: dvn });
      expect(r1.failures).to.deep.equal([]);
      expect(dvn.asked).to.deep.equal([{ eid: LZ_EIDS.bsc, label: "hub <-> bsc" }]);
    });

    it("fails a peer on a chain that is not declared (the reviewer's E-2a, EID 30110) and STILL runs the DVN check on it", async function () {
      const w = await hubWorld();
      await w.token.connect(w.safe).setPeer(30110, pad(w.other.address));
      const dvn = spy({ 30110: ["hub <-> EID 30110 send: uses the endpoint's default send library"] });
      const r = await checkHubPeers({ token: w.token, fromBlock: w.deployBlock, declared: [bsc(rand())], dvnCheck: dvn });
      expect(dvn.asked).to.deep.equal([{ eid: 30110, label: "hub <-> EID 30110" }]); // not only the LZ_EIDS list
      expect(r.failures).to.have.length(2);
      expect(r.failures[0]).to.match(/the hub trusts a peer on EID 30110 \(0x[0-9a-fA-F]{40}\), a chain that is not declared/);
      expect(r.failures[1]).to.match(/default send library/);
    });

    it("fails a peer on a declared chain at an address other than the declared contract", async function () {
      const w = await hubWorld();
      const declared = rand();
      await w.token.connect(w.safe).setPeer(LZ_EIDS.bsc, pad(w.other.address));
      const r = await checkHubPeers({ token: w.token, fromBlock: w.deployBlock, declared: [bsc(declared)], dvnCheck: spy() });
      expect(r.failures).to.have.length(1);
      expect(r.failures[0]).to.match(/the hub's peer on bsc \(EID \d+\) is 0x[0-9a-fA-F]{40}, not the declared SRX_OFT_NATIVE_BSC/);
    });

    it("fails a peer on a declared chain whose contract address is not stated", async function () {
      const w = await hubWorld();
      await w.token.connect(w.safe).setPeer(LZ_EIDS.bsc, pad(w.other.address));
      const r = await checkHubPeers({ token: w.token, fromBlock: w.deployBlock, declared: [bsc(null)], dvnCheck: spy() });
      expect(r.failures.join(NL)).to.match(/SRX_OFT_NATIVE_BSC is not set/);
    });

    it("passes on the DVN check's own failures for a declared peer", async function () {
      const w = await hubWorld();
      const spoke = rand();
      await w.token.connect(w.safe).setPeer(LZ_EIDS.bsc, pad(spoke));
      const r = await checkHubPeers({ token: w.token, fromBlock: w.deployBlock, declared: [bsc(spoke)], dvnCheck: spy({ [LZ_EIDS.bsc]: ["one DVN only"] }) });
      expect(r.failures).to.deep.equal(["one DVN only"]);
    });

    it("without the deployment block the peers cannot be listed (a failure), but the known endpoint ids are still checked", async function () {
      const w = await hubWorld();
      const spoke = rand();
      await w.token.connect(w.safe).setPeer(LZ_EIDS.bsc, pad(spoke));
      const dvn = spy();
      const r = await checkHubPeers({ token: w.token, fromBlock: null, declared: [bsc(spoke)], extraEids: Object.values(LZ_EIDS), dvnCheck: dvn, envName: "SRX_TOKEN_DEPLOY_BLOCK_ETHEREUM" });
      expect(r.failures).to.have.length(1);
      expect(r.failures[0]).to.match(/the hub's peers could not be listed: .* set SRX_TOKEN_DEPLOY_BLOCK_ETHEREUM/);
      expect(dvn.asked.map((a) => a.eid)).to.deep.equal([LZ_EIDS.bsc]);
    });
  });

  describe("the declared chains", function () {
    it("come from one list shared by 07 and the gate, per environment", function () {
      const env = { SRX_OFT_NATIVE_BSC: "0x1111111111111111111111111111111111111111", SRX_OFT_NATIVE_ZKSYNC: "none" };
      const eth = declaredSpokes("ethereum", env);
      expect(eth.map((s) => [s.chain, s.eid, s.address])).to.deep.equal([
        ["bsc", LZ_EIDS.bsc, "0x1111111111111111111111111111111111111111"], ["zkSync", LZ_EIDS.zkSync, null],
      ]);
      expect(declaredSpokes("sepolia", {}).map((s) => s.chain)).to.deep.equal(["bscTestnet", "zkSyncSepolia"]);
      expect(declaredSpokes("localhost", env)).to.deep.equal([]); // a rehearsal chain declares no spokes: any peer there is a failure
      expect(environmentOf("bsc").role).to.equal("spoke");
      expect(src("scripts/deploy/07_deploy_bridge.js")).to.include('require("./lib/bridgeEnv")');
      expect(src("scripts/deploy/07_deploy_bridge.js")).to.not.match(/const ENVIRONMENTS = \{/);
    });

    it("verify_roles.js lists the peers (not the fixed LZ_EIDS walk)", function () {
      const s = src("scripts/verify/verify_roles.js");
      expect(s).to.match(/await checkHubPeers\(/);
      expect(s).to.match(/SRX_TOKEN_DEPLOY_BLOCK_/);
      expect(s).to.not.match(/for \(const \[name, eid\] of Object\.entries\(LZ_EIDS\)\)/);
    });
  });
});
