// SPDX-License-Identifier: MIT
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
 *  - No admin can fast-track execution.
 *
 * Role assignments at deployment:
 *  PROPOSER_ROLE  — SRXGovernor contract only.
 *  EXECUTOR_ROLE  — address(0) = anyone can trigger execution after delay.
 *  CANCELLER_ROLE — admin multi-sig (guardian during transition period).
 *
 * Decentralization path:
 *  Phase 1 (now): 48-hour delay. Admin multi-sig holds CANCELLER_ROLE.
 *  Phase 2 (6 months post-TGE): delay extended to 72 hours. CANCELLER_ROLE
 *         transferred to a community-elected security council.
 *  Phase 3 (DAO milestone): admin renounces DEFAULT_ADMIN_ROLE.
 *         Timelock becomes fully autonomous.
 *
 * Controlled assets:
 *  - SRXTreasury funds
 *  - Protocol upgrade authorizations (UUPS)
 *  - Fee parameter changes (FeeController)
 *  - Staking tier changes (SRXStaking)
 *  - Bridge peer configuration (SRXToken)
 */
contract SRXTimelock is TimelockController {
    /**
     * @param minDelay   Initial delay in seconds. Recommended: 172800 (48 hours).
     * @param proposers  Array containing [address(SRXGovernor)].
     * @param executors  Array containing [address(0)] to allow permissionless execution.
     * @param admin      Admin address (Gnosis Safe). Set to address(0) after Phase 3.
     */
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    )
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
