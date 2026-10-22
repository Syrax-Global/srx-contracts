// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice What SRXStaking and StabilisationFund read from TGEDistributor to learn
///         how much of their SRX was delivered by the launch allocation (REG-50).
interface ITGEAllocationSource {
    function token() external view returns (address);
    function distributed() external view returns (bool);
    function allocatedTo(address destination) external view returns (uint256);
}
