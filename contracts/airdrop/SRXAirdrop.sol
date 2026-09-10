// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { MerkleProof }   from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { IERC20 }        from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 }     from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SRXAirdrop
 * @notice Merkle-tree-based claimable airdrop for SRX tokens.
 *
 * Flow:
 *   1. Admin funds this contract with SRX.
 *   2. Admin calls setMerkleRoot(root, deadline) — this activates the airdrop.
 *      The Merkle tree leaves are chain-bound and double-hashed (SC-AD-001 + SC-AD-002):
 *        inner = keccak256(abi.encode(block.chainid, recipient, claimableAmount))
 *        leaf  = keccak256(inner)
 *      See the claim() NatSpec below for the exact encoding the off-chain tree
 *      generator MUST match. (Do NOT use the legacy abi.encodePacked(address, amount)
 *      single-hash form — proofs built that way will fail verification.)
 *   3. Eligible addresses call claim(amount, proof) to receive their SRX.
 *   4. After the deadline, admin calls rescueUnclaimed() to recover undistributed SRX.
 *
 * Multiple rounds:
 *   setMerkleRoot() can be called again after the previous deadline has passed,
 *   or to replace an active airdrop (admin responsibility to not accidentally
 *   invalidate ongoing claims). Each new root starts fresh — claimed[] is NOT
 *   reset, so previously claimed addresses cannot claim again in any round.
 *   Use a fresh recipient list per round, or deploy a new contract per round.
 *
 * Off-chain tooling:
 *   Use a standard Merkle tree library (e.g. the openzeppelin/merkle-tree JS package)
 *   to generate the tree and proofs from a CSV of (address, amount) pairs.
 *
 *   Leaf encoding follows the OpenZeppelin StandardMerkleTree convention with
 *   an added chain ID domain separator:
 *   - DOUBLE-HASH leaves to provide domain separation from internal node hashes
 *     (SC-AD-001 hardening — prevents second-preimage ambiguity).
 *   - Include block.chainid in the leaf to prevent cross-chain replay if the
 *     same Merkle root is ever deployed on multiple chains by accident
 *     (SC-AD-002 hardening).
 *
 *   Equivalent hand-rolled encoding (matches contract):
 *     const inner = keccak256(abi.encode(chainId, address, uint256))
 *     const leaf  = keccak256(inner)
 *
 * Role model:
 *   DEFAULT_ADMIN_ROLE — set Merkle root + deadline, rescue unclaimed tokens,
 *                        recover accidentally sent tokens other than SRX.
 */
contract SRXAirdrop is AccessControl {
    using SafeERC20 for IERC20;
    using MerkleProof for bytes32[];

    // ── Immutables ─────────────────────────────────────────────────────────────

    /// @notice The SRX token distributed by this contract.
    IERC20 public immutable srxToken;

    // ── State ──────────────────────────────────────────────────────────────────

    /// @notice Current active Merkle root. Zero bytes = no active airdrop.
    bytes32 public merkleRoot;

    /// @notice Unix timestamp after which claiming is closed and admin may rescue.
    uint256 public claimDeadline;

    /// @notice Total SRX claimed across all rounds.
    uint256 public totalClaimed;

    /// @notice Tracks whether an address has already claimed.
    ///         Persists across rounds — claimed addresses cannot claim again.
    mapping(address => bool) public claimed;

    // ── Events ─────────────────────────────────────────────────────────────────

    event AirdropConfigured(bytes32 indexed merkleRoot, uint256 deadline, uint256 timestamp);
    event Claimed(address indexed recipient, uint256 amount);
    event UnclaimedRescued(address indexed to, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error NoActiveAirdrop();
    error ClaimExpired();
    error AlreadyClaimed();
    error InvalidProof();
    error DeadlineNotPassed();
    error ZeroAddress();
    error ZeroAmount();
    error NothingToRescue();
    error DeadlineMustBeFuture();

    // ── Constructor ────────────────────────────────────────────────────────────

    /**
     * @param _srxToken  Address of the SRX ERC-20 token.
     * @param _admin     Initial admin (should be Treasury multisig on mainnet).
     */
    constructor(address _srxToken, address _admin) {
        if (_srxToken == address(0)) revert ZeroAddress();
        if (_admin    == address(0)) revert ZeroAddress();

        srxToken = IERC20(_srxToken);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    /**
     * @notice Activate or replace the airdrop with a new Merkle root and deadline.
     *         Fund this contract with SRX before calling.
     *
     * @param root     Merkle root of the (address → amount) distribution tree.
     * @param deadline Unix timestamp after which claiming closes. Must be in the future.
     */
    function setMerkleRoot(
        bytes32 root,
        uint256 deadline
    )
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (root     == bytes32(0))    revert NoActiveAirdrop();
        if (deadline <= block.timestamp) revert DeadlineMustBeFuture();

        merkleRoot    = root;
        claimDeadline = deadline;

        emit AirdropConfigured(root, deadline, block.timestamp);
    }

    /**
     * @notice Recover all remaining SRX after the claim deadline has passed.
     *         Transfers the full SRX balance to `to`.
     * @param to Recipient of the unclaimed tokens (typically Treasury).
     */
    function rescueUnclaimed(address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (block.timestamp <= claimDeadline) revert DeadlineNotPassed();
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = srxToken.balanceOf(address(this));
        if (balance == 0) revert NothingToRescue();

        srxToken.safeTransfer(to, balance);
        emit UnclaimedRescued(to, balance);
    }

    // ── Claim ──────────────────────────────────────────────────────────────────

    /**
     * @notice Claim SRX tokens included in the active airdrop.
     *
     *         Leaf encoding (must match off-chain tree generation):
     *           inner = keccak256(abi.encode(block.chainid, msg.sender, amount))
     *           leaf  = keccak256(inner)
     *
     *         The chain ID domain separator prevents cross-chain replay if the
     *         same Merkle root is ever set on multiple chain deployments by
     *         accident (SC-AD-002 fix). The double-hash provides domain
     *         separation from internal Merkle node hashes (SC-AD-001 fix).
     *         Together they implement the OpenZeppelin StandardMerkleTree
     *         convention plus a chain-specific hardening layer.
     *
     * @param amount Amount of SRX claimable by msg.sender (18-decimal).
     * @param proof  Merkle proof for the leaf (chainId, msg.sender, amount).
     */
    function claim(uint256 amount, bytes32[] calldata proof) external {
        if (merkleRoot == bytes32(0))       revert NoActiveAirdrop();
        if (block.timestamp > claimDeadline) revert ClaimExpired();
        if (claimed[msg.sender])             revert AlreadyClaimed();
        if (amount == 0)                     revert ZeroAmount();

        // Verify proof — chain-bound double-hash leaf (SC-AD-001 + SC-AD-002)
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(block.chainid, msg.sender, amount)))
        );
        if (!proof.verify(merkleRoot, leaf)) revert InvalidProof();

        // Mark claimed before transfer (CEI pattern)
        claimed[msg.sender]  = true;
        totalClaimed        += amount;

        srxToken.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    /// @notice Returns true if the airdrop is currently active and claimable.
    function isActive() external view returns (bool) {
        return merkleRoot != bytes32(0) && block.timestamp <= claimDeadline;
    }

    /// @notice SRX balance remaining in this contract for distribution.
    function remainingBalance() external view returns (uint256) {
        return srxToken.balanceOf(address(this));
    }
}
