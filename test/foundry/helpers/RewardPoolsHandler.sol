// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";
import {SRXStaking} from "../../../contracts/staking/SRXStaking.sol";
import {StabilisationFund} from "../../../contracts/stabilisation/StabilisationFund.sol";

/**
 * @title RewardPoolsHandler
 * @notice Drives SRXStaking and StabilisationFund after a real launch distribution,
 *         through everything that could try to feed their reward pools from outside the
 *         launch allocation (REG-50): "fee" SRX sent by plain transfer at any time,
 *         repeated registrations of any size, governance deployments of any size, stress
 *         events, deposits, withdrawals, claims, rescues and the passage of time.
 *         Ghost state lets RewardPoolsInvariant check the accounting after every call.
 */
contract RewardPoolsHandler is Test {
    SRXToken public srx;
    SRXStaking public staking;
    StabilisationFund public fund;
    address public gov;
    address public feeSource = address(0xFEE);
    address public staker = address(0x5A);
    address public depositor = address(0xD0);
    address public target = address(0x7A);
    uint256 public constant UNIT = 1e18;

    uint256 public ghost_feeSent;        // SRX sent in from outside the allocation
    uint256 public ghost_registered;     // successful registrations, both contracts
    uint256 public ghost_calls;          // handler calls made (positive control)
    uint256 public ghost_walletReleases; // reward SRX released to a wallet (must stay 0)
    uint256 public ghost_releasedStaking; // released to the staking successor, summed
    uint256 public ghost_releasedFund;    // released to the fund successor, summed
    SRXStaking public stakingSuccessor;
    StabilisationFund public fundSuccessor;

    modifier counted() { ghost_calls++; _; }

    constructor(SRXToken _srx, SRXStaking _staking, StabilisationFund _fund, address _gov) {
        srx = _srx; staking = _staking; fund = _fund; gov = _gov;
    }

    // ── fee SRX arrives by plain transfer ─────────────────────────────────────
    function sendFeesToStaking(uint256 whole) external counted {
        uint256 bal = srx.balanceOf(feeSource) / UNIT;
        if (bal == 0) return;
        uint256 amt = bound(whole, 1, bal) * UNIT;
        vm.prank(feeSource); srx.transfer(address(staking), amt);
        ghost_feeSent += amt;
    }

    function sendFeesToFund(uint256 whole) external counted {
        uint256 bal = srx.balanceOf(feeSource) / UNIT;
        if (bal == 0) return;
        uint256 amt = bound(whole, 1, bal) * UNIT;
        vm.prank(feeSource); srx.transfer(address(fund), amt);
        ghost_feeSent += amt;
    }

    // ── governance tries to register rewards of any size ──────────────────────
    function registerStaking(uint256 amount) external counted {
        amount = bound(amount, 1, 3_000_000_000 * UNIT);
        vm.prank(gov);
        try staking.notifyRewardAmount(amount) { ghost_registered += amount; } catch {}
    }

    function registerFund(uint256 amount) external counted {
        amount = bound(amount, 1, 3_000_000_000 * UNIT);
        vm.prank(gov);
        try fund.notifyRewardAmount(amount) { ghost_registered += amount; } catch {}
    }

    function setRates(uint256 s, uint256 f) external counted {
        vm.startPrank(gov);
        // try: after wind-down both refuse (WoundDown), and a reverting call wastes the run's depth
        try staking.setRewardRate(bound(s, 0, 1_000 * UNIT)) {} catch {}
        try fund.setRewardRate(bound(f, 0, 1_000 * UNIT)) {} catch {}
        vm.stopPrank();
    }

    // ── governance and fast paths try to move SRX out of the fund ─────────────
    function govDeploy(uint256 amount) external counted {
        amount = bound(amount, 1, 3_000_000_000 * UNIT);
        vm.prank(gov);
        try fund.deployLiquidity(target, address(srx), amount, "fuzz") {} catch {}
    }

    function stress() external counted {
        vm.prank(gov);
        try fund.triggerStressEvent() {} catch {}
    }

    function resolve() external counted {
        vm.prank(gov);
        try fund.resolveStressEvent() {} catch {}
    }

    // ── users ─────────────────────────────────────────────────────────────────
    function stake(uint256 whole) external counted {
        if (staking.totalLocked() > 0) return;
        uint256 amt = bound(whole, 100, 1_000_000) * UNIT;
        vm.prank(staker);
        try staking.lock(amt, 7 days) {} catch {}
    }

    function unstake() external counted {
        vm.prank(staker);
        try staking.unlock() {} catch {}
    }

    function claimStaking() external counted {
        vm.prank(staker);
        try staking.claimRewards() {} catch {}
    }

    function deposit(uint256 whole) external counted {
        uint256 amt = bound(whole, 100, 1_000_000) * UNIT;
        vm.prank(depositor);
        try fund.contribute(amt) {} catch {}
    }

    function withdraw(uint256 whole) external counted {
        (uint256 principal,) = fund.contributions(depositor);
        if (principal == 0) return;
        vm.prank(depositor);
        try fund.withdrawContribution(bound(whole, 1, principal / UNIT) * UNIT) {} catch {}
        vm.prank(depositor);
        try fund.withdrawContribution(principal) {} catch {}
    }

    function claimFund() external counted {
        vm.prank(depositor);
        try fund.claimRewards() {} catch {}
    }

    // ── wind-down and migration (sweep 22 Oct 2026: POOL2/POOL4 never saw a release) ──
    function windDown() external counted {
        vm.startPrank(gov);
        try staking.startWindDown() {} catch {}
        try fund.startWindDown() {} catch {}
        vm.stopPrank();
    }

    /// @dev Release to a real successor (deployed with the old contract as its source).
    ///      Interleaved with govDeploy, this is the SWEEP-01 sequence: a release, then an
    ///      SRX deployment, then another release.
    function releaseToSuccessor(uint256 sAmt, uint256 fAmt) external counted {
        if (!staking.windDown() || !fund.windDown()) return;
        if (address(stakingSuccessor) == address(0)) {
            stakingSuccessor = new SRXStaking(address(srx), gov, address(staking));
            fundSuccessor = new StabilisationFund(address(srx), gov, 3_000, 7_000, 30 days, fund.rewardAllocation(), address(fund));
        }
        uint256 sr = staking.releasableRewardAllocation();
        uint256 fr = fund.releasableRewardAllocation();
        vm.startPrank(gov);
        if (sr > 0) {
            uint256 a = bound(sAmt, 1, sr);
            try staking.releaseRewardAllocation(address(stakingSuccessor), a) { ghost_releasedStaking += a; } catch {}
        }
        if (fr > 0) {
            uint256 a = bound(fAmt, 1, fr);
            try fund.releaseRewardAllocation(address(fundSuccessor), a) { ghost_releasedFund += a; } catch {}
        }
        vm.stopPrank();
    }

    /// @dev Internal audit L1 (16 Oct 2026): rescueStrandedPool is gone. Governance now tries
    ///      to send reward SRX to a wallet through the only remaining exit; any success is
    ///      recorded and fails invariant POOL5.
    function rescue(uint256 whole) external counted {
        uint256 amount = bound(whole, 1, 1_000_000) * UNIT;
        vm.startPrank(gov);
        try staking.releaseRewardAllocation(gov, amount) { ghost_walletReleases++; } catch {}
        try fund.releaseRewardAllocation(gov, amount) { ghost_walletReleases++; } catch {}
        vm.stopPrank();
    }

    function wait(uint256 secs) external counted {
        vm.warp(block.timestamp + bound(secs, 0, 40 days));
    }
}
