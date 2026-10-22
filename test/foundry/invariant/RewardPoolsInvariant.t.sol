// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";
import {TGEDistributor} from "../../../contracts/token/TGEDistributor.sol";
import {SRXStaking} from "../../../contracts/staking/SRXStaking.sol";
import {StabilisationFund} from "../../../contracts/stabilisation/StabilisationFund.sol";
import {MockLZEndpoint} from "../../../contracts/mocks/MockLZEndpoint.sol";
import {RewardPoolsHandler} from "../helpers/RewardPoolsHandler.sol";

/**
 * @title RewardPoolsInvariant
 * @notice REG-50 (A + C): SRX rewards come only from fixed SRX allocations, never from
 *         fees or any non-SRX source. A real TGEDistributor delivers the launch
 *         allocations; the handler then sends "fee" SRX in by plain transfer at random,
 *         registers, deploys and rescues at random.
 *
 *   POOL-1  Staking: rewards ever registered <= the backing <= the 1.7B allocation, and
 *           the backing equals exactly what the distributor delivered (capped).
 *   POOL-2  Fund: rewards ever registered <= the backing <= rewardAllocation, and the
 *           backing equals what the distributor delivered (capped).
 *   POOL-3  Fund: it always holds depositors' principal + the reward pool + the launch
 *           SRX still backing unregistered rewards. Nothing reserved ever leaves.
 *   POOL-4  However much fee SRX arrived, total registrations never exceed the two
 *           launch backings together.
 *
 * Run: forge test --match-contract RewardPoolsInvariant -vv
 */
contract RewardPoolsInvariant is Test {
    SRXToken internal srx;
    TGEDistributor internal dist;
    SRXStaking internal staking;
    StabilisationFund internal fund;
    RewardPoolsHandler internal handler;
    address internal constant ADMIN = address(0xAD);
    // Deliveries deliberately BELOW the code ceilings, so the invariants can tell "backed
    // by what was delivered" from "capped by the ceiling" (a mutation to the latter fails).
    uint256 internal constant STAKING_ALLOC = 1_200_000_000e18;  // ceiling 1.7B
    uint256 internal constant FUND_ALLOC = 1_000_000_000e18;     // delivered to the fund
    uint256 internal constant FUND_REWARDS = 1_500_000_000e18;   // rewardAllocation (the maximum)

    function setUp() public {
        MockLZEndpoint ep = new MockLZEndpoint(40161);
        srx = new SRXToken(address(ep), ADMIN);
        dist = new TGEDistributor(address(srx), ADMIN);

        // REG-53: plain, non-upgradeable contracts.
        staking = new SRXStaking(address(srx), ADMIN, address(dist));
        fund = new StabilisationFund(address(srx), ADMIN, 3_000, 7_000, 30 days, FUND_REWARDS, address(dist));

        handler = new RewardPoolsHandler(srx, staking, fund, ADMIN);

        TGEDistributor.Allocation[] memory a = new TGEDistributor.Allocation[](5);
        a[0] = TGEDistributor.Allocation(address(staking), STAKING_ALLOC, false, "Staking");
        a[1] = TGEDistributor.Allocation(address(fund), FUND_ALLOC, false, "StabilisationFund");
        a[2] = TGEDistributor.Allocation(handler.feeSource(), 1_000_000_000e18, false, "Fees");
        a[3] = TGEDistributor.Allocation(handler.staker(), 10_000_000e18, false, "Staker");
        a[4] = TGEDistributor.Allocation(handler.depositor(), 10_000_000_000e18 - STAKING_ALLOC - FUND_ALLOC - 1_000_000_000e18 - 10_000_000e18, false, "Depositor");

        vm.startPrank(ADMIN);
        srx.genesis(address(dist));
        dist.setAllocations(a);
        dist.distribute();
        fund.grantRole(fund.ORACLE_REPORTER_ROLE(), ADMIN);
        fund.setDeployTarget(handler.target(), true);
        vm.stopPrank();

        address s = handler.staker();
        address d = handler.depositor();
        vm.prank(s); srx.approve(address(staking), type(uint256).max);
        vm.prank(d); srx.approve(address(fund), type(uint256).max);

        targetContract(address(handler));
    }

    function invariant_POOL1_stakingBackedOnlyByTheLaunchAllocation() public view {
        assertLe(staking.totalRewardsRegistered(), staking.rewardBacking());
        assertLe(staking.rewardBacking(), staking.REWARD_ALLOCATION());
        if (staking.allocationSynced() && !staking.windDown()) assertEq(staking.rewardBacking(), STAKING_ALLOC);
    }

    function invariant_POOL2_fundBackedOnlyByTheLaunchAllocation() public view {
        assertLe(fund.totalRewardsRegistered(), fund.rewardBacking());
        assertLe(fund.rewardBacking(), fund.rewardAllocation());
        // Before wind-down the backing is exactly what was delivered; a release lowers it.
        if (fund.allocationSynced() && !fund.windDown()) assertEq(fund.rewardBacking(), FUND_ALLOC);
    }

    /// Sweep SWEEP-01 (22 Oct 2026): across every release to a successor, no more than the
    /// launch allocation delivered here ever leaves as reward allocation, and the successor's
    /// record matches what was sent. A re-read of the backing after a release would let the
    /// same allocation go twice.
    function invariant_POOL6_releasesNeverExceedTheDeliveredAllocation() public view {
        assertLe(handler.ghost_releasedStaking(), STAKING_ALLOC);
        assertLe(handler.ghost_releasedFund(), FUND_ALLOC);
        if (address(handler.fundSuccessor()) != address(0)) {
            assertEq(fund.allocatedTo(address(handler.fundSuccessor())), handler.ghost_releasedFund());
            assertEq(staking.allocatedTo(address(handler.stakingSuccessor())), handler.ghost_releasedStaking());
        }
    }

    function invariant_POOL3_fundNeverReleasesReservedSRX() public view {
        if (!fund.allocationSynced()) {
            // Before the backing is read no SRX can leave at all: deployLiquidity reads
            // it first. (The contract reserves the whole rewardAllocation meanwhile, which
            // can exceed what was delivered, so a balance comparison would be wrong here.)
            assertEq(fund.totalDeployed(), 0);
            return;
        }
        uint256 unregistered = fund.rewardBacking() - fund.totalRewardsRegistered();
        assertGe(srx.balanceOf(address(fund)), fund.totalContributions() + fund.rewardPool() + unregistered);
    }

    /// Internal audit L1: no path sends reward SRX to a wallet.
    function invariant_POOL5_rewardsNeverReleasedToAWallet() public view {
        assertEq(handler.ghost_walletReleases(), 0);
    }

    function invariant_POOL4_feesNeverBecomeRewards() public view {
        assertLe(handler.ghost_registered(), STAKING_ALLOC + FUND_ALLOC);
        assertEq(handler.ghost_registered(), staking.totalRewardsRegistered() + fund.totalRewardsRegistered());
    }

    /// Positive control: the campaign really drove the handler. (That the invariants can
    /// SEE a violation is proved by mutation: scratchpad mutate_pools.sh, PR description.)
    function afterInvariant() external view {
        assertGt(handler.ghost_calls(), 0, "the campaign never acted");
    }
}
