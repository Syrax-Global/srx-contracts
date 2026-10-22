// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Test-only stand-in for a Gnosis Safe: answers getOwners() and getThreshold()
///         like the real one, so the launch gate's multi-signature check can be tested.
contract MockSafe {
    address[] private _owners;
    uint256 private _threshold;

    constructor(address[] memory owners_, uint256 threshold_) {
        _owners = owners_;
        _threshold = threshold_;
    }

    function getOwners() external view returns (address[] memory) { return _owners; }
    function getThreshold() external view returns (uint256) { return _threshold; }
}
