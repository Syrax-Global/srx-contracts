// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PausableStub
 * @notice Minimal pausable contract used exclusively in GuardianModule tests.
 *         Mimics the pause()/unpause() interface that all protocol contracts expose.
 *         NOT deployed to any production environment.
 */
contract PausableStub {
    bool public paused;

    function pause() external {
        paused = true;
    }

    function unpause() external {
        paused = false;
    }
}
