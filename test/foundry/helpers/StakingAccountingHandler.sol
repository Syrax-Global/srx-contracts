// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";
import {SRXStaking} from "../../../contracts/staking/SRXStaking.sol";

/**
 * @title StakingAccountingHandler
 * @notice Drives SRXStaking through every state-changing path with bounded inputs:
 *         lock, addToPosition, unlock, earlyWithdraw, claimRewards, pokeExpiredPosition
 *         (by a third party), the passage of time, governance reward-rate and
 *         reward-registration changes within the launch allocation, pause / unpause
 *         and wind-down followed by exits. Ghost variables record how much of each
 *         action really happened so the invariant suite can prove the campaign was
 *         live (a positive control) rather than a run of reverts.
 */
contract StakingAccountingHandler is Test {
    SRXToken public srx;
    SRXStaking public staking;
    address public gov;
    address public poker = address(0xBEEF); // a third party: holds no position, no role
    address[] internal _actors;
    uint256 public immutable allocation; // launch allocation delivered to the staking contract

    uint256 internal constant UNIT = 1e18;

    // ghost state
    uint256 public ghost_calls;       // handler entry points called
    uint256 public ghost_locks;       // successful lock()
    uint256 public ghost_adds;        // successful addToPosition()
    uint256 public ghost_unlocks;     // successful unlock()
    uint256 public ghost_earlyExits;  // successful earlyWithdraw()
    uint256 public ghost_claims;      // successful claimRewards() that paid > 0
    uint256 public ghost_claimed;     // SRX paid out by claimRewards()
    uint256 public ghost_pokes;       // successful pokeExpiredPosition()
    uint256 public ghost_notifies;    // successful notifyRewardAmount()
    uint256 public ghost_rateSets;    // successful setRewardRate()
    uint256 public ghost_pauses;      // successful pause()
    uint256 public ghost_windDowns;   // successful startWindDown()
    uint256 public ghost_windExits;   // successful exitAfterWindDown()

    modifier counted() { ghost_calls++; _; }

    constructor(SRXToken _srx, SRXStaking _staking, address _gov, address[] memory actors_, uint256 _allocation) {
        srx = _srx; staking = _staking; gov = _gov; allocation = _allocation;
        for (uint256 i; i < actors_.length; i++) _actors.push(actors_[i]);
    }

    function actors(uint256 i) external view returns (address) { return _actors[i]; }
    function actorCount() external view returns (uint256) { return _actors.length; }

    function _actor(uint256 seed) internal view returns (address) { return _actors[seed % _actors.length]; }

    function _duration(uint256 seed) internal pure returns (uint256) {
        uint256 k = seed % 4;
        if (k == 0) return 7 days;
        if (k == 1) return 30 days;
        if (k == 2) return 90 days;
        return 180 days;
    }

    // ── users ────────────────────────────────────────────────────────────────

    function lock(uint256 actorSeed, uint256 amountSeed, uint256 durSeed) external counted {
        address a = _actor(actorSeed);
        uint256 bal = srx.balanceOf(a);
        if (bal < 100 * UNIT) return;
        uint256 hi = bal < 50_000_000 * UNIT ? bal : 50_000_000 * UNIT;
        uint256 amt = bound(amountSeed, 100 * UNIT, hi);
        vm.prank(a);
        try staking.lock(amt, _duration(durSeed)) { ghost_locks++; } catch {}
    }

    /// @dev durChoice 0 = keep the current duration (0), otherwise one of the valid durations.
    function addToPosition(uint256 actorSeed, uint256 amountSeed, uint256 durChoice) external counted {
        address a = _actor(actorSeed);
        uint256 bal = srx.balanceOf(a);
        if (bal == 0) return;
        uint256 hi = bal < 10_000_000 * UNIT ? bal : 10_000_000 * UNIT;
        uint256 amt = bound(amountSeed, 1, hi);
        uint256 dur = durChoice % 5 == 0 ? 0 : _duration(durChoice);
        vm.prank(a);
        try staking.addToPosition(amt, dur) { ghost_adds++; } catch {}
    }

    function unlock(uint256 actorSeed) external counted {
        vm.prank(_actor(actorSeed));
        try staking.unlock() { ghost_unlocks++; } catch {}
    }

    function earlyWithdraw(uint256 actorSeed) external counted {
        vm.prank(_actor(actorSeed));
        try staking.earlyWithdraw() { ghost_earlyExits++; } catch {}
    }

    function claimRewards(uint256 actorSeed) external counted {
        address a = _actor(actorSeed);
        uint256 before = srx.balanceOf(a);
        vm.prank(a);
        try staking.claimRewards() {
            uint256 got = srx.balanceOf(a) - before;
            if (got > 0) { ghost_claims++; ghost_claimed += got; }
        } catch {}
    }

    /// @dev A third party closes an expired position's weight window (permissionless).
    function pokeExpiredPosition(uint256 actorSeed) external counted {
        address a = _actor(actorSeed);
        vm.prank(poker);
        try staking.pokeExpiredPosition(a) { ghost_pokes++; } catch {}
    }

    // ── time ─────────────────────────────────────────────────────────────────

    function warp(uint256 secs, uint256 mode) external counted {
        uint256 d = mode % 3 == 0 ? bound(secs, 0, 1 days) : bound(secs, 0, 100 days);
        vm.warp(block.timestamp + d);
    }

    // ── governance ───────────────────────────────────────────────────────────

    function setRewardRate(uint256 rateSeed) external counted {
        // 0 .. 100 SRX per second: fast enough to drain a small pool inside one warp.
        uint256 rate = rateSeed % 5 == 0 ? 0 : bound(rateSeed, 1, 100 * UNIT);
        vm.prank(gov);
        try staking.setRewardRate(rate) { ghost_rateSets++; } catch {}
    }

    /// @dev Registers within what the launch allocation still allows and the free balance covers.
    function notifyRewardAmount(uint256 amountSeed) external counted {
        uint256 remaining = allocation - staking.totalRewardsRegistered();
        uint256 bal = srx.balanceOf(address(staking));
        uint256 enc = staking.totalLocked() + staking.rewardPool();
        uint256 free = bal > enc ? bal - enc : 0;
        uint256 hi = remaining < free ? remaining : free;
        if (hi == 0) return;
        // half the time a modest top-up, half the time anything up to the ceiling
        uint256 cap = amountSeed % 2 == 0 ? (hi < 1_000_000 * UNIT ? hi : 1_000_000 * UNIT) : hi;
        uint256 amt = bound(amountSeed, 1, cap);
        vm.prank(gov);
        try staking.notifyRewardAmount(amt) { ghost_notifies++; } catch {}
    }

    function pause() external counted {
        vm.prank(gov);
        try staking.pause() { ghost_pauses++; } catch {}
    }

    function unpause() external counted {
        vm.prank(gov);
        try staking.unpause() {} catch {}
    }

    /// @dev Wind-down is final, so it is rare (about 1 in 12 calls) or the campaign would
    ///      spend most of its depth in an exit-only contract.
    function startWindDown(uint256 seed) external counted {
        if (seed % 12 != 0) return;
        vm.prank(gov);
        try staking.startWindDown() { ghost_windDowns++; } catch {}
    }

    function exitAfterWindDown(uint256 actorSeed) external counted {
        vm.prank(_actor(actorSeed));
        try staking.exitAfterWindDown() { ghost_windExits++; } catch {}
    }
}
