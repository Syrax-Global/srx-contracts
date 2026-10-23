// Cross-chain conservation under an adversarial spoke (external disclosure A, 7 Oct 2026).
//
// Random sequences of honest bridging, forged spoke mints (a compromised DVN or delegate),
// returns that are refused and retried later, limit changes, freezes and the passage of
// time. After every step:
//   1. Exact accounting on Ethereum: hub supply + outstanding to the spoke + burned = 10B.
//   2. Exact accounting across both chains: spoke supply + returns in flight
//      = outstanding + forged mints. Whatever was forged is the only thing unbacked.
//   3. The hub's limit behaves exactly like the model draining bucket: inboundAvailable
//      matches the model, and a return succeeds if and only if the model says it should.
//   4. However the attack is timed, the hub credits at most Lmax × (1 + elapsed / 24 h),
//      where Lmax is the highest limit governance ever set.
//   5. Hub supply never exceeds MAX_SUPPLY.
// Seeded, so a failure reproduces: set SRX_PROP_SEED to replay one seed.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (n) => ethers.parseUnits(String(n), 18);
const HUB = 40161, SPOKE = 40102;
const W = 24n * 3600n;
const b32 = (a) => ethers.zeroPadValue(a, 32);
const SD = 10n ** 12n; // shared decimals 6
const msgTo = (to, amountLD) => ethers.concat([b32(to), ethers.toBeHex(amountLD / SD, 8)]);
const fee = { nativeFee: 0n, lzTokenFee: 0n };

function prng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function impersonate(addr) {
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  await ethers.provider.send("hardhat_setBalance", [addr, "0x21e19e0c9bab2400000"]);
  return ethers.getSigner(addr);
}

async function setup() {
  const [admin, alice, attacker] = await ethers.getSigners();
  const Ep = await ethers.getContractFactory("MockLZEndpoint");
  const hubEp = await Ep.deploy(HUB);
  const spokeEp = await Ep.deploy(SPOKE);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await hubEp.getAddress(), admin.address);
  const native = await (await ethers.getContractFactory("SRXOFTNative"))
    .deploy(await spokeEp.getAddress(), admin.address, HUB, await token.getAddress());
  await token.connect(admin).genesis(admin.address);
  await token.connect(admin).setPeer(SPOKE, b32(await native.getAddress()));
  await native.connect(admin).setPeer(HUB, b32(await token.getAddress()));
  await token.connect(admin).transfer(alice.address, E(50_000_000));
  return {
    admin, alice, attacker, token, native,
    hubEpS: await impersonate(await hubEp.getAddress()),
    spokeEpS: await impersonate(await spokeEp.getAddress()),
  };
}

async function runSequence(seed, steps) {
  const rnd = prng(seed);
  const pick = (n) => Math.floor(rnd() * n);
  const amount = (maxWhole) => BigInt(1 + pick(maxWhole)) * E(1); // whole SRX, so no dust from shared decimals
  const c = await setup();
  const { admin, alice, attacker, token, native, hubEpS, spokeEpS } = c;
  const sp = (dstEid, to, amt) => ({ dstEid, to: b32(to), amountLD: amt, minAmountLD: amt, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" });

  let nonce = 0;
  const onSpoke = (to, amt) => native.connect(spokeEpS).lzReceive(
    { srcEid: HUB, sender: b32(token.target), nonce: ++nonce }, ethers.ZeroHash, msgTo(to, amt), ethers.ZeroAddress, "0x");
  const onHub = (m) => token.connect(hubEpS).lzReceive(
    { srcEid: SPOKE, sender: b32(native.target), nonce: m.nonce }, ethers.ZeroHash, msgTo(m.to, m.amt), ethers.ZeroAddress, "0x");

  // Model of the hub's draining bucket.
  const model = { limit: 0n, inFlight: 0n, updatedAt: 0n, frozen: false };
  const now = async () => BigInt(await time.latest());
  const drained = (t) => {
    const d = ((t - model.updatedAt) * model.limit) / W;
    return model.inFlight > d ? model.inFlight - d : 0n;
  };

  const pending = []; // returns sent from the spoke, not yet credited on Ethereum
  let forgedMinted = 0n, credited = 0n, lmax = 0n;
  const t0 = await now();

  const setLimit = async (l) => {
    await token.connect(admin).setInboundLimit(SPOKE, l);
    const t = await now();
    model.inFlight = drained(t); model.updatedAt = t; model.limit = l;
    if (l > lmax) lmax = l;
  };
  await setLimit(E(1_000_000));

  const deliver = async (i) => {
    const m = pending[i];
    const outstanding = await token.outstandingByEid(SPOKE);
    // The block this transaction is mined in is one second later.
    const t = (await now()) + 1n;
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
    const room = model.limit > drained(t) ? model.limit - drained(t) : 0n;
    const shouldPass = !model.frozen && m.amt <= outstanding && m.amt <= room;
    if (shouldPass) {
      await onHub(m);
      model.inFlight = drained(t) + m.amt; model.updatedAt = t;
      credited += m.amt;
      pending.splice(i, 1);
    } else {
      // Same order as SRXToken._credit: backing first, then the freeze, then the limit.
      const err = m.amt > outstanding ? "UnbackedInboundCredit"
        : model.frozen ? "InboundChainFrozen" : "InboundLimitExceeded";
      await expect(onHub(m)).to.be.revertedWithCustomError(token, err);
    }
  };

  const check = async (label) => {
    const MAX = await token.MAX_SUPPLY();
    const hubSupply = await token.totalSupply();
    const outstanding = await token.outstandingByEid(SPOKE);
    const burned = await token.totalBurned();
    const ctx = `seed ${seed}, ${label}`;
    expect(hubSupply + outstanding + burned, `1 hub accounting (${ctx})`).to.equal(MAX);
    const inFlight = pending.reduce((s, m) => s + m.amt, 0n);
    expect((await native.totalSupply()) + inFlight, `2 cross-chain accounting (${ctx})`).to.equal(outstanding + forgedMinted);
    const t = await now();
    const room = model.limit > drained(t) ? model.limit - drained(t) : 0n;
    expect(await token.inboundAvailable(SPOKE), `3 bucket matches model (${ctx})`).to.equal(room);
    expect(credited, `4 credited within Lmax x (1 + elapsed / day) (${ctx})`).to.be.lte(lmax + (lmax * (t - t0)) / W);
    expect(hubSupply, `5 supply cap (${ctx})`).to.be.lte(MAX);
  };

  for (let s = 0; s < steps; s++) {
    const r = pick(100);
    let label;
    if (r < 18) { // honest: Ethereum -> spoke, delivered at once
      const amt = amount(2_000_000);
      label = `send ${amt / E(1)} to spoke`;
      if (model.frozen) {
        // review round 22 Oct (A2): SRX is not sent INTO a frozen chain either; the send is
        // refused, nothing is burned, and the model does not move.
        label += " (refused: chain frozen)";
        await expect(token.connect(alice).send(sp(SPOKE, alice.address, amt), fee, alice.address))
          .to.be.revertedWithCustomError(token, "InboundChainFrozen");
      } else {
        await token.connect(alice).send(sp(SPOKE, alice.address, amt), fee, alice.address);
        await onSpoke(alice.address, amt);
      }
    } else if (r < 36) { // honest: spoke -> Ethereum
      const bal = await native.balanceOf(alice.address);
      if (bal === 0n) continue;
      const amt = (amount(2_000_000) % (bal / E(1) + 1n) || 1n) * E(1);
      if (amt > bal) continue;
      label = `return ${amt / E(1)}`;
      await native.connect(alice).send(sp(HUB, alice.address, amt), fee, alice.address);
      pending.push({ to: alice.address, amt, nonce: ++nonce, forged: false });
    } else if (r < 52) { // attacker: forged mint on the spoke, sent straight back
      const amt = amount(5_000_000);
      label = `forge ${amt / E(1)}`;
      await onSpoke(attacker.address, amt);
      forgedMinted += amt;
      await native.connect(attacker).send(sp(HUB, attacker.address, amt), fee, attacker.address);
      pending.push({ to: attacker.address, amt, nonce: ++nonce, forged: true });
    } else if (r < 75) { // the relayer delivers or retries one return
      if (pending.length === 0) continue;
      const i = pick(pending.length);
      label = `deliver ${pending[i].amt / E(1)}${pending[i].forged ? " (forged)" : ""}`;
      await deliver(i);
    } else if (r < 87) { // time passes
      const secs = BigInt(pick(Number(2n * W)));
      label = `wait ${secs}s`;
      await time.increase(secs);
    } else if (r < 94) { // governance changes the limit (sometimes to 0)
      const l = pick(5) === 0 ? 0n : amount(3_000_000);
      label = `limit ${l / E(1)}`;
      await setLimit(l);
    } else { // guardian freezes, or governance lifts it
      model.frozen = !model.frozen;
      label = model.frozen ? "freeze" : "unfreeze";
      if (model.frozen) await token.connect(admin).freezeInbound(SPOKE);
      else await token.connect(admin).unfreezeInbound(SPOKE);
    }
    await check(`step ${s}: ${label}`);
  }
  return { credited, forgedMinted };
}

describe("Bridge conservation under an adversarial spoke (property, disclosure A)", function () {
  this.timeout(600_000);
  const seeds = process.env.SRX_PROP_SEED
    ? [Number(process.env.SRX_PROP_SEED)]
    : Array.from({ length: 12 }, (_, i) => 0x5eed0000 + i * 7919);

  for (const seed of seeds) {
    it(`seed ${seed}: accounting exact, limit exact, forgery bounded`, async function () {
      await runSequence(seed, 45);
    });
  }

  it("control: the bound in property 4 is tight enough to catch a hub without the limit", async function () {
    // Without the limit (set it to the whole supply) a forger extracts far more in one step
    // than a 1,000,000 SRX/day limit would allow, so property 4 would fail at that limit.
    const c = await setup();
    const { admin, attacker, token, native, hubEpS, spokeEpS } = c;
    await token.connect(admin).setInboundLimit(SPOKE, await token.MAX_SUPPLY());
    const sp = (to, amt) => ({ dstEid: HUB, to: b32(to), amountLD: amt, minAmountLD: amt, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" });
    await token.connect(c.alice).send({ dstEid: SPOKE, to: b32(c.alice.address), amountLD: E(10_000_000), minAmountLD: E(10_000_000), extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" }, fee, c.alice.address);
    await native.connect(spokeEpS).lzReceive({ srcEid: HUB, sender: b32(token.target), nonce: 1 }, ethers.ZeroHash, msgTo(attacker.address, E(10_000_000)), ethers.ZeroAddress, "0x");
    await native.connect(attacker).send(sp(attacker.address, E(10_000_000)), fee, attacker.address);
    await token.connect(hubEpS).lzReceive({ srcEid: SPOKE, sender: b32(native.target), nonce: 2 }, ethers.ZeroHash, msgTo(attacker.address, E(10_000_000)), ethers.ZeroAddress, "0x");
    expect(await token.balanceOf(attacker.address)).to.be.gt(E(1_000_000) * 2n);
  });
});
