// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title PausableStrictStub
 * @notice Pausable stub that behaves EXACTLY like the production protocol contracts.
 *
 *         It inherits OpenZeppelin `Pausable`, so `pause()` on an already-paused
 *         contract reverts `EnforcedPause`, and `unpause()` on an unpaused one reverts
 *         `ExpectedPause` — matching SRXToken, SRXStaking, FeeController, SRXTreasury,
 *         StabilisationFund and SRXOFTNative.
 *
 *         ⚠️  Its sibling `PausableStub` is IDEMPOTENT — its pause()/unpause() are plain
 *         boolean setters with no guards, so they can never revert. That makes it unable
 *         to reproduce any failure mode that depends on real pause-state semantics, and
 *         tests written against it can pass while the same scenario reverts in production
 *         (this is exactly what masked R7-02).
 *
 *         Use THIS stub for any test that depends on pause-state semantics. NOT deployed
 *         to any production environment.
 */
contract PausableStrictStub is Pausable {
    function pause()   external { _pause();   }
    function unpause() external { _unpause(); }
}
