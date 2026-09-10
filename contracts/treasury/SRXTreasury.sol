// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// ReentrancyGuardUpgradeable was removed in OZ v5.1+. Inline implementation below.

/**
 * @title SRXTreasury
 * @notice On-chain treasury for the Syrax DAO.
 *
 * Holds:
 *  - SRX Treasury & Ops allocation (900,000,000 SRX — 9% of supply)
 *  - Platform revenue converted to stablecoins/ETH (operational runway)
 *  - Any other assets received by the DAO
 *
 * Spend control:
 *  - ALL spend requires SPENDER_ROLE, which is held ONLY by the SRXTimelock.
 *  - The Timelock executes proposals passed by SRXGovernor.
 *  - No admin EOA can withdraw funds directly. No single point of control.
 *
 * Buy-and-Burn:
 *  - `executeBuyAndBurn()` is called quarterly by the Timelock.
 *  - It uses revenue (ETH/stablecoins in treasury) to buy SRX on-market,
 *    then calls SRXToken.buyAndBurn(). The market purchase itself happens
 *    off-chain; the treasury receives SRX, then burns it via this function.
 *  - All burns are permanently on-chain and publicly auditable.
 *
 * Transparency:
 *  - Every spend emits a Withdrawal event with a reason string.
 *  - Quarterly reporting is enforced by the community via governance.
 *
 * UUPS upgradeable — treasury logic can evolve as the DAO matures.
 */
contract SRXTreasury is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant SPENDER_ROLE    = keccak256("SPENDER_ROLE");    // Timelock only
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant PAUSER_ROLE     = keccak256("PAUSER_ROLE");     // GuardianModule
    /// @notice Authorises UUPS upgrades. SEPARATED from GOVERNANCE_ROLE (SC-TRUST-001 fix)
    ///         so upgrade authority can be homed exclusively on the SRXTimelock while
    ///         routine governance lives elsewhere. MUST be migrated to the Timelock and
    ///         revoked from the admin EOA before mainnet (enforced by verify_roles.js).
    bytes32 public constant UPGRADER_ROLE   = keccak256("UPGRADER_ROLE");   // Timelock only (post-migration)

    // ── State ──────────────────────────────────────────────────────────────────

    address public srxToken;

    /// @notice Local audit counter for SRX permanently burned via this treasury.
    ///         Canonical total-burned accounting lives in SRXToken.totalBurned which
    ///         is updated by every buyAndBurn() call regardless of caller (A3-L-02).
    uint256 public totalBurned;
    uint256 public totalSpentSRX;

    // ── Reentrancy guard (inline — ReentrancyGuardUpgradeable removed in OZ v5.1+) ──

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED     = 2;
    uint256 private _status;

    /// @dev Storage gap for future upgrades (R7-1 + SC-UUPS-001 fix).
    ///
    ///      DISCIPLINE: Every upgrade that adds N new state variables MUST shrink this
    ///      gap by exactly N (50 → 48 for two new variables). Append new state ABOVE
    ///      this gap, then update the size literal. Wrong shrinkage causes storage
    ///      slot collision on subsequent upgrades — data corruption.
    ///
    ///      VERIFICATION: Every upgrade PR must run `hardhat-upgrades` validateUpgrade
    ///      and the upgrade runbook must include a "Storage Layout Diff" section.
    // solhint-disable-next-line var-name-mixedcase
    uint256[50] private __gap;

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    event Withdrawal(
        address indexed token,
        address indexed recipient,
        uint256 amount,
        string  reason
    );
    event ETHWithdrawal(address indexed recipient, uint256 amount, string reason);
    event BuyAndBurnExecuted(uint256 srxAmount, uint256 timestamp);
    event Received(address indexed sender, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance();
    error EmptyReason();

    // ── Initializer ────────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _srxToken,
        address _admin,
        address _timelock
    ) external initializer {
        if (_srxToken == address(0) || _admin == address(0) || _timelock == address(0))
            revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        _status = _NOT_ENTERED;

        // SC-UUPS-002 fix: set state BEFORE granting roles (defensive ordering).
        srxToken = _srxToken;

        // Grant roles LAST — after state is fully consistent
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNANCE_ROLE,    _admin);
        _grantRole(PAUSER_ROLE,        _admin);
        _grantRole(SPENDER_ROLE,       _timelock); // Only timelock can spend
        // SC-TRUST-001 fix: upgrade authority is granted to the Timelock directly
        // (its address is known at init here). Admin also receives it for deployment
        // bootstrap and must be revoked post-migration (verify_roles.js enforces this).
        _grantRole(UPGRADER_ROLE,      _timelock);
        _grantRole(UPGRADER_ROLE,      _admin);
    }

    // ── Pause ─────────────────────────────────────────────────────────────────

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ── Receive ETH ───────────────────────────────────────────────────────────

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    // ── Governance spend ───────────────────────────────────────────────────────

    /**
     * @notice Transfer ERC-20 tokens from the treasury. Timelock (SPENDER_ROLE) only.
     * @param token     ERC-20 token address (SRX, USDC, etc.).
     * @param recipient Destination address.
     * @param amount    Amount to transfer.
     * @param reason    Short description for on-chain transparency (required).
     */
    function withdraw(
        address token,
        address recipient,
        uint256 amount,
        string calldata reason
    ) external onlyRole(SPENDER_ROLE) nonReentrant whenNotPaused {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0)             revert ZeroAmount();
        if (bytes(reason).length == 0) revert EmptyReason();

        if (token == srxToken) totalSpentSRX += amount;

        IERC20(token).safeTransfer(recipient, amount);
        emit Withdrawal(token, recipient, amount, reason);
    }

    /**
     * @notice Transfer ETH from the treasury. Timelock (SPENDER_ROLE) only.
     */
    function withdrawETH(
        address payable recipient,
        uint256 amount,
        string calldata reason
    ) external onlyRole(SPENDER_ROLE) nonReentrant whenNotPaused {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0)             revert ZeroAmount();
        if (bytes(reason).length == 0) revert EmptyReason();
        if (address(this).balance < amount) revert InsufficientBalance();

        (bool success, ) = recipient.call{ value: amount }("");
        require(success, "ETH transfer failed");

        emit ETHWithdrawal(recipient, amount, reason);
    }

    // ── Buy-and-Burn ───────────────────────────────────────────────────────────

    /**
     * @notice Execute the quarterly buy-and-burn.
     *
     * Precondition: The treasury must already hold the SRX to burn. The actual
     * open-market purchase is done off-chain; the proceeds (SRX) are sent to
     * this contract before calling this function. Governance passes a proposal
     * authorizing the burn of a specific amount.
     *
     * The SRXToken's BURN_ROLE must be granted to this treasury contract.
     * buyAndBurn() burns from msg.sender's own balance (A3-H-01 fix — aligned with
     * A2-H-01 which removed the arbitrary `from` parameter from SRXToken.buyAndBurn).
     *
     * @param amount SRX amount to burn (18-decimal).
     */
    function executeBuyAndBurn(uint256 amount)
        external
        onlyRole(SPENDER_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();

        totalBurned += amount;

        ISRXToken(srxToken).buyAndBurn(amount);

        emit BuyAndBurnExecuted(amount, block.timestamp);
    }

    // ── View ───────────────────────────────────────────────────────────────────

    function srxBalance() external view returns (uint256) {
        return IERC20(srxToken).balanceOf(address(this));
    }

    function ethBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function tokenBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    // ── UUPS ───────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImpl) internal override onlyRole(UPGRADER_ROLE) {}
}

// ── Minimal SRX token interface ────────────────────────────────────────────────

interface ISRXToken {
    /// @dev Burns `amount` from the caller's (msg.sender's) balance.
    ///      A2-H-01 removed the `address from` parameter — BURN_ROLE holders
    ///      can only burn tokens they hold, not arbitrary third-party balances.
    function buyAndBurn(uint256 amount) external;
}
