// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ISRXBurnable } from "../token/ISRXBurnable.sol";
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
 *  - No admin EOA can withdraw funds directly. No single point of control for spending.
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
 * ⛔ NOT UPGRADEABLE (REG-53, Jared, 12 Oct 2026). A plain contract: its code can never
 *    change and no role can replace it. The pause (PAUSER_ROLE, held by GuardianModule)
 *    stays. A fix ships as a new contract that holders choose to move to
 *    (docs/MIGRATION.md), never as a forced or in-place change.
 */
contract SRXTreasury is AccessControl, Pausable {
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant SPENDER_ROLE    = keccak256("SPENDER_ROLE");    // Timelock only
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant PAUSER_ROLE     = keccak256("PAUSER_ROLE");     // GuardianModule

    // ── State ──────────────────────────────────────────────────────────────────

    address public immutable srxToken;

    /// @notice Local audit counter for SRX permanently burned via this treasury.
    ///         Canonical total-burned accounting lives in SRXToken.totalBurned which
    ///         is updated by every buyAndBurn() call regardless of caller (A3-L-02).
    uint256 public totalBurned;
    uint256 public totalSpentSRX;

    // ── Reentrancy guard (inline — ReentrancyGuardUpgradeable removed in OZ v5.1+) ──

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED     = 2;
    uint256 private _status;


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

    // ── Constructor ────────────────────────────────────────────────────────────


    constructor(
        address _srxToken,
        address _admin,
        address _timelock
    ) {
        if (_srxToken == address(0) || _admin == address(0) || _timelock == address(0))
            revert ZeroAddress();

        _status = _NOT_ENTERED;

        // Set state BEFORE granting roles (defensive ordering, SC-UUPS-002).
        srxToken = _srxToken;

        // Grant roles LAST — after state is fully consistent
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNANCE_ROLE,    _admin);
        _grantRole(PAUSER_ROLE,        _admin);
        _grantRole(SPENDER_ROLE,       _timelock); // Only timelock can spend
        // SC-TRUST-001, enforced in code (45d8fd15, 1 Oct 2026): spending authority
        // administers itself, so DEFAULT_ADMIN_ROLE cannot hand it out. Only the Timelock
        // ever holds SPENDER_ROLE, so the Safe can never become a spender, even before the
        // launch hand-over.
        _setRoleAdmin(SPENDER_ROLE,  SPENDER_ROLE);
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
    // slither-disable-next-line arbitrary-send-eth -- reviewed 8 Oct 2026: the recipient is chosen by SPENDER_ROLE, which only the 48 h Timelock holds after the hand-over (verify_roles); nonReentrant. Sending treasury ETH to a chosen address is the function's purpose
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

        ISRXBurnable(srxToken).buyAndBurn(amount);

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

    // ── Internal ───────────────────────────────────────────────────────────────

}

// ── Minimal SRX token interface ────────────────────────────────────────────────

