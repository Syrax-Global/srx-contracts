// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";
import {TGEDistributor} from "../../../contracts/token/TGEDistributor.sol";
import {SRXStaking} from "../../../contracts/staking/SRXStaking.sol";
import {MockLZEndpoint} from "../../../contracts/mocks/MockLZEndpoint.sol";
import {StakingAccountingHandler} from "../helpers/StakingAccountingHandler.sol";

/**
 * @title StakingAccountingInvariant
 * @notice SRXStaking's books stay consistent under any sequence of lock, top-up, unlock,
 *         early exit, claim, third-party poke, time passing, governance rate and
 *         registration changes, pause / unpause and wind-down with exits.
 *
 *   STK-A1  totalPendingRewards <= rewardPool: what is booked as owed never exceeds the pool.
 *   STK-A2  Sum of earned(user) over every actor <= rewardPool + (number of actors) wei.
 *           earned() includes accrual not yet booked, so this is the check that the
 *           schedule (periodFinish) really bounds emission to the pool. The small slack
 *           is per-update flooring: the global total is floored once per update, the
 *           individuals once per checkpoint, so their sum can differ by a few wei.
 *   STK-B   The contract SRX balance >= totalLocked + totalPendingRewards: principal and
 *           owed rewards are always backed. Also >= totalLocked + rewardPool (the whole
 *           registered pool is backed, not just the part already accrued).
 *   STK-C   totalWeightedStake == sum of positions[user].weightedAmount over all actors.
 *   STK-D   totalLocked == sum of positions[user].amount over all actors.
 *
 * Run: forge test --match-contract StakingAccountingInvariant -vv
 */
contract StakingAccountingInvariant is Test {
    SRXToken internal srx;
    TGEDistributor internal dist;
    SRXStaking internal staking;
    StakingAccountingHandler internal handler;
    address internal constant ADMIN = address(0xAD);
    address internal constant REST = address(0xE5);
    uint256 internal constant STAKING_ALLOC = 1_700_000_000e18; // the ceiling (REWARD_ALLOCATION)
    uint256 internal constant PER_ACTOR = 200_000_000e18;
    uint256 internal constant NUM_ACTORS = 4;

    address[] internal actorList;

    function setUp() public {
        MockLZEndpoint ep = new MockLZEndpoint(40161);
        srx = new SRXToken(address(ep), ADMIN);
        dist = new TGEDistributor(address(srx), ADMIN);
        staking = new SRXStaking(address(srx), ADMIN, address(dist));

        actorList.push(address(0xA1));
        actorList.push(address(0xA2));
        actorList.push(address(0xA3));
        actorList.push(address(0xA4));

        TGEDistributor.Allocation[] memory a = new TGEDistributor.Allocation[](2 + NUM_ACTORS);
        a[0] = TGEDistributor.Allocation(address(staking), STAKING_ALLOC, false, "Staking");
        for (uint256 i; i < NUM_ACTORS; i++) {
            a[1 + i] = TGEDistributor.Allocation(actorList[i], PER_ACTOR, false, "Actor");
        }
        a[1 + NUM_ACTORS] = TGEDistributor.Allocation(REST, 10_000_000_000e18 - STAKING_ALLOC - NUM_ACTORS * PER_ACTOR, false, "Rest");

        vm.startPrank(ADMIN);
        srx.genesis(address(dist));
        dist.setAllocations(a);
        dist.distribute();
        vm.stopPrank();

        for (uint256 i; i < NUM_ACTORS; i++) {
            vm.prank(actorList[i]);
            srx.approve(address(staking), type(uint256).max);
        }

        handler = new StakingAccountingHandler(srx, staking, ADMIN, actorList, STAKING_ALLOC);
        targetContract(address(handler));
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _sumEarned() internal view returns (uint256 s) {
        for (uint256 i; i < actorList.length; i++) s += staking.earned(actorList[i]);
    }

    function _sumAmount() internal view returns (uint256 s) {
        for (uint256 i; i < actorList.length; i++) {
            (uint256 amount,,,,) = staking.positions(actorList[i]);
            s += amount;
        }
    }

    function _sumWeighted() internal view returns (uint256 s) {
        for (uint256 i; i < actorList.length; i++) {
            (,,,, uint256 w) = staking.positions(actorList[i]);
            s += w;
        }
    }

    // ── invariants ───────────────────────────────────────────────────────────

    function invariant_STKA1_bookedOwedNeverExceedsPool() public view {
        assertLe(staking.totalPendingRewards(), staking.rewardPool());
    }

    function invariant_STKA2_sumOfEarnedNeverExceedsPoolBeyondRounding() public view {
        assertLe(_sumEarned(), staking.rewardPool() + actorList.length);
    }

    function invariant_STKB_principalAndOwedRewardsAreBacked() public view {
        uint256 bal = srx.balanceOf(address(staking));
        assertGe(bal, staking.totalLocked() + staking.totalPendingRewards());
        assertGe(bal, staking.totalLocked() + staking.rewardPool());
    }

    function invariant_STKC_totalWeightedStakeIsSumOfPositions() public view {
        assertEq(staking.totalWeightedStake(), _sumWeighted());
    }

    function invariant_STKD_totalLockedIsSumOfPositions() public view {
        assertEq(staking.totalLocked(), _sumAmount());
    }

    /// Positive control: the campaign really drove the handler.
    function afterInvariant() external view {
        assertGt(handler.ghost_calls(), 0, "the campaign never acted");
    }

    // ── positive control (deterministic) ─────────────────────────────────────

    /// A scripted run through every path proves the sums are not vacuously zero and the
    /// handler calls succeed: stake with actors, fund the pool, accrue, claim, poke an
    /// expired lock, exit early, wind down. Every invariant is then evaluated on live numbers.
    function test_positiveControl_scriptedRunMakesTheInvariantsNonVacuous() public {
        handler.lock(0, 1_000_000e18, 3);       // actor 0, 180d
        handler.lock(1, 5_000_000e18, 0);       // actor 1, 7d
        handler.setRewardRate(1e17 + 1);
        handler.notifyRewardAmount(500_000e18);  // even seed: a modest pool
        handler.warp(30 days, 1);
        handler.pokeExpiredPosition(1);         // 7d lock expired: weight decays
        handler.addToPosition(0, 1_000e18, 0);
        handler.claimRewards(1);
        handler.earlyWithdraw(0);
        handler.lock(2, 2_000_000e18, 1);

        assertGt(handler.ghost_locks(), 0, "no lock succeeded");
        assertGt(handler.ghost_notifies(), 0, "no registration succeeded");
        assertGt(handler.ghost_pokes(), 0, "no poke succeeded");
        assertGt(handler.ghost_adds(), 0, "no top-up succeeded");
        assertGt(handler.ghost_claims(), 0, "no claim paid out");
        assertGt(handler.ghost_earlyExits(), 0, "no early exit succeeded");
        assertGt(staking.rewardPool(), 0);
        assertGt(staking.totalLocked(), 0);
        assertGt(_sumWeighted(), 0);
        assertGt(_sumAmount(), 0);
        handler.warp(5 days, 1);
        assertGt(_sumEarned(), 0, "nothing accrued");

        invariant_STKA1_bookedOwedNeverExceedsPool();
        invariant_STKA2_sumOfEarnedNeverExceedsPoolBeyondRounding();
        invariant_STKB_principalAndOwedRewardsAreBacked();
        invariant_STKC_totalWeightedStakeIsSumOfPositions();
        invariant_STKD_totalLockedIsSumOfPositions();

        handler.startWindDown(0);
        handler.exitAfterWindDown(1);
        assertGt(handler.ghost_windDowns(), 0, "wind-down never started");
        assertGt(handler.ghost_windExits(), 0, "no exit after wind-down");
        invariant_STKA1_bookedOwedNeverExceedsPool();
        invariant_STKB_principalAndOwedRewardsAreBacked();
        invariant_STKC_totalWeightedStakeIsSumOfPositions();
        invariant_STKD_totalLockedIsSumOfPositions();
    }
}
