// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title TGEDistributor
 * @notice One-shot genesis distribution of the full SRX supply.
 *
 * Flow:
 *  1. Deploy all VestingVaults and other allocation contracts.
 *  2. Deploy TGEDistributor with their addresses and allocation amounts.
 *  3. Call SRXToken.genesis(address(tgeDistributor)) — mints 10B SRX here.
 *  4. Call TGEDistributor.distribute() — sends each allocation to its
 *     destination and verifies the total matches MAX_SUPPLY. This function
 *     does NOT trigger TGE on vesting vaults.
 *  5. Start each vault's clock with VestingVault.triggerTGE(). The launch vaults'
 *     admin is the SRXTimelock, so this is a scheduled Timelock operation
 *     (scripts/deploy/lib/vaultOps.js, prepared by steps 03 and 06), not something
 *     this contract or the deploy script's signer can do directly.
 *  6. distribute() is one-shot — after the first successful call, the `distributed`
 *     flag is permanently set, blocking any re-entry or re-distribution (A5-I-01).
 *
 * Allocation breakdown: the amounts, destinations and vesting schedules live in
 * scripts/deploy/00_config.js (ALLOCATIONS, VESTING and TGE_PLAN: six vesting
 * vaults, direct contract and wallet rows) and are published, generated from that
 * file, in docs/TOKENOMICS.md. They always sum to MAX_SUPPLY (10,000,000,000 SRX).
 */
contract TGEDistributor {
    using SafeERC20 for IERC20;

    // ── Struct ─────────────────────────────────────────────────────────────────

    struct Allocation {
        address destination;
        uint256 amount;
        bool    isVestingVault; // reserved for off-chain tracking; triggerTGE() is a separate Timelock operation
        string  label;
    }

    // ── Constants ──────────────────────────────────────────────────────────────

    uint256 public constant MAX_SUPPLY = 10_000_000_000 * 10 ** 18;

    // ── Immutables ─────────────────────────────────────────────────────────────

    address public immutable admin;
    IERC20  public immutable token;

    // ── State ──────────────────────────────────────────────────────────────────

    Allocation[] public allocations;
    bool         public distributed;

    // ── Events ─────────────────────────────────────────────────────────────────

    event AllocationSent(string indexed label, address indexed destination, uint256 amount);
    event DistributionComplete(uint256 totalDistributed, uint256 timestamp);
    event AllocationsSet(uint256 count, uint256 totalAmount, uint256 timestamp);
    /// @notice Tokens left here after distribution were recovered (sweep 22 Oct, Info).
    event TokenRecovered(address indexed token, address indexed recipient, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error OnlyAdmin();
    error AlreadyDistributed();
    error NotDistributed();
    error SupplyMismatch(uint256 expected, uint256 actual);
    error ZeroAddress();
    error TokenBalanceInsufficient();
    /// @notice distribute() was called before setAllocations().
    error NoAllocationsSet();

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _token, address _admin) {
        if (_token == address(0) || _admin == address(0)) revert ZeroAddress();
        token = IERC20(_token);
        admin = _admin;
    }

    // ── Config ─────────────────────────────────────────────────────────────────

    /**
     * @notice Register all allocations before distribution. Must be called by admin.
     *         The sum of all amounts must equal MAX_SUPPLY exactly.
     *         Call order matches the table in the natspec above.
     */
    function setAllocations(Allocation[] calldata _allocations) external {
        if (msg.sender != admin) revert OnlyAdmin();
        if (distributed)        revert AlreadyDistributed();

        delete allocations;

        uint256 total = 0;
        for (uint256 i; i < _allocations.length; ++i) {
            if (_allocations[i].destination == address(0)) revert ZeroAddress();
            allocations.push(_allocations[i]);
            total += _allocations[i].amount;
        }

        if (total != MAX_SUPPLY) revert SupplyMismatch(MAX_SUPPLY, total);

        // Emit a record of the allocation set so any overwrite is visible on-chain.
        // Without this event, a second call to setAllocations() would silently replace
        // the first with no on-chain audit trail (A2-L-06 fix).
        emit AllocationsSet(allocations.length, total, block.timestamp);
    }

    // ── Distribution ───────────────────────────────────────────────────────────

    /**
     * @notice Distribute all allocations to their configured destinations.
     *
     * Prerequisites:
     *  - SRXToken.genesis(address(this)) must have been called first.
     *  - setAllocations() must have been called with a valid allocation set.
     *
     * After this call:
     *  - All destinations have received their SRX allocation.
     *  - This contract holds zero SRX.
     *  - distributed flag is set — no re-entry possible.
     *
     * ⚠️  This function does NOT call triggerTGE() on vesting vaults. Their admin is
     *     the SRXTimelock, so starting each clock is a scheduled Timelock operation
     *     (vaultOps.js), which 06_execute_tge.js checks is ready before it sends
     *     anything (M-03).
     */
    function distribute() external {
        if (msg.sender != admin) revert OnlyAdmin();
        if (distributed)        revert AlreadyDistributed();

        uint256 balance = token.balanceOf(address(this));
        if (balance < MAX_SUPPLY) revert TokenBalanceInsufficient();

        // ⛔ THIS RAN HAPPILY WITH NO ALLOCATIONS AT ALL AND BURNED THE ONE-SHOT
        //    FLAG DOING IT. setAllocations() enforces `total == MAX_SUPPLY`, but
        //    nothing required it to have been CALLED. distribute() before it left
        //    an empty loop, set distributed = true, and closed the intended path
        //    permanently -- setAllocations() then reverts AlreadyDistributed, and
        //    so does distribute(). The only remaining move is recoverToken(),
        //    sweeping all 10,000,000,000 SRX to a single arbitrary address.
        //    Proven in test/audit-poc/vesting-and-distribution.test.js.
        if (allocations.length == 0) revert NoAllocationsSet();

        distributed = true;

        uint256 totalSent = 0;
        for (uint256 i; i < allocations.length; ++i) {
            Allocation memory alloc = allocations[i];

            token.safeTransfer(alloc.destination, alloc.amount);
            totalSent += alloc.amount;

            emit AllocationSent(alloc.label, alloc.destination, alloc.amount);
        }

        // ⭐ Re-checked HERE and not only in setAllocations(). The invariant that
        //    matters is what this function actually moved, and asserting it at the
        //    point of movement means a future edit to the allocation path cannot
        //    quietly bypass it. The whole supply passes through this loop once.
        if (totalSent != MAX_SUPPLY) revert SupplyMismatch(MAX_SUPPLY, totalSent);

        emit DistributionComplete(totalSent, block.timestamp);
    }

    /**
     * @notice Total SRX the allocation set routes to `destination` (sent, once
     *         `distributed` is true).
     * @dev REG-50: SRXStaking and StabilisationFund read this, after distribution, to
     *      learn exactly how much of their SRX came from the launch allocation. That,
     *      and nothing that arrives later (fee revenue, buy-back proceeds, a plain
     *      transfer), is all their reward pools can ever be backed by.
     */
    function allocatedTo(address destination) external view returns (uint256 total) {
        for (uint256 i; i < allocations.length; ++i) {
            if (allocations[i].destination == destination) total += allocations[i].amount;
        }
    }

    /**
     * @notice Emergency recovery of any tokens accidentally sent to this contract
     *         after distribution is complete.
     */
    function recoverToken(address _token, address recipient) external {
        if (msg.sender != admin)      revert OnlyAdmin();
        if (!distributed)             revert NotDistributed(); // only callable after distribution
        if (recipient == address(0))  revert ZeroAddress();
        uint256 bal = IERC20(_token).balanceOf(address(this));
        if (bal > 0) {
            IERC20(_token).safeTransfer(recipient, bal);
            emit TokenRecovered(_token, recipient, bal);
        }
    }
}

