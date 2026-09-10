const { expect }     = require("chai");
const { ethers }     = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/**
 * Launch Protection × cross-contract integration tests.
 *
 * Purpose: at TGE, governance enables launch protection (maxTransferAmount,
 * maxWalletBalance). Without exempting the right addresses, several core flows
 * break silently. This file enumerates each affected flow and demonstrates
 * the exemption requirements.
 *
 * Output: an authoritative checklist of contracts that MUST be exempted on the
 * day launch protection is flipped on.
 */

// ── Minimal Merkle tree helper (matches SRXAirdrop chain-bound double-hash) ─
function buildMerkleTree(entries, chainId) {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const leaves = entries.map(e => {
    const inner = ethers.keccak256(
      abiCoder.encode(["uint256", "address", "uint256"], [chainId, e.address, e.amount])
    );
    return ethers.keccak256(inner);
  });
  const sorted = [...leaves].sort();
  function hashPair(a, b) {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "bytes32"],
      a < b ? [a, b] : [b, a]
    );
  }
  let layer = sorted;
  const layers = [layer];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) next.push(hashPair(layer[i], layer[i + 1]));
      else next.push(layer[i]);
    }
    layer = next;
    layers.push(layer);
  }
  const root = layers[layers.length - 1][0];
  function getProof(leafIndex) {
    const sortedIndex = sorted.indexOf(leaves[leafIndex]);
    let idx = sortedIndex;
    const proof = [];
    for (let l = 0; l < layers.length - 1; l++) {
      const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sibling < layers[l].length) proof.push(layers[l][sibling]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }
  return { root, getProof };
}

describe("Launch Protection × Cross-Contract Integration", function () {

  // Test values — small enough that real-world contract flows easily exceed them
  const MAX_TX  = ethers.parseUnits("100000",  18);   // 100K SRX per transfer
  const MAX_WAL = ethers.parseUnits("5000000", 18);   // 5M  SRX per wallet

  // Base fixture — deploys SRXToken with admin holding full supply
  async function deployBaseFixture() {
    const [admin, user1, user2, user3] = await ethers.getSigners();

    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    return { token, admin, user1, user2, user3 };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. SRXAirdrop × Launch Protection
  // ═══════════════════════════════════════════════════════════════════════════

  describe("1. SRXAirdrop — must be exempt as SENDER", function () {
    async function airdropFixture() {
      const base = await deployBaseFixture();
      const { token, admin, user1, user2 } = base;

      const SRXAirdrop = await ethers.getContractFactory("SRXAirdrop");
      const airdrop = await SRXAirdrop.deploy(await token.getAddress(), admin.address);
      await airdrop.waitForDeployment();

      // Fund airdrop with 1M SRX BEFORE enabling launch protection
      const FUND = ethers.parseUnits("1000000", 18);
      await token.connect(admin).transfer(await airdrop.getAddress(), FUND);

      // Build Merkle tree with two claim sizes — one below MAX_TX, one above
      const AMOUNT_SMALL = ethers.parseUnits("50000",  18);  // under MAX_TX
      const AMOUNT_LARGE = ethers.parseUnits("250000", 18);  // above MAX_TX
      const entries = [
        { address: user1.address, amount: AMOUNT_SMALL },
        { address: user2.address, amount: AMOUNT_LARGE },
      ];
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const tree = buildMerkleTree(entries, chainId);

      const deadline = (await time.latest()) + 7 * 24 * 60 * 60;
      await airdrop.connect(admin).setMerkleRoot(tree.root, deadline);

      // Enable launch protection AFTER funding
      await token.connect(admin).setMaxTransferAmount(MAX_TX);
      await token.connect(admin).setMaxWalletBalance(MAX_WAL);

      return { ...base, airdrop, tree, AMOUNT_SMALL, AMOUNT_LARGE };
    }

    it("LARGE claim reverts (TransferExceedsMaxAmount) when airdrop NOT exempt", async function () {
      const { token, airdrop, user2, tree, AMOUNT_LARGE } = await loadFixture(airdropFixture);
      const proof = tree.getProof(1);
      await expect(airdrop.connect(user2).claim(AMOUNT_LARGE, proof))
        .to.be.revertedWithCustomError(token, "TransferExceedsMaxAmount")
        .withArgs(AMOUNT_LARGE, MAX_TX);
    });

    it("SMALL claim (below MAX_TX) succeeds even without exemption", async function () {
      const { token, airdrop, user1, tree, AMOUNT_SMALL } = await loadFixture(airdropFixture);
      const proof = tree.getProof(0);
      await expect(airdrop.connect(user1).claim(AMOUNT_SMALL, proof)).to.not.be.reverted;
      expect(await token.balanceOf(user1.address)).to.equal(AMOUNT_SMALL);
    });

    it("LARGE claim succeeds once airdrop is exempt as sender", async function () {
      const { token, airdrop, admin, user2, tree, AMOUNT_LARGE } = await loadFixture(airdropFixture);
      await token.connect(admin).setExemptFromLimits(await airdrop.getAddress(), true);
      const proof = tree.getProof(1);
      await expect(airdrop.connect(user2).claim(AMOUNT_LARGE, proof)).to.not.be.reverted;
      expect(await token.balanceOf(user2.address)).to.equal(AMOUNT_LARGE);
    });

    it("claim reverts (WalletExceedsMaxBalance) when recipient is at the wallet cap", async function () {
      const { token, airdrop, admin, user1, tree, AMOUNT_SMALL } = await loadFixture(airdropFixture);
      // Exempt admin (acts as treasury here) so the pre-fill transfer isn't blocked
      // by maxTransferAmount — treasury wallets are exempt in production anyway.
      await token.connect(admin).setExemptFromLimits(admin.address, true);
      // Exempt airdrop so the claim's transfer-amount check passes
      await token.connect(admin).setExemptFromLimits(await airdrop.getAddress(), true);
      // Pre-fill user1 to just below the wallet cap so a SMALL claim tips them over
      const fillTarget = MAX_WAL - (AMOUNT_SMALL / 2n);
      await token.connect(admin).transfer(user1.address, fillTarget);
      const proof = tree.getProof(0);
      // user1 is NOT exempt — claim's wallet-cap check should fire
      await expect(airdrop.connect(user1).claim(AMOUNT_SMALL, proof))
        .to.be.revertedWithCustomError(token, "WalletExceedsMaxBalance");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. BuybackBurner × Launch Protection
  // ═══════════════════════════════════════════════════════════════════════════

  describe("2. BuybackBurner — must be exempt as RECIPIENT", function () {
    async function burnerFixture() {
      const base = await deployBaseFixture();
      const { token, admin } = base;

      const BuybackBurner = await ethers.getContractFactory("BuybackBurner");
      const burner = await BuybackBurner.deploy(await token.getAddress(), admin.address);
      await burner.waitForDeployment();

      // BURN_ROLE on token + EXECUTOR_ROLE on burner
      const BURN_ROLE = await token.BURN_ROLE();
      await token.connect(admin).grantRole(BURN_ROLE, await burner.getAddress());
      const EXECUTOR_ROLE = await burner.EXECUTOR_ROLE();
      await burner.connect(admin).grantRole(EXECUTOR_ROLE, admin.address);

      // Enable launch protection
      await token.connect(admin).setMaxTransferAmount(MAX_TX);
      await token.connect(admin).setMaxWalletBalance(MAX_WAL);

      return { ...base, burner };
    }

    it("large fee-routing transfer to burner reverts when burner NOT exempt", async function () {
      const { token, burner, admin } = await loadFixture(burnerFixture);
      const LARGE = ethers.parseUnits("500000", 18); // 500K > MAX_TX
      await expect(token.connect(admin).transfer(await burner.getAddress(), LARGE))
        .to.be.revertedWithCustomError(token, "TransferExceedsMaxAmount");
    });

    it("transfer succeeds once burner is exempt as recipient", async function () {
      const { token, burner, admin } = await loadFixture(burnerFixture);
      await token.connect(admin).setExemptFromLimits(await burner.getAddress(), true);
      const LARGE = ethers.parseUnits("500000", 18);
      await expect(token.connect(admin).transfer(await burner.getAddress(), LARGE)).to.not.be.reverted;
      expect(await token.balanceOf(await burner.getAddress())).to.equal(LARGE);
    });

    it("burnHeld() always works (burn destination is address(0) — bypasses limits)", async function () {
      const { token, burner, admin } = await loadFixture(burnerFixture);
      // Small fund (under MAX_TX so we don't need exemption)
      const SMALL = ethers.parseUnits("50000", 18);
      await token.connect(admin).transfer(await burner.getAddress(), SMALL);
      // Burn — to == 0 → launch protection skipped
      await expect(burner.connect(admin).burnHeld()).to.not.be.reverted;
      expect(await token.balanceOf(await burner.getAddress())).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. PreSaleRound vault deployment × Launch Protection
  // ═══════════════════════════════════════════════════════════════════════════

  describe("3. PreSaleRound — must be exempt as SENDER, vaults receive 4M+ SRX", function () {
    async function presaleFixture() {
      const base = await deployBaseFixture();
      const { token, admin, user1 } = base;

      // ETH/USD feed at $2500
      const MockChainlinkFeed = await ethers.getContractFactory("MockChainlinkFeed");
      const ethFeed = await MockChainlinkFeed.deploy(2500_00000000n);
      await ethFeed.waitForDeployment();

      // Stable mocks
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6); await usdc.waitForDeployment();
      const usdt = await MockERC20.deploy("USDT", "USDT", 6); await usdt.waitForDeployment();

      // PreSaleRound — note constructor order from contract source
      const HARD_CAP  = ethers.parseUnits("400000000", 18);  // 400M SRX
      const SRX_PRICE = 1_250_000n;                          // $0.0125 in 8-dec
      const PreSaleRound = await ethers.getContractFactory("PreSaleRound");
      const presale = await PreSaleRound.deploy(
        await token.getAddress(),
        await usdc.getAddress(),
        await usdt.getAddress(),
        ethers.ZeroAddress,            // wbtc disabled
        await ethFeed.getAddress(),
        ethers.ZeroAddress,            // btc feed disabled
        admin.address,
        HARD_CAP,
        SRX_PRICE
      );
      await presale.waitForDeployment();

      // Fund presale with 10M SRX
      const PRESALE_FUND = ethers.parseUnits("10000000", 18);
      await token.connect(admin).transfer(await presale.getAddress(), PRESALE_FUND);

      // Off-chain investor: $50K → Entry +10% → 4.4M SRX allocation
      const USD_AMOUNT = 50_000_00000000n;
      await presale.connect(admin).addInvestor(user1.address, USD_AMOUNT);

      // Enable launch protection
      await token.connect(admin).setMaxTransferAmount(MAX_TX);
      await token.connect(admin).setMaxWalletBalance(MAX_WAL);

      return { ...base, presale };
    }

    it("deployVault reverts (TransferExceedsMaxAmount) when PreSaleRound NOT exempt", async function () {
      const { token, presale, admin, user1 } = await loadFixture(presaleFixture);
      await expect(presale.connect(admin).deployVault(user1.address))
        .to.be.revertedWithCustomError(token, "TransferExceedsMaxAmount");
    });

    it("deployVault succeeds when PreSaleRound is exempt as sender AND wallet cap is generous", async function () {
      // Vault receives 4.4M SRX — under MAX_WAL of 5M, so it fits
      const { token, presale, admin, user1 } = await loadFixture(presaleFixture);
      await token.connect(admin).setExemptFromLimits(await presale.getAddress(), true);
      await expect(presale.connect(admin).deployVault(user1.address)).to.not.be.reverted;
    });

    it("deployVault reverts (WalletExceedsMaxBalance) when wallet cap too small even with sender exemption", async function () {
      // Drop wallet cap below 4.4M — vault recipient tips over
      const { token, presale, admin, user1 } = await loadFixture(presaleFixture);
      await token.connect(admin).setExemptFromLimits(await presale.getAddress(), true);
      await token.connect(admin).setMaxWalletBalance(ethers.parseUnits("1000000", 18)); // 1M cap
      await expect(presale.connect(admin).deployVault(user1.address))
        .to.be.revertedWithCustomError(token, "WalletExceedsMaxBalance");
    });

    it("deployVault succeeds when wallet cap is disabled (0) — sender-exemption alone is sufficient", async function () {
      const { token, presale, admin, user1 } = await loadFixture(presaleFixture);
      await token.connect(admin).setExemptFromLimits(await presale.getAddress(), true);
      await token.connect(admin).setMaxWalletBalance(0n);   // disable wallet cap
      await expect(presale.connect(admin).deployVault(user1.address)).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Mint and burn always bypass — operational sanity
  // ═══════════════════════════════════════════════════════════════════════════

  describe("4. Mint/burn bypass — sanity checks", function () {
    it("genesis() succeeds even if maxWalletBalance is set to 1 SRX (mint exempt)", async function () {
      const [admin] = await ethers.getSigners();
      const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
      const ep = await MockLZEndpoint.deploy(40161); await ep.waitForDeployment();
      const SRXToken = await ethers.getContractFactory("SRXToken");
      const t = await SRXToken.deploy(await ep.getAddress(), admin.address);
      await t.waitForDeployment();
      // Set tiny cap BEFORE genesis
      await t.connect(admin).setMaxWalletBalance(ethers.parseUnits("1", 18));
      await expect(t.connect(admin).genesis(admin.address)).to.not.be.reverted;
    });

    it("buyAndBurn() with 8B SRX succeeds when MAX_TX is 100K (burn exempt)", async function () {
      const { token, admin } = await loadFixture(deployBaseFixture);
      const BURN_ROLE = await token.BURN_ROLE();
      await token.connect(admin).grantRole(BURN_ROLE, admin.address);
      await token.connect(admin).setMaxTransferAmount(MAX_TX); // 100K — way below 8B
      const huge = ethers.parseUnits("8000000000", 18);
      await expect(token.connect(admin).buyAndBurn(huge)).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. End-to-end "exemption checklist" — all flows working together
  // ═══════════════════════════════════════════════════════════════════════════

  describe("5. End-to-end with full exemption list", function () {
    it("airdrop claim + burner transfer + presale vault deploy all succeed when all three are exempt", async function () {
      const [admin, user1, user2] = await ethers.getSigners();

      // ── Deploy everything ─────────────────────────────────────────────────
      const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
      const ep = await MockLZEndpoint.deploy(40161); await ep.waitForDeployment();
      const SRXToken = await ethers.getContractFactory("SRXToken");
      const token = await SRXToken.deploy(await ep.getAddress(), admin.address);
      await token.waitForDeployment();
      await token.connect(admin).genesis(admin.address);

      const SRXAirdrop = await ethers.getContractFactory("SRXAirdrop");
      const airdrop = await SRXAirdrop.deploy(await token.getAddress(), admin.address);
      await airdrop.waitForDeployment();

      const BuybackBurner = await ethers.getContractFactory("BuybackBurner");
      const burner = await BuybackBurner.deploy(await token.getAddress(), admin.address);
      await burner.waitForDeployment();
      const BURN_ROLE = await token.BURN_ROLE();
      await token.connect(admin).grantRole(BURN_ROLE, await burner.getAddress());

      const MockChainlinkFeed = await ethers.getContractFactory("MockChainlinkFeed");
      const ethFeed = await MockChainlinkFeed.deploy(2500_00000000n); await ethFeed.waitForDeployment();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6); await usdc.waitForDeployment();
      const usdt = await MockERC20.deploy("USDT", "USDT", 6); await usdt.waitForDeployment();

      const PreSaleRound = await ethers.getContractFactory("PreSaleRound");
      const presale = await PreSaleRound.deploy(
        await token.getAddress(),
        await usdc.getAddress(),
        await usdt.getAddress(),
        ethers.ZeroAddress,
        await ethFeed.getAddress(),
        ethers.ZeroAddress,
        admin.address,
        ethers.parseUnits("400000000", 18),
        1_250_000n
      );
      await presale.waitForDeployment();

      // ── Fund everything BEFORE enabling launch protection ─────────────────
      await token.connect(admin).transfer(await airdrop.getAddress(),  ethers.parseUnits("1000000", 18));
      await token.connect(admin).transfer(await presale.getAddress(), ethers.parseUnits("10000000", 18));

      // Configure airdrop
      const AMOUNT_LARGE = ethers.parseUnits("250000", 18); // > MAX_TX
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const tree = buildMerkleTree([{ address: user1.address, amount: AMOUNT_LARGE }], chainId);
      const deadline = (await time.latest()) + 7 * 24 * 60 * 60;
      await airdrop.connect(admin).setMerkleRoot(tree.root, deadline);

      // Off-chain presale investor
      await presale.connect(admin).addInvestor(user2.address, 50_000_00000000n);

      // ── Enable launch protection ──────────────────────────────────────────
      await token.connect(admin).setMaxTransferAmount(MAX_TX);
      await token.connect(admin).setMaxWalletBalance(MAX_WAL);

      // ── Apply the full exemption list ─────────────────────────────────────
      await token.connect(admin).setExemptFromLimits(await airdrop.getAddress(),  true);
      await token.connect(admin).setExemptFromLimits(await burner.getAddress(),   true);
      await token.connect(admin).setExemptFromLimits(await presale.getAddress(), true);

      // ── Exercise each flow ────────────────────────────────────────────────
      // (a) Airdrop claim of LARGE amount
      await expect(airdrop.connect(user1).claim(AMOUNT_LARGE, tree.getProof(0))).to.not.be.reverted;

      // (b) Large transfer to burner + burn
      const TRANSFER_TO_BURNER = ethers.parseUnits("500000", 18);
      await expect(token.connect(admin).transfer(await burner.getAddress(), TRANSFER_TO_BURNER))
        .to.not.be.reverted;
      // Grant EXECUTOR + burn
      const EXECUTOR_ROLE = await burner.EXECUTOR_ROLE();
      await burner.connect(admin).grantRole(EXECUTOR_ROLE, admin.address);
      await expect(burner.connect(admin).burnHeld()).to.not.be.reverted;

      // (c) Vault deploy (4.4M SRX recipient — under 5M cap)
      await expect(presale.connect(admin).deployVault(user2.address)).to.not.be.reverted;

      // ── Final assertions ──────────────────────────────────────────────────
      expect(await token.balanceOf(user1.address)).to.equal(AMOUNT_LARGE);
      expect(await token.balanceOf(await burner.getAddress())).to.equal(0n);
      expect((await presale.investors(user2.address)).vault).to.not.equal(ethers.ZeroAddress);
    });
  });
});
