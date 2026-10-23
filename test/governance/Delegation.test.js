/**
 * Launch delegation, option 1 (Jared's steer via the Command Centre, 23 Oct 2026):
 * holders activate their own votes; Syrax-held SRX is never delegated; a relayer can submit a
 * holder's signed delegation (delegateBySig) and pay the gas.
 *
 * What these tests pin down: SRX votes only once delegated; a proposal cannot reach quorum
 * until 400M is delegated; the gas-free path works and cannot be replayed, used after expiry,
 * or used to move anyone else's votes; contract-held SRX cannot vote; and
 * scripts/ops/lib/delegated_supply.js reads exactly the sum of everyone's votes.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { delegatedSupply, concentrationWarnings } = require("../../scripts/ops/lib/delegated_supply");

const E = (n) => ethers.parseUnits(String(n), 18);

describe("Launch delegation (option 1): holders activate their own votes", function () {
  async function fixture() {
    const [admin, proposer, alice, bob, carol, relayer, stranger] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    const deployBlock = (await token.deploymentTransaction().wait()).blockNumber;
    await token.connect(admin).genesis(admin.address);
    const timelock = await (await ethers.getContractFactory("SRXTimelock")).deploy(172800, [], [ethers.ZeroAddress], admin.address);
    const governor = await (await ethers.getContractFactory("SRXGovernor")).deploy(await token.getAddress(), await timelock.getAddress());
    await timelock.connect(admin).grantRole(await timelock.PROPOSER_ROLE(), await governor.getAddress());
    for (const [who, amt] of [[proposer, 2_000_000], [alice, 150_000_000], [bob, 150_000_000], [carol, 150_000_000]]) {
      await token.connect(admin).transfer(who.address, E(amt));
    }
    return { token, governor, timelock, deployBlock, admin, proposer, alice, bob, carol, relayer, stranger };
  }

  async function signDelegation(token, holder, delegatee, nonce, expiry) {
    const { chainId } = await ethers.provider.getNetwork();
    return ethers.Signature.from(await holder.signTypedData(
      { name: "Syrax Token", version: "1", chainId, verifyingContract: await token.getAddress() },
      { Delegation: [{ name: "delegatee", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" }] },
      { delegatee, nonce, expiry },
    ));
  }

  it("SRX has no votes until its holder delegates; self-delegation activates exactly the balance", async function () {
    const { token, alice } = await loadFixture(fixture);
    expect(await token.balanceOf(alice.address)).to.equal(E(150_000_000));
    expect(await token.getVotes(alice.address)).to.equal(0n);
    await expect(token.connect(alice).delegate(alice.address)).to.emit(token, "DelegateVotesChanged").withArgs(alice.address, 0n, E(150_000_000));
    expect(await token.getVotes(alice.address)).to.equal(E(150_000_000));
  });

  it("a proposal cannot reach quorum (400M) until enough is delegated, however much SRX exists", async function () {
    const { token, governor, proposer, alice, bob, carol } = await loadFixture(fixture);
    await token.connect(proposer).delegate(proposer.address);
    // 302M delegated: below the 400M quorum.
    await token.connect(alice).delegate(alice.address);
    await token.connect(bob).delegate(bob.address);
    const t = await governor.getAddress();
    const tx = await governor.connect(proposer).propose([t], [0], ["0x"], "below quorum");
    const id = (await tx.wait()).logs.map((l) => { try { return governor.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "ProposalCreated").args.proposalId;
    await time.increase(86400 + 1); await mine();
    await governor.connect(alice).castVote(id, 1);
    await governor.connect(bob).castVote(id, 1);
    await governor.connect(proposer).castVote(id, 1);
    await time.increase(7 * 86400 + 1); await mine();
    expect(await governor.state(id)).to.equal(3n); // Defeated: for-votes 302M < quorum 400M
    // The same vote with carol delegated too (452M) succeeds.
    await token.connect(carol).delegate(carol.address);
    const tx2 = await governor.connect(proposer).propose([t], [0], ["0x"], "at quorum");
    const id2 = (await tx2.wait()).logs.map((l) => { try { return governor.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "ProposalCreated").args.proposalId;
    await time.increase(86400 + 1); await mine();
    for (const v of [alice, bob, carol]) await governor.connect(v).castVote(id2, 1);
    await time.increase(7 * 86400 + 1); await mine();
    expect(await governor.state(id2)).to.equal(4n); // Succeeded
  });

  it("gas-free path: a relayer submits the holder's signed delegation and pays the gas; the holder sends no transaction", async function () {
    const { token, alice, relayer } = await loadFixture(fixture);
    const nonce = await token.nonces(alice.address);
    const expiry = (await time.latest()) + 3600;
    const sig = await signDelegation(token, alice, alice.address, nonce, expiry);
    const aliceEth = await ethers.provider.getBalance(alice.address);
    await expect(token.connect(relayer).delegateBySig(alice.address, nonce, expiry, sig.v, sig.r, sig.s))
      .to.emit(token, "DelegateChanged").withArgs(alice.address, ethers.ZeroAddress, alice.address);
    expect(await token.getVotes(alice.address)).to.equal(E(150_000_000));
    expect(await ethers.provider.getBalance(alice.address)).to.equal(aliceEth); // alice paid nothing
  });

  it("the signed delegation cannot be replayed, used after expiry, or redirected by the relayer", async function () {
    const { token, alice, relayer, stranger } = await loadFixture(fixture);
    const nonce = await token.nonces(alice.address);
    const expiry = (await time.latest()) + 3600;
    const sig = await signDelegation(token, alice, alice.address, nonce, expiry);
    // Redirected: the relayer submits alice's signature with itself as delegatee -> recovers to a
    // different signer, so alice's votes do not move to the relayer.
    await token.connect(relayer).delegateBySig(relayer.address, nonce, expiry, sig.v, sig.r, sig.s).catch(() => {});
    expect(await token.getVotes(relayer.address)).to.equal(0n);
    expect(await token.delegates(alice.address)).to.equal(ethers.ZeroAddress);
    // Used once, then replay refused (nonce consumed).
    await token.connect(relayer).delegateBySig(alice.address, nonce, expiry, sig.v, sig.r, sig.s);
    await expect(token.connect(relayer).delegateBySig(alice.address, nonce, expiry, sig.v, sig.r, sig.s))
      .to.be.revertedWithCustomError(token, "InvalidAccountNonce");
    // Expired signature refused.
    const n2 = await token.nonces(alice.address);
    const past = (await time.latest()) - 1;
    const old = await signDelegation(token, alice, stranger.address, n2, past);
    await expect(token.connect(relayer).delegateBySig(stranger.address, n2, past, old.v, old.r, old.s))
      .to.be.revertedWithCustomError(token, "VotesExpiredSignature");
    expect(await token.delegates(alice.address)).to.equal(alice.address);
  });

  it("contract-held SRX cannot vote: a vesting vault holds SRX with zero votes and has no way to delegate", async function () {
    const { token, admin, alice, stranger } = await loadFixture(fixture);
    const VV = await ethers.getContractFactory("VestingVault");
    expect(VV.interface.getFunction("delegate")).to.equal(null);
    expect(VV.interface.getFunction("delegateBySig")).to.equal(null);
    // token, beneficiary, admin, cliff, vesting duration, TGE unlock bps, revoke recipient
    const vault = await VV.deploy(await token.getAddress(), alice.address, admin.address, 0, 365 * 86400, 0, stranger.address);
    await token.connect(admin).transfer(await vault.getAddress(), E(1_000));
    expect(await token.balanceOf(await vault.getAddress())).to.equal(E(1_000));
    expect(await token.getVotes(await vault.getAddress())).to.equal(0n);
    expect(await token.delegates(await vault.getAddress())).to.equal(ethers.ZeroAddress);
  });

  it("delegated_supply.js equals the sum of getVotes over every delegate, through delegation changes and transfers", async function () {
    const { token, deployBlock, admin, alice, bob, carol, stranger } = await loadFixture(fixture);
    await token.connect(alice).delegate(alice.address);
    await token.connect(bob).delegate(alice.address);       // bob's votes go to alice
    await token.connect(carol).delegate(stranger.address);   // carol's go to a non-holder
    await token.connect(alice).transfer(carol.address, E(10_000_000)); // moves votes alice -> stranger
    await token.connect(bob).delegate(bob.address);           // bob takes his back
    await token.connect(admin).transfer(bob.address, E(5_000_000));    // undelegated sender, delegated receiver
    const { total, byDelegate } = await delegatedSupply(token, deployBlock);
    let sum = 0n;
    for (const d of [alice, bob, carol, stranger, admin]) sum += await token.getVotes(d.address);
    expect(total).to.equal(sum);
    for (const [d, v] of byDelegate) expect(await token.getVotes(d)).to.equal(v);
    await expect(delegatedSupply(token, undefined)).to.be.rejectedWith(/deployment block is required/);
  });

  it("concentration warning (Security condition 5): a delegate gaining more than 10% of quorum flags; 10% exactly does not", async function () {
    const { token, governor, deployBlock, alice, bob, stranger } = await loadFixture(fixture);
    const quorum = await governor.quorum((await time.latest()) - 1);
    expect(quorum).to.equal(E(400_000_000));
    await token.connect(alice).delegate(alice.address);
    const before = (await delegatedSupply(token, deployBlock)).byDelegate;
    // bob routes 150M to a stranger in one go (a phishing or vote-buying shape): flagged.
    await token.connect(bob).delegate(stranger.address);
    // alice receives exactly 10% of quorum (40M) more: at the limit, not over it.
    await token.connect(bob).transfer(alice.address, 0n); // no-op, keeps the read honest
    const after = (await delegatedSupply(token, deployBlock)).byDelegate;
    const warn = concentrationWarnings(before, after, quorum);
    expect(warn.map((w) => w.delegate)).to.deep.equal([stranger.address]);
    expect(warn[0].gained).to.equal(E(150_000_000));
    const atLimit = new Map(before); atLimit.set(alice.address, (before.get(alice.address) || 0n) + quorum / 10n);
    expect(concentrationWarnings(before, atLimit, quorum)).to.deep.equal([]);
  });
});
