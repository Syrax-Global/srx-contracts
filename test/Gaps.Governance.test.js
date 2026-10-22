// Gap-closing tests for SRXGovernor: proposal threshold, delegation and snapshot rules, quorum counting.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const THRESHOLD = ethers.parseUnits("1000000", 18);          // 1M SRX
const DELAY = 172_800;
const e18 = (n) => ethers.parseUnits(String(n), 18);

describe("Gaps: SRXGovernor", function () {
  async function fixture() {
    const [admin, a, b, c, d, e, f] = await ethers.getSigners();
    const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
    await token.connect(admin).genesis(admin.address);
    const timelock = await (await ethers.getContractFactory("SRXTimelock")).deploy(DELAY, [], [ethers.ZeroAddress], admin.address);
    const governor = await (await ethers.getContractFactory("SRXGovernor")).deploy(await token.getAddress(), await timelock.getAddress());
    await timelock.connect(admin).grantRole(await timelock.PROPOSER_ROLE(), await governor.getAddress());
    const tokenAddr = await token.getAddress();
    // A harmless proposal body.
    const body = (tag) => ({
      targets: [tokenAddr], values: [0n],
      calldatas: [token.interface.encodeFunctionData("transfer", [admin.address, 0n])],
      desc: "gaps proposal " + tag,
    });
    const propose = async (who, tag) => {
      const p = body(tag);
      const r = await (await governor.connect(who).propose(p.targets, p.values, p.calldatas, p.desc)).wait();
      const id = r.logs.filter(l => l.fragment?.name === "ProposalCreated")[0].args[0];
      return { id, ...p, descHash: ethers.id(p.desc) };
    };
    return { admin, a, b, c, d, e, f, token, tokenAddr, timelock, governor, body, propose };
  }

  // ── GV1 ────────────────────────────────────────────────────────────────────
  describe("GV1: proposal threshold", function () {
    it("threshold - 1 wei of votes reverts GovernorInsufficientProposerVotes; exactly the threshold succeeds", async function () {
      const { admin, a, token, governor, body } = await loadFixture(fixture);
      expect(await governor.proposalThreshold()).to.equal(THRESHOLD);

      await token.connect(admin).transfer(a.address, THRESHOLD - 1n);
      await token.connect(a).delegate(a.address);
      await mine(1);
      const p = body("t1");
      expect(await governor.getVotes(a.address, (await time.latest()) - 1)).to.equal(THRESHOLD - 1n);
      await expect(governor.connect(a).propose(p.targets, p.values, p.calldatas, p.desc))
        .to.be.revertedWithCustomError(governor, "GovernorInsufficientProposerVotes")
        .withArgs(a.address, THRESHOLD - 1n, THRESHOLD);

      // Control: one more wei, delegated, and the same proposal is accepted.
      await token.connect(admin).transfer(a.address, 1n);
      await mine(1);
      expect(await governor.getVotes(a.address, (await time.latest()) - 1)).to.equal(THRESHOLD);
      await expect(governor.connect(a).propose(p.targets, p.values, p.calldatas, p.desc))
        .to.emit(governor, "ProposalCreated");
    });
  });

  // ── GV2 ────────────────────────────────────────────────────────────────────
  describe("GV2: delegation and snapshot", function () {
    it("an undelegated holder has 0 voting weight and cannot propose; delegating makes the same tokens count", async function () {
      const { admin, a, b, token, governor, body, propose } = await loadFixture(fixture);
      await token.connect(admin).transfer(a.address, THRESHOLD * 5n);   // never delegates
      await token.connect(admin).transfer(b.address, THRESHOLD * 2n);
      await token.connect(b).delegate(b.address);
      await mine(1);

      expect(await token.balanceOf(a.address)).to.equal(THRESHOLD * 5n);
      expect(await token.getVotes(a.address)).to.equal(0n);
      const p = body("undelegated");
      await expect(governor.connect(a).propose(p.targets, p.values, p.calldatas, p.desc))
        .to.be.revertedWithCustomError(governor, "GovernorInsufficientProposerVotes")
        .withArgs(a.address, 0n, THRESHOLD);

      // A vote by the undelegated holder is recorded with weight 0 and adds nothing to the tally.
      const prop = await propose(b, "vote-weight");
      await time.increase((await governor.votingDelay()) + 1n);
      await expect(governor.connect(a).castVote(prop.id, 1))
        .to.emit(governor, "VoteCast").withArgs(a.address, prop.id, 1, 0n, "");
      expect(await governor.hasVoted(prop.id, a.address)).to.equal(true);
      let [against, forVotes, abstain] = await governor.proposalVotes(prop.id);
      expect([against, forVotes, abstain]).to.deep.equal([0n, 0n, 0n]);

      // Control: a delegated holder with 2M votes counts 2M (b's own weight, snapshotted before the vote started).
      await governor.connect(b).castVote(prop.id, 1);
      [against, forVotes, abstain] = await governor.proposalVotes(prop.id);
      expect(forVotes).to.equal(THRESHOLD * 2n);
    });

    it("tokens acquired or delegated after a proposal's snapshot do not count for that proposal", async function () {
      const { admin, a, b, c, d, token, governor, propose } = await loadFixture(fixture);
      const early = THRESHOLD * 3n;
      await token.connect(admin).transfer(a.address, THRESHOLD * 2n);   // proposer, delegated before
      await token.connect(a).delegate(a.address);
      await token.connect(admin).transfer(b.address, early);            // delegated before the snapshot
      await token.connect(b).delegate(b.address);
      await token.connect(admin).transfer(c.address, early);            // holds tokens, delegates only AFTER the snapshot
      await token.connect(d).delegate(d.address);                        // delegated while holding nothing
      await mine(1);

      const prop = await propose(a, "snapshot");
      const snapshot = await governor.proposalSnapshot(prop.id);
      await time.increase((await governor.votingDelay()) + 1n);
      expect(BigInt(await time.latest())).to.be.greaterThan(snapshot);

      // After the snapshot: c delegates its existing tokens; d is sent tokens; a fresh holder appears.
      await token.connect(c).delegate(c.address);
      await token.connect(admin).transfer(d.address, early);
      await mine(1);
      expect(await token.getVotes(c.address)).to.equal(early);   // live votes exist now ...
      expect(await token.getVotes(d.address)).to.equal(early);
      expect(await token.getPastVotes(c.address, snapshot)).to.equal(0n);
      expect(await token.getPastVotes(d.address, snapshot)).to.equal(0n);

      // ... but the proposal's weight for them is the snapshot's: 0.
      await expect(governor.connect(c).castVote(prop.id, 1)).to.emit(governor, "VoteCast").withArgs(c.address, prop.id, 1, 0n, "");
      await expect(governor.connect(d).castVote(prop.id, 1)).to.emit(governor, "VoteCast").withArgs(d.address, prop.id, 1, 0n, "");
      // Control: b, delegated before the snapshot, counts in full.
      await expect(governor.connect(b).castVote(prop.id, 1)).to.emit(governor, "VoteCast").withArgs(b.address, prop.id, 1, early, "");
      const [against, forVotes, abstain] = await governor.proposalVotes(prop.id);
      expect([against, forVotes, abstain]).to.deep.equal([0n, early, 0n]);
    });
  });

  // ── GV3 ────────────────────────────────────────────────────────────────────
  describe("GV3: quorum counts For + Abstain", function () {
    async function quorumFixture() {
      const ctx = await fixture();
      const { admin, a, b, c, d, token } = ctx;
      // a: proposer / tiny For voter (2M). b, c: 200M each = 400M of Abstain. d: a third 200M holder.
      for (const [who, amt] of [[a, e18(2_000_000)], [b, e18(200_000_000)], [c, e18(200_000_000)], [d, e18(200_000_000)]]) {
        await token.connect(admin).transfer(who.address, amt);
        await token.connect(who).delegate(who.address);
      }
      await mine(1);
      return ctx;
    }

    it("Abstain votes reaching 4% of the 10B cap plus a tiny For make the proposal Succeed", async function () {
      const { a, b, c, governor, propose } = await loadFixture(quorumFixture);
      const quorum = (10_000_000_000n * 10n ** 18n * 4n) / 100n;
      expect(await governor.quorum(await time.latest())).to.equal(quorum); // 400,000,000 SRX

      const prop = await propose(a, "abstain-quorum");
      await time.increase((await governor.votingDelay()) + 1n);
      await governor.connect(a).castVote(prop.id, 1);  // For: 2M, half a percent of quorum
      await governor.connect(b).castVote(prop.id, 2);  // Abstain: 200M
      await governor.connect(c).castVote(prop.id, 2);  // Abstain: 200M
      const [against, forVotes, abstain] = await governor.proposalVotes(prop.id);
      expect(forVotes).to.equal(e18(2_000_000));
      expect(abstain).to.equal(e18(400_000_000));
      expect(against).to.equal(0n);

      await time.increase(await governor.votingPeriod());
      await mine(1);
      // R7-13: the Governor NatSpec used to say quorum is "4% ... of total delegated supply must vote FOR" (corrected 7 Oct 2026).
      // Actual: quorum is a FIXED 4% of the 10B cap (400M SRX, not of delegated supply) and OZ
      // GovernorCountingSimple counts For + Abstain towards it, so 2M For + 400M Abstain reaches it
      // and the proposal (For > Against) Succeeds with only 0.02% of supply actually voting For.
      expect(forVotes + abstain).to.be.gte(quorum);
      expect(await governor.state(prop.id)).to.equal(4n); // Succeeded
    });

    it("control: the same tiny For with no Abstain, or with Abstain just under the bar, is Defeated", async function () {
      const { a, b, governor, propose } = await loadFixture(quorumFixture);
      // (i) 2M For, nobody else.
      const p1 = await propose(a, "no-abstain");
      // (ii) 2M For + 200M Abstain = 202M < 400M.
      const p2 = await propose(a, "half-abstain");
      await time.increase((await governor.votingDelay()) + 1n);
      await governor.connect(a).castVote(p1.id, 1);
      await governor.connect(a).castVote(p2.id, 1);
      await governor.connect(b).castVote(p2.id, 2);
      await time.increase(await governor.votingPeriod());
      await mine(1);
      expect(await governor.state(p1.id)).to.equal(3n); // Defeated
      expect(await governor.state(p2.id)).to.equal(3n); // Defeated
    });

    it("Against votes do not count toward quorum: the same 400M as Against is Defeated, not Succeeded", async function () {
      const { a, b, c, governor, propose } = await loadFixture(quorumFixture);
      const prop = await propose(a, "against");
      await time.increase((await governor.votingDelay()) + 1n);
      await governor.connect(a).castVote(prop.id, 1);
      await governor.connect(b).castVote(prop.id, 0);
      await governor.connect(c).castVote(prop.id, 0);
      await time.increase(await governor.votingPeriod());
      await mine(1);
      expect(await governor.state(prop.id)).to.equal(3n); // Defeated (quorum is For + Abstain only)
    });
  });
});
