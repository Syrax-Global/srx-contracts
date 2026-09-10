// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Minimal interface for the SRX burn path. ZkSyncMigrator must hold
///      BURN_ROLE on SRXToken so that buyAndBurn() is callable and totalBurned
///      is updated correctly (M-05 fix).
///
///      buyAndBurn() burns from msg.sender's own balance (A2-H-01 fix). The migrator
///      must therefore pull tokens from the user first, then call buyAndBurn() to
///      burn its own held balance.
interface ISRXBurnable {
    function buyAndBurn(uint256 amount) external;
}

/**
 * @title ZkSyncMigrator
 * @notice Strategy A — Burn-to-Migrate for the Syrax Chain (zkSync-based) transition.
 *
 * When the Syrax Chain launches, SRX transitions from an OFT bridged token to the
 * native gas/staking/governance asset of the new chain. This contract facilitates
 * that transition using a burn-and-claim model.
 *
 * Migration flow (Strategy A):
 *  1. User approves ZkSyncMigrator to spend their SRX (on any supported chain).
 *  2. User calls migrate(amount). Tokens are burned. A MigrationRequest event fires.
 *  3. The Syrax Chain bridge oracle (operated by Syrax Global FZCO or DAO after
 *     decentralization) monitors migration events and issues equivalent native SRX
 *     on the Syrax Chain to the same address.
 *  4. A unique migrationId is returned for user tracking and oracle matching.
 *
 * Why Strategy A over Strategy B (snapshot-airdrop)?
 *  ┌──────────────────────┬─────────────────────────┬───────────────────────────┐
 *  │                      │ Strategy A (this)       │ Strategy B (snapshot)     │
 *  ├──────────────────────┼─────────────────────────┼───────────────────────────┤
 *  │ Supply integrity     │ ✅ Burn matches mint     │ ⚠️ Snapshot disputes      │
 *  │ User effort          │ Active (must call)      │ Passive (automatic)       │
 *  │ Bridge exploit risk  │ ✅ Burn is atomic       │ ⚠️ Snapshot window risk   │
 *  │ Exchange complexity  │ Coordinated with CEXs   │ Requires CEX pause        │
 *  │ Regulatory clarity   │ ✅ Clear burn event     │ ⚠️ Airdrop tax questions  │
 *  └──────────────────────┴─────────────────────────┴───────────────────────────┘
 *
 * Deployment notes:
 *  - Deployed on Ethereum mainnet (and optionally BSC/zkSync testnet OFT chains).
 *  - The admin enables migration only when the Syrax Chain is live.
 *  - Migration window can be closed by governance after a defined period.
 *  - Users who miss the window can still claim via a governance snapshot (fallback).
 *
 * Oracle security:
 *  The bridge oracle verifies each MigrationRequest event using:
 *  - Block finality confirmation (≥64 blocks on Ethereum)
 *  - migrationId uniqueness check on the Syrax Chain
 *  - Amount matches burn log exactly
 *  Oracle operator must be replaced by a decentralized bridge (e.g. LayerZero)
 *  once the Syrax Chain has its own endpoint configured.
 */
contract ZkSyncMigrator is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant ORACLE_ROLE     = keccak256("ORACLE_ROLE");

    // ── State ──────────────────────────────────────────────────────────────────

    IERC20  public immutable srxToken;
    bool    public migrationEnabled;
    bool    public migrationClosed;

    uint256 public totalMigrated;
    uint256 public migrationCount;

    // migrationId => confirmed on Syrax Chain
    mapping(uint256 => bool) public confirmed;

    // migrationId => original migrating user (A4-L-01: used to validate confirmMigration)
    mapping(uint256 => address) public migrationUser;

    // user => total migrated amount (for user-facing dashboards)
    mapping(address => uint256) public userMigrated;

    // ── Events ─────────────────────────────────────────────────────────────────

    /**
     * @notice Emitted when a user burns SRX for migration.
     *         Bridge oracle listens to this event and mints native SRX on Syrax Chain.
     */
    /// @dev `srcChainId` is emitted explicitly as well as encoded in the high bits
    ///      of `migrationId`. A consumer should never have to decode an id to know
    ///      which chain a request came from.
    event MigrationRequest(
        uint256 indexed migrationId,
        address indexed user,
        uint256 amount,
        uint256 timestamp,
        uint256 srcChainId
    );

    event MigrationConfirmed(uint256 indexed migrationId, address indexed user);
    event MigrationEnabled(uint256 timestamp);
    event MigrationClosed(uint256 timestamp, uint256 totalMigrated);
    event TokensRescued(address indexed token, address indexed recipient, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error MigrationNotEnabled();
    error MigrationWindowClosed();
    error AlreadyEnabled();
    error AlreadyClosed();
    error ZeroAmount();
    error ZeroAddress();
    error AlreadyConfirmed();
    error UserMismatch(uint256 migrationId, address expected, address provided); // A4-L-01
    error InvalidMigrationId(uint256 migrationId); // A6-ZK-01: ID was never created by migrate()

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _srxToken, address _admin) {
        if (_srxToken == address(0) || _admin == address(0)) revert ZeroAddress();
        srxToken = IERC20(_srxToken);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNANCE_ROLE,    _admin);
    }

    // ── User migration ─────────────────────────────────────────────────────────

    /**
     * @notice Burn SRX on this chain in exchange for native SRX on the Syrax Chain.
     *
     * The user MUST have approved this contract to spend `amount` SRX before calling.
     * Tokens are pulled from the user's wallet into this contract, then destroyed via
     * SRXToken.buyAndBurn(). This two-step pull-then-burn pattern ensures BURN_ROLE
     * can only burn tokens the caller holds, not arbitrary third-party wallets (A2-H-01).
     *
     * After burning, the bridge oracle detects the MigrationRequest event and
     * issues equivalent native SRX on the Syrax Chain to msg.sender.
     *
     * ⚠️  PAUSE INTERACTION (A6-TK-04): If SRXToken is paused, the `buyAndBurn()`
     *     call at step 2 will revert because SRXToken._update() is gated by
     *     `whenNotPaused`. Migration is therefore blocked while SRXToken is paused.
     *     Users should wait for SRXToken to be unpaused before attempting migration.
     *
     * @param amount SRX to burn (18-decimal). Must be > 0.
     * @return migrationId Unique ID for tracking this request on the Syrax Chain.
     */
    function migrate(uint256 amount) external nonReentrant returns (uint256 migrationId) {
        if (!migrationEnabled)  revert MigrationNotEnabled();
        if (migrationClosed)    revert MigrationWindowClosed();
        if (amount == 0)        revert ZeroAmount();

        // ⛔ THIS WAS A BARE COUNTER, SO EVERY CHAIN PRODUCED THE SAME IDs.
        //    Two deployments emitted BYTE-IDENTICAL MigrationRequest payloads for
        //    the same user and amount -- same id, same user, same amount -- with
        //    nothing binding a request to the chain it came from. The bridge
        //    oracle mints native SRX from this event, so a request observed on one
        //    chain is indistinguishable from the same request on another, and a
        //    signed or relayed one replays. Proven in
        //    test/audit-poc/migration-replay.test.js case 3.
        //
        // ⭐ The chain id occupies the high 128 bits and the local counter the low
        //    128, so ids stay uint256 and monotonic per chain while being globally
        //    unique. Every chain id in use is far below 2^128.
        unchecked { ++migrationCount; }
        migrationId = (block.chainid << 128) | migrationCount;

        totalMigrated             += amount;
        userMigrated[msg.sender]  += amount;
        migrationUser[migrationId] = msg.sender; // A4-L-01: snapshot for oracle validation

        // Step 1: Pull tokens from user into this contract (requires prior approval).
        srxToken.safeTransferFrom(msg.sender, address(this), amount);

        // Step 2: Burn from this contract's balance via buyAndBurn().
        // ZkSyncMigrator must hold BURN_ROLE on SRXToken. buyAndBurn() burns from
        // msg.sender (this contract), so only the migrator's own held balance is
        // consumed — no arbitrary address burns possible (A2-H-01 fix).
        ISRXBurnable(address(srxToken)).buyAndBurn(amount);

        emit MigrationRequest(migrationId, msg.sender, amount, block.timestamp, block.chainid);
    }

    // ── Oracle confirmation ────────────────────────────────────────────────────

    /**
     * @notice Called by the bridge oracle after native SRX has been issued on
     *         the Syrax Chain. Used for on-chain bookkeeping and user confirmation.
     *
     *         The `user` parameter must match the address that originally called
     *         migrate() for this migrationId. This prevents a malicious oracle
     *         from emitting MigrationConfirmed for a different address, which could
     *         mislead off-chain dashboards or downstream contracts (A4-L-01 fix).
     */
    function confirmMigration(uint256 migrationId, address user)
        external
        onlyRole(ORACLE_ROLE)
    {
        if (confirmed[migrationId]) revert AlreadyConfirmed();
        // A6-ZK-01: reject confirmation of a migrationId that was never created by migrate().
        // Without this, an oracle passing user=address(0) could pre-confirm future sequential
        // IDs (since migrationUser[id] defaults to address(0)), permanently poisoning them.
        address expected = migrationUser[migrationId];
        if (expected == address(0)) revert InvalidMigrationId(migrationId);
        if (user != expected) revert UserMismatch(migrationId, expected, user);
        confirmed[migrationId] = true;
        emit MigrationConfirmed(migrationId, user);
    }

    // ── Admin / Governance ─────────────────────────────────────────────────────

    /**
     * @notice Enable the migration window. Called by governance when Syrax Chain is live.
     *         This is a one-way gate — once enabled it cannot be re-disabled,
     *         only closed (permanently).
     */
    /**
     * @notice Recover tokens sent to this contract by mistake.
     * @dev ⛔ NO RESCUE EXISTED, so anything sent here directly was lost forever.
     *      Proven in test/audit-poc/migration-replay.test.js case 4, and it also
     *      drove case 5: a stranded balance combined with SRXToken's
     *      maxWalletBalance could brick migrate() for everyone, because the
     *      transferFrom into this contract would push it over the cap.
     *
     * ⭐ Safe for SRX specifically because migrate() pulls and burns within the
     *    SAME transaction -- this contract is never a custodian between calls, so
     *    any SRX balance sitting here is by definition stray. There is no user
     *    position to drain.
     * @param token     Token to recover.
     * @param recipient Where to send it. Must not be the zero address.
     */
    function rescueTokens(address token, address recipient)
        external
        onlyRole(GOVERNANCE_ROLE)
        nonReentrant
    {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(recipient, balance);
        emit TokensRescued(token, recipient, balance);
    }

    function enableMigration() external onlyRole(GOVERNANCE_ROLE) {
        if (migrationEnabled)  revert AlreadyEnabled();
        migrationEnabled = true;
        emit MigrationEnabled(block.timestamp);
    }

    /**
     * @notice Permanently close the migration window.
     *         After this, no new burns are accepted. Unclaimed allocations
     *         revert to governance via a snapshot-based fallback (off-chain).
     */
    function closeMigration() external onlyRole(GOVERNANCE_ROLE) {
        if (!migrationEnabled) revert MigrationNotEnabled();
        if (migrationClosed)   revert AlreadyClosed();
        migrationClosed = true;
        emit MigrationClosed(block.timestamp, totalMigrated);
    }

    // ── View ───────────────────────────────────────────────────────────────────

    function getUserMigrated(address user) external view returns (uint256) {
        return userMigrated[user];
    }
}
