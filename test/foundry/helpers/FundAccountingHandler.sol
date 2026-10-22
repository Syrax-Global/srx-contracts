// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";
import {StabilisationFund} from "../../../contracts/stabilisation/StabilisationFund.sol";

/**
 * @title FundAccountingHandler
 * @notice Drives StabilisationFund through contribute, withdrawContribution, claimRewards,
 *         the passage of time, governance reward-rate and reward-registration changes
 *         within the launch allocation, pause / unpause and wind-down followed by exits.
 *         Ghost variables record how much of each action really happened so the
 *         invariant suite can prove the campaign was live.
 */
contract FundAccountingHandler is Test {
    SRXToken public srx;
    StabilisationFund public fund;
    address public gov;
    address[] internal _actors;
    uint256 public immutable allocation; // launch allocation delivered to the fund (<= rewardAllocation)

    uint256 internal constant UNIT = 1e18;

    // ghost state
    uint256 public ghost_calls;        // handler entry points called
    uint256 public ghost_contribs;     // successful contribute()
    uint256 public ghost_withdraws;    // successful withdrawContribution()
    uint256 public ghost_claims;       // successful claimRewards() that paid > 0
    uint256 public ghost_claimed;      // SRX paid out by claimRewards()
    uint256 public ghost_notifies;     // successful notifyRewardAmount()
    uint256 public ghost_rateSets;     // successful setRewardRate()
    uint256 public ghost_pauses;       // successful pause()
    uint256 public ghost_windDowns;    // successful startWindDown()
    uint256 public ghost_windExits;    // successful exitAfterWindDown()

    modifier counted() { ghost_calls++; _; }

    constructor(SRXToken _srx, StabilisationFund _fund, address _gov, address[] memory actors_, uint256 _allocation) {
        srx = _srx; fund = _fund; gov = _gov; allocation = _allocation;
        for (uint256 i; i < actors_.length; i++) _actors.push(actors_[i]);
    }

    function actors(uint256 i) external view returns (address) { return _actors[i]; }
    function actorCount() external view returns (uint256) { return _actors.length; }

    function _actor(uint256 seed) internal view returns (address) { return _actors[seed % _actors.length]; }

    // ── contributors ─────────────────────────────────────────────────────────

    function contribute(uint256 actorSeed, uint256 amountSeed) external counted {
        address a = _actor(actorSeed);
        uint256 bal = srx.balanceOf(a);
        if (bal < 100 * UNIT) return;
        uint256 hi = bal < 50_000_000 * UNIT ? bal : 50_000_000 * UNIT;
        uint256 amt = bound(amountSeed, 100 * UNIT, hi);
        vm.prank(a);
        try fund.contribute(amt) { ghost_contribs++; } catch {}
    }

    /// @dev Half the time withdraws everything, otherwise a random part (the fund refuses a
    ///      remainder below the minimum, which is a revert the invariants must survive).
    function withdrawContribution(uint256 actorSeed, uint256 amountSeed) external counted {
        address a = _actor(actorSeed);
        (uint256 principal,) = fund.contributions(a);
        if (principal == 0) return;
        uint256 amt = amountSeed % 2 == 0 ? principal : bound(amountSeed, 1, principal);
        vm.prank(a);
        try fund.withdrawContribution(amt) { ghost_withdraws++; } catch {}
    }

    function claimRewards(uint256 actorSeed) external counted {
        address a = _actor(actorSeed);
        uint256 before = srx.balanceOf(a);
        vm.prank(a);
        try fund.claimRewards() {
            uint256 got = srx.balanceOf(a) - before;
            if (got > 0) { ghost_claims++; ghost_claimed += got; }
        } catch {}
    }

    // ── time ─────────────────────────────────────────────────────────────────

    function warp(uint256 secs, uint256 mode) external counted {
        uint256 d = mode % 3 == 0 ? bound(secs, 0, 1 days) : bound(secs, 0, 100 days);
        vm.warp(block.timestamp + d);
    }

    // ── governance ───────────────────────────────────────────────────────────

    function setRewardRate(uint256 rateSeed) external counted {
        uint256 rate = rateSeed % 5 == 0 ? 0 : bound(rateSeed, 1, 100 * UNIT);
        vm.prank(gov);
        try fund.setRewardRate(rate) { ghost_rateSets++; } catch {}
    }

    /// @dev Registers within what the launch allocation still allows and the free balance covers.
    function notifyRewardAmount(uint256 amountSeed) external counted {
        uint256 remaining = allocation - fund.totalRewardsRegistered();
        uint256 bal = srx.balanceOf(address(fund));
        uint256 enc = fund.totalContributions() + fund.rewardPool();
        uint256 free = bal > enc ? bal - enc : 0;
        uint256 hi = remaining < free ? remaining : free;
        if (hi == 0) return;
        uint256 cap = amountSeed % 2 == 0 ? (hi < 1_000_000 * UNIT ? hi : 1_000_000 * UNIT) : hi;
        uint256 amt = bound(amountSeed, 1, cap);
        vm.prank(gov);
        try fund.notifyRewardAmount(amt) { ghost_notifies++; } catch {}
    }

    function pause() external counted {
        vm.prank(gov);
        try fund.pause() { ghost_pauses++; } catch {}
    }

    function unpause() external counted {
        vm.prank(gov);
        try fund.unpause() {} catch {}
    }

    /// @dev Wind-down is final, so it is rare (about 1 in 12 calls).
    function startWindDown(uint256 seed) external counted {
        if (seed % 12 != 0) return;
        vm.prank(gov);
        try fund.startWindDown() { ghost_windDowns++; } catch {}
    }

    function exitAfterWindDown(uint256 actorSeed) external counted {
        vm.prank(_actor(actorSeed));
        try fund.exitAfterWindDown() { ghost_windExits++; } catch {}
    }
}
