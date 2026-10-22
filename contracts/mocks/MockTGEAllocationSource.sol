// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Test stand-in for TGEDistributor's REG-50 read surface. Reports a fixed
///         allocation for every destination unless one is set, so unit tests can arm
///         a reward pool without running the whole launch distribution. The real
///         distributor is exercised in test/REG50.FixedRewardPools.test.js.
contract MockTGEAllocationSource {
    address public immutable token;
    bool    public distributed;
    uint256 public defaultAllocation;
    mapping(address => bool)    private _set;
    mapping(address => uint256) private _allocated;

    constructor(address _token, uint256 _defaultAllocation, bool _distributed) {
        token = _token;
        defaultAllocation = _defaultAllocation;
        distributed = _distributed;
    }

    function setDistributed(bool d) external { distributed = d; }

    function setAllocatedTo(address destination, uint256 amount) external {
        _set[destination] = true;
        _allocated[destination] = amount;
    }

    function allocatedTo(address destination) external view returns (uint256) {
        return _set[destination] ? _allocated[destination] : defaultAllocation;
    }
}
