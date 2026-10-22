// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice TEST ONLY. A pausable module target that answers its paused() view truthfully and,
///         when unpaused, calls back into the GuardianModule with stored calldata, recording
///         whether that inner call succeeded. Used to prove the module's nonReentrant guard on
///         its unpause paths, now that the module reads the target's state before acting.
contract ReentrantPausableTarget {
    bool public paused;
    address public module;
    bytes public data;
    bool public called;
    bool public innerOk;
    bytes public innerRet;

    function arm(address module_, bytes calldata data_) external { module = module_; data = data_; }
    function pause() external { paused = true; }
    function unpause() external {
        (bool ok, bytes memory ret) = module.call(data);
        called = true;
        innerOk = ok;
        innerRet = ret;
        paused = false;
    }
}
