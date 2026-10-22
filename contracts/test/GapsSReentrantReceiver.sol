// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Test-only ETH receiver. When armed, receive() calls back into `target` with `reenterData`
///         (once), and records whether that call succeeded and the raw revert data it returned,
///         then lets the outer transfer complete. poke() makes the same call from outside any
///         transfer, as a control that the refusal is the target's lock and not this contract.
contract GapsSReentrantReceiver {
    address public target;
    bytes public reenterData;
    bool public armed;
    bool public reentered;
    bool public reenterOk;
    bytes public reenterResult;

    function arm(address _target, bytes calldata _data) external {
        target = _target;
        reenterData = _data;
        armed = true;
    }

    function disarm() external { armed = false; }

    function poke() external returns (bool ok, bytes memory result) {
        (ok, result) = target.call(reenterData);
    }

    receive() external payable {
        if (armed && !reentered) {
            reentered = true;
            (reenterOk, reenterResult) = target.call(reenterData);
        }
    }
}
