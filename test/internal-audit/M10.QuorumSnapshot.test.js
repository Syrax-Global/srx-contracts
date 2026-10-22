// Internal audit 16 Oct 2026, M10 (CONTROL-04): quorum() read the CURRENT numerator, so
// lowering it revived proposals that had failed quorum. It must use the numerator in force
// at each proposal's snapshot.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;
const DELAY = 2 * DAY;
const State = { Defeated: 3n, Succeeded: 4n };

async function launched() {
  const [admin, whale, attacker] = await ethers.getSigners();
  const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
  await token.connect(admin).genesis(admin.address);
  const tl = await (await ethers.getContractFactory("SRXTimelock")).deploy(DELAY, [], [ethers.ZeroAddress], admin.address);
  const gov = await (await ethers.getContractFactory("SRXGovernor")).deploy(await token.getAddress(), await tl.getAddress());
  await tl.connect(admin).grantRole(await tl.PROPOSER_ROLE(), await gov.getAddress());
  await tl.connect(admin).grantRole(await tl.CANCELLER_ROLE(), await gov.getAddress());
  for (const [who, amt] of [[whale, 450_000_000], [attacker, 150_000_000]]) {
    await token.connect(admin).transfer(who.address, E(amt));
    await token.connect(who).delegate(who.address);
  }
  await time.increase(10);
  return { whale, attacker, tl, gov };
}

async function propose(gov, who, target, data, desc) {
  await gov.connect(who).propose([target], [0], [data], desc);
  const id = await gov.hashProposal([target], [0], [data], ethers.id(desc));
  await time.increase(DAY + 1);
  return { id, args: [[target], [0], [data], ethers.id(desc)] };
}

describe("Internal audit M10: quorum is read at each proposal's snapshot", function () {
  it("a proposal that failed quorum stays Defeated after the quorum is lowered", async function () {
    const { gov, tl, whale, attacker } = await loadFixture(launched);
    const grab = tl.interface.encodeFunctionData("grantRole", [await tl.PROPOSER_ROLE(), attacker.address]);
    const A = await propose(gov, attacker, await tl.getAddress(), grab, "A");
    await gov.connect(attacker).castVote(A.id, 1);              // 150M For, below the 400M quorum
    await time.increase(7 * DAY + 1);
    expect(await gov.state(A.id)).to.equal(State.Defeated);

    const lower = gov.interface.encodeFunctionData("updateQuorumNumerator", [1]);
    const B = await propose(gov, whale, await gov.getAddress(), lower, "lower quorum to 1%");
    await gov.connect(whale).castVote(B.id, 1);
    await time.increase(7 * DAY + 1);
    await gov.queue(...B.args);
    await time.increase(DELAY + 1);
    await gov.execute(...B.args);
    expect(await gov["quorumNumerator()"]()).to.equal(1n);

    expect(await gov.state(A.id)).to.equal(State.Defeated);     // was Succeeded before the fix
    await expect(gov.queue(...A.args)).to.be.reverted;
  });

  it("control: a proposal made after the change uses the new, lower quorum", async function () {
    const { gov, whale, attacker } = await loadFixture(launched);
    const lower = gov.interface.encodeFunctionData("updateQuorumNumerator", [1]);
    const B = await propose(gov, whale, await gov.getAddress(), lower, "lower");
    await gov.connect(whale).castVote(B.id, 1);
    await time.increase(7 * DAY + 1);
    await gov.queue(...B.args);
    await time.increase(DELAY + 1);
    await gov.execute(...B.args);
    await time.increase(10);
    const C = await propose(gov, attacker, await gov.getAddress(),
      gov.interface.encodeFunctionData("setVotingDelay", [DAY]), "C");
    await gov.connect(attacker).castVote(C.id, 1);              // 150M >= 100M
    await time.increase(7 * DAY + 1);
    expect(await gov.state(C.id)).to.equal(State.Succeeded);
  });
});
