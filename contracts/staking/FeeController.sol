// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

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
 * Payment type multipliers:
 *  - Fiat payments:     100% of base fee (standard)
 *  - Non-SRX crypto:    75% of base fee (reduced, rounded down)
 *  - SRX payments:      0%  of base fee (always free regardless of tier)
 *
 * Staking tier discounts apply on top of the payment-type multiplier for
 * non-SRX crypto payments. SRX payments are always zero-fee.
 *
 * All fee parameters are governance-adjustable via the timelock.
 *
 * UUPS upgradeable to allow fee model evolution without re-integrating the
 * gateway backend (the contract address stays constant).
 */
contract FeeController is Initializable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable {

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant GATEWAY_ROLE    = keccak256("GATEWAY_ROLE"); // Syrax backend address
    bytes32 public constant PAUSER_ROLE     = keccak256("PAUSER_ROLE");  // GuardianModule
    /// @notice Authorises UUPS upgrades. SEPARATED from GOVERNANCE_ROLE (SC-TRUST-001 fix)
    ///         so upgrade authority can be homed exclusively on the SRXTimelock. MUST be
    ///         migrated to the Timelock and revoked from the admin EOA before mainnet
    ///         (enforced by verify_roles.js).
    bytes32 public constant UPGRADER_ROLE   = keccak256("UPGRADER_ROLE");

    // ── Payment type enum ──────────────────────────────────────────────────────

    enum PaymentType { Fiat, Crypto, SRX }

    // ── Constants ──────────────────────────────────────────────────────────────

    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ── State ──────────────────────────────────────────────────────────────────

    address public stakingContract;

    uint256 public baseFeeRateBps;         // Default: 150 = 1.50%
    uint256 public cryptoFeeMultiplierBps; // Default: 7500 = 75% of base fee
    // SRX payment fee is always 0 — not a configurable parameter.

    uint256 public minFeeBps;              // Minimum floor fee (prevents 0 on tiny discounts)
    uint256 public maxFeeBps;             // Safety cap (never charge more than this)

    // ── Fee distribution routing table ─────────────────────────────────────────
    //
    // Governance configures how collected platform fee revenue should be split
    // across destinations (e.g. Treasury, RealYield pool, AutoBurn contract).
    // This table is read by the gateway backend (eth_call) and by any future
    // on-chain FeeRouter contract. No money moves through FeeController itself —
    // it is a pure calculator. The routing table is the expansion port that allows
    // new revenue streams (real yield, auto-burn) to be wired without a contract
    // upgrade.
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

    /// @dev Storage gap for future upgrades (R7-1 + SC-UUPS-001 fix).
    ///
    ///      DISCIPLINE: Every upgrade that adds N new state variables MUST shrink this
    ///      gap by exactly N (e.g., 50 → 48 for two new variables). Append the new state
    ///      variables ABOVE this gap, then update the size literal. Wrong shrinkage
    ///      causes storage slot collision on subsequent upgrades.
    ///
    ///      VERIFICATION: Every upgrade PR must run the OpenZeppelin storage layout
    ///      check (`hardhat-upgrades` validateUpgrade) and the upgrade runbook must
    ///      include a "Storage Layout Diff" section.
    // solhint-disable-next-line var-name-mixedcase
    uint256[50] private __gap;

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

    // ── Initializer ────────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _stakingContract,
        address _admin
    ) external initializer {
        if (_stakingContract == address(0) || _admin == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();

        // SC-UUPS-002 fix: set state BEFORE granting roles (defensive ordering).
        stakingContract      = _stakingContract;
        baseFeeRateBps       = 150;   // 1.50%
        cryptoFeeMultiplierBps = 7_500; // 75% of base fee
        // Non-zero floor so a 100% (Obsidian-tier) discount never means a literal
        // $0 fee at scale -- Obsidian still pays ~10% of the fiat base fee (~13%
        // of the discounted crypto base), i.e. a ~90% discount, not "free
        // forever." Without this floor, platform fee revenue trends to zero
        // as adoption grows and more holders reach Obsidian -- the opposite of
        // what a fee model should do. Governance-adjustable via setFeeLimits().
        minFeeBps            = 15;    // 0.15% floor -- applies even at 100% discount
        maxFeeBps            = 500;   // 5.00% hard cap

        // Grant roles LAST — after state is fully consistent
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNANCE_ROLE,    _admin);
        _grantRole(PAUSER_ROLE,        _admin);
        // SC-TRUST-001 fix: upgrade authority granted to admin for deployment bootstrap.
        // MUST be migrated to the SRXTimelock and revoked from admin pre-mainnet
        // (verify_roles.js enforces this end state).
        _grantRole(UPGRADER_ROLE,      _admin);
    }

    // ── Pause ──────────────────────────────────────────────────────────────────

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
     */
    function calculateFee(address payer, PaymentType paymentType)
        external
        view
        whenNotPaused
        returns (uint256 feeBps)
    {
        // SRX payments are always zero-fee — this is a core utility promise.
        if (paymentType == PaymentType.SRX) return 0;

        uint256 base;

        if (paymentType == PaymentType.Fiat) {
            base = baseFeeRateBps;
        } else {
            // Crypto payments get a base reduction
            base = (baseFeeRateBps * cryptoFeeMultiplierBps) / BPS_DENOMINATOR;
        }

        // Apply staking tier discount
        uint256 discountBps = _getDiscount(payer);
        uint256 effective = discountBps >= BPS_DENOMINATOR
            ? 0
            : (base * (BPS_DENOMINATOR - discountBps)) / BPS_DENOMINATOR;

        // Clamp to [minFeeBps, maxFeeBps] — applies even for Obsidian tier (0 fee clamped to floor)
        if (effective < minFeeBps) return minFeeBps;
        if (effective > maxFeeBps) return maxFeeBps;

        return effective;
    }

    /**
     * @notice Returns a human-readable fee breakdown for a payer.
     *         Useful for the gateway UI to display expected fees.
     */
    function feeBreakdown(address payer, PaymentType paymentType)
        external
        view
        whenNotPaused
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
        effectiveBps = discountBps >= BPS_DENOMINATOR
            ? 0
            : (baseBps * (BPS_DENOMINATOR - discountBps)) / BPS_DENOMINATOR;

        // Clamp
        if (effectiveBps < minFeeBps) effectiveBps = minFeeBps;
        if (effectiveBps > maxFeeBps) effectiveBps = maxFeeBps;

        tierName = _tierName(payer);
    }

    // ── Governance ─────────────────────────────────────────────────────────────

    // ── R7-03: keep minFeeBps at or below the LOWEST achievable base fee ───────────
    //
    // The floor clamps upward. If minFeeBps ever exceeds the base fee, every tier —
    // including undiscounted Tier.None — pays minFeeBps, the tier discounts collapse to
    // a single identical fee, and a "discount" becomes a fee INCREASE. The lowest base
    // is the crypto one (crypto multiplier <= 100%), so that is the binding constraint.
    //
    // Latent while minFeeBps defaulted to 0; live now that it defaults to 15 bps. All
    // three setters below enforce the invariant so it cannot be broken from any direction.

    /// @dev Lowest base fee any payment type can be charged before discounts/clamps.
    function _lowestBaseFeeBps() internal view returns (uint256) {
        return (baseFeeRateBps * cryptoFeeMultiplierBps) / BPS_DENOMINATOR;
    }

    function setBaseFeeRate(uint256 newBps) external onlyRole(GOVERNANCE_ROLE) {
        if (newBps > maxFeeBps) revert InvalidBps();
        // R7-03: lowering the base must not drop it below the floor.
        if ((newBps * cryptoFeeMultiplierBps) / BPS_DENOMINATOR < minFeeBps) revert InvalidBps();
        emit BaseFeeUpdated(baseFeeRateBps, newBps);
        baseFeeRateBps = newBps;
    }

    function setCryptoFeeMultiplier(uint256 newBps) external onlyRole(GOVERNANCE_ROLE) {
        if (newBps > BPS_DENOMINATOR) revert InvalidBps();
        // R7-03: the crypto base is the lowest base — it must not fall below the floor.
        if ((baseFeeRateBps * newBps) / BPS_DENOMINATOR < minFeeBps) revert InvalidBps();
        emit CryptoMultiplierUpdated(cryptoFeeMultiplierBps, newBps);
        cryptoFeeMultiplierBps = newBps;
    }

    function setStakingContract(address newAddr) external onlyRole(GOVERNANCE_ROLE) {
        if (newAddr == address(0)) revert ZeroAddress();
        emit StakingContractUpdated(stakingContract, newAddr);
        stakingContract = newAddr;
    }

    function setFeeLimits(uint256 newMin, uint256 newMax) external onlyRole(GOVERNANCE_ROLE) {
        if (newMax > BPS_DENOMINATOR) revert InvalidBps(); // A4-M-01: cap cannot exceed 100%
        if (newMin > newMax)          revert InvalidBps();
        // R7-03: the floor must never exceed the lowest achievable base fee, or it would
        // clamp every tier upward and turn discounts into increases. To raise both, raise
        // the base rate first.
        if (newMin > _lowestBaseFeeBps()) revert InvalidBps();
        minFeeBps = newMin;
        maxFeeBps = newMax;
    }

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
     * @param label     Human-readable label, e.g. "Treasury", "RealYield", "AutoBurn".
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

    function _authorizeUpgrade(address newImpl) internal override onlyRole(UPGRADER_ROLE) {}
}

// ── Minimal staking interface ──────────────────────────────────────────────────

interface IStaking {
    function getDiscountBps(address user) external view returns (uint256);
    function getTier(address user) external view returns (uint8);
}
