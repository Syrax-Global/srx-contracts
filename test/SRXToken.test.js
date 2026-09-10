const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ── Mock LayerZero endpoint for testing ────────────────────────────────────────
// In tests we use a zero-address endpoint since we don't test bridge messaging here.
// Cross-chain tests are in Bridge.test.js using LayerZero's test helpers.
const MOCK_LZ_ENDPOINT = ethers.ZeroAddress;

describe("SRXToken", function () {

  async function deployTokenFixture() {
    const [admin, user1, user2, bridge, pauser] = await ethers.getSigners();

    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint = await MockLZEndpoint.deploy(40161); // Sepolia EID
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();

    const BURN_ROLE       = await token.BURN_ROLE();
    const PAUSER_ROLE     = await token.PAUSER_ROLE();
    const GOVERNANCE_ROLE = await token.GOVERNANCE_ROLE();

    // Grant pauser role
    await token.connect(admin).grantRole(PAUSER_ROLE, pauser.address);

    return { token, admin, user1, user2, bridge, pauser, BURN_ROLE, PAUSER_ROLE, GOVERNANCE_ROLE };
  }

  async function deployWithGenesisFixture() {
    const { token, admin, user1, user2, bridge, pauser, BURN_ROLE, PAUSER_ROLE, GOVERNANCE_ROLE } =
      await loadFixture(deployTokenFixture);

    // Deploy a mock distributor (just use user1 address for testing)
    await token.connect(admin).genesis(user1.address);

    return { token, admin, user1, user2, bridge, pauser, BURN_ROLE, PAUSER_ROLE, GOVERNANCE_ROLE };
  }

  // ── Deployment ──────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets correct name and symbol", async function () {
      const { token } = await loadFixture(deployTokenFixture);
      expect(await token.name()).to.equal("Syrax Token");
      expect(await token.symbol()).to.equal("SRX");
    });

    it("sets 18 decimals", async function () {
      const { token } = await loadFixture(deployTokenFixture);
      expect(await token.decimals()).to.equal(18);
    });

    it("sets MAX_SUPPLY to 10 billion SRX", async function () {
      const { token } = await loadFixture(deployTokenFixture);
      const expected = ethers.parseUnits("10000000000", 18);
      expect(await token.MAX_SUPPLY()).to.equal(expected);
    });

    it("grants admin all roles", async function () {
      const { token, admin, PAUSER_ROLE, GOVERNANCE_ROLE } = await loadFixture(deployTokenFixture);
      const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
      expect(await token.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await token.hasRole(GOVERNANCE_ROLE, admin.address)).to.be.true;
      expect(await token.hasRole(PAUSER_ROLE, admin.address)).to.be.true;
    });

    it("genesis is not complete before genesis()", async function () {
      const { token } = await loadFixture(deployTokenFixture);
      expect(await token.genesisComplete()).to.be.false;
    });

    it("totalSupply is 0 before genesis", async function () {
      const { token } = await loadFixture(deployTokenFixture);
      expect(await token.totalSupply()).to.equal(0n);
    });
  });

  // ── Genesis ─────────────────────────────────────────────────────────────────

  describe("genesis()", function () {
    it("mints MAX_SUPPLY to the distributor", async function () {
      const { token, admin, user1 } = await loadFixture(deployTokenFixture);
      await token.connect(admin).genesis(user1.address);
      expect(await token.balanceOf(user1.address)).to.equal(await token.MAX_SUPPLY());
    });

    it("sets genesisComplete = true", async function () {
      const { token, admin, user1 } = await loadFixture(deployTokenFixture);
      await token.connect(admin).genesis(user1.address);
      expect(await token.genesisComplete()).to.be.true;
    });

    it("reverts if called twice", async function () {
      const { token, admin, user1 } = await loadFixture(deployTokenFixture);
      await token.connect(admin).genesis(user1.address);
      await expect(
        token.connect(admin).genesis(user1.address)
      ).to.be.revertedWithCustomError(token, "GenesisAlreadyComplete");
    });

    it("reverts if called by non-admin", async function () {
      const { token, user1 } = await loadFixture(deployTokenFixture);
      await expect(
        token.connect(user1).genesis(user1.address)
      ).to.be.reverted;
    });

    it("reverts with zero address distributor", async function () {
      const { token, admin } = await loadFixture(deployTokenFixture);
      await expect(
        token.connect(admin).genesis(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(token, "ZeroAddress");
    });

    it("emits GenesisExecuted event", async function () {
      const { token, admin, user1 } = await loadFixture(deployTokenFixture);
      await expect(token.connect(admin).genesis(user1.address))
        .to.emit(token, "GenesisExecuted")
        .withArgs(user1.address, await token.MAX_SUPPLY());
    });
  });

  // ── Buy-and-Burn ────────────────────────────────────────────────────────────

  describe("buyAndBurn()", function () {
    it("burns the specified amount from caller's balance", async function () {
      const { token, admin, user1, user2, BURN_ROLE } = await loadFixture(deployWithGenesisFixture);
      const burnAmount = ethers.parseUnits("1000", 18);

      await token.connect(admin).grantRole(BURN_ROLE, user2.address);
      // user2 must hold the tokens they intend to burn (A2-H-01: no arbitrary from)
      // genesis() mints all tokens to user1, so transfer from user1 (not admin)
      await token.connect(user1).transfer(user2.address, burnAmount);
      await token.connect(user2).buyAndBurn(burnAmount);

      const maxSupply = await token.MAX_SUPPLY();
      expect(await token.totalSupply()).to.equal(maxSupply - burnAmount);
    });

    it("increments totalBurned", async function () {
      const { token, admin, user1, user2, BURN_ROLE } = await loadFixture(deployWithGenesisFixture);
      const burnAmount = ethers.parseUnits("500", 18);

      await token.connect(admin).grantRole(BURN_ROLE, user2.address);
      await token.connect(user1).transfer(user2.address, burnAmount);
      await token.connect(user2).buyAndBurn(burnAmount);

      expect(await token.totalBurned()).to.equal(burnAmount);
    });

    it("reverts if called without BURN_ROLE", async function () {
      const { token, user2 } = await loadFixture(deployWithGenesisFixture);
      await expect(
        token.connect(user2).buyAndBurn(1n)
      ).to.be.reverted;
    });

    it("reverts with zero amount", async function () {
      const { token, admin, user2, BURN_ROLE } = await loadFixture(deployWithGenesisFixture);
      await token.connect(admin).grantRole(BURN_ROLE, user2.address);
      await expect(
        token.connect(user2).buyAndBurn(0n)
      ).to.be.revertedWithCustomError(token, "ZeroAmount");
    });

    it("emits BuyAndBurn event", async function () {
      const { token, admin, user1, user2, BURN_ROLE } = await loadFixture(deployWithGenesisFixture);
      const burnAmount = ethers.parseUnits("100", 18);
      await token.connect(admin).grantRole(BURN_ROLE, user2.address);
      await token.connect(user1).transfer(user2.address, burnAmount);

      await expect(token.connect(user2).buyAndBurn(burnAmount))
        .to.emit(token, "BuyAndBurn")
        .withArgs(user2.address, burnAmount);
    });
  });

  // ── Pause ───────────────────────────────────────────────────────────────────

  describe("Pause", function () {
    it("blocks transfers when paused", async function () {
      const { token, admin, user1, user2, pauser } = await loadFixture(deployWithGenesisFixture);
      await token.connect(pauser).pause();

      await expect(
        token.connect(user1).transfer(user2.address, 1n)
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("allows transfers after unpause", async function () {
      const { token, user1, user2, pauser } = await loadFixture(deployWithGenesisFixture);
      await token.connect(pauser).pause();
      await token.connect(pauser).unpause();

      const amount = ethers.parseUnits("10", 18);
      await expect(token.connect(user1).transfer(user2.address, amount)).to.not.be.reverted;
    });

    it("reverts pause if not PAUSER_ROLE", async function () {
      const { token, user2 } = await loadFixture(deployWithGenesisFixture);
      await expect(token.connect(user2).pause()).to.be.reverted;
    });
  });

  // ── ERC20Votes ──────────────────────────────────────────────────────────────

  describe("Governance / Voting Power", function () {
    it("has zero voting power before delegation", async function () {
      const { token, user1 } = await loadFixture(deployWithGenesisFixture);
      expect(await token.getVotes(user1.address)).to.equal(0n);
    });

    it("gains voting power after self-delegation", async function () {
      const { token, user1 } = await loadFixture(deployWithGenesisFixture);
      const balance = await token.balanceOf(user1.address);
      await token.connect(user1).delegate(user1.address);
      expect(await token.getVotes(user1.address)).to.equal(balance);
    });

    it("transfers voting power on delegation to another address", async function () {
      const { token, user1, user2 } = await loadFixture(deployWithGenesisFixture);
      await token.connect(user1).delegate(user2.address);
      const balance = await token.balanceOf(user1.address);
      expect(await token.getVotes(user2.address)).to.equal(balance);
      expect(await token.getVotes(user1.address)).to.equal(0n);
    });
  });

  // ── ERC20Permit ─────────────────────────────────────────────────────────────

  describe("EIP-2612 Permit", function () {
    it("executes a valid permit", async function () {
      const { token, user1, user2 } = await loadFixture(deployWithGenesisFixture);
      const amount   = ethers.parseUnits("100", 18);
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const nonce    = await token.nonces(user1.address);

      const domain = {
        name:    "Syrax Token",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        Permit: [
          { name: "owner",   type: "address" },
          { name: "spender", type: "address" },
          { name: "value",   type: "uint256" },
          { name: "nonce",   type: "uint256" },
          { name: "deadline",type: "uint256" },
        ],
      };

      const values = {
        owner:    user1.address,
        spender:  user2.address,
        value:    amount,
        nonce:    nonce,
        deadline: deadline,
      };

      const sig = await user1.signTypedData(domain, types, values);
      const { v, r, s } = ethers.Signature.from(sig);

      await token.permit(user1.address, user2.address, amount, deadline, v, r, s);
      expect(await token.allowance(user1.address, user2.address)).to.equal(amount);
    });
  });
});
