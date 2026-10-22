// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ITGEAllocationSource } from "../token/ITGEAllocationSource.sol";
import { ISuccessorOf } from "../token/ISuccessorOf.sol";
// ReentrancyGuardUpgradeable was removed in OZ v5.1+. Inline implementation below.

/**
 * @title SRXStaking
 * @notice Lock SRX tokens to:
 *   1. Activate a fee discount tier on the Syrax payment platform.
 *   2. Receive SRX rewards from the fixed staking allocation, in proportion to
 *      weighted stake.
 *
 * ⛔ REWARDS COME FROM ONE FIXED SRX ALLOCATION AND NOTHING ELSE (REG-50, 11 Oct 2026).
 *    Rewards can only be registered against rewardBacking: the SRX the launch
 *    distribution (TGEDistributor, fixed at deployment) records it delivered to this
 *    contract, at most REWARD_ALLOCATION (1.7 billion SRX), counted cumulatively. SRX
 *    that arrives any other way (fee revenue, buy-back proceeds, a plain transfer) can
 *    neither extend the rewards nor pay for them (Security review 11 Oct 2026: a cap on
 *    the total alone still let transferred SRX fund rewards within it). Rewards are
 *    paid in SRX only. The second "bonus" reward stream (a second token, for example
 *    USDC, that governance could fund from platform fees) was REMOVED from the code,
 *    not switched off: a dormant path that a vote could turn on was itself the
 *    problem (law agents' preliminary view REG-0023 (4)). Stakers therefore have no
 *    entitlement to Syrax's fee income, present or contingent.
 *
 * Fee discount tiers (governance-adjustable):
 *  ┌──────────┬──────────────────────┬────────────────┐
 *  │ Tier     │ Weighted SRX (min)   │ Fee Discount   │
 *  ├──────────┼──────────────────────┼────────────────┤
 *  │ None     │          0           │    0%          │
 *  │ Slate    │     50,000 SRX       │   25%          │
 *  │ Onyx     │    250,000 SRX       │   60%          │
 *  │ Obsidian │  1,000,000 SRX       │  100%          │
 *  └──────────┴──────────────────────┴────────────────┘
 *
 * A 100% discount does not mean a zero fee: FeeController keeps a 15 bps fee floor
 * even at a 100% discount. Paying in SRX carries no fee at any tier.
 *
 * Tier is determined by WEIGHTED stake (principal × duration multiplier) while a
 * lock is ACTIVE, and by raw principal once it has expired — see getTier(). The
 * weighted figure is the same one used for incentive-pool weighting above. A
 * longer lock lowers the effective principal needed to reach a tier (e.g. Obsidian
 * needs the full 1,000,000 SRX at a 7-day lock, but only 500,000 SRX at a
 * 180-day lock). This ties the fee discount to a genuine duration commitment:
 * reaching a tier via the shortest lock requires the full threshold, and a
 * staker cannot get the *cheapest* route to a tier without actually committing
 * capital for longer.
 *
 * The multiplier expires with the lock (R7-01). While the lock runs, weightedAmount
 * is fixed (set at lock(), only ever raised via addToPosition(), which re-commits the
 * whole position for a full term), so a position's weight, and with it its tier, does
 * not fluctuate. Once lockEnd passes, the next touch of the position (by anyone, via
 * pokeExpiredPosition) drops it to the principal. (Governance can still
 * change the tier thresholds with updateTierParams, which applies to existing
 * positions at once: A6-SK-04.) But once lockEnd passes the staker has full liquidity and
 * is no more committed than a 7-day staker, so the multiplier no longer applies
 * and the tier reverts to what raw principal earns. Re-locking, or extending via
 * addToPosition(), restores it. Without this, one finite lock would have bought a
 * permanent multiplied tier at full liquidity.
 *
 * Ecosystem participation incentives:
 *  Sourced exclusively from the pre-allocated 1.7 billion SRX incentive pool
 *  (17% of total supply, sent to this contract at TGE). No new tokens are ever
 *  minted. Longer lock commitments receive a higher share of the pool per token:
 *  ┌──────────────┬────────────────────────────────────────────────────────────┐
 *  │ Lock period  │ Incentive multiplier                                       │
 *  ├──────────────┼────────────────────────────────────────────────────────────┤
 *  │ 7 days       │ 1.00× (base)                                               │
 *  │ 30 days      │ 1.25×                                                      │
 *  │ 90 days      │ 1.50×                                                      │
 *  │ 180 days     │ 2.00×                                                      │
 *  └──────────────┴────────────────────────────────────────────────────────────┘
 *
 * Incentive accounting uses the Synthetix reward-per-token pattern which is
 * gas-efficient, correct under concurrent stake/unstake activity, and does
 * not require iteration over all stakers.
 *
 * Incentive emission is governance-controlled via setRewardRate(). Governance
 * may reduce or pause emissions at any time. The pool is registered via
 * notifyRewardAmount() after TGE distribution deposits tokens into this contract.
 *
 * Early withdrawal: 10% principal penalty sent to the dead address (0xdEaD), out of
 * circulation for good but not counted in SRXToken.totalBurned or deducted from
 * totalSupply. Any incentives
 * accrued up to the point of exit are paid out — the penalty applies only to
 * the principal.
 *
 * ⛔ NOT UPGRADEABLE (REG-53, Jared, 12 Oct 2026). A plain contract: its code can never
 *    change and no role can replace it. The pause (PAUSER_ROLE, held by GuardianModule)
 *    stays. A fix ships as a new contract that holders choose to move to
 *    (docs/MIGRATION.md), never as a forced or in-place change.
 * ⛔ WIND-DOWN (REG-53, Security requirement 12 Oct 2026). Without upgrades, a bug plus a
 *    pause could otherwise trap stakers' SRX. startWindDown() is ONE-WAY: no new locks or
 *    reward registrations ever again, emission stops, and exitAfterWindDown() returns
 *    exactly the caller's own principal, with no penalty and no lock wait, even while the
 *    contract is paused. Rewards accrued up to the switch stay claimable from the
 *    registered pool (claimRewards works in wind-down even while paused). Nothing moves
 *    anyone's tokens for them. Switched by the Timelock (GOVERNANCE_ROLE), the guardian
 *    Safe (WIND_DOWN_ROLE), or by anyone once the contract has been paused for
 *    PAUSE_EXIT_DELAY in total within one run of pauses (pauses less than PAUSE_BREAK
 *    apart are one run; only time actually paused counts). A token-wide SRXToken pause
 *    still stops every
 *    transfer, exits included.
 */
/// @notice What a successor contract must answer: the allocation source it was deployed with.

contract SRXStaking is AccessControl, Pausable {
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant PAUSER_ROLE     = keccak256("PAUSER_ROLE");
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    /// @notice May switch on wind-down without the Timelock's delay: the guardian Safe.
    bytes32 public constant WIND_DOWN_ROLE  = keccak256("WIND_DOWN_ROLE");

    /// @notice After this much time paused within one run (pauses less than PAUSE_BREAK
    ///         apart), anyone may switch on wind-down, so a
    ///         pause can never become permanent confinement of stakers' SRX.
    uint256 public constant PAUSE_EXIT_DELAY = 30 days;
    /// @notice Pauses less than this far apart are one run; only time actually paused
    ///         counts towards PAUSE_EXIT_DELAY, and a gap this long or longer starts a new run
    ///         (internal audit L2, 16 Oct 2026).
    uint256 public constant PAUSE_BREAK = 7 days;

    // ── Tier enum ──────────────────────────────────────────────────────────────

    enum Tier { None, Slate, Onyx, Obsidian }

    // ── Structs ────────────────────────────────────────────────────────────────

    struct LockParams {
        uint256 minSRX;       // minimum WEIGHTED SRX (principal x duration multiplier) to reach this tier
        uint256 discountBps;  // fee discount in basis points (10000 = 100%)
    }

    struct StakePosition {
        uint256 amount;          // SRX principal locked
        uint256 lockEnd;         // unix timestamp when lock expires
        uint256 lockedAt;        // unix timestamp when position was opened
        uint256 lockDuration;    // chosen duration constant (LOCK_7D / 30D / 90D / 180D)
        uint256 weightedAmount;  // amount × multiplier / MULTIPLIER_BASE
    }

    // ── Lock duration constants ────────────────────────────────────────────────

    uint256 public constant LOCK_7D   =   7 days;
    uint256 public constant LOCK_30D  =  30 days;
    uint256 public constant LOCK_90D  =  90 days;
    uint256 public constant LOCK_180D = 180 days;

    // ── Incentive multipliers ──────────────────────────────────────────────────
    // Denominated out of MULTIPLIER_BASE (100). A 180-day staker receives 2× the
    // share per token compared to a 7-day staker.

    uint256 public constant MULTIPLIER_BASE = 100;
    uint256 public constant MULTIPLIER_7D   = 100; // 1.00×
    uint256 public constant MULTIPLIER_30D  = 125; // 1.25×
    uint256 public constant MULTIPLIER_90D  = 150; // 1.50×
    uint256 public constant MULTIPLIER_180D = 200; // 2.00×

    // ── Principal early-exit penalty ───────────────────────────────────────────

    uint256 public constant EARLY_WITHDRAW_PENALTY_BPS = 1_000; // 10%
    uint256 public constant BPS_DENOMINATOR            = 10_000;

    // ── Fixed reward allocation (REG-50) ───────────────────────────────────────

    /// @notice The most SRX that can EVER be registered as staking rewards: the
    ///         1.7 billion SRX staking allocation set at launch (deploy config
    ///         ALLOCATIONS.stakingPool). A constant, so no governance call, role or
    ///         deployment can raise it; counted cumulatively in totalRewardsRegistered,
    ///         so a rescued or claimed amount never frees room for a later top-up.
    uint256 public constant REWARD_ALLOCATION = 1_700_000_000 * 10 ** 18;

    // ── Internal precision scalar for reward-per-token accumulator ─────────────

    uint256 private constant PRECISION = 1e18;

    // ── State: fee tiers and positions ─────────────────────────────────────────

    IERC20 public immutable srx;

    mapping(Tier => LockParams)     public tierParams;
    mapping(address => StakePosition) public positions;

    uint256 public totalLocked;         // sum of all principal amounts
    uint256 public totalPenaltyBurned;  // cumulative early-exit penalties

    // ── State: incentive accounting ────────────────────────────────────────────

    uint256 public rewardRate;           // SRX wei per second across all stakers (0 = paused)
    uint256 public rewardPerTokenStored; // accumulated incentive per unit weighted stake (× PRECISION)
    uint256 public lastUpdateTime;       // block.timestamp at last global accumulator update
    uint256 public totalWeightedStake;   // sum of all users' weightedAmount values
    uint256 public rewardPool;           // remaining undistributed incentive tokens


    mapping(address => uint256) public userRewardPerTokenPaid; // per-user checkpoint
    mapping(address => uint256) public pendingRewards;         // earned but unclaimed

    // ── Reentrancy guard (inline — ReentrancyGuardUpgradeable removed in OZ v5.1+) ──

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED     = 2;
    uint256 private _status;

    // ⛔ REMOVED 11 Oct 2026 (REG-50 option C): the "bonus" second reward stream
    //    (bonusRewardToken, its rate, accumulator, pool, per-user checkpoints,
    //    bonusPeriodFinish and totalBonusPendingRewards). It existed so governance
    //    could pay stakers a second token funded from platform fee revenue. Its
    //    storage is gone too, not left as a placeholder.

    /// @notice Timestamp after which reward accrual stops (SC-ECON-001 fix).
    ///         Recomputed on pool/rate changes as now + pool/rate, so total emission
    ///         can never exceed the funded pool. Accrual is capped via
    ///         lastTimeRewardApplicable().
    uint256 public periodFinish;

    // ── Appended 9 Sep 2026 (audit remediation) ────────────────────────────────

    /// @notice Sum of every user's accrued-but-unclaimed pendingRewards.
    /// @dev rewardPool alone is NOT the free balance: it still holds tokens that
    ///      have already accrued to stakers and are merely unclaimed. Scheduling
    ///      against rewardPool therefore promised the same tokens twice.
    uint256 public totalPendingRewards;

    /// @notice Smallest position this contract will accept.
    /// @dev Dust positions are not a rounding curiosity: a 1-wei stake collected
    ///      the entire emission stream (1,166,400 SRX in a day) and simultaneously
    ///      blocked the (since removed) rescueStrandedPool(), which required totalWeightedStake == 0.
    uint256 public minStakeAmount;

    /// @notice Total weighted stake below which emission does not accrue at all.
    /// @dev ⭐ This, not minStakeAmount, is what actually fixes the capture. Under
    ///      Synthetix accounting ANY sole staker collects 100% of emissions, which
    ///      is correct; the defect is that it could be done with no capital at
    ///      risk. Below this threshold the accrual clock does not advance, exactly
    ///      as it already does not when totalWeightedStake is zero -- so the paused
    ///      interval is skipped rather than paid retroactively.
    uint256 public minTotalStakeForEmission;

    // ── Appended 11 Oct 2026 (REG-50) ───────────────────────────────────────────
    /// @notice Every SRX amount ever registered as rewards via notifyRewardAmount(),
    ///         summed. Never decreases: claims and releases do not give
    ///         room back. notifyRewardAmount() refuses anything that would take it
    ///         above REWARD_ALLOCATION.
    uint256 public totalRewardsRegistered;

    /// @notice The launch distributor whose record of what it delivered here is the only
    ///         thing rewards can be backed by. Fixed at deployment.
    address public immutable tgeDistributor;

    /// @notice SRX the launch distribution delivered to this contract, capped at
    ///         REWARD_ALLOCATION. Set once, by syncAllocation(), after distribution.
    uint256 public rewardBacking;

    /// @notice True once syncAllocation() has read the distributor's record.
    bool public allocationSynced;

    // ── Wind-down (REG-53) ────────────────────────────────────────────────────
    /// @notice True for good once startWindDown() has run. No function sets it false.
    bool public windDown;
    /// @notice When the current pause began (0 while not paused).
    uint256 public pausedSince;
    /// @notice Unused reward allocation released to each successor after wind-down.
    mapping(address => uint256) public releasedTo;
    /// @notice When the last pause ended (0 before the first unpause).
    uint256 public unpausedAt;
    /// @notice Time already spent paused in the current run, before the pause now running.
    ///         Pauses separated by less than PAUSE_BREAK are one run (sweep SWEEP-03).
    uint256 public pausedInRun;


    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    event Locked(address indexed user, uint256 amount, uint256 lockEnd, Tier tier, uint256 weightedAmount);
    event Unlocked(address indexed user, uint256 amount);
    event EarlyWithdrawal(address indexed user, uint256 returned, uint256 penalty);
    event RewardsClaimed(address indexed user, uint256 amount);
    event RewardRateSet(uint256 oldRate, uint256 newRate);
    event RewardPoolFunded(uint256 amount, uint256 newTotal);
    /// @notice The pool could not cover a staker's full accrued entitlement.
    ///         The unpaid remainder stays claimable; it is not written off.
    event RewardShortfall(address indexed user, uint256 unpaid);
    /// @notice An expired lock's reward multiplier was dropped back to 1.00x.
    event WeightDecayed(address indexed user, uint256 newWeight, uint256 removed);
    /// @notice addToPosition changed a position's principal, lock end and weight.
    event PositionIncreased(address indexed user, uint256 added, uint256 newAmount, uint256 lockEnd, uint256 weightedAmount);
    event MinStakeAmountSet(uint256 oldMinimum, uint256 newMinimum);
    event MinTotalStakeForEmissionSet(uint256 oldMinimum, uint256 newMinimum);
    event TierParamsUpdated(Tier indexed tier, uint256 minSRX, uint256 discountBps);
    /// @notice REG-50: the launch allocation delivered here, and the part of it that
    ///         may back rewards (capped at REWARD_ALLOCATION).
    event AllocationSynced(address indexed distributor, uint256 delivered, uint256 backing);
    /// @notice The contract is now exit-only, for good. byPauseTimeout: switched by anyone
    ///         after PAUSE_EXIT_DELAY of pause within one run.
    event WindDownStarted(address indexed by, bool byPauseTimeout);
    /// @notice A staker took back exactly their principal after wind-down.
    event ExitedAfterWindDown(address indexed user, uint256 principal);
    /// @notice Unused launch reward allocation moved to a successor contract after wind-down.
    event RewardAllocationReleased(address indexed successor, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error InvalidLockDuration();
    error PositionExists();
    error NoPosition();
    error LockNotExpired(uint256 lockEnd);
    /// @notice The position is smaller than minStakeAmount.
    error BelowMinimumStake(uint256 amount, uint256 minimum);
    error InvalidBps();
    error NothingToClaim();
    error PoolAmountExceedsAvailable(uint256 available, uint256 requested);
    /// @notice REG-50: registering `requested` would take cumulative rewards past
    ///         REWARD_ALLOCATION; `remaining` is what is left of the allocation.
    error RewardAllocationExceeded(uint256 remaining, uint256 requested);
    error DistributionNotComplete();
    error WrongDistributorToken(address token);
    error WoundDown();
    error NotWoundDown();
    error NotAuthorisedToWindDown();
    error ReleaseExceedsUnusedAllocation(uint256 releasable, uint256 requested);
    /// @notice The release target is not a contract that names this one as its allocation source.
    error NotASuccessor(address successor);

    // ── Constructor ────────────────────────────────────────────────────────────


    /// @param _tgeDistributor The launch TGEDistributor (deploy step 03). REG-50: its
    ///        record of what it delivers here is the only backing rewards can have.
    constructor(address _srx, address _admin, address _tgeDistributor) {
        if (_srx == address(0) || _admin == address(0) || _tgeDistributor == address(0)) revert ZeroAddress();

        _status = _NOT_ENTERED;

        // Set state BEFORE granting roles (defensive ordering, SC-UUPS-002).
        srx            = IERC20(_srx);
        tgeDistributor = _tgeDistributor;
        lastUpdateTime = block.timestamp; // anchor accumulator to deploy time

        // Default tier parameters — adjustable by governance
        tierParams[Tier.None]   = LockParams({ minSRX: 0,                    discountBps: 0      });
        tierParams[Tier.Slate] = LockParams({ minSRX: 50_000  * 10 ** 18,   discountBps: 2_500  });
        tierParams[Tier.Onyx] = LockParams({ minSRX: 250_000 * 10 ** 18,   discountBps: 6_000  });
        tierParams[Tier.Obsidian]   = LockParams({ minSRX: 1_000_000 * 10 ** 18, discountBps: 10_000 });

        // ── Audit remediation defaults, 9 Sep 2026 ─────────────────────────────
        //
        // 100 SRX is 0.2% of the Slate tier floor: it excludes no genuine
        // participant while making dust griefing cost real money. On its own this
        // closes the 1-wei cases -- the 1-wei position that collected the whole
        // emission stream, and the 1-wei seed lock that minted a permanent 2.00x
        // slot -- and it breaks nothing in the existing suite. It does not stop a
        // sole staker at the minimum from taking the whole stream: that is what
        // minTotalStakeForEmission is for, and it is inactive until governance sets it.
        minStakeAmount = 100 * 10 ** 18;

        // ⚠️ DELIBERATELY INACTIVE (0). The mechanism is built and tested
        //    (test/Gaps.Staking.test.js S2); the
        //    VALUE is a launch decision and is not being guessed here.
        //
        //    A candidate of 1,000,000 SRX (the Obsidian floor) was tried and broke
        //    17 existing tests, because the suite stakes smaller amounts and
        //    legitimately expects accrual. That is a real signal about blast
        //    radius, not a test problem: shipping a live economic gate whose value
        //    was picked without production data is how a launch gets bricked by
        //    its own safety control. Governance sets it before mainnet, when the
        //    expected participation is known.
        minTotalStakeForEmission = 0;

        // Grant roles LAST — after state is fully consistent
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNANCE_ROLE,    _admin);
        _grantRole(PAUSER_ROLE,        _admin);
        _grantRole(WIND_DOWN_ROLE,     _admin); // the guardian Safe (REG-53)
    }

    // ── Incentive accounting (read) ────────────────────────────────────────────

    /**
     * @notice Current accumulated incentive per unit of weighted stake.
     *         Increases monotonically as time passes while rewardRate > 0.
     */
    /**
     * @notice Latest time primary-reward accrual is valid — capped at periodFinish so
     *         emission never exceeds the funded pool (SC-ECON-001 fix).
     */
    // slither-disable-next-line incorrect-equality -- reviewed 7 Oct 2026: a `== 0` nothing-to-do guard on internal accounting or our own balance; no outsider can move it to bypass or block anything
    function lastTimeRewardApplicable() public view returns (uint256) {
        if (periodFinish == 0) return block.timestamp; // no schedule set yet — uncapped (rate is 0)
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        // ⛔ Emission does not accrue into negligible participation. A 1-wei
        //    position previously collected the entire stream -- 1,166,400 SRX in a
        //    day. Returning the stored value (rather than advancing it) is the
        //    same mechanism already used for totalWeightedStake == 0, and because
        //    _updateReward always advances lastUpdateTime to
        //    lastTimeRewardApplicable(), the paused interval is SKIPPED rather
        //    than paid out retroactively when stake later crosses the threshold.
        if (totalWeightedStake < minTotalStakeForEmission) return rewardPerTokenStored;
        if (totalWeightedStake == 0) return rewardPerTokenStored;
        uint256 applicable = lastTimeRewardApplicable();
        if (applicable <= lastUpdateTime) return rewardPerTokenStored;
        uint256 elapsed = applicable - lastUpdateTime;
        return rewardPerTokenStored + (rewardRate * elapsed * PRECISION) / totalWeightedStake;
    }

    /**
     * @notice Total earned-but-unclaimed incentives for a user.
     */
    function earned(address user) public view returns (uint256) {
        StakePosition memory pos = positions[user];
        return (pos.weightedAmount * (rewardPerToken() - userRewardPerTokenPaid[user])) / PRECISION
            + pendingRewards[user];
    }

    // ── Incentive accounting (write) ───────────────────────────────────────────

    /**
     * @dev Update the global accumulator and snapshot the user's checkpoint.
     *      Must be called before any change to totalWeightedStake or a user's weightedAmount.
     *      Pass address(0) when only the global state needs updating.
     */
    function _updateReward(address user) internal {
        uint256 newRPT = rewardPerToken();

        // ⭐ Roll up EVERY staker's accrual, not just this caller's. Tracking it
        //    per-user was wrong: a global update (user == address(0)), which is
        //    exactly what the funding and rate-setting paths perform, left the
        //    other stakers' accrual uncounted, so the liability was understated
        //    and the schedule still over-extended. The delta in rewardPerToken
        //    applies to the whole weighted stake by construction, so accruing it
        //    here is both exact and independent of who triggered the update.
        if (newRPT > rewardPerTokenStored && totalWeightedStake != 0) {
            unchecked {
                totalPendingRewards +=
                    (totalWeightedStake * (newRPT - rewardPerTokenStored)) / PRECISION;
            }
        }

        rewardPerTokenStored = newRPT;
        lastUpdateTime       = lastTimeRewardApplicable();

        if (user != address(0)) {
            pendingRewards[user]         = earned(user);
            userRewardPerTokenPaid[user] = rewardPerTokenStored;

            // ⭐ The weight may only change once accrual has been banked at the OLD
            //    weight, which is true from here on. (While the bonus stream existed
            //    this ran at the end of _updateBonusReward instead, because both
            //    accumulators shared weightedAmount; REG-50 removed that stream.)
            _decayExpiredWeight(user);
        }
    }

    /**
     * @dev Drop an expired position's REWARD weight back to its raw principal.
     *
     * ⛔ getTier() already did this for fee tiers (the R7-01 fix, with a comment
     *    explaining that an expired lock is "no more committed than a 7-day
     *    staker"). The reward path never got the same treatment, so a finite lock
     *    bought a PERMANENT 2.00x emission share at zero ongoing commitment.
     *    Measured: two stakers with identical principal, one on an expired 180-day
     *    lock and one on an expired 7-day lock, accrued in a 2:1 ratio forever
     *    (test/audit-poc/staking-economics.test.js F2, F6, F6b).
     *
     * ⚠️ This is a LAZY decay, and that is a deliberate trade-off rather than an
     *    oversight. rewardPerToken() divides by totalWeightedStake, so an
     *    "effective weight" computed inside earned() would not match the
     *    denominator and would break the accumulator for everyone. The weight has
     *    to actually change, and nothing runs at lockEnd. So a position keeps its
     *    multiplier until something next touches it.
     *
     * ⭐ pokeExpiredPosition() exists so that window is bounded by someone caring
     *    rather than by the staker's own inaction -- anyone may close it, and it
     *    costs the caller only gas.
     */
    function _decayExpiredWeight(address user) internal {
        StakePosition storage pos = positions[user];
        if (pos.amount == 0)               return;   // no position
        if (block.timestamp < pos.lockEnd) return;   // still committed
        if (pos.weightedAmount <= pos.amount) return; // already at 1.00x

        uint256 excess;
        unchecked { excess = pos.weightedAmount - pos.amount; }
        pos.weightedAmount  = pos.amount;
        totalWeightedStake -= excess;

        emit WeightDecayed(user, pos.amount, excess);
    }

    /**
     * @dev Bound total primary emission to the funded pool (SC-ECON-001). Call AFTER
     *      any rewardPool/rewardRate change and AFTER _updateReward has settled accrual.
     */
    function _recomputePeriodFinish() internal {
        // Anchor the accrual clock to now (Synthetix pattern) so a gap between a
        // previously-ended period and this rate/pool change is not retroactively
        // billed. _updateReward must be called immediately before this.
        lastUpdateTime = block.timestamp;

        // ⛔ THIS DIVIDED THE WHOLE rewardPool, WHICH RE-PROMISED TOKENS ALREADY
        //    OWED. rewardPool is only decremented when a staker CLAIMS, so it
        //    still contains everything accrued-but-unclaimed. Every rate change or
        //    top-up therefore re-granted the accrued liability as fresh runway.
        //    Measured: a 10 SRX top-up extended the schedule to 1010s where ~110s
        //    was funded, and earned reached 1912 against a pool of 1010
        //    (test/audit-poc/staking-economics.test.js F1, F1b).
        uint256 unaccrued = rewardPool > totalPendingRewards
            ? rewardPool - totalPendingRewards
            : 0;

        periodFinish = rewardRate == 0
            ? block.timestamp
            : block.timestamp + (unaccrued / rewardRate);
    }

    /**
     * @dev Transfer all pending incentives to the user and decrement the pool.
     *      Does nothing if pendingRewards[user] == 0.
     */
    // slither-disable-next-line incorrect-equality -- reviewed 7 Oct 2026: a `== 0` nothing-to-do guard on internal accounting or our own balance; no outsider can move it to bypass or block anything
    function _settleRewards(address user) internal {
        uint256 owed = pendingRewards[user];
        if (owed == 0) return;

        // Safety cap — should not trigger now that the schedule is bounded by the
        // unaccrued pool, but it is kept because a cap that never fires costs
        // nothing and a missing one costs everything.
        uint256 reward = owed > rewardPool ? rewardPool : owed;

        // ⛔ THIS SET pendingRewards TO ZERO AFTER CAPPING, SO ANY SHORTFALL WAS
        //    PERMANENTLY DESTROYED -- no revert, no event, nothing for the staker
        //    to see. They were simply paid less than they had earned and the
        //    entitlement vanished. The remainder is now RETAINED as still-pending
        //    and becomes claimable once the pool is refunded, and the gap is
        //    announced rather than swallowed.
        pendingRewards[user] = owed - reward;
        // ⛔ STK-M1: this was an unchecked subtraction. Per-update flooring leaves
        //    the global total a few wei BELOW the sum of individual claims, so the
        //    last claim wrapped it to ~2^256, after which _recomputePeriodFinish
        //    saw no unaccrued pool and froze every future schedule. Clamp at zero.
        totalPendingRewards = totalPendingRewards > reward ? totalPendingRewards - reward : 0;
        rewardPool -= reward;

        srx.safeTransfer(user, reward);
        emit RewardsClaimed(user, reward);

        if (reward < owed) emit RewardShortfall(user, owed - reward);
    }

    // ── Staking ────────────────────────────────────────────────────────────────

    /**
     * @notice Lock SRX for a chosen duration. Immediately activates the fee tier
     *         and begins accumulating ecosystem participation incentives.
     * @param amount       SRX amount (18-decimal).
     * @param lockDuration One of LOCK_7D, LOCK_30D, LOCK_90D, LOCK_180D.
     */
    function lock(uint256 amount, uint256 lockDuration) external nonReentrant whenNotPaused {
        if (windDown)                      revert WoundDown();
        if (amount == 0)                   revert ZeroAmount();
        if (amount < minStakeAmount)       revert BelowMinimumStake(amount, minStakeAmount);
        if (!_validDuration(lockDuration)) revert InvalidLockDuration();
        if (positions[msg.sender].amount > 0) revert PositionExists();

        _updateReward(msg.sender);

        uint256 multiplier     = _multiplier(lockDuration);
        uint256 weightedAmount = (amount * multiplier) / MULTIPLIER_BASE;

        positions[msg.sender] = StakePosition({
            amount:         amount,
            lockEnd:        block.timestamp + lockDuration,
            lockedAt:       block.timestamp,
            lockDuration:   lockDuration,
            weightedAmount: weightedAmount
        });

        totalLocked        += amount;
        totalWeightedStake += weightedAmount;

        srx.safeTransferFrom(msg.sender, address(this), amount);

        emit Locked(msg.sender, amount, block.timestamp + lockDuration, getTier(msg.sender), weightedAmount);
    }

    /**
     * @notice Add more SRX to an existing position. Optionally extend the lock duration,
     *         which also upgrades the incentive multiplier for the entire position.
     * @param additionalAmount Extra SRX to lock.
     * @param newDuration      0 = keep the current duration: the lock ends no earlier than
     *                         a full term of it from now. Otherwise a valid duration; the
     *                         lock ends no earlier than a full term of it from now.
     */
    function addToPosition(uint256 additionalAmount, uint256 newDuration) external nonReentrant whenNotPaused {
        if (windDown) revert WoundDown();
        StakePosition storage pos = positions[msg.sender];
        if (pos.amount == 0)        revert NoPosition();
        if (additionalAmount == 0)  revert ZeroAmount();

        _updateReward(msg.sender);

        // Remove old weighted stake from global total before recalculating
        totalWeightedStake -= pos.weightedAmount;

        pos.amount  += additionalAmount;
        totalLocked += additionalAmount;

        // An expired lock is no longer a commitment of any length, so the
        // no-downgrade rule below protects nothing and only blocks a fresh lock.
        bool expired = block.timestamp >= pos.lockEnd;

        if (newDuration > 0) {
            if (!_validDuration(newDuration)) revert InvalidLockDuration();
            // Prevent multiplier downgrade — stakers may only maintain or upgrade
            // their commitment tier. A 180-day staker near expiry cannot switch to
            // 7-day to drop their multiplier from 2.0× to 1.0× (A2-M-04 fix).
            if (!expired && _multiplier(newDuration) < _multiplier(pos.lockDuration)) revert InvalidLockDuration();
            uint256 newEnd = block.timestamp + newDuration;
            if (newEnd > pos.lockEnd) {
                pos.lockEnd      = newEnd;
                pos.lockDuration = newDuration;
            }
        } else {
            // ⛔ Internal audit M5 and M6 (STAKING-01, -02; 16 Oct 2026). With 0 the lock end
            //    did not move, so SRX added a day before a 180-day lock ended got the full
            //    2.00x weight for a day's commitment, and SRX added to an EXPIRED lock counted
            //    for the fee tier at once and could leave in the next transaction (one stack
            //    gave Obsidian to two addresses in one block). New SRX now serves a full
            //    term of the duration whose multiplier the position carries.
            uint256 renewEnd = block.timestamp + pos.lockDuration;
            if (renewEnd > pos.lockEnd) pos.lockEnd = renewEnd;
        }

        // ⛔ F6 WAS RECORDED AS FIXED AND WAS NOT. This line recomputed the weight
        //    from the stored lockDuration, which still says 180 days after the
        //    lock has lapsed, so addToPosition(x, 0) on an expired lock put the
        //    whole enlarged position straight back at 2.00x with no live lock.
        //    _decayExpiredWeight had just removed the multiplier; this restored it.
        //    The PoC asserted the 2.00x and was labelled [FIXED] (pre-external-audit
        //    sweep, 23 Sep 2026). A position whose lock has ended weighs its
        //    principal, exactly as _decayExpiredWeight and getTier already treat it.
        uint256 mult = block.timestamp >= pos.lockEnd ? MULTIPLIER_BASE : _multiplier(pos.lockDuration);
        pos.weightedAmount  = (pos.amount * mult) / MULTIPLIER_BASE;
        totalWeightedStake += pos.weightedAmount;

        srx.safeTransferFrom(msg.sender, address(this), additionalAmount);
        emit PositionIncreased(msg.sender, additionalAmount, pos.amount, pos.lockEnd, pos.weightedAmount);
    }

    /**
     * @notice Unlock SRX after the lock period has expired. Any earned incentives
     *         are automatically paid out at the same time.
     */
    function unlock() external nonReentrant whenNotPaused {
        StakePosition memory pos = positions[msg.sender];
        if (pos.amount == 0)               revert NoPosition();
        if (block.timestamp < pos.lockEnd) revert LockNotExpired(pos.lockEnd);

        _updateReward(msg.sender);
        _settleRewards(msg.sender);

        // ⛔ RE-READ AFTER SETTLEMENT. The snapshot above was taken BEFORE the
        //    _update* calls, which may now decay an expired position's
        //    weightedAmount and reduce totalWeightedStake with it. Subtracting the
        //    STALE weight from an already-reduced total underflows and reverts --
        //    caught by the existing "unlocking clears the tier entirely" test, not
        //    by anything I wrote.
        pos = positions[msg.sender];

        totalLocked        -= pos.amount;
        totalWeightedStake -= pos.weightedAmount;
        delete positions[msg.sender];

        srx.safeTransfer(msg.sender, pos.amount);
        emit Unlocked(msg.sender, pos.amount);
    }

    /**
     * @notice Emergency exit before lock expiry. A 10% principal penalty is sent
     *         to the canonical dead address (not counted in SRXToken.totalBurned). Any incentives earned up to this point
     *         are paid out in full — the penalty applies only to the principal.
     *
     * ⚠️  This function intentionally omits `whenNotPaused` so users can exit
     *     staking positions during a guardian-triggered emergency. However, SRXToken
     *     itself blocks all transfers when paused (via _update override). As a result,
     *     if the SRX token contract is paused, this function will revert on the
     *     safeTransfer calls even though the staking contract is not paused.
     *     This is a known design constraint: a token-level pause effectively freezes
     *     all token movements, including emergency staking exits (A2-H-02).
     */
    /**
     * @notice Drop an expired position's reward multiplier back to 1.00x.
     * @dev ⭐ PERMISSIONLESS BY DESIGN. The multiplier prices an active
     *      commitment, so once lockEnd passes it should stop applying -- but
     *      nothing runs at lockEnd, and the decay otherwise waits for the staker
     *      to touch their own position, which a staker benefiting from 2.00x at
     *      zero commitment has no reason to do. Letting anyone close that window
     *      removes the incentive to sit still. The caller pays only gas and gains
     *      nothing directly beyond a larger share of the emission stream, which is
     *      precisely the right incentive.
     *
     *      No-op if the position is empty, still locked, or already at 1.00x.
     * @param user The position to bring up to date.
     */
    /**
     * @notice Set the smallest acceptable position.
     * @dev Does not affect existing positions; it gates new entries only.
     */
    function setMinStakeAmount(uint256 newMinimum) external onlyRole(GOVERNANCE_ROLE) {
        emit MinStakeAmountSet(minStakeAmount, newMinimum);
        minStakeAmount = newMinimum;
    }

    /**
     * @notice Set the total weighted stake below which emission does not accrue.
     * @dev ⚠️ Raising this above the CURRENT total weighted stake pauses emission
     *      immediately. That is the intended lever, but it is a live economic
     *      control and not a cosmetic parameter, so it is GOVERNANCE_ROLE only and
     *      emits both values.
     */
    function setMinTotalStakeForEmission(uint256 newMinimum) external onlyRole(GOVERNANCE_ROLE) {
        _updateReward(address(0));       // bank accrual under the OLD threshold first
        emit MinTotalStakeForEmissionSet(minTotalStakeForEmission, newMinimum);
        minTotalStakeForEmission = newMinimum;
    }

    function pokeExpiredPosition(address user) external nonReentrant {
        // Accrual is banked at the OLD weight before it changes; _updateReward
        // performs the decay as its final step.
        _updateReward(user);
    }

    function earlyWithdraw() external nonReentrant {
        StakePosition memory pos = positions[msg.sender];
        if (pos.amount == 0) revert NoPosition();

        _updateReward(msg.sender);
        // ⛔ Internal audit L11 (STAKING-03, 16 Oct 2026): this paid rewards out while paused,
        //    when claimRewards refuses. During a pause the principal still leaves (this is the
        //    emergency exit) but rewards stay pending, claimable once the pause ends.
        if (!paused() || windDown) _settleRewards(msg.sender);

        // ⛔ RE-READ AFTER SETTLEMENT. The snapshot above was taken BEFORE the
        //    _update* calls, which may now decay an expired position's
        //    weightedAmount and reduce totalWeightedStake with it. Subtracting the
        //    STALE weight from an already-reduced total underflows and reverts --
        //    caught by the existing "unlocking clears the tier entirely" test, not
        //    by anything I wrote.
        pos = positions[msg.sender];

        // ⛔ THE PENALTY WAS CHARGED UNCONDITIONALLY, INCLUDING ON LOCKS THAT HAD
        //    ALREADY EXPIRED. A withdrawal after lockEnd is not early, so there is
        //    nothing to penalise -- the staker served the full term. Measured: a
        //    100,000 principal on an EXPIRED lock returned 90,000
        //    (test/audit-poc/staking-economics.test.js F3).
        //
        // ⭐ This also removes most of F4. unlock() and claimRewards() are
        //    whenNotPaused, so while the contract is paused earlyWithdraw() is the
        //    only exit -- which meant a staker whose lock had long expired paid 10%
        //    for the privilege of leaving during an incident they did not cause.
        //    An expired position now exits whole, paused or not.
        // REG-53: no penalty once wound down (exitAfterWindDown is the intended route).
        uint256 penalty  = (block.timestamp < pos.lockEnd && !windDown)
            ? (pos.amount * EARLY_WITHDRAW_PENALTY_BPS) / BPS_DENOMINATOR
            : 0;
        uint256 returned = pos.amount - penalty;

        totalLocked        -= pos.amount;
        totalWeightedStake -= pos.weightedAmount;
        totalPenaltyBurned += penalty;

        delete positions[msg.sender];

        srx.safeTransfer(msg.sender, returned);
        // Penalty goes to the canonical dead address: out of circulation for good, but
        // totalSupply and SRXToken.totalBurned do not change.
        // Guarded because an expired position now has no penalty at all.
        if (penalty != 0) {
            srx.safeTransfer(address(0x000000000000000000000000000000000000dEaD), penalty);
        }

        emit EarlyWithdrawal(msg.sender, returned, penalty);
    }

    /**
     * @notice Claim accumulated ecosystem participation incentives without unstaking.
     *         The staking position and fee tier remain active.
     */
    // slither-disable-next-line incorrect-equality -- reviewed 7 Oct 2026: a `== 0` nothing-to-do guard on internal accounting or our own balance; no outsider can move it to bypass or block anything
    function claimRewards() external nonReentrant {
        // REG-53: rewards accrued before wind-down stay claimable, even while paused.
        if (paused() && !windDown) revert EnforcedPause();
        // ⛔ This required a live position, so a staker who exited during a pool
        //    shortfall could reach the remainder (kept as pending, never written off)
        //    only by staking again (internal review, 7 Oct 2026). Pending rewards are
        //    claimable with or without a position, as in StabilisationFund.
        _updateReward(msg.sender);
        if (pendingRewards[msg.sender] == 0)   revert NothingToClaim();
        _settleRewards(msg.sender);
    }

    // ── Tier queries ───────────────────────────────────────────────────────────

    /**
     * @notice Returns the current fee discount tier for an address.
     *         Called by FeeController at payment time.
     * @dev Tier is keyed off WEIGHTED stake (positions[user].weightedAmount),
     *      not raw principal — see contract-level NatSpec. This is the same
     *      duration-scaled figure already used for incentive-pool weighting,
     *      so reaching a tier via a longer lock requires less raw SRX than
     *      reaching it via the shortest (7-day) lock.
     */
    function getTier(address user) public view returns (Tier) {
        StakePosition storage pos = positions[user];

        // R7-01 fix: the duration multiplier prices an ACTIVE commitment, so it only
        // applies while the lock is still running. Once lockEnd passes the staker has
        // full liquidity (unlock() is callable in the next block) and is therefore no
        // more committed than a 7-day staker — so the tier falls back to raw principal.
        //
        // Without this, a single finite lock granted a PERMANENT multiplied tier: 500,000
        // SRX locked once for 180 days held Obsidian forever, at full liquidity, halving the
        // capital cost of the top tier and leaking platform fee revenue indefinitely.
        //
        // An expired position keeps whatever tier its raw principal earns; re-locking (or
        // addToPosition with a longer duration) restores the multiplier. For an empty
        // position lockEnd == 0, so this yields amount == 0 → Tier.None (as long as
        // Slate's minSRX stays above 0, as deployed).
        // Internal audit L13 (STAKING-07): after wind-down a position can leave at any
        // moment, so like an expired lock it counts its principal only.
        uint256 effective = (block.timestamp < pos.lockEnd && !windDown)
            ? pos.weightedAmount
            : pos.amount;

        if (effective >= tierParams[Tier.Obsidian].minSRX)   return Tier.Obsidian;
        if (effective >= tierParams[Tier.Onyx].minSRX) return Tier.Onyx;
        if (effective >= tierParams[Tier.Slate].minSRX) return Tier.Slate;
        return Tier.None;
    }

    /**
     * @notice Returns the discount in basis points for a given address.
     */
    function getDiscountBps(address user) external view returns (uint256) {
        return tierParams[getTier(user)].discountBps;
    }

    /**
     * @notice Returns full position details including current incentive balance.
     */
    function getPosition(address user) external view returns (
        uint256 amount,
        uint256 lockEnd,
        uint256 lockedAt,
        Tier    tier,
        uint256 discountBps,
        uint256 weightedAmount,
        uint256 pendingReward
    ) {
        StakePosition memory pos = positions[user];
        Tier t = getTier(user);
        return (
            pos.amount,
            pos.lockEnd,
            pos.lockedAt,
            t,
            tierParams[t].discountBps,
            pos.weightedAmount,
            earned(user)
        );
    }

    // ── Governance ─────────────────────────────────────────────────────────────

    /**
     * @notice Register tokens already held in this contract as the ecosystem
     *         incentive pool. Called by governance after TGE distribution sends
     *         the staking allocation to this contract.
     *
     *         The tokens must already be present in the contract (TGEDistributor
     *         sends them via safeTransfer). This function only updates the internal
     *         accounting — no tokens are moved.
     *
     * ⛔ REG-50: cumulative registrations can never exceed rewardBacking, the SRX the
     *    launch distribution delivered here (at most REWARD_ALLOCATION). SRX that
     *    reaches this contract any other way (fee revenue, buy-back proceeds, a plain
     *    transfer) can therefore neither extend the rewards nor pay for them, whoever
     *    holds GOVERNANCE_ROLE. Before syncAllocation() the backing is read here first.
     *
     * @param amount Amount to register. Must not exceed unallocated balance
     *               (contract balance minus user-staked tokens), nor what remains
     *               of REWARD_ALLOCATION.
     */
    function notifyRewardAmount(uint256 amount) external onlyRole(GOVERNANCE_ROLE) {
        if (windDown)    revert WoundDown();
        if (amount == 0) revert ZeroAmount();
        _syncAllocation(); // read live (internal audit M1)
        uint256 remaining = rewardBacking - totalRewardsRegistered;
        if (amount > remaining) revert RewardAllocationExceeded(remaining, amount);
        // Subtract both locked principal AND existing rewardPool so governance cannot
        // double-register the same token balance as rewards (A2-L-05 fix).
        uint256 balance   = srx.balanceOf(address(this));
        uint256 encumbered = totalLocked + rewardPool;
        uint256 available  = balance > encumbered ? balance - encumbered : 0;
        if (amount > available) revert PoolAmountExceedsAvailable(available, amount);

        _updateReward(address(0)); // settle global accumulator before modifying pool

        totalRewardsRegistered += amount;
        rewardPool             += amount;
        _recomputePeriodFinish(); // SC-ECON-001: extend schedule to cover the new pool
        emit RewardPoolFunded(amount, rewardPool);
    }

    /**
     * @notice Read how much SRX the allocation source delivered here; only that (at most
     *         REWARD_ALLOCATION) can ever back rewards (REG-50).
     * @dev Permissionless: the amount comes from the source fixed at deployment, not
     *      from the caller, and it can only be read after distribution. Also run by
     *      every notifyRewardAmount() and by startWindDown().
     *
     * ⛔ Internal audit M1 (MONEY-01, 16 Oct 2026): this was one-shot. A successor's source
     *    is its wound-down predecessor, whose record grows with each release, so anyone
     *    who synced the successor before the release fixed its backing at 0 for good and
     *    the released launch SRX arrived as free SRX. The record is now re-read until this
     *    contract winds down, and the backing only ever rises: a TGEDistributor's record
     *    is final once distributed, and a predecessor's releasedTo only grows. Before
     *    wind-down nothing reduces rewardBacking (releaseRewardAllocation needs wind-down).
     */
    function syncAllocation() external {
        if (windDown) revert WoundDown();
        _syncAllocation();
    }

    function _syncAllocation() internal {
        // ⛔ Sweep SWEEP-01 (22 Oct 2026): after wind-down a release lowers rewardBacking; a
        //    later sync (the fund's SRX deployLiquidity called it) raised it back, so the same
        //    allocation could be released twice, out of free or fee SRX (REG-50). After
        //    wind-down the record is final: startWindDown read it last.
        if (windDown) return;
        ITGEAllocationSource d = ITGEAllocationSource(tgeDistributor);
        if (d.token() != address(srx)) revert WrongDistributorToken(d.token());
        if (!d.distributed())          revert DistributionNotComplete();
        uint256 delivered = d.allocatedTo(address(this));
        uint256 backing   = delivered > REWARD_ALLOCATION ? REWARD_ALLOCATION : delivered;
        allocationSynced = true;
        if (backing > rewardBacking) rewardBacking = backing;
        emit AllocationSynced(address(d), delivered, rewardBacking);
    }

    /**
     * @notice Set the per-second ecosystem incentive emission rate.
     *         Set to 0 to pause all incentive accrual. Governance can adjust
     *         this at any time to control the distribution speed.
     *
     *         Example rates for the 1.7B SRX pool:
     *           13_500_000_000_000_000_000  →  ~4 year distribution
     *            6_750_000_000_000_000_000  →  ~8 year distribution
     *                                    0  →  emissions paused
     *
     * @param newRate SRX wei per second distributed across all weighted stakers.
     */
    function setRewardRate(uint256 newRate) external onlyRole(GOVERNANCE_ROLE) {
        if (windDown) revert WoundDown();
        _updateReward(address(0)); // settle accumulator at old rate before switching
        emit RewardRateSet(rewardRate, newRate);
        rewardRate = newRate;
        _recomputePeriodFinish(); // SC-ECON-001: bound emission to pool at the new rate
    }

    // ── No stranded-pool rescue (internal audit L1, 16 Oct 2026) ──────────────
    //
    // ⛔ rescueStrandedPool(recipient) sent the unaccrued pool to ANY address whenever
    //    nobody was staked, including right after TGE (1.7B SRX), against "no admin can
    //    withdraw it" and against its own twin releaseRewardAllocation, which pays only a
    //    successor. A pool with no stakers is not stranded: accrual resumes when stakers
    //    return. After wind-down, releaseRewardAllocation is the only way out (MIGRATION.md).

    /**
     * @notice Adjust fee tier parameters. Governance-only.
     *
     * ⚠️  RETROACTIVE EFFECT (A6-SK-04): Changes take effect immediately for ALL
     *     stakers — including users currently mid-lock. A staker who locked for 180 days
     *     expecting Obsidian-tier discounts could be silently downgraded to Onyx if the
     *     Obsidian `minSRX` threshold is raised above their weighted stake. There is no
     *     event emitted when an individual staker's effective tier changes (tier is
     *     computed live in `getTier()`). Governance SHOULD announce threshold changes
     *     in advance and minimise disruption to current lock holders.
     *
     * @param minSRX Minimum WEIGHTED SRX (principal x duration multiplier, i.e. the
     *               same figure stored in positions[user].weightedAmount) required
     *               to reach this tier — not raw locked principal.
     */
    function updateTierParams(Tier tier, uint256 minSRX, uint256 discountBps)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        if (tier == Tier.None)             revert InvalidBps(); // None is immutable
        if (discountBps > BPS_DENOMINATOR) revert InvalidBps();

        // Enforce strict tier monotonicity: Slate < Onyx < Obsidian (A5-H-01 fix).
        // getTier() checks tiers in descending order (Obsidian → Onyx → Slate).
        // If a lower tier's minSRX >= a higher tier's minSRX, the higher tier would
        // always match first, making the lower tier unreachable for its intended range.
        // Internal audit L12 (STAKING-06): Slate at 0 gave every address a discount, and a
        // lower tier could carry a larger discount than a higher one. Discounts now rise
        // with the tier, and Slate needs some stake.
        if (tier == Tier.Slate) {
            if (minSRX == 0) revert InvalidBps();
            if (minSRX >= tierParams[Tier.Onyx].minSRX) revert InvalidBps();
            if (discountBps > tierParams[Tier.Onyx].discountBps) revert InvalidBps();
        } else if (tier == Tier.Onyx) {
            if (minSRX <= tierParams[Tier.Slate].minSRX) revert InvalidBps();
            if (minSRX >= tierParams[Tier.Obsidian].minSRX)   revert InvalidBps();
            if (discountBps < tierParams[Tier.Slate].discountBps
                || discountBps > tierParams[Tier.Obsidian].discountBps) revert InvalidBps();
        } else if (tier == Tier.Obsidian) {
            if (minSRX <= tierParams[Tier.Onyx].minSRX) revert InvalidBps();
            if (discountBps < tierParams[Tier.Onyx].discountBps) revert InvalidBps();
        }

        tierParams[tier] = LockParams({ minSRX: minSRX, discountBps: discountBps });
        emit TierParamsUpdated(tier, minSRX, discountBps);
    }

    // ⛔ Internal audit L2 (MONEY-03, STAKING-04, CLAIMS-03; 16 Oct 2026): unpause zeroed
    //    pausedSince, so an unpause and re-pause in one block restarted the 30-day clock
    //    after which anyone may wind down, and stakers could be held for as long as the
    //    pauser liked. A break shorter than PAUSE_BREAK now continues the same pause.
    // ⛔ Sweep SWEEP-03 (22 Oct 2026): L2's fix kept pausedSince through short breaks and
    //    measured WALL time, so a chain of short pauses under 7 days apart opened the
    //    permissionless wind-down after about 5 hours of actual pause. The clock now counts
    //    time actually paused within a run, as GuardianModule's token run does.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
        if (unpausedAt == 0 || block.timestamp >= unpausedAt + PAUSE_BREAK) pausedInRun = 0;
        pausedSince = block.timestamp;
    }
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
        pausedInRun += block.timestamp - pausedSince;
        pausedSince = 0;
        unpausedAt  = block.timestamp;
    }

    // ── Wind-down (REG-53) ─────────────────────────────────────────────────────

    /**
     * @notice Make the contract exit-only, for good. Emission stops now; accrued rewards
     *         stay claimable; every staker can take back their principal with
     *         exitAfterWindDown(). There is no function that reverses this.
     * @dev The Timelock (GOVERNANCE_ROLE) or the guardian Safe (WIND_DOWN_ROLE) may call it
     *      at any time; anyone may once the contract has been paused for a total of
     *      PAUSE_EXIT_DELAY within one run of pauses. Works while paused.
     */
    // slither-disable-next-line reentrancy-no-eth -- reviewed 12 Oct 2026: the only external call is this contract's own syncAllocation(), which reads the TGEDistributor fixed at deployment (no user-supplied target); startWindDown is nonReentrant, so a call-back cannot enter an exit or a registration
    function startWindDown() external nonReentrant {
        if (windDown) revert WoundDown();
        bool byTimeout = false;
        if (!hasRole(GOVERNANCE_ROLE, msg.sender) && !hasRole(WIND_DOWN_ROLE, msg.sender)) {
            if (!(paused() && pausedSince != 0 && block.timestamp >= windDownOpenToAllAt())) {
                revert NotAuthorisedToWindDown();
            }
            byTimeout = true;
        }
        // Security review (12 Oct): read the launch allocation first, so a pool that never
        // registered rewards can still migrate its unused allocation. A failing read must
        // never block the exit, so it is attempted through an external self-call.
        try this.syncAllocation() {} catch {}
        _updateReward(address(0)); // bank everything accrued up to now
        rewardRate   = 0;
        periodFinish = block.timestamp;
        windDown     = true;
        emit RewardRateSet(rewardRate, 0);
        emit WindDownStarted(msg.sender, byTimeout);
    }

    /// @notice When anyone may switch on wind-down if the current pause continues (0 when not
    ///         paused), when the run's paused time reaches PAUSE_EXIT_DELAY. Monitoring alerts
    ///         at 21 days of pause within the run (MONITORING.md).
    function windDownOpenToAllAt() public view returns (uint256) {
        if (!paused()) return 0;
        // The run's paused time so far counts; breaks inside the run do not.
        return pausedInRun >= PAUSE_EXIT_DELAY ? pausedSince : pausedSince + (PAUSE_EXIT_DELAY - pausedInRun);
    }

    /**
     * @notice After wind-down: take back exactly your own principal, with no penalty and no
     *         lock wait, even while the contract is paused. Rewards accrued up to the switch
     *         are recorded and stay claimable with claimRewards().
     */
    /**
     * @notice After wind-down, the reward allocation nobody has been promised: the launch
     *         SRX never registered, plus the registered pool not yet accrued to anyone.
     *         Never holders' principal and never rewards already owed.
     */
    function releasableRewardAllocation() public view returns (uint256) {
        if (!windDown) return 0;
        uint256 unregistered = rewardBacking - totalRewardsRegistered;
        uint256 unaccrued    = rewardPool > totalPendingRewards ? rewardPool - totalPendingRewards : 0;
        // Defence in depth: never more than the SRX actually held beyond holders' principal
        // and rewards already owed, even if an allocation record over-reported.
        uint256 bal  = srx.balanceOf(address(this));
        uint256 kept = totalLocked + totalPendingRewards;
        uint256 held = bal > kept ? bal - kept : 0;
        uint256 want = unregistered + unaccrued;
        return want < held ? want : held;
    }

    /**
     * @notice After wind-down, move unused launch reward allocation to a successor contract
     *         (docs/MIGRATION.md step 5). Timelock only. The successor, deployed with THIS
     *         contract as its allocation source, can then register exactly what was released
     *         here, and nothing else: fee SRX never enters the chain of custody (REG-50).
     */
    function releaseRewardAllocation(address successor, uint256 amount)
        external onlyRole(GOVERNANCE_ROLE) nonReentrant
    {
        if (successor == address(0)) revert ZeroAddress();
        if (amount == 0)             revert ZeroAmount();
        // Security review (12 Oct): never to a wallet or an unrelated contract. The successor
        // must be a contract that names THIS one as its allocation source, so released launch
        // reward SRX can only ever become that successor's rewards (REG-50).
        if (successor.code.length == 0) revert NotASuccessor(successor);
        try ISuccessorOf(successor).tgeDistributor() returns (address source) {
            if (source != address(this)) revert NotASuccessor(successor);
        } catch {
            revert NotASuccessor(successor);
        }
        uint256 releasable = releasableRewardAllocation(); // 0 before wind-down
        if (amount > releasable) revert ReleaseExceedsUnusedAllocation(releasable, amount);

        // Unregistered launch SRX goes first, then the unaccrued part of the pool.
        uint256 unregistered = rewardBacking - totalRewardsRegistered;
        uint256 fromUnregistered = amount < unregistered ? amount : unregistered;
        rewardBacking -= fromUnregistered;
        rewardPool    -= amount - fromUnregistered;

        releasedTo[successor] += amount;
        srx.safeTransfer(successor, amount);
        emit RewardAllocationReleased(successor, amount);
    }

    // ── As an allocation source for a successor (ITGEAllocationSource) ────────

    /// @notice The token this contract releases (ITGEAllocationSource).
    function token() external view returns (address) { return address(srx); }

    /// @notice True once wound down: from then on releasedTo() is this contract's final word
    ///         to a successor (ITGEAllocationSource).
    function distributed() external view returns (bool) { return windDown; }

    /// @notice What this contract released to `destination` (ITGEAllocationSource).
    function allocatedTo(address destination) external view returns (uint256) { return releasedTo[destination]; }

    function exitAfterWindDown() external nonReentrant {
        if (!windDown) revert NotWoundDown();
        StakePosition memory pos = positions[msg.sender];
        if (pos.amount == 0) revert NoPosition();

        // Bank accrued rewards. Emission stopped at the switch, so this only records what
        // was already owed; it is kept claimable, never paid out of principal.
        pendingRewards[msg.sender]         = earned(msg.sender);
        userRewardPerTokenPaid[msg.sender] = rewardPerTokenStored;

        totalLocked        -= pos.amount;
        totalWeightedStake -= pos.weightedAmount;
        delete positions[msg.sender];

        srx.safeTransfer(msg.sender, pos.amount);
        emit ExitedAfterWindDown(msg.sender, pos.amount);
    }

    // ── Internal helpers ───────────────────────────────────────────────────────

    function _validDuration(uint256 d) internal pure returns (bool) {
        return d == LOCK_7D || d == LOCK_30D || d == LOCK_90D || d == LOCK_180D;
    }

    function _multiplier(uint256 lockDuration) internal pure returns (uint256) {
        if (lockDuration == LOCK_180D) return MULTIPLIER_180D;
        if (lockDuration == LOCK_90D)  return MULTIPLIER_90D;
        if (lockDuration == LOCK_30D)  return MULTIPLIER_30D;
        return MULTIPLIER_7D;
    }

}
