// Internal audit 16 Oct 2026, CONTROL-10 / CONTROL-05 / CONTROL-08: the blocking launch gate
// (verify_roles.js) and the circuit-breaker monitor passed or counted too little.
//
//  CONTROL-10  roles all right, but a Guardian module unregistered or pointing at the wrong
//              contract, or the bridge breaker never configured (reports then do nothing).
//  CONTROL-05  an operation the Safe scheduled while it was a temporary Timelock PROPOSER
//              survives the revoke; hasRole() cannot see it.
//  CONTROL-08  the monitor counted OFTSent (leaving) only, not OFTReceived (returns).
//
// The checking logic lives in lib modules and runs here against real contracts deployed
// in-process, so each test can be made to fail by breaking the thing it checks.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  GUARDIAN_MODULES, checkGuardianWiring, pendingTimelockOps, checkNoPendingTimelockOps, parseOpList, parseBlock,
} = require("../../scripts/deploy/lib/gate_checks");
const {
  OFT_SENT_TOPIC, OFT_RECEIVED_TOPIC, OFT_EVENTS_ABI, bridgeActivityFromLog,
} = require("../../scripts/ops/lib/bridge_events");

const E = (n) => ethers.parseUnits(String(n), 18);

// ── Task 1: Guardian registry and breaker ────────────────────────────────────

describe("Launch gate: GuardianModule registry and bridge breaker (CONTROL-10)", function () {
  async function setup({ skip = [], override = {}, configureBreaker = true } = {}) {
    const [admin, guardianMs, governance, token, staking, fee, treasury, ssf, stranger] = await ethers.getSigners();
    const gm = await (await ethers.getContractFactory("GuardianModule"))
      .deploy(admin.address, guardianMs.address, governance.address, 90 * 86400);
    const target = { token: token.address, staking: staking.address, fee: fee.address, treasury: treasury.address, ssf: ssf.address };
    for (const m of GUARDIAN_MODULES) {
      if (skip.includes(m.label)) continue;
      const to = override[m.label] || target[m.expects];
      await gm.connect(governance).registerModule(m.id, to);
    }
    // the contract only lets a registered module have a breaker
    if (configureBreaker && !skip.includes("MODULE_BRIDGE")) await gm.connect(governance).configureCircuitBreaker(GUARDIAN_MODULES[1].id, E(1_000_000), 3600);
    return { gm, governance, expected: target, stranger };
  }

  it("the gate's module ids are the contract's own constants (so the check looks at the real ids)", async function () {
    const { gm } = await setup();
    const own = {
      MODULE_TOKEN: await gm.MODULE_TOKEN(), MODULE_BRIDGE: await gm.MODULE_BRIDGE(), MODULE_STAKING: await gm.MODULE_STAKING(),
      MODULE_FEE: await gm.MODULE_FEE(), MODULE_TREASURY: await gm.MODULE_TREASURY(), MODULE_SSF: await gm.MODULE_SSF(),
    };
    expect(GUARDIAN_MODULES).to.have.length(6);
    for (const m of GUARDIAN_MODULES) expect(m.id, m.label).to.equal(own[m.label]);
  });

  it("passes when all six modules are registered to the right contracts and the breaker is configured", async function () {
    const { gm, expected } = await setup();
    expect(await checkGuardianWiring({ guardian: gm, expected })).to.deep.equal([]);
  });

  for (const m of GUARDIAN_MODULES) {
    it(`fails when ${m.label} is not registered, and names it`, async function () {
      const { gm, expected } = await setup({ skip: [m.label] });
      const failures = await checkGuardianWiring({ guardian: gm, expected });
      // an unregistered bridge cannot have a breaker either, so that case reports it too
      expect(failures).to.have.length(m.label === "MODULE_BRIDGE" ? 3 : 1);
      expect(failures[0]).to.include(`${m.label} is not registered`);
    });
  }

  it("fails when a module is registered to the wrong target, for each module that has a distinct target", async function () {
    for (const m of GUARDIAN_MODULES) {
      const { gm, expected, stranger } = await setup({ override: { [m.label]: (await ethers.getSigners())[8].address } });
      const failures = await checkGuardianWiring({ guardian: gm, expected });
      expect(failures, m.label).to.have.length(1);
      expect(failures[0], m.label).to.include(`${m.label} is registered to ${stranger.address}`);
    }
  });

  it("fails when MODULE_BRIDGE is registered to the staking contract (right module, wrong place)", async function () {
    const { gm, expected } = await setup({ override: { MODULE_BRIDGE: (await ethers.getSigners())[4].address } });
    const failures = await checkGuardianWiring({ guardian: gm, expected });
    expect(failures).to.have.length(1);
    expect(failures[0]).to.match(/MODULE_BRIDGE is registered to .*expected/);
  });

  it("fails when the bridge circuit breaker was never configured", async function () {
    const { gm, expected } = await setup({ configureBreaker: false });
    const failures = await checkGuardianWiring({ guardian: gm, expected });
    expect(failures).to.have.length(2); // threshold and window are both zero
    expect(failures.join("\n")).to.include("volumeThreshold is 0").and.to.include("windowDuration is 0");
  });

  it("fails when an expected target was not supplied, rather than skipping the module", async function () {
    const { gm, expected } = await setup();
    const failures = await checkGuardianWiring({ guardian: gm, expected: { ...expected, ssf: undefined } });
    expect(failures).to.have.length(1);
    expect(failures[0]).to.include("MODULE_SSF");
  });

  it("fails (does not throw, does not pass) when the address is not a GuardianModule", async function () {
    const [, , , , , , , , stranger] = await ethers.getSigners();
    const notGm = await ethers.getContractAt("GuardianModule", stranger.address); // an EOA
    const failures = await checkGuardianWiring({ guardian: notGm, expected: { token: stranger.address, staking: stranger.address, fee: stranger.address, treasury: stranger.address, ssf: stranger.address } });
    expect(failures.length).to.be.gte(7); // six modules and the breaker
  });
});

// ── Task 2: Timelock operations that survive the hand-over ──────────────────

describe("Launch gate: pending Timelock operations (CONTROL-05)", function () {
  const DELAY = 3600;
  async function setup() {
    const [admin, safe, governor, target] = await ethers.getSigners();
    const tl = await (await ethers.getContractFactory("SRXTimelock"))
      .deploy(DELAY, [governor.address], [ethers.ZeroAddress], admin.address);
    const fromBlock = (await tl.deploymentTransaction().wait()).blockNumber;
    // The temporary setup state: the Safe is a PROPOSER and a CANCELLER.
    const PROPOSER = await tl.PROPOSER_ROLE(), CANCELLER = await tl.CANCELLER_ROLE();
    await tl.connect(admin).grantRole(PROPOSER, safe.address);
    await tl.connect(admin).grantRole(CANCELLER, safe.address);
    let n = 0;
    // Schedules a harmless call (empty data to an EOA) under a fresh salt; returns its id.
    const schedule = async (who = safe) => {
      const salt = ethers.id(`op-${n++}`);
      await tl.connect(who).schedule(target.address, 0, "0x", ethers.ZeroHash, salt, DELAY);
      return { id: await tl.hashOperation(target.address, 0, "0x", ethers.ZeroHash, salt), salt };
    };
    return { tl, fromBlock, safe, admin, target, schedule, PROPOSER };
  }

  it("passes when nothing was ever scheduled", async function () {
    const { tl, fromBlock } = await setup();
    expect(await pendingTimelockOps({ timelock: tl, fromBlock })).to.deep.equal([]);
    expect(await checkNoPendingTimelockOps({ timelock: tl, fromBlock })).to.deep.equal([]);
  });

  it("fails on an operation scheduled in the setup window and left pending, reporting its id", async function () {
    const { tl, fromBlock, schedule } = await setup();
    const { id } = await schedule();
    expect(await pendingTimelockOps({ timelock: tl, fromBlock })).to.deep.equal([id]);
    const failures = await checkNoPendingTimelockOps({ timelock: tl, fromBlock });
    expect(failures).to.have.length(1);
    expect(failures[0]).to.include(id);
  });

  it("still fails after the Safe's PROPOSER is revoked: that is the hole hasRole() cannot see", async function () {
    const { tl, fromBlock, safe, admin, schedule, PROPOSER } = await setup();
    const { id } = await schedule();
    await tl.connect(admin).revokeRole(PROPOSER, safe.address);
    expect(await tl.hasRole(PROPOSER, safe.address)).to.equal(false);
    expect(await pendingTimelockOps({ timelock: tl, fromBlock })).to.deep.equal([id]);
    // ...and once the delay has passed anyone can run it.
    await time.increase(DELAY + 1);
    expect(await tl.isOperationReady(id)).to.equal(true);
  });

  it("passes once the operation has been executed", async function () {
    const { tl, fromBlock, target, schedule } = await setup();
    const { id, salt } = await schedule();
    await time.increase(DELAY + 1);
    await tl.execute(target.address, 0, "0x", ethers.ZeroHash, salt); // anyone may
    expect(await tl.isOperationDone(id)).to.equal(true);
    expect(await pendingTimelockOps({ timelock: tl, fromBlock })).to.deep.equal([]);
  });

  it("passes once the operation has been cancelled", async function () {
    const { tl, fromBlock, safe, schedule } = await setup();
    const { id } = await schedule();
    await tl.connect(safe).cancel(id);
    expect(await pendingTimelockOps({ timelock: tl, fromBlock })).to.deep.equal([]);
  });

  it("fails again if a cancelled operation is scheduled afresh (same id)", async function () {
    const { tl, fromBlock, safe, target, schedule } = await setup();
    const { id, salt } = await schedule();
    await tl.connect(safe).cancel(id);
    await tl.connect(safe).schedule(target.address, 0, "0x", ethers.ZeroHash, salt, DELAY);
    expect(await pendingTimelockOps({ timelock: tl, fromBlock })).to.deep.equal([id]);
  });

  it("passes when the pending operation is on the allow-list (any letter case), and only that one", async function () {
    const { tl, fromBlock, schedule } = await setup();
    const a = await schedule();
    const b = await schedule();
    expect(await pendingTimelockOps({ timelock: tl, fromBlock, allowList: [a.id.toUpperCase().replace("0X", "0x")] })).to.deep.equal([b.id]);
    expect(await checkNoPendingTimelockOps({ timelock: tl, fromBlock, allowList: [a.id, b.id] })).to.deep.equal([]);
  });

  it("reports a batch operation once, however many calls it holds", async function () {
    const { tl, fromBlock, safe, target } = await setup();
    const salt = ethers.id("batch");
    await tl.connect(safe).scheduleBatch([target.address, target.address], [0, 0], ["0x", "0x"], ethers.ZeroHash, salt, DELAY);
    const id = await tl.hashOperationBatch([target.address, target.address], [0, 0], ["0x", "0x"], ethers.ZeroHash, salt);
    expect(await tl.queryFilter(tl.filters.CallScheduled(), fromBlock)).to.have.length(2); // two events, one id
    expect(await pendingTimelockOps({ timelock: tl, fromBlock })).to.deep.equal([id]);
  });

  it("fails, rather than skipping, when fromBlock was not provided", async function () {
    const { tl, schedule } = await setup();
    await schedule();
    for (const missing of [undefined, null, parseBlock(""), parseBlock("not-a-block")]) {
      await expect(pendingTimelockOps({ timelock: tl, fromBlock: missing })).to.be.rejectedWith(/fromBlock .* was not provided/);
      const failures = await checkNoPendingTimelockOps({ timelock: tl, fromBlock: missing });
      expect(failures).to.have.length(1);
      expect(failures[0]).to.include("could not be checked");
    }
  });

  it("fails when fromBlock is after the Timelock was deployed, since earlier operations would be missed", async function () {
    const { tl, fromBlock, schedule } = await setup();
    await schedule();
    const failures = await checkNoPendingTimelockOps({ timelock: tl, fromBlock: fromBlock + 1 });
    expect(failures).to.have.length(1);
    expect(failures[0]).to.include("after the Timelock was deployed");
    // the deployment block itself, and an earlier one, are fine
    expect(await checkNoPendingTimelockOps({ timelock: tl, fromBlock })).to.have.length(1); // the pending op
    expect(await checkNoPendingTimelockOps({ timelock: tl, fromBlock: 0 })).to.have.length(1);
  });

  it("parses the allow-list and the block from the environment strings, and refuses a malformed id", function () {
    const id = ethers.id("x");
    expect(parseOpList("")).to.deep.equal([]);
    expect(parseOpList(undefined)).to.deep.equal([]);
    expect(parseOpList(` ${id.toUpperCase().replace("0X", "0x")} , ${id} `)).to.deep.equal([id, id]);
    expect(() => parseOpList("0x1234")).to.throw(/not a Timelock operation id/);
    expect(parseBlock("123")).to.equal(123);
    expect(parseBlock(" 0 ")).to.equal(0);
    expect(parseBlock("")).to.equal(null);
    expect(parseBlock("12abc")).to.equal(null);
    expect(parseBlock(undefined)).to.equal(null);
  });
});

// ── Task 3: the monitor counts returns as well as sends ──────────────────────

describe("Circuit-breaker monitor: OFTSent and OFTReceived both count (CONTROL-08)", function () {
  const HUB = 40161, SPOKE = 40102;
  const b32 = (a) => ethers.zeroPadValue(a, 32);
  const fee = { nativeFee: 0n, lzTokenFee: 0n };
  const sp = (dstEid, to, amt) => ({ dstEid, to: b32(to), amountLD: amt, minAmountLD: amt, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" });
  async function impersonate(addr) {
    await ethers.provider.send("hardhat_impersonateAccount", [addr]);
    await ethers.provider.send("hardhat_setBalance", [addr, "0x21e19e0c9bab2400000"]);
    return ethers.getSigner(addr);
  }

  // The real hub token and a real spoke, relaying the exact messages they produce, so the
  // logs below are what Ethereum would actually emit, not hand-built ones.
  async function bridge() {
    const [admin, user, recipient] = await ethers.getSigners();
    const Ep = await ethers.getContractFactory("MockLZEndpoint");
    const hubEp = await Ep.deploy(HUB), spokeEp = await Ep.deploy(SPOKE);
    const hub = await (await ethers.getContractFactory("SRXToken")).deploy(await hubEp.getAddress(), admin.address);
    await hub.connect(admin).genesis(admin.address);
    const spoke = await (await ethers.getContractFactory("SRXOFTNative"))
      .deploy(await spokeEp.getAddress(), admin.address, HUB, await hub.getAddress());
    await hub.connect(admin).setPeer(SPOKE, b32(await spoke.getAddress()));
    await spoke.connect(admin).setPeer(HUB, b32(await hub.getAddress()));
    await hub.connect(admin).setInboundLimit(SPOKE, E(10_000_000));
    await hub.connect(admin).transfer(user.address, E(1_000_000));
    const chains = {
      [HUB]: { token: hub, signer: await impersonate(await hubEp.getAddress()) },
      [SPOKE]: { token: spoke, signer: await impersonate(await spokeEp.getAddress()) },
    };
    const relay = async (tx) => {
      const receipt = await tx.wait();
      const log = receipt.logs.find((l) => { try { return hubEp.interface.parseLog(l)?.name === "MockSent"; } catch { return false; } });
      const sent = hubEp.interface.parseLog(log);
      const srcEid = Number(await (await ethers.getContractAt("MockLZEndpoint", log.address)).eid());
      const dst = chains[Number(sent.args.dstEid)];
      return dst.token.connect(dst.signer).lzReceive({ srcEid, sender: b32(sent.args.sender), nonce: sent.args.nonce }, sent.args.guid, sent.args.message, ethers.ZeroAddress, "0x");
    };
    return { hub, spoke, user, recipient, relay };
  }

  it("uses the signatures the real token emits", async function () {
    const { hub } = await bridge();
    expect(OFT_SENT_TOPIC).to.equal(hub.interface.getEvent("OFTSent").topicHash);
    expect(OFT_RECEIVED_TOPIC).to.equal(hub.interface.getEvent("OFTReceived").topicHash);
    expect(OFT_SENT_TOPIC).to.not.equal(OFT_RECEIVED_TOPIC);
  });

  it("maps the hub's real logs: a send out is 'out', a return in is 'in', everything else is ignored", async function () {
    const { hub, spoke, user, recipient, relay } = await bridge();
    const iface = new ethers.Interface(OFT_EVENTS_ABI);
    const hubAddr = await hub.getAddress();

    await relay(await hub.connect(user).send(sp(SPOKE, recipient.address, E(250_000)), fee, user.address)); // out: 250k
    await relay(await spoke.connect(recipient).send(sp(HUB, user.address, E(100_000)), fee, recipient.address)); // return: 100k
    await hub.connect(user).transfer(recipient.address, E(5)); // an ordinary transfer: Transfer log, not a bridge movement

    const logs = await ethers.provider.getLogs({ address: hubAddr, fromBlock: 0 });
    const mapped = logs.map((l) => bridgeActivityFromLog(iface, l, hubAddr)).filter(Boolean);

    expect(logs.length).to.be.gt(mapped.length); // Transfer / limit / role logs were seen and dropped
    expect(mapped).to.have.length(2);
    const out = mapped.find((m) => m.direction === "out");
    const back = mapped.find((m) => m.direction === "in");
    expect(out.amount).to.equal(E(250_000));
    expect(out.eid).to.equal(SPOKE);
    expect(out.account).to.equal(user.address);
    expect(back.amount).to.equal(E(100_000));
    expect(back.eid).to.equal(SPOKE);
    expect(back.account).to.equal(user.address);

    // The OLD behaviour, for contrast: watching OFTSent alone would have missed the return.
    expect(logs.filter((l) => l.topics[0] === OFT_SENT_TOPIC)).to.have.length(1);
    expect(logs.filter((l) => l.topics[0] === OFT_RECEIVED_TOPIC)).to.have.length(1);
  });

  it("ignores OFT logs from any other contract (the spoke's own OFTSent / OFTReceived)", async function () {
    const { hub, spoke, user, recipient, relay } = await bridge();
    const iface = new ethers.Interface(OFT_EVENTS_ABI);
    await relay(await hub.connect(user).send(sp(SPOKE, recipient.address, E(10)), fee, user.address));
    await relay(await spoke.connect(recipient).send(sp(HUB, user.address, E(4)), fee, recipient.address));
    const spokeAddr = await spoke.getAddress();
    const spokeLogs = (await ethers.provider.getLogs({ address: spokeAddr, fromBlock: 0 }))
      .filter((l) => [OFT_SENT_TOPIC, OFT_RECEIVED_TOPIC].includes(l.topics[0]));
    expect(spokeLogs).to.have.length(2);
    // counted when the caller does not pin the token, ignored when it does
    expect(spokeLogs.map((l) => bridgeActivityFromLog(iface, l)).filter(Boolean)).to.have.length(2);
    expect(spokeLogs.map((l) => bridgeActivityFromLog(iface, l, hub.target)).filter(Boolean)).to.have.length(0);
  });

  it("ignores a log with a topic it does not know, and one that cannot be decoded", function () {
    const iface = new ethers.Interface(OFT_EVENTS_ABI);
    const addr = ethers.Wallet.createRandom().address;
    expect(bridgeActivityFromLog(iface, { address: addr, topics: [ethers.id("Transfer(address,address,uint256)")], data: "0x" }, addr)).to.equal(null);
    expect(bridgeActivityFromLog(iface, { address: addr, topics: [OFT_RECEIVED_TOPIC], data: "0x" }, addr)).to.equal(null); // truncated
    expect(bridgeActivityFromLog(iface, { address: addr, topics: [], data: "0x" }, addr)).to.equal(null);
  });
});

