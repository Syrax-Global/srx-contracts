// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Governor } from "@openzeppelin/contracts/governance/Governor.sol";
import { GovernorSettings } from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import { GovernorCountingSimple } from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import { GovernorVotes } from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import { GovernorVotesQuorumFraction } from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import { GovernorTimelockControl } from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { IVotes } from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/**
 * @title SRXGovernor
 * @notice On-chain governance for the Syrax DAO.
 *
 * Voting model: Token-weighted. 1 SRX locked (delegated) = 1 vote.
 * Delegation is required — tokens must be self-delegated or delegated to another
 * address to have active voting power. Undelegated SRX has no governance weight.
 *
 * Governance scope (what proposals can do):
 *  - Spend from SRXTreasury
 *  - Adjust fee parameters (FeeController)
 *  - Adjust staking tier thresholds (SRXStaking)
 *  - Upgrade UUPS-proxy contracts
 *  - Set bridge peers (SRXToken)
 *  - Change governor parameters (via GovernorSettings)
 *
 * Parameters (all adjustable via governance):
 *  votingDelay:   1 day   — time between proposal creation and voting start
 *  votingPeriod:  7 days  — duration of the voting window
 *  proposalThreshold: 1,000,000 SRX (0.01% of supply) to create a proposal
 *  quorum:        4%      — of total delegated supply must vote FOR
 *  timelock:      48 hours — after vote passes, delay before execution
 *
 * Governance activation timeline:
 *  - At TGE: Governor deployed, timelock deployed, roles wired.
 *  - Months 0-6: Admin can veto via Timelock CANCELLER_ROLE (guardian period).
 *  - Month 6+: Guardian role transferred to security council; admin renounces.
 *  - DAO milestone: Fully autonomous governance.
 *
 * Cross-chain governance note:
 *  Voting power is Ethereum-native (ERC20Votes on SRXToken). Cross-chain
 *  governance aggregation (via LayerZero message passing) is a Phase 3 feature.
 *  Until then, all DAO decisions are executed on Ethereum and pushed to remote
 *  chains via authorized bridge calls from the timelock.
 */
/// @dev Minimal view onto SRXToken's fixed cap, so the governor does not
///      hardcode a number that could drift from the token it governs.
interface ISRXSupplyCap {
    function MAX_SUPPLY() external view returns (uint256);
}

contract SRXGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    constructor(
        IVotes            _token,
        TimelockController _timelock
    )
        Governor("SRX Governor")
        GovernorSettings(
            1 days,          // votingDelay:         1 day
            7 days,          // votingPeriod:         7 days
            1_000_000 * 10 ** 18  // proposalThreshold: 1,000,000 SRX
        )
        GovernorVotes(_token)
        GovernorVotesQuorumFraction(4) // 4% quorum
        GovernorTimelockControl(_timelock)
    {
        // Read once, from the token itself, so this cannot drift from the cap it
        // is meant to track.
        GLOBAL_SUPPLY_CAP = ISRXSupplyCap(address(_token)).MAX_SUPPLY();
    }

    /// @notice The fixed global SRX supply, used as the quorum denominator.
    uint256 public immutable GLOBAL_SUPPLY_CAP;

    // ── Required overrides (diamond resolution) ────────────────────────────────

    function votingDelay()
        public view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }

    function votingPeriod()
        public view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }

    /**
     * @notice Votes required for a proposal to pass.
     *
     * @dev ⛔ THIS USED TO BE A FRACTION OF THE LIVE ETHEREUM-SIDE SUPPLY, WHICH
     *      AN ACTOR COULD LOWER AT WILL. SRX is an OFT: bridging tokens off
     *      Ethereum BURNS them here, so `getPastTotalSupply` falls, and 4% of a
     *      smaller number is a smaller quorum. Measured: 400,000,000 SRX at 10B
     *      supply, 160,000,000 at 4B, back to 400,000,000 once bridged home
     *      (test/audit-poc/token-standard-and-governance.test.js T3). Anyone able
     *      to move tokens to another chain could reduce the bar for their own
     *      proposal, and moving them back afterwards costs nothing but fees.
     *
     * ⭐ The denominator is now the FIXED global cap, so the threshold is a
     *      constant 4% of 10,000,000,000 SRX and no amount of bridging changes it.
     *      The numerator stays governance-adjustable via updateQuorumNumerator.
     *
     * ⚠️ THE TRADE-OFF, STATED PLAINLY: voting power is Ethereum-native (see the
     *      cross-chain note above), so if most of the supply migrates to other
     *      chains, quorum becomes a larger share of the votes that remain and
     *      proposals get harder to pass. That is the safe direction — a quorum
     *      that is hard to reach stalls governance, while one an attacker can
     *      lower defeats it — but it is a real constraint, and it is the reason
     *      cross-chain vote aggregation is on the roadmap rather than optional.
     */
    function quorum(uint256 blockNumber)
        public view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        blockNumber; // silences unused-parameter; the cap is time-invariant by design
        return (GLOBAL_SUPPLY_CAP * quorumNumerator()) / quorumDenominator();
    }

    function proposalThreshold()
        public view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    function state(uint256 proposalId)
        public view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    )
        internal
        override(Governor, GovernorTimelockControl)
        returns (uint48)
    {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    )
        internal
        override(Governor, GovernorTimelockControl)
    {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    )
        internal
        override(Governor, GovernorTimelockControl)
        returns (uint256)
    {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor()
        internal view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }
}
