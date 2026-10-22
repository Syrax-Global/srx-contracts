// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title SRXTimelock
 * @notice Governance timelock for the Syrax DAO.
 *
 * All approved governance proposals execute through this contract after a
 * mandatory delay. During the delay window:
 *  - The community can review what will change.
 *  - A guardian (CANCELLER_ROLE) can cancel malicious proposals.
 *  - No admin can fast-track execution: the delay cannot be lowered below the delay the
 *    contract was deployed with (minDelayFloor; updateDelay below it reverts
 *    DelayBelowFloor), and after the launch hand-over the Safe holds no admin here.
 *
 * Role assignments at deployment:
 *  PROPOSER_ROLE  — SRXGovernor contract only.
 *  EXECUTOR_ROLE  — address(0) = anyone can trigger execution after delay.
 *  CANCELLER_ROLE — admin multi-sig (guardian during transition period).
 *
 * Decentralization path:
 *  Phase 1 (now): 48-hour delay. Admin multi-sig holds CANCELLER_ROLE (a veto only).
 *         The multi-sig's own admin rights over this contract are removed by
 *         scripts/ops/migrate_roles.js phase 2, so the Timelock administers itself.
 *  Phase 2 (6 months post-TGE): delay extended to 72 hours. CANCELLER_ROLE
 *         transferred to a community-elected security council.
 *  Phase 3 (DAO milestone): Timelock becomes fully autonomous.
 *
 * Controlled assets:
 *  - SRXTreasury funds
 *  - Wind-down and successor releases (no SRX contract is upgradeable, REG-53)
 *  - Fee parameter changes (FeeController)
 *  - Staking tier changes (SRXStaking)
 *  - Bridge peer configuration (SRXToken)
 */
contract SRXTimelock is TimelockController {
    /**
     * @param minDelay   Initial delay in seconds. Recommended: 172800 (48 hours).
     * @param proposers  Array containing [address(SRXGovernor)].
     * @param executors  Array containing [address(0)] to allow permissionless execution.
     * @param admin      Admin address (Gnosis Safe) at deployment only. migrate_roles.js
     *                   phase 2 removes it; the Timelock then administers itself.
     */
    /// @notice The delay can never go below what it was deployed with (48 hours on
    ///         mainnet; the deploy script refuses less). Raising it is allowed.
    /// @dev ⛔ The "48-hour delay, cannot be bypassed" claim was enforced only by the
    ///      deploy script: a passed proposal calling updateDelay(0) would have made every
    ///      later operation immediate (internal review, 7 Oct 2026).
    uint256 public immutable minDelayFloor;

    error DelayBelowFloor(uint256 requested, uint256 floor);

    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    )
        TimelockController(minDelay, proposers, executors, admin)
    {
        minDelayFloor = minDelay;
    }

    /// @inheritdoc TimelockController
    function updateDelay(uint256 newDelay) public override {
        if (newDelay < minDelayFloor) revert DelayBelowFloor(newDelay, minDelayFloor);
        super.updateDelay(newDelay);
    }
}
