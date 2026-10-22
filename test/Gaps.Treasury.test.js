// Gap-closing tests: treasury spend authority, UUPS upgrade authorisation (treasury, staking, fee
// controller), ETH re-entry, and the full Governor -> Timelock -> Treasury path.
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { allocationSource } = require("./helpers/allocationSource");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const DELAY = 172_800; // 48 hours

async function deployToken(admin) {
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
  await token.connect(admin).genesis(admin.address);
  return token;
}

describe("Gaps: SRXTreasury, Governor -> Timelock -> Treasury", function () {
  // ── Treasury with an EOA standing in for the Timelock ──────────────────────
  async function treasuryFixture() {
    const [admin, timelock, recipient, stranger, gov] = await ethers.getSigners();
    const token = await deployToken(admin);
    const treasury = await (await ethers.getContractFactory("SRXTreasury")).deploy(...[await token.getAddress(), admin.address, timelock.address]);
    const treasuryAddr = await treasury.getAddress();
    await token.connect(admin).grantRole(await token.BURN_ROLE(), treasuryAddr);
    await token.connect(admin).transfer(treasuryAddr, ethers.parseUnits("10000000", 18));
    await admin.sendTransaction({ to: treasuryAddr, value: ethers.parseEther("10") });
    return { admin, timelock, recipient, stranger, gov, token, treasury, treasuryAddr };
  }

  // ── TR1 ────────────────────────────────────────────────────────────────────
  describe("TR1: only the Timelock can spend", function () {
    it("the Timelock holds SPENDER_ROLE after initialize; the admin (DEFAULT_ADMIN, no SPENDER) does not", async function () {
      const { admin, timelock, treasury } = await loadFixture(treasuryFixture);
      const SPENDER = await treasury.SPENDER_ROLE();
      expect(await treasury.hasRole(SPENDER, timelock.address)).to.equal(true);
      expect(await treasury.hasRole(SPENDER, admin.address)).to.equal(false);
      expect(await treasury.hasRole(await treasury.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    });

    it("the admin calling withdraw, withdrawETH and executeBuyAndBurn reverts AccessControlUnauthorizedAccount(admin, SPENDER_ROLE)", async function () {
      const { admin, recipient, token, treasury } = await loadFixture(treasuryFixture);
      const SPENDER = await treasury.SPENDER_ROLE();
      await expect(treasury.connect(admin).withdraw(await token.getAddress(), recipient.address, 1n, "x"))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount").withArgs(admin.address, SPENDER);
      await expect(treasury.connect(admin).withdrawETH(recipient.address, 1n, "x"))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount").withArgs(admin.address, SPENDER);
      await expect(treasury.connect(admin).executeBuyAndBurn(1n))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount").withArgs(admin.address, SPENDER);
    });

    it("control: the same three calls succeed from the Timelock and move exactly the stated amounts", async function () {
      const { timelock, recipient, token, treasury, treasuryAddr } = await loadFixture(treasuryFixture);
      const amt = ethers.parseUnits("1000", 18);
      const supplyBefore = await token.totalSupply();

      await expect(treasury.connect(timelock).withdraw(await token.getAddress(), recipient.address, amt, "grant"))
        .to.emit(treasury, "Withdrawal").withArgs(await token.getAddress(), recipient.address, amt, "grant");
      expect(await token.balanceOf(recipient.address)).to.equal(amt);
      expect(await treasury.totalSpentSRX()).to.equal(amt);

      const ethBefore = await ethers.provider.getBalance(recipient.address);
      await expect(treasury.connect(timelock).withdrawETH(recipient.address, ethers.parseEther("1"), "ops"))
        .to.emit(treasury, "ETHWithdrawal").withArgs(recipient.address, ethers.parseEther("1"), "ops");
      expect(await ethers.provider.getBalance(recipient.address)).to.equal(ethBefore + ethers.parseEther("1"));
      expect(await ethers.provider.getBalance(treasuryAddr)).to.equal(ethers.parseEther("9"));

      await expect(treasury.connect(timelock).executeBuyAndBurn(amt))
        .to.emit(treasury, "BuyAndBurnExecuted");
      expect(await treasury.totalBurned()).to.equal(amt);
      expect(await token.totalSupply()).to.equal(supplyBefore - amt);
    });
  });

  // REG-53 (12 Oct 2026): this contract is no longer upgradeable, so the upgrade-authority
  // tests that stood here were removed. That no upgrade is possible, by any role, is proved
  // in test/REG53.NotUpgradeable.test.js.

  // ── TR3 ────────────────────────────────────────────────────────────────────
  describe("TR3: withdrawETH to a contract that re-enters withdrawETH from receive()", function () {
    // The re-entry is refused by the treasury's inline reentrancy guard, which is
    // require(_status != _ENTERED, "ReentrancyGuard: reentrant call").
    // Note: claim says ReentrancyGuardReentrantCall (the OpenZeppelin custom error); the treasury
    // uses its own inline guard, so the refusal is a plain Error(string) "ReentrancyGuard: reentrant call".
    const ERROR_STRING_SELECTOR = "0x08c379a0";

    async function reentryFixture() {
      const ctx = await treasuryFixture();
      const rx = await (await ethers.getContractFactory("GapsSReentrantReceiver")).deploy();
      // For the re-entry to reach the guard (and not the role check) the receiver must itself be a spender.
      await ctx.treasury.connect(ctx.timelock).grantRole(await ctx.treasury.SPENDER_ROLE(), await rx.getAddress());
      const reenter = ctx.treasury.interface.encodeFunctionData("withdrawETH", [await rx.getAddress(), 1n, "reenter"]);
      return { ...ctx, rx, reenter };
    }

    it("the re-entrant call is refused with the guard's revert string; the outer withdrawal still pays exactly the amount", async function () {
      const { timelock, treasury, treasuryAddr, rx, reenter } = await loadFixture(reentryFixture);
      await rx.arm(treasuryAddr, reenter);
      const amount = ethers.parseEther("1");
      const rxAddr = await rx.getAddress();

      await expect(treasury.connect(timelock).withdrawETH(rxAddr, amount, "outer"))
        .to.emit(treasury, "ETHWithdrawal").withArgs(rxAddr, amount, "outer");

      expect(await rx.reentered()).to.equal(true);
      expect(await rx.reenterOk()).to.equal(false);
      const data = await rx.reenterResult();
      expect(data.slice(0, 10)).to.equal(ERROR_STRING_SELECTOR);
      const [msg] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10));
      expect(msg).to.equal("ReentrancyGuard: reentrant call");

      // Only the outer amount left the treasury; the 1 wei re-entry paid nothing.
      expect(await ethers.provider.getBalance(rxAddr)).to.equal(amount);
      expect(await ethers.provider.getBalance(treasuryAddr)).to.equal(ethers.parseEther("9"));
    });

    it("control: the identical call made from the receiver OUTSIDE a withdrawal succeeds, so the refusal above is the lock", async function () {
      const { treasury, treasuryAddr, rx, reenter } = await loadFixture(reentryFixture);
      await rx.arm(treasuryAddr, reenter);
      const rxAddr = await rx.getAddress();
      const [ok] = await rx.poke.staticCall();
      expect(ok).to.equal(true);
      await expect(rx.poke()).to.emit(treasury, "ETHWithdrawal").withArgs(rxAddr, 1n, "reenter");
      expect(await ethers.provider.getBalance(rxAddr)).to.equal(1n);
    });

    it("control: an unarmed receiver is simply paid", async function () {
      const { timelock, treasury, rx } = await loadFixture(reentryFixture);
      const rxAddr = await rx.getAddress();
      await expect(treasury.connect(timelock).withdrawETH(rxAddr, 5n, "plain")).to.emit(treasury, "ETHWithdrawal");
      expect(await rx.reentered()).to.equal(false);
      expect(await ethers.provider.getBalance(rxAddr)).to.equal(5n);
    });

    it("a receiver WITHOUT SPENDER_ROLE is stopped one step earlier, by the role check, not the guard", async function () {
      const { timelock, treasury, treasuryAddr, token } = await loadFixture(treasuryFixture);
      const rx = await (await ethers.getContractFactory("GapsSReentrantReceiver")).deploy();
      const rxAddr = await rx.getAddress();
      await rx.arm(treasuryAddr, treasury.interface.encodeFunctionData("withdrawETH", [rxAddr, 1n, "r"]));
      await treasury.connect(timelock).withdrawETH(rxAddr, 10n, "outer");
      expect(await rx.reenterOk()).to.equal(false);
      const data = await rx.reenterResult();
      expect(data.slice(0, 10)).to.equal(treasury.interface.getError("AccessControlUnauthorizedAccount").selector);
      void token;
    });
  });

  // ── TR4 ────────────────────────────────────────────────────────────────────
  describe("TR4: Governor -> Timelock -> Treasury, end to end", function () {
    async function e2eFixture() {
      const [admin, proposer, voter1, voter2, voter3, recipient, stranger] = await ethers.getSigners();
      const token = await deployToken(admin);
      const tokenAddr = await token.getAddress();

      const big = ethers.parseUnits("200000000", 18);
      for (const v of [voter1, voter2, voter3]) {
        await token.connect(admin).transfer(v.address, big);
        await token.connect(v).delegate(v.address);
      }
      await token.connect(admin).transfer(proposer.address, ethers.parseUnits("2000000", 18));
      await token.connect(proposer).delegate(proposer.address);

      const timelock = await (await ethers.getContractFactory("SRXTimelock"))
        .deploy(DELAY, [], [ethers.ZeroAddress], admin.address);
      const governor = await (await ethers.getContractFactory("SRXGovernor"))
        .deploy(tokenAddr, await timelock.getAddress());
      await timelock.connect(admin).grantRole(await timelock.PROPOSER_ROLE(), await governor.getAddress());
      // Wiring done: the admin gives up its Timelock admin so only governance can change things.
      await timelock.connect(admin).renounceRole(await timelock.DEFAULT_ADMIN_ROLE(), admin.address);

      const treasury = await (await ethers.getContractFactory("SRXTreasury")).deploy(...[tokenAddr, admin.address, await timelock.getAddress()]);
      const treasuryAddr = await treasury.getAddress();
      await token.connect(admin).transfer(treasuryAddr, ethers.parseUnits("10000000", 18));
      return { admin, proposer, voter1, voter2, voter3, recipient, stranger, token, tokenAddr, timelock, governor, treasury, treasuryAddr };
    }

    it("a passed proposal calling treasury.withdraw queues, cannot execute before the delay, executes after it, and moves the funds", async function () {
      const { admin, proposer, voter1, voter2, voter3, recipient, stranger, token, tokenAddr, timelock, governor, treasury, treasuryAddr } =
        await loadFixture(e2eFixture);
      const amount = ethers.parseUnits("2500000", 18);
      const timelockAddr = await timelock.getAddress();

      // Nobody but the Timelock can spend: not the admin, not the proposer, not a stranger.
      expect(await treasury.hasRole(await treasury.SPENDER_ROLE(), timelockAddr)).to.equal(true);
      for (const who of [admin, proposer, stranger]) {
        await expect(treasury.connect(who).withdraw(tokenAddr, recipient.address, amount, "direct"))
          .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
      }

      const calldata = treasury.interface.encodeFunctionData("withdraw", [tokenAddr, recipient.address, amount, "community grant"]);
      const targets = [treasuryAddr], values = [0n], calldatas = [calldata];
      const desc = "Pay the community grant";
      const descHash = ethers.id(desc);

      const receipt = await (await governor.connect(proposer).propose(targets, values, calldatas, desc)).wait();
      const proposalId = receipt.logs.filter(l => l.fragment?.name === "ProposalCreated")[0].args[0];
      expect(await governor.state(proposalId)).to.equal(0n); // Pending

      await time.increase((await governor.votingDelay()) + 1n);
      expect(await governor.state(proposalId)).to.equal(1n); // Active
      for (const v of [voter1, voter2, voter3]) await governor.connect(v).castVote(proposalId, 1);

      await time.increase(await governor.votingPeriod());
      await mine(1);
      expect(await governor.state(proposalId)).to.equal(4n); // Succeeded

      // Not queued -> cannot execute (the Timelock has no such operation scheduled).
      await expect(governor.execute(targets, values, calldatas, descHash))
        .to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

      await governor.queue(targets, values, calldatas, descHash);
      expect(await governor.state(proposalId)).to.equal(5n); // Queued

      // Before the delay has run: refused by the Timelock.
      await time.increase(DELAY - 60);
      await expect(governor.execute(targets, values, calldatas, descHash))
        .to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
      expect(await token.balanceOf(recipient.address)).to.equal(0n);

      // After the delay: executes, and the money moves.
      await time.increase(61);
      await expect(governor.execute(targets, values, calldatas, descHash))
        .to.emit(treasury, "Withdrawal").withArgs(tokenAddr, recipient.address, amount, "community grant");
      expect(await governor.state(proposalId)).to.equal(7n); // Executed
      expect(await token.balanceOf(recipient.address)).to.equal(amount);
      expect(await treasury.srxBalance()).to.equal(ethers.parseUnits("10000000", 18) - amount);
      expect(await treasury.totalSpentSRX()).to.equal(amount);
    });

    it("control: a proposal that does not reach quorum cannot be queued, so the treasury never pays", async function () {
      const { proposer, voter1, recipient, token, tokenAddr, governor, treasury, treasuryAddr } = await loadFixture(e2eFixture);
      const calldata = treasury.interface.encodeFunctionData("withdraw", [tokenAddr, recipient.address, 1n, "x"]);
      const receipt = await (await governor.connect(proposer).propose([treasuryAddr], [0n], [calldata], "No quorum")).wait();
      const proposalId = receipt.logs.filter(l => l.fragment?.name === "ProposalCreated")[0].args[0];
      await time.increase((await governor.votingDelay()) + 1n);
      await governor.connect(proposer).castVote(proposalId, 1); // 2M, far below the 400M quorum
      await time.increase(await governor.votingPeriod());
      await mine(1);
      expect(await governor.state(proposalId)).to.equal(3n); // Defeated
      await expect(governor.queue([treasuryAddr], [0n], [calldata], ethers.id("No quorum")))
        .to.be.revertedWithCustomError(governor, "GovernorUnexpectedProposalState");
      expect(await token.balanceOf(recipient.address)).to.equal(0n);
      void voter1;
    });
  });
});
