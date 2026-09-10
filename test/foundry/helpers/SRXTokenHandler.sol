// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";

/**
 * @title SRXTokenHandler
 * @notice Actor / handler contract for SRXToken invariant tests. Foundry calls
 *         these functions with randomized inputs to drive the system through
 *         many possible states. The invariant test then asserts that the
 *         supply equation holds after every sequence of calls.
 *
 *         The handler is intentionally generous in what it allows (random
 *         senders, random amounts) — bugs hide in unexpected combinations.
 */
contract SRXTokenHandler is Test {
    SRXToken public token;
    address[] public actors;
    uint256 public ghost_totalBurned;
    uint256 public ghost_totalTransferred;

    constructor(SRXToken _token, address[] memory _actors) {
        token   = _token;
        actors  = _actors;
    }

    // ── Bounded helpers ────────────────────────────────────────────────────

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _boundAmount(uint256 raw, uint256 max) internal pure returns (uint256) {
        if (max == 0) return 0;
        return raw % max;
    }

    // ── Randomized operations ──────────────────────────────────────────────

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = _actor(fromSeed);
        address to   = _actor(toSeed);
        uint256 bal  = token.balanceOf(from);
        if (bal == 0) return;
        amount = _boundAmount(amount, bal);
        if (amount == 0) return;

        vm.prank(from);
        try token.transfer(to, amount) {
            ghost_totalTransferred += amount;
        } catch {
            // Some transfers correctly revert (launch protection, paused).
            // The invariant must still hold even when transfers are blocked.
        }
    }

    function buyAndBurn(uint256 callerSeed, uint256 amount) external {
        address caller = _actor(callerSeed);
        uint256 bal    = token.balanceOf(caller);
        if (bal == 0) return;
        amount = _boundAmount(amount, bal);
        if (amount == 0) return;

        // Only proceed if caller has BURN_ROLE
        if (!token.hasRole(token.BURN_ROLE(), caller)) return;

        vm.prank(caller);
        try token.buyAndBurn(amount) {
            ghost_totalBurned += amount;
        } catch {
            // burn might fail for various legitimate reasons
        }
    }

    function delegate(uint256 fromSeed, uint256 toSeed) external {
        address from = _actor(fromSeed);
        address to   = _actor(toSeed);
        vm.prank(from);
        try token.delegate(to) {} catch {}
    }
}
