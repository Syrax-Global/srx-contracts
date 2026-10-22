// SPDX-License-Identifier: UNLICENSED
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

    /// @dev Mirrors SRXToken's bridge-only stop (Security ruling, 12 Oct 2026): GuardianModule's
    ///      MODULE_BRIDGE drives this, never pause(). Idempotent, exactly like the token.
    bool public bridgePaused;
    function setBridgePaused(bool paused_) external { bridgePaused = paused_; }
}
