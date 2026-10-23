// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice What a reward pool asks of a successor before it releases unused launch reward
///         SRX to it: the successor must name this contract as its allocation source.
/// @dev One shared declaration for SRXStaking and StabilisationFund (it was declared twice,
///      identically; Aderyn H-3, 22 Oct 2026).
interface ISuccessorOf {
    function tgeDistributor() external view returns (address);
    /// @dev Review round 22 Oct (B1): the release re-reads the successor's backing around
    ///      the transfer, so every released SRX must become the successor's reward backing.
    function rewardBacking() external view returns (uint256);
    function syncAllocation() external;
}
