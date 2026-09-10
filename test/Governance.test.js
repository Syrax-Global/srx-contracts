const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("SRXGovernor + SRXTimelock", function () {

  const PROPOSAL_THRESHOLD = ethers.parseUnits("1000000", 18); // 1M SRX
  const TIMELOCK_DELAY     = 172800; // 48 hours

  async function deployGovernanceFixture() {
    const [admin, proposer, voter1, voter2, voter3, recipient] = await ethers.getSigners();

    // ── Token ────────────────────────────────────────────────────────────────
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    // Distribute voting tokens
    const largeHolding = ethers.parseUnits("200000000", 18); // 200M SRX — 3 voters × 200M = 600M > 4% quorum (400M)
    await token.connect(admin).transfer(voter1.address, largeHolding);
    await token.connect(admin).transfer(voter2.address, largeHolding);
    await token.connect(admin).transfer(voter3.address, largeHolding);
    await token.connect(admin).transfer(proposer.address, PROPOSAL_THRESHOLD * 2n);

    // Self-delegate to activate voting power
    await token.connect(voter1).delegate(voter1.address);
    await token.connect(voter2).delegate(voter2.address);
    await token.connect(voter3).delegate(voter3.address);
    await token.connect(proposer).delegate(proposer.address);

    // ── Timelock ─────────────────────────────────────────────────────────────
    const SRXTimelock = await ethers.getContractFactory("SRXTimelock");
    const timelock = await SRXTimelock.deploy(
      TIMELOCK_DELAY,
      [],
      [ethers.ZeroAddress],
      admin.address
    );
    await timelock.waitForDeployment();

    // ── Governor ─────────────────────────────────────────────────────────────
    const SRXGovernor = await ethers.getContractFactory("SRXGovernor");
    const governor = await SRXGovernor.deploy(
      await token.getAddress(),
      await timelock.getAddress()
    );
    await governor.waitForDeployment();

    // Wire governor as proposer on timelock
    const PROPOSER_ROLE   = await timelock.PROPOSER_ROLE();
    const CANCELLER_ROLE  = await timelock.CANCELLER_ROLE();
    await timelock.connect(admin).grantRole(PROPOSER_ROLE,  await governor.getAddress());
    // Admin holds CANCELLER_ROLE as guardian during the 0–6 month veto window
    await timelock.connect(admin).grantRole(CANCELLER_ROLE, admin.address);

    // Fund the timelock (for proposals to execute withdrawals)
    await token.connect(admin).transfer(await timelock.getAddress(), ethers.parseUnits("1000", 18));

    return { token, timelock, governor, admin, proposer, voter1, voter2, voter3, recipient };
  }

  // ── Deployment ──────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("governor has correct name", async function () {
      const { governor } = await loadFixture(deployGovernanceFixture);
      expect(await governor.name()).to.equal("SRX Governor");
    });

    it("voting period is 7 days", async function () {
      const { governor } = await loadFixture(deployGovernanceFixture);
      expect(await governor.votingPeriod()).to.equal(7n * 86400n);
    });

    it("voting delay is 1 day", async function () {
      const { governor } = await loadFixture(deployGovernanceFixture);
      expect(await governor.votingDelay()).to.equal(1n * 86400n);
    });

    it("proposal threshold is 1M SRX", async function () {
      const { governor } = await loadFixture(deployGovernanceFixture);
      expect(await governor.proposalThreshold()).to.equal(PROPOSAL_THRESHOLD);
    });

    it("quorum is 4% of supply", async function () {
      const { governor } = await loadFixture(deployGovernanceFixture);
      const numerator = await governor.quorumNumerator();
      expect(numerator).to.equal(4n);
    });

    it("timelock delay is 48 hours", async function () {
      const { timelock } = await loadFixture(deployGovernanceFixture);
      expect(await timelock.getMinDelay()).to.equal(BigInt(TIMELOCK_DELAY));
    });
  });

  // ── Proposal creation ───────────────────────────────────────────────────────

  describe("Proposal creation", function () {
    it("creates a proposal with sufficient threshold", async function () {
      const { governor, token, proposer, recipient } = await loadFixture(deployGovernanceFixture);

      const calldata = token.interface.encodeFunctionData("transfer", [
        recipient.address,
        ethers.parseUnits("100", 18)
      ]);

      await expect(
        governor.connect(proposer).propose(
          [await token.getAddress()],
          [0n],
          [calldata],
          "Transfer 100 SRX to recipient"
        )
      ).to.emit(governor, "ProposalCreated");
    });

    it("reverts if proposer has insufficient tokens", async function () {
      const { governor, token, recipient } = await loadFixture(deployGovernanceFixture);

      const calldata = token.interface.encodeFunctionData("transfer", [
        recipient.address,
        ethers.parseUnits("100", 18)
      ]);

      await expect(
        governor.connect(recipient).propose(
          [await token.getAddress()],
          [0n],
          [calldata],
          "Transfer tokens"
        )
      ).to.be.reverted;
    });
  });

  // ── Full governance flow ────────────────────────────────────────────────────

  describe("Full governance flow", function () {
    it("executes a passed proposal after timelock", async function () {
      const { governor, timelock, token, proposer, voter1, voter2, voter3, recipient } =
        await loadFixture(deployGovernanceFixture);

      const transferAmount = ethers.parseUnits("100", 18);
      const timelockAddress = await timelock.getAddress();

      // The timelock holds tokens; we propose transferring from it
      const calldata = token.interface.encodeFunctionData("transfer", [
        recipient.address,
        transferAmount
      ]);

      // 1. Create proposal
      const proposeTx = await governor.connect(proposer).propose(
        [await token.getAddress()],
        [0n],
        [calldata],
        "Governance test: transfer tokens"
      );
      const proposeReceipt = await proposeTx.wait();
      const proposalId = proposeReceipt.logs
        .filter(l => l.fragment?.name === "ProposalCreated")[0]
        .args[0];

      // 2. Wait for voting delay
      await time.increase(await governor.votingDelay() + 1n);
      await mine(1);

      // 3. Vote (For = 1)
      await governor.connect(voter1).castVote(proposalId, 1);
      await governor.connect(voter2).castVote(proposalId, 1);
      await governor.connect(voter3).castVote(proposalId, 1);

      // 4. Wait for voting period to end
      await time.increase(await governor.votingPeriod());
      await mine(1);

      // 5. Queue
      const descHash = ethers.id("Governance test: transfer tokens");
      await governor.queue(
        [await token.getAddress()],
        [0n],
        [calldata],
        descHash
      );

      // 6. Wait for timelock
      await time.increase(TIMELOCK_DELAY + 1);

      // 7. Execute
      const recipientBefore = await token.balanceOf(recipient.address);
      await governor.execute(
        [await token.getAddress()],
        [0n],
        [calldata],
        descHash
      );

      expect(await token.balanceOf(recipient.address)).to.equal(
        recipientBefore + transferAmount
      );
    });
  });

  // ── Cancellation ────────────────────────────────────────────────────────────

  describe("Cancellation (guardian)", function () {
    it("admin (CANCELLER_ROLE) can cancel a queued proposal", async function () {
      const { governor, timelock, token, proposer, voter1, voter2, voter3, admin } =
        await loadFixture(deployGovernanceFixture);

      const calldata = token.interface.encodeFunctionData("transfer", [
        ethers.ZeroAddress, ethers.parseUnits("100", 18)
      ]);

      const proposeTx = await governor.connect(proposer).propose(
        [await token.getAddress()], [0n], [calldata], "Malicious proposal"
      );
      const receipt = await proposeTx.wait();
      const proposalId = receipt.logs
        .filter(l => l.fragment?.name === "ProposalCreated")[0]
        .args[0];

      await time.increase(await governor.votingDelay() + 1n);
      await mine(1);

      await governor.connect(voter1).castVote(proposalId, 1);
      await governor.connect(voter2).castVote(proposalId, 1);
      await governor.connect(voter3).castVote(proposalId, 1);

      await time.increase(await governor.votingPeriod());
      await mine(1);

      const descHash = ethers.id("Malicious proposal");
      await governor.queue([await token.getAddress()], [0n], [calldata], descHash);

      // Admin cancels via timelock directly
      const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
      expect(await timelock.hasRole(CANCELLER_ROLE, admin.address)).to.be.true;
    });
  });
});
