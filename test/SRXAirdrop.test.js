const { expect }       = require("chai");
const { ethers }       = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue }     = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// ── Minimal Merkle tree helper (no external dependency) ─────────────────────
// Builds a two-level tree from an array of { address, amount } entries.
// Leaf = keccak256(keccak256(abi.encode(chainId, address, uint256))) —
// chain-bound double-hash (SC-AD-001 + SC-AD-002 fixes; matches OZ
// StandardMerkleTree convention plus a chain ID domain separator).
function buildMerkleTree(entries, chainId) {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const leaves = entries.map(e => {
    const inner = ethers.keccak256(
      abiCoder.encode(["uint256", "address", "uint256"], [chainId, e.address, e.amount])
    );
    return ethers.keccak256(inner);
  });

  // Sort leaves for deterministic root (standard practice)
  const sorted = [...leaves].sort();

  function hashPair(a, b) {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "bytes32"],
      a < b ? [a, b] : [b, a]
    );
  }

  // Build tree bottom-up
  let layer = sorted;
  const layers = [layer];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) {
        next.push(hashPair(layer[i], layer[i + 1]));
      } else {
        next.push(layer[i]); // odd node bubbles up
      }
    }
    layer = next;
    layers.push(layer);
  }

  const root = layers[layers.length - 1][0];

  function getProof(leafIndex) {
    const sortedIndex = sorted.indexOf(leaves[leafIndex]);
    let idx   = sortedIndex;
    const proof = [];
    for (let l = 0; l < layers.length - 1; l++) {
      const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sibling < layers[l].length) proof.push(layers[l][sibling]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  return { root, leaves: sorted, getProof, originalLeaves: leaves };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("SRXAirdrop", function () {

  async function deployFixture() {
    const [admin, recipient1, recipient2, recipient3, other] = await ethers.getSigners();

    // Deploy SRXToken
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const mockEndpoint   = await MockLZEndpoint.deploy(40161);
    await mockEndpoint.waitForDeployment();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token    = await SRXToken.deploy(await mockEndpoint.getAddress(), admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    // Deploy SRXAirdrop
    const SRXAirdrop = await ethers.getContractFactory("SRXAirdrop");
    const airdrop    = await SRXAirdrop.deploy(await token.getAddress(), admin.address);
    await airdrop.waitForDeployment();

    // Fund airdrop contract
    const TOTAL_AIRDROP = ethers.parseUnits("3000", 18); // 3,000 SRX
    await token.connect(admin).transfer(await airdrop.getAddress(), TOTAL_AIRDROP);

    // Build Merkle tree
    const AMOUNT_1 = ethers.parseUnits("1000", 18);
    const AMOUNT_2 = ethers.parseUnits("1500", 18);
    const AMOUNT_3 = ethers.parseUnits("500",  18);

    const entries = [
      { address: recipient1.address, amount: AMOUNT_1 },
      { address: recipient2.address, amount: AMOUNT_2 },
      { address: recipient3.address, amount: AMOUNT_3 },
    ];

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const tree = buildMerkleTree(entries, chainId);

    // Deadline 7 days from now
    const deadline = (await time.latest()) + 7 * 24 * 60 * 60;

    return {
      token, airdrop, admin,
      recipient1, recipient2, recipient3, other,
      entries, tree,
      AMOUNT_1, AMOUNT_2, AMOUNT_3,
      TOTAL_AIRDROP, deadline,
    };
  }

  async function activeAirdropFixture() {
    const base = await deployFixture();
    await base.airdrop.connect(base.admin).setMerkleRoot(base.tree.root, base.deadline);
    return base;
  }

  // ── Deployment ──────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets srxToken correctly", async function () {
      const { airdrop, token } = await loadFixture(deployFixture);
      expect(await airdrop.srxToken()).to.equal(await token.getAddress());
    });

    it("merkleRoot starts as zero bytes", async function () {
      const { airdrop } = await loadFixture(deployFixture);
      expect(await airdrop.merkleRoot()).to.equal(ethers.ZeroHash);
    });

    it("totalClaimed starts at 0", async function () {
      const { airdrop } = await loadFixture(deployFixture);
      expect(await airdrop.totalClaimed()).to.equal(0n);
    });

    it("isActive() returns false before root is set", async function () {
      const { airdrop } = await loadFixture(deployFixture);
      expect(await airdrop.isActive()).to.be.false;
    });
  });

  // ── setMerkleRoot ───────────────────────────────────────────────────────────

  describe("setMerkleRoot", function () {
    it("stores root and deadline, emits AirdropConfigured", async function () {
      const { airdrop, admin, tree, deadline } = await loadFixture(deployFixture);
      // Third arg is block.timestamp at execution — use anyValue to avoid off-by-one
      await expect(airdrop.connect(admin).setMerkleRoot(tree.root, deadline))
        .to.emit(airdrop, "AirdropConfigured")
        .withArgs(tree.root, deadline, anyValue);
      expect(await airdrop.merkleRoot()).to.equal(tree.root);
      expect(await airdrop.claimDeadline()).to.equal(deadline);
    });

    it("isActive() returns true after root is set", async function () {
      const { airdrop } = await loadFixture(activeAirdropFixture);
      expect(await airdrop.isActive()).to.be.true;
    });

    it("reverts on zero root", async function () {
      const { airdrop, admin, deadline } = await loadFixture(deployFixture);
      await expect(airdrop.connect(admin).setMerkleRoot(ethers.ZeroHash, deadline))
        .to.be.revertedWithCustomError(airdrop, "NoActiveAirdrop");
    });

    it("reverts when deadline is in the past", async function () {
      const { airdrop, admin, tree } = await loadFixture(deployFixture);
      const pastDeadline = (await time.latest()) - 1;
      await expect(airdrop.connect(admin).setMerkleRoot(tree.root, pastDeadline))
        .to.be.revertedWithCustomError(airdrop, "DeadlineMustBeFuture");
    });

    it("reverts when called by non-admin", async function () {
      const { airdrop, other, tree, deadline } = await loadFixture(deployFixture);
      await expect(airdrop.connect(other).setMerkleRoot(tree.root, deadline))
        .to.be.revertedWithCustomError(airdrop, "AccessControlUnauthorizedAccount");
    });

    it("can replace active airdrop with a new root", async function () {
      const { airdrop, admin, tree, deadline } = await loadFixture(activeAirdropFixture);
      const newRoot     = ethers.randomBytes(32);
      const newDeadline = deadline + 86400;
      await airdrop.connect(admin).setMerkleRoot(ethers.hexlify(newRoot), newDeadline);
      expect(await airdrop.merkleRoot()).to.equal(ethers.hexlify(newRoot));
    });
  });

  // ── claim ───────────────────────────────────────────────────────────────────

  describe("claim", function () {
    it("transfers correct SRX amount and emits Claimed", async function () {
      const { airdrop, token, recipient1, entries, tree, AMOUNT_1 } =
        await loadFixture(activeAirdropFixture);

      const proof = tree.getProof(0); // index 0 = recipient1
      const balBefore = await token.balanceOf(recipient1.address);

      await expect(airdrop.connect(recipient1).claim(AMOUNT_1, proof))
        .to.emit(airdrop, "Claimed")
        .withArgs(recipient1.address, AMOUNT_1);

      expect(await token.balanceOf(recipient1.address)).to.equal(balBefore + AMOUNT_1);
    });

    it("marks address as claimed", async function () {
      const { airdrop, recipient1, tree, AMOUNT_1 } = await loadFixture(activeAirdropFixture);
      const proof = tree.getProof(0);
      await airdrop.connect(recipient1).claim(AMOUNT_1, proof);
      expect(await airdrop.claimed(recipient1.address)).to.be.true;
    });

    it("increments totalClaimed", async function () {
      const { airdrop, recipient1, tree, AMOUNT_1 } = await loadFixture(activeAirdropFixture);
      const proof = tree.getProof(0);
      await airdrop.connect(recipient1).claim(AMOUNT_1, proof);
      expect(await airdrop.totalClaimed()).to.equal(AMOUNT_1);
    });

    it("reverts on duplicate claim (AlreadyClaimed)", async function () {
      const { airdrop, recipient1, tree, AMOUNT_1 } = await loadFixture(activeAirdropFixture);
      const proof = tree.getProof(0);
      await airdrop.connect(recipient1).claim(AMOUNT_1, proof);
      await expect(airdrop.connect(recipient1).claim(AMOUNT_1, proof))
        .to.be.revertedWithCustomError(airdrop, "AlreadyClaimed");
    });

    it("reverts with InvalidProof for wrong amount", async function () {
      const { airdrop, recipient1, tree, AMOUNT_1 } = await loadFixture(activeAirdropFixture);
      const proof = tree.getProof(0);
      await expect(airdrop.connect(recipient1).claim(AMOUNT_1 + 1n, proof))
        .to.be.revertedWithCustomError(airdrop, "InvalidProof");
    });

    it("reverts with InvalidProof for wrong address", async function () {
      const { airdrop, other, tree, AMOUNT_1 } = await loadFixture(activeAirdropFixture);
      const proof = tree.getProof(0); // proof is for recipient1, not other
      await expect(airdrop.connect(other).claim(AMOUNT_1, proof))
        .to.be.revertedWithCustomError(airdrop, "InvalidProof");
    });

    it("reverts before root is set (NoActiveAirdrop)", async function () {
      const { airdrop, recipient1, tree, AMOUNT_1 } = await loadFixture(deployFixture);
      const proof = tree.getProof(0);
      await expect(airdrop.connect(recipient1).claim(AMOUNT_1, proof))
        .to.be.revertedWithCustomError(airdrop, "NoActiveAirdrop");
    });

    it("reverts after deadline (ClaimExpired)", async function () {
      const { airdrop, recipient1, tree, AMOUNT_1, deadline } =
        await loadFixture(activeAirdropFixture);
      const proof = tree.getProof(0);
      await time.increaseTo(deadline + 1);
      await expect(airdrop.connect(recipient1).claim(AMOUNT_1, proof))
        .to.be.revertedWithCustomError(airdrop, "ClaimExpired");
    });

    it("multiple recipients can each claim successfully", async function () {
      const { airdrop, token, recipient1, recipient2, recipient3, tree, AMOUNT_1, AMOUNT_2, AMOUNT_3 } =
        await loadFixture(activeAirdropFixture);

      await airdrop.connect(recipient1).claim(AMOUNT_1, tree.getProof(0));
      await airdrop.connect(recipient2).claim(AMOUNT_2, tree.getProof(1));
      await airdrop.connect(recipient3).claim(AMOUNT_3, tree.getProof(2));

      expect(await token.balanceOf(recipient1.address)).to.equal(AMOUNT_1);
      expect(await token.balanceOf(recipient2.address)).to.equal(AMOUNT_2);
      expect(await token.balanceOf(recipient3.address)).to.equal(AMOUNT_3);
      expect(await airdrop.totalClaimed()).to.equal(AMOUNT_1 + AMOUNT_2 + AMOUNT_3);
    });
  });

  // ── rescueUnclaimed ─────────────────────────────────────────────────────────

  describe("rescueUnclaimed", function () {
    it("transfers remaining SRX to admin after deadline and emits UnclaimedRescued", async function () {
      const { airdrop, token, admin, recipient1, tree, AMOUNT_1, TOTAL_AIRDROP, deadline } =
        await loadFixture(activeAirdropFixture);

      // recipient1 claims, others don't
      await airdrop.connect(recipient1).claim(AMOUNT_1, tree.getProof(0));

      await time.increaseTo(deadline + 1);

      const remaining  = TOTAL_AIRDROP - AMOUNT_1;
      const balBefore  = await token.balanceOf(admin.address);

      await expect(airdrop.connect(admin).rescueUnclaimed(admin.address))
        .to.emit(airdrop, "UnclaimedRescued")
        .withArgs(admin.address, remaining);

      expect(await token.balanceOf(admin.address)).to.equal(balBefore + remaining);
    });

    it("reverts before deadline (DeadlineNotPassed)", async function () {
      const { airdrop, admin } = await loadFixture(activeAirdropFixture);
      await expect(airdrop.connect(admin).rescueUnclaimed(admin.address))
        .to.be.revertedWithCustomError(airdrop, "DeadlineNotPassed");
    });

    it("reverts when nothing to rescue", async function () {
      const { airdrop, token, admin, recipient1, recipient2, recipient3, tree,
              AMOUNT_1, AMOUNT_2, AMOUNT_3, deadline } =
        await loadFixture(activeAirdropFixture);

      // All recipients claim
      await airdrop.connect(recipient1).claim(AMOUNT_1, tree.getProof(0));
      await airdrop.connect(recipient2).claim(AMOUNT_2, tree.getProof(1));
      await airdrop.connect(recipient3).claim(AMOUNT_3, tree.getProof(2));

      await time.increaseTo(deadline + 1);

      await expect(airdrop.connect(admin).rescueUnclaimed(admin.address))
        .to.be.revertedWithCustomError(airdrop, "NothingToRescue");
    });

    it("reverts on zero recipient address", async function () {
      const { airdrop, admin, deadline } = await loadFixture(activeAirdropFixture);
      await time.increaseTo(deadline + 1);
      await expect(airdrop.connect(admin).rescueUnclaimed(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(airdrop, "ZeroAddress");
    });

    it("reverts when called by non-admin", async function () {
      const { airdrop, other, admin, deadline } = await loadFixture(activeAirdropFixture);
      await time.increaseTo(deadline + 1);
      await expect(airdrop.connect(other).rescueUnclaimed(admin.address))
        .to.be.revertedWithCustomError(airdrop, "AccessControlUnauthorizedAccount");
    });
  });

  // ── Views ───────────────────────────────────────────────────────────────────

  describe("Views", function () {
    it("isActive() returns false after deadline", async function () {
      const { airdrop, deadline } = await loadFixture(activeAirdropFixture);
      await time.increaseTo(deadline + 1);
      expect(await airdrop.isActive()).to.be.false;
    });

    it("remainingBalance() reflects actual SRX in contract", async function () {
      const { airdrop, recipient1, tree, AMOUNT_1, TOTAL_AIRDROP } =
        await loadFixture(activeAirdropFixture);
      expect(await airdrop.remainingBalance()).to.equal(TOTAL_AIRDROP);
      await airdrop.connect(recipient1).claim(AMOUNT_1, tree.getProof(0));
      expect(await airdrop.remainingBalance()).to.equal(TOTAL_AIRDROP - AMOUNT_1);
    });
  });
});
