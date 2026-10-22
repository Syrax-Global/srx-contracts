// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";
import {TGEDistributor} from "../../../contracts/token/TGEDistributor.sol";
import {StabilisationFund} from "../../../contracts/stabilisation/StabilisationFund.sol";
import {MockLZEndpoint} from "../../../contracts/mocks/MockLZEndpoint.sol";
import {FundAccountingHandler} from "../helpers/FundAccountingHandler.sol";

/**
 * @title FundAccountingInvariant
 * @notice StabilisationFund's books stay consistent under any sequence of contributions,
 *         withdrawals, claims, time passing, governance rate and registration changes,
 *         pause / unpause and wind-down with exits.
 *
 *   FUND-A1  totalPendingRewards <= rewardPool: what is booked as owed never exceeds the pool.
 *   FUND-A2  Sum of earned(user) over every actor <= rewardPool + (number of actors) wei
 *            (earned() includes accrual not yet booked; the slack is per-update flooring).
 *   FUND-B   The fund SRX balance >= totalContributions + totalPendingRewards: depositors
 *            principal and owed rewards are always backed. Also >= totalContributions +
 *            rewardPool (the whole registered pool is backed).
 *   FUND-C   totalContributions == sum of contributions[user].srxAmount over all actors.
 *
 * Run: forge test --match-contract FundAccountingInvariant -vv
 */
contract FundAccountingInvariant is Test {
    SRXToken internal srx;
    TGEDistributor internal dist;
    StabilisationFund internal fund;
    FundAccountingHandler internal handler;
    address internal constant ADMIN = address(0xAD);
    address internal constant REST = address(0xE5);
    uint256 internal constant FUND_ALLOC = 1_500_000_000e18; // = rewardAllocation, the ceiling
    uint256 internal constant PER_ACTOR = 200_000_000e18;
    uint256 internal constant NUM_ACTORS = 4;

    address[] internal actorList;

    function setUp() public {
        MockLZEndpoint ep = new MockLZEndpoint(40161);
        srx = new SRXToken(address(ep), ADMIN);
        dist = new TGEDistributor(address(srx), ADMIN);
        fund = new StabilisationFund(address(srx), ADMIN, 3_000, 7_000, 30 days, FUND_ALLOC, address(dist));

        actorList.push(address(0xB1));
        actorList.push(address(0xB2));
        actorList.push(address(0xB3));
        actorList.push(address(0xB4));

        TGEDistributor.Allocation[] memory a = new TGEDistributor.Allocation[](2 + NUM_ACTORS);
        a[0] = TGEDistributor.Allocation(address(fund), FUND_ALLOC, false, "StabilisationFund");
        for (uint256 i; i < NUM_ACTORS; i++) {
            a[1 + i] = TGEDistributor.Allocation(actorList[i], PER_ACTOR, false, "Actor");
        }
        a[1 + NUM_ACTORS] = TGEDistributor.Allocation(REST, 10_000_000_000e18 - FUND_ALLOC - NUM_ACTORS * PER_ACTOR, false, "Rest");

        vm.startPrank(ADMIN);
        srx.genesis(address(dist));
        dist.setAllocations(a);
        dist.distribute();
        vm.stopPrank();

        for (uint256 i; i < NUM_ACTORS; i++) {
            vm.prank(actorList[i]);
            srx.approve(address(fund), type(uint256).max);
        }

        handler = new FundAccountingHandler(srx, fund, ADMIN, actorList, FUND_ALLOC);
        targetContract(address(handler));
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _sumEarned() internal view returns (uint256 s) {
        for (uint256 i; i < actorList.length; i++) s += fund.earned(actorList[i]);
    }

    function _sumContributions() internal view returns (uint256 s) {
        for (uint256 i; i < actorList.length; i++) {
            (uint256 amount,) = fund.contributions(actorList[i]);
            s += amount;
        }
    }

    // ── invariants ───────────────────────────────────────────────────────────

    function invariant_FUNDA1_bookedOwedNeverExceedsPool() public view {
        assertLe(fund.totalPendingRewards(), fund.rewardPool());
    }

    function invariant_FUNDA2_sumOfEarnedNeverExceedsPoolBeyondRounding() public view {
        assertLe(_sumEarned(), fund.rewardPool() + actorList.length);
    }

    function invariant_FUNDB_principalAndOwedRewardsAreBacked() public view {
        uint256 bal = srx.balanceOf(address(fund));
        assertGe(bal, fund.totalContributions() + fund.totalPendingRewards());
        assertGe(bal, fund.totalContributions() + fund.rewardPool());
    }

    function invariant_FUNDC_totalContributionsIsSumOfPositions() public view {
        assertEq(fund.totalContributions(), _sumContributions());
    }

    /// Positive control: the campaign really drove the handler.
    function afterInvariant() external view {
        assertGt(handler.ghost_calls(), 0, "the campaign never acted");
    }

    // ── positive control (deterministic) ─────────────────────────────────────

    /// A scripted run through every path proves the sums are not vacuously zero and the
    /// handler calls succeed. Every invariant is then evaluated on live numbers.
    function test_positiveControl_scriptedRunMakesTheInvariantsNonVacuous() public {
        handler.contribute(0, 1_000_000e18);
        handler.contribute(1, 4_000_000e18);
        handler.setRewardRate(1e17 + 1);
        handler.notifyRewardAmount(500_000e18); // even seed: a modest pool
        handler.warp(40 days, 1);               // past the 30-day lock; the pool runs dry
        handler.claimRewards(0);
        handler.withdrawContribution(1, 2);     // even seed: everything
        handler.contribute(2, 2_000_000e18);
        handler.warp(1 days, 1);

        assertGt(handler.ghost_contribs(), 0, "no contribution succeeded");
        assertGt(handler.ghost_notifies(), 0, "no registration succeeded");
        assertGt(handler.ghost_claims(), 0, "no claim paid out");
        assertGt(handler.ghost_withdraws(), 0, "no withdrawal succeeded");
        assertGt(fund.rewardPool(), 0);
        assertGt(fund.totalContributions(), 0);
        assertGt(_sumContributions(), 0);

        invariant_FUNDA1_bookedOwedNeverExceedsPool();
        invariant_FUNDA2_sumOfEarnedNeverExceedsPoolBeyondRounding();
        invariant_FUNDB_principalAndOwedRewardsAreBacked();
        invariant_FUNDC_totalContributionsIsSumOfPositions();

        handler.startWindDown(0);
        handler.exitAfterWindDown(0);
        assertGt(handler.ghost_windDowns(), 0, "wind-down never started");
        assertGt(handler.ghost_windExits(), 0, "no exit after wind-down");
        invariant_FUNDA1_bookedOwedNeverExceedsPool();
        invariant_FUNDA2_sumOfEarnedNeverExceedsPoolBeyondRounding();
        invariant_FUNDB_principalAndOwedRewardsAreBacked();
        invariant_FUNDC_totalContributionsIsSumOfPositions();
    }
}
