// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title FeeController
 * @notice Calculates the effective fee for a payment on the Syrax platform.
 *
 * The Syrax gateway backend calls `calculateFee()` via an RPC read (eth_call)
 * at payment initiation time. No transaction is required — this is a pure view
 * computation. This design keeps gas costs off the payment flow entirely.
 *
 * Fee logic:
 *  effectiveFee = baseFee * (BPS_DENOMINATOR - discountBps) / BPS_DENOMINATOR
 *
 * The result is clamped to [MIN_FEE_BPS, MAX_FEE_BPS]: a 0.15% floor that applies even at
 * a 100% discount (Obsidian pays the floor, not zero), and a 5% ceiling. ⛔ REG-54 (Jared,
 * 12 Oct 2026): both are constants. They were governance-adjustable (the floor down to 0,
 * the ceiling up to 100%), which contradicted the whitepaper's "a discount never takes a
 * fee below 0.15%". Governance still sets the base rate and the crypto multiplier, but
 * only between them.
 *
 * Payment type multipliers:
 *  - Fiat payments:     100% of base fee (standard)
 *  - Non-SRX crypto:    75% of base fee (reduced, rounded down)
 *  - SRX payments:      0%  of base fee (always free regardless of tier)
 *
 * Staking tier discounts apply on top of the payment-type multiplier for
 * non-SRX crypto payments. SRX payments are always zero-fee.
 *
 * The base rate, crypto multiplier, tiers and routing are governance-adjustable via the
 * timelock; the floor and ceiling are not.
 *
 * ⛔ NOT UPGRADEABLE (REG-53, Jared, 12 Oct 2026). A plain contract: its code can never
 *    change and no role can replace it. The pause (PAUSER_ROLE, held by GuardianModule)
 *    stays. A fix ships as a new contract that holders choose to move to
 *    (docs/MIGRATION.md), never as a forced or in-place change.
 *    Fee parameters remain governance-adjustable through the Timelock; only the code
 *    is fixed.
 */
contract FeeController is AccessControl, Pausable {

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    // GATEWAY_ROLE is defined but gates no function today: calculateFee() is a public
    // view, so the backend needs no role. Reserved for a future write path; verify_roles.js
    // only checks that the deployer key does not hold it.
    bytes32 public constant GATEWAY_ROLE    = keccak256("GATEWAY_ROLE");
    bytes32 public constant PAUSER_ROLE     = keccak256("PAUSER_ROLE");  // GuardianModule

    // ── Payment type enum ──────────────────────────────────────────────────────

    enum PaymentType { Fiat, Crypto, SRX }

    // ── Constants ──────────────────────────────────────────────────────────────

    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ── State ──────────────────────────────────────────────────────────────────

    address public stakingContract;

    uint256 public baseFeeRateBps;         // Default: 150 = 1.50%
    uint256 public cryptoFeeMultiplierBps; // Default: 7500 = 75% of base fee
    // SRX payment fee is always 0 — not a configurable parameter.

    /// @notice The fee floor, 0.15%. Fixed in code (REG-54): no role can change it.
    uint256 public constant MIN_FEE_BPS = 15;
    /// @notice The fee ceiling, 5%. Fixed in code (REG-54): no role can change it.
    uint256 public constant MAX_FEE_BPS = 500;

    // ── Fee distribution routing table ─────────────────────────────────────────
    //
    // Governance configures how collected platform fee revenue should be split
    // across destinations (e.g. Treasury, AutoBurn contract).
    // This table is read by the gateway backend (eth_call) and by any future
    // on-chain FeeRouter contract. No money moves through FeeController itself —
    // it is a pure calculator. The routing table lets new destinations (for example
    // auto-burn) be wired without deploying a new contract.
    // ⛔ REG-50 (11 Oct 2026): fee revenue never funds SRX holder rewards. Staking and
    //    StabilisationFund rewards can only be backed by their launch allocations, so a
    //    destination pointed at either contract cannot become rewards; it would only
    //    strand the fees there. Route fees to the Treasury or the buy-back.
    //
    // Invariant enforced by governance: when active destinations are summed they
    // must equal BPS_DENOMINATOR (10,000). validateFeeDistribution() checks this.

    struct FeeDestination {
        address recipient;  // Where this slice of fee revenue should be sent
        uint256 shareBps;   // Share of total fee revenue (out of 10,000)
        bytes32 label;      // Human-readable label encoded as bytes32 (e.g. "Treasury")
        bool    active;     // Inactive destinations are skipped in routing
    }

    uint256 public constant MAX_FEE_DESTINATIONS = 8;

    mapping(uint256 => FeeDestination) public feeDestinations;
    uint256 public feeDestinationCount;


    // ── Events ─────────────────────────────────────────────────────────────────

    event BaseFeeUpdated(uint256 oldBps, uint256 newBps);
    event CryptoMultiplierUpdated(uint256 oldBps, uint256 newBps);
    event StakingContractUpdated(address oldAddr, address newAddr);
    event FeeDestinationUpdated(uint256 indexed index, address recipient, uint256 shareBps, bool active, bytes32 label);
    event FeeDistributionCommitted(uint256 totalBps, uint256 timestamp);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidBps();
    error DestinationIndexOutOfBounds();
    error TooManyDestinations();
    error FeeDistributionInvalid(uint256 totalBps);

    // ── Constructor ────────────────────────────────────────────────────────────


    constructor(
        address _stakingContract,
        address _admin
    ) {
        if (_stakingContract == address(0) || _admin == address(0)) revert ZeroAddress();


        // Set state BEFORE granting roles (defensive ordering, SC-UUPS-002).
        stakingContract      = _stakingContract;
        baseFeeRateBps       = 150;   // 1.50%
        cryptoFeeMultiplierBps = 7_500; // 75% of base fee
        // Non-zero floor so a 100% (Obsidian-tier) discount never means a literal
        // $0 fee at scale -- Obsidian still pays ~10% of the fiat base fee (~13%
        // of the discounted crypto base), i.e. a ~90% discount, not "free
        // forever." Without this floor, platform fee revenue trends to zero
        // as adoption grows and more holders reach Obsidian -- the opposite of
        // what a fee model should do. The floor and ceiling are constants (REG-54).

        // Grant roles LAST — after state is fully consistent
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNANCE_ROLE,    _admin);
        _grantRole(PAUSER_ROLE,        _admin);
    }

    // ── Pause ──────────────────────────────────────────────────────────────────

    /// @notice paused() is the stop signal the payment gateway reads before it accepts a
    ///         payment. Since 22 Oct 2026 the fee reads keep answering while paused (a read
    ///         changes nothing), so the gateway can still show what a fee would be.
    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ── Core fee calculation ───────────────────────────────────────────────────

    /**
     * @notice Calculate the effective fee for a payment.
     * @param payer       Address of the paying user (used to look up staking tier).
     * @param paymentType Fiat, Crypto, or SRX.
     * @return feeBps     Effective fee in basis points.
     *
     * This is a pure view — the gateway calls it via eth_call at no gas cost.
     *
     * ⛔ External report, 22 Oct 2026 (Low): this and feeBreakdown carried whenNotPaused,
     *    so a paused FeeController made every fee READ revert, including the SRX case,
     *    which is always 0. A pause stops state changes; a read changes nothing, and a
     *    gateway that cannot read the fee cannot even show it. Pause no longer applies.
     */
    function calculateFee(address payer, PaymentType paymentType)
        external
        view
        returns (uint256 feeBps)
    {
        // SRX payments are always zero-fee — this is a core utility promise.
        if (paymentType == PaymentType.SRX) return 0;

        // Crypto base reduction and staking tier discount, rounded once (see _effectiveBps).
        uint256 effective = _effectiveBps(paymentType, _getDiscount(payer));

        // Clamp to [MIN_FEE_BPS, MAX_FEE_BPS] — applies even for Obsidian tier (0 fee clamped to floor)
        if (effective < MIN_FEE_BPS) return MIN_FEE_BPS;
        if (effective > MAX_FEE_BPS) return MAX_FEE_BPS;

        return effective;
    }

    /**
     * @notice Returns a human-readable fee breakdown for a payer.
     *         Useful for the gateway UI to display expected fees.
     */
    function feeBreakdown(address payer, PaymentType paymentType)
        external
        view
        returns (
            uint256 baseBps,
            uint256 discountBps,
            uint256 effectiveBps,
            string memory tierName
        )
    {
        if (paymentType == PaymentType.SRX) {
            return (0, 10_000, 0, "SRX");
        }

        baseBps = paymentType == PaymentType.Fiat
            ? baseFeeRateBps
            : (baseFeeRateBps * cryptoFeeMultiplierBps) / BPS_DENOMINATOR;

        discountBps = _getDiscount(payer);
        effectiveBps = _effectiveBps(paymentType, discountBps); // the same figure calculateFee charges

        // Clamp
        if (effectiveBps < MIN_FEE_BPS) effectiveBps = MIN_FEE_BPS;
        if (effectiveBps > MAX_FEE_BPS) effectiveBps = MAX_FEE_BPS;

        tierName = _tierName(payer);
    }

    /**
     * @dev The fee before clamping, in basis points: base rate x crypto multiplier x
     *      (1 - discount). ⛔ This divided twice (multiplier, then discount), rounding down
     *      after each step and losing up to 1 bp against the exact figure (Slither
     *      divide-before-multiply, 7 Oct 2026). Now every multiplication comes first and
     *      the result is rounded down once. calculateFee and feeBreakdown both use it, so
     *      the breakdown a user sees is the fee they are charged.
     */
    function _effectiveBps(PaymentType paymentType, uint256 discountBps) internal view returns (uint256) {
        if (discountBps >= BPS_DENOMINATOR) return 0;
        uint256 multiplier = paymentType == PaymentType.Fiat ? BPS_DENOMINATOR : cryptoFeeMultiplierBps;
        return (baseFeeRateBps * multiplier * (BPS_DENOMINATOR - discountBps)) / (BPS_DENOMINATOR * BPS_DENOMINATOR);
    }

    // ── Governance ─────────────────────────────────────────────────────────────

    // ── R7-03: keep the base fee at or above the floor, from every direction ───────
    //
    // The floor clamps upward. If MIN_FEE_BPS ever exceeds the base fee, every tier —
    // including undiscounted Tier.None — pays MIN_FEE_BPS, the tier discounts collapse to
    // a single identical fee, and a "discount" becomes a fee INCREASE. The lowest base
    // is the crypto one (crypto multiplier <= 100%), so that is the binding constraint.
    //
    // The floor is a constant now (REG-54), so only the base rate and the crypto
    // multiplier can move toward it; both setters below refuse to cross it.

    function setBaseFeeRate(uint256 newBps) external onlyRole(GOVERNANCE_ROLE) {
        if (newBps > MAX_FEE_BPS) revert InvalidBps();
        // R7-03: lowering the base must not drop it below the floor.
        if ((newBps * cryptoFeeMultiplierBps) / BPS_DENOMINATOR < MIN_FEE_BPS) revert InvalidBps();
        emit BaseFeeUpdated(baseFeeRateBps, newBps);
        baseFeeRateBps = newBps;
    }

    function setCryptoFeeMultiplier(uint256 newBps) external onlyRole(GOVERNANCE_ROLE) {
        if (newBps > BPS_DENOMINATOR) revert InvalidBps();
        // R7-03: the crypto base is the lowest base — it must not fall below the floor.
        if ((baseFeeRateBps * newBps) / BPS_DENOMINATOR < MIN_FEE_BPS) revert InvalidBps();
        emit CryptoMultiplierUpdated(cryptoFeeMultiplierBps, newBps);
        cryptoFeeMultiplierBps = newBps;
    }

    function setStakingContract(address newAddr) external onlyRole(GOVERNANCE_ROLE) {
        if (newAddr == address(0)) revert ZeroAddress();
        emit StakingContractUpdated(stakingContract, newAddr);
        stakingContract = newAddr;
    }

    // ⛔ setFeeLimits() is gone (REG-54, 12 Oct 2026): the floor and ceiling are constants.
    //    These two views keep the getters the hub manifest and integrations already read.

    /// @notice The fee floor in basis points (MIN_FEE_BPS).
    function minFeeBps() external pure returns (uint256) { return MIN_FEE_BPS; }

    /// @notice The fee ceiling in basis points (MAX_FEE_BPS).
    function maxFeeBps() external pure returns (uint256) { return MAX_FEE_BPS; }

    // ── Fee distribution routing table ─────────────────────────────────────────

    /**
     * @notice Add or update a fee destination.
     *
     * To add a new destination: pass index == feeDestinationCount (appends).
     * To update an existing destination: pass index < feeDestinationCount.
     * To deactivate: call with active = false (keeps the slot, skipped in routing).
     *
     * After any update, call validateFeeDistribution() to confirm active shares
     * still sum to BPS_DENOMINATOR. The contract does NOT enforce the sum on-chain
     * so that governance can update multiple destinations in separate transactions
     * without violating the invariant mid-sequence.
     *
     * @param index     Slot index (0–7). Must be < feeDestinationCount to update,
     *                  or == feeDestinationCount to append a new destination.
     * @param recipient Address that receives this share of fee revenue.
     * @param shareBps  Share of total fee revenue in basis points (out of 10,000).
     * @param active    Whether this destination is live.
     * @param label     Human-readable label, e.g. "Treasury", "AutoBurn".
     */
    function setFeeDestination(
        uint256 index,
        address recipient,
        uint256 shareBps,
        bool    active,
        bytes32 label
    ) external onlyRole(GOVERNANCE_ROLE) {
        if (shareBps > BPS_DENOMINATOR)  revert InvalidBps();
        if (recipient == address(0))     revert ZeroAddress();

        if (index == feeDestinationCount) {
            // Appending a new destination
            if (feeDestinationCount >= MAX_FEE_DESTINATIONS) revert TooManyDestinations();
            feeDestinationCount++;
        } else if (index >= feeDestinationCount) {
            // Gaps are not allowed — must append sequentially
            revert DestinationIndexOutOfBounds();
        }

        feeDestinations[index] = FeeDestination({
            recipient: recipient,
            shareBps:  shareBps,
            label:     label,
            active:    active
        });

        emit FeeDestinationUpdated(index, recipient, shareBps, active, label);
    }

    /**
     * @notice Toggle a destination's active flag without changing its parameters.
     */
    function setFeeDestinationActive(uint256 index, bool active)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        if (index >= feeDestinationCount) revert DestinationIndexOutOfBounds();
        feeDestinations[index].active = active;
        FeeDestination memory d = feeDestinations[index];
        emit FeeDestinationUpdated(index, d.recipient, d.shareBps, active, d.label);
    }

    /**
     * @notice Returns all configured destinations (active and inactive).
     *         Used by the gateway backend and future FeeRouter contracts.
     */
    function getFeeDistribution() external view returns (FeeDestination[] memory) {
        FeeDestination[] memory result = new FeeDestination[](feeDestinationCount);
        for (uint256 i = 0; i < feeDestinationCount; i++) {
            result[i] = feeDestinations[i];
        }
        return result;
    }

    /**
     * @notice Validate and commit the fee routing table on-chain.
     *         Call this after completing all setFeeDestination() updates in a
     *         multi-step governance sequence. Reverts if active shares do not
     *         sum to exactly BPS_DENOMINATOR, protecting against mid-sequence
     *         misrouting of fee revenue (A2-M-05 fix).
     *
     *         Emits FeeDistributionCommitted as an on-chain record that the
     *         routing table is valid and ready for use.
     */
    function commitFeeDistribution() external onlyRole(GOVERNANCE_ROLE) {
        (bool valid, uint256 totalBps) = validateFeeDistribution();
        if (!valid) revert FeeDistributionInvalid(totalBps);
        emit FeeDistributionCommitted(totalBps, block.timestamp);
    }

    /**
     * @notice Validates that all active destinations sum to exactly BPS_DENOMINATOR.
     * @return valid    True if the routing table is correctly calibrated.
     * @return totalBps Sum of all active destination shares.
     */
    function validateFeeDistribution() public view returns (bool valid, uint256 totalBps) {
        for (uint256 i = 0; i < feeDestinationCount; i++) {
            if (feeDestinations[i].active) {
                totalBps += feeDestinations[i].shareBps;
            }
        }
        valid = (totalBps == BPS_DENOMINATOR);
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    function _getDiscount(address user) internal view returns (uint256) {
        if (stakingContract == address(0)) return 0;
        if (stakingContract.code.length == 0) return 0; // EOA or self-destructed — treat as no discount
        try IStaking(stakingContract).getDiscountBps(user) returns (uint256 d) {
            return d;
        } catch {
            return 0;
        }
    }

    function _tierName(address user) internal view returns (string memory) {
        if (stakingContract == address(0)) return "None";
        if (stakingContract.code.length == 0) return "None";
        try IStaking(stakingContract).getTier(user) returns (uint8 t) {
            if (t == 3) return "Obsidian";
            if (t == 2) return "Onyx";
            if (t == 1) return "Slate";
            return "None";
        } catch {
            return "None";
        }
    }

}

// ── Minimal staking interface ──────────────────────────────────────────────────

interface IStaking {
    function getDiscountBps(address user) external view returns (uint256);
    function getTier(address user) external view returns (uint8);
}
