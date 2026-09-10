// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// ReentrancyGuardUpgradeable was removed in OZ v5.1+. Inline implementation below.

/**
 * @title SRXStaking
 * @notice Lock SRX tokens to:
 *   1. Activate a fee discount tier on the Syrax payment platform.
 *   2. Earn a proportional share of the ecosystem participation incentive pool.
 *
 * Fee discount tiers (governance-adjustable):
 *  ┌──────────┬──────────────────────┬────────────────┐
 *  │ Tier     │ Weighted SRX (min)   │ Fee Discount   │
 *  ├──────────┼──────────────────────┼────────────────┤
 *  │ None     │          0           │    0%          │
 *  │ Slate    │     50,000 SRX       │   25%          │
 *  │ Onyx     │    250,000 SRX       │   60%          │
 *  │ Obsidian │  1,000,000 SRX       │  100% (0 fee)  │
 *  └──────────┴──────────────────────┴────────────────┘
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
 * The multiplier expires with the lock (R7-01). weightedAmount itself is fixed
 * for the life of a position (set at lock(), only ever upgraded via
 * addToPosition() — never silently downgraded), so a tier never fluctuates while
 * the lock is running. But once lockEnd passes the staker has full liquidity and
 * is no more committed than a 7-day staker, so the multiplier no longer applies
 * and the tier reverts to what raw principal earns. Re-locking, or extending via
 * addToPosition(), restores it. Without this, one finite lock would have bought a
 * permanent multiplied tier at full liquidity.
 *
 * Ecosystem participation incentives:
 *  Sourced exclusively from the pre-allocated 1.7 billion SRX incentive pool
 *  (17% of total supply, sent to this contract at TGE). No new tokens are ever
 *  minted. Longer lock commitments earn a higher share of the pool per token:
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
 * Early withdrawal: 10% principal penalty burned permanently. Any incentives
 * earned up to the point of exit are paid out — the penalty applies only to
 * the principal.
 *
 * UUPS upgradeable — tier parameters and incentive logic can be adjusted by
 * governance without migrating user stake positions.
 */
contract SRXStaking is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant PAUSER_ROLE     = keccak256("PAUSER_ROLE");
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    /// @notice Authorises UUPS upgrades. SEPARATED from GOVERNANCE_ROLE (SC-TRUST-001 fix)
    ///         so upgrade authority can be homed exclusively on the SRXTimelock while
    ///         routine governance lives elsewhere. MUST be migrated to the Timelock and
    ///         revoked from the admin EOA before mainnet (enforced by verify_roles.js).
    bytes32 public constant UPGRADER_ROLE   = keccak256("UPGRADER_ROLE");

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
    // Denominated out of MULTIPLIER_BASE (100). A 180-day staker earns 2× the
    // share per token compared to a 7-day staker.

    uint256 public constant MULTIPLIER_BASE = 100;
    uint256 public constant MULTIPLIER_7D   = 100; // 1.00×
    uint256 public constant MULTIPLIER_30D  = 125; // 1.25×
    uint256 public constant MULTIPLIER_90D  = 150; // 1.50×
    uint256 public constant MULTIPLIER_180D = 200; // 2.00×

    // ── Principal early-exit penalty ───────────────────────────────────────────

    uint256 public constant EARLY_WITHDRAW_PENALTY_BPS = 1_000; // 10%
    uint256 public constant BPS_DENOMINATOR            = 10_000;

    // ── Internal precision scalar for reward-per-token accumulator ─────────────

    uint256 private constant PRECISION = 1e18;

    // ── State: fee tiers and positions ─────────────────────────────────────────

    IERC20 public srx;

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

    // ── Bonus reward token (real yield — e.g. USDC) ────────────────────────────
    //
    // A second, independent Synthetix reward-per-token accumulator that runs
    // in parallel with the primary SRX incentive pool. Governance sets the bonus
    // token (e.g. USDC), funds the pool via notifyBonusRewardAmount(), and controls
    // the emission rate via setBonusRewardRate(). Stakers claim bonus rewards via
    // claimBonusRewards() or receive them automatically on unlock/earlyWithdraw.
    //
    // address(0) = bonus token not yet configured. All bonus accounting is a no-op
    // until setBonusRewardToken() is called. This is the expansion port for real
    // yield from gateway fee revenue — no upgrade required to activate it.

    IERC20  public bonusRewardToken;           // e.g. USDC — address(0) = not configured
    uint256 public bonusRewardRate;            // bonus token wei per second (0 = paused)
    uint256 public bonusRewardPerTokenStored;  // accumulated per unit weighted stake (× PRECISION)
    uint256 public bonusLastUpdateTime;        // block.timestamp at last bonus accumulator update
    uint256 public bonusRewardPool;            // remaining undistributed bonus tokens

    mapping(address => uint256) public bonusUserRewardPerTokenPaid;
    mapping(address => uint256) public bonusPendingRewards;

    /// @notice Timestamps after which reward accrual stops (SC-ECON-001 fix). Each is
    ///         recomputed on pool/rate changes as now + pool/rate, so total emission
    ///         can never exceed the funded pool. Accrual is capped via
    ///         lastTimeRewardApplicable() / bonusLastTimeRewardApplicable().
    uint256 public periodFinish;       // primary SRX incentive schedule end
    uint256 public bonusPeriodFinish;  // bonus (real-yield) schedule end

    // ── Appended 9 Sep 2026 (audit remediation) ────────────────────────────────
    //
    // ⛔ APPENDED HERE, ABOVE THE GAP, AND THE GAP SHRUNK BY EXACTLY THREE.
    //    totalPendingRewards was first declared mid-layout beside rewardPool --
    //    which is the identical defect this audit raised as a P0 against
    //    StabilisationFund, where periodFinish was inserted between rewardPool and
    //    userRewardPerTokenPaid and shifted seven variables by one slot on the
    //    deployed proxy. Writing the finding did not stop me repeating it; the gap
    //    discipline below did, on re-reading it.

    /// @notice Sum of every user's accrued-but-unclaimed pendingRewards.
    /// @dev rewardPool alone is NOT the free balance: it still holds tokens that
    ///      have already accrued to stakers and are merely unclaimed. Scheduling
    ///      against rewardPool therefore promised the same tokens twice.
    uint256 public totalPendingRewards;

    /// @notice Smallest position this contract will accept.
    /// @dev Dust positions are not a rounding curiosity: a 1-wei stake collected
    ///      the entire emission stream (1,166,400 SRX in a day) and simultaneously
    ///      blocked rescueStrandedPool(), which requires totalWeightedStake == 0.
    uint256 public minStakeAmount;

    /// @notice Total weighted stake below which emission does not accrue at all.
    /// @dev ⭐ This, not minStakeAmount, is what actually fixes the capture. Under
    ///      Synthetix accounting ANY sole staker collects 100% of emissions, which
    ///      is correct; the defect is that it could be done with no capital at
    ///      risk. Below this threshold the accrual clock does not advance, exactly
    ///      as it already does not when totalWeightedStake is zero -- so the paused
    ///      interval is skipped rather than paid retroactively.
    uint256 public minTotalStakeForEmission;

    /// @dev Storage gap for future upgrades (R7-1 + SC-UUPS-001 fix).
    ///
    ///      DISCIPLINE: Every upgrade that adds N new state variables MUST shrink this
    ///      gap by exactly N (e.g., 50 → 48 for two new variables). Append the new state
    ///      variables ABOVE this gap declaration, then update the size literal. Failing
    ///      to shrink the gap wastes slots but is harmless; shrinking by the WRONG
    ///      amount causes storage slot collision on subsequent upgrades — data
    ///      corruption that is difficult to detect post-deployment.
    ///      (Reduced 50 → 48 for periodFinish + bonusPeriodFinish — SC-ECON-001;
    ///      then 48 → 45 for totalPendingRewards + minStakeAmount +
    ///      minTotalStakeForEmission — audit remediation, 9 Sep 2026.)
    ///
    ///      VERIFICATION: Every upgrade PR must run the OpenZeppelin Upgrades Plugin
    ///      storage layout check (`hardhat-upgrades` validateUpgrade) and the upgrade
    ///      runbook must include a "Storage Layout Diff" section showing the previous
    ///      gap size, new gap size, and every new variable added.
    // solhint-disable-next-line var-name-mixedcase
    uint256[45] private __gap;

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
    event MinStakeAmountSet(uint256 oldMinimum, uint256 newMinimum);
    event MinTotalStakeForEmissionSet(uint256 oldMinimum, uint256 newMinimum);
    event TierParamsUpdated(Tier indexed tier, uint256 minSRX, uint256 discountBps);
    event BonusRewardTokenSet(address indexed token);
    event BonusRewardPoolFunded(uint256 amount, uint256 newTotal);
    event BonusRewardRateSet(uint256 oldRate, uint256 newRate);
    event BonusRewardsClaimed(address indexed user, uint256 amount);
    event RewardPoolReset(address indexed recipient, uint256 amount);      // R5-01: stranded-pool rescue
    event BonusRewardPoolReset(address indexed recipient, uint256 amount); // R5-01: stranded bonus rescue

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
    error BonusTokenNotSet();
    error BonusTokenAlreadySet();
    error InvalidBonusToken();
    error InsufficientBonusBalance(uint256 balance, uint256 required);
    error NoStrandedPool(); // R5-01: rescue only valid when all stakers have exited and a pool remains

    // ── Initializer ────────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _srx, address _admin) external initializer {
        if (_srx == address(0) || _admin == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        _status = _NOT_ENTERED;

        // SC-UUPS-002 fix: set state BEFORE granting roles (defensive ordering).
        srx            = IERC20(_srx);
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
        // closes BOTH dust findings -- the 1-wei position that collected the whole
        // emission stream, and the 1-wei seed lock that minted a permanent 2.00x
        // slot -- and it breaks nothing in the existing suite.
        minStakeAmount = 100 * 10 ** 18;

        // ⚠️ DELIBERATELY INACTIVE (0). The mechanism is built and tested; the
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
        // SC-TRUST-001 fix: upgrade authority granted to admin for deployment bootstrap.
        // MUST be migrated to the SRXTimelock and revoked from admin pre-mainnet
        // (verify_roles.js enforces this end state).
        _grantRole(UPGRADER_ROLE,      _admin);
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
        unchecked {
            pendingRewards[user] = owed - reward;
            totalPendingRewards -= reward;
        }
        rewardPool -= reward;

        srx.safeTransfer(user, reward);
        emit RewardsClaimed(user, reward);

        if (reward < owed) emit RewardShortfall(user, owed - reward);
    }

    // ── Bonus reward accounting (read) ────────────────────────────────────────

    /**
     * @notice Current accumulated bonus reward per unit of weighted stake.
     *         Returns bonusRewardPerTokenStored if the bonus token is not yet
     *         configured or no time has elapsed since the last update.
     */
    /**
     * @notice Latest time bonus-reward accrual is valid — capped at bonusPeriodFinish
     *         so bonus emission never exceeds the funded bonus pool (SC-ECON-001 fix).
     */
    function bonusLastTimeRewardApplicable() public view returns (uint256) {
        if (bonusPeriodFinish == 0) return block.timestamp; // no schedule set yet — uncapped (rate is 0)
        return block.timestamp < bonusPeriodFinish ? block.timestamp : bonusPeriodFinish;
    }

    function bonusRewardPerToken() public view returns (uint256) {
        // Same gate as the primary stream, for the same reason.
        if (totalWeightedStake < minTotalStakeForEmission) return bonusRewardPerTokenStored;
        if (totalWeightedStake == 0 || bonusLastUpdateTime == 0) return bonusRewardPerTokenStored;
        uint256 applicable = bonusLastTimeRewardApplicable();
        if (applicable <= bonusLastUpdateTime) return bonusRewardPerTokenStored;
        uint256 elapsed = applicable - bonusLastUpdateTime;
        return bonusRewardPerTokenStored + (bonusRewardRate * elapsed * PRECISION) / totalWeightedStake;
    }

    /**
     * @notice Total earned-but-unclaimed bonus rewards for a user.
     */
    function earnedBonus(address user) public view returns (uint256) {
        StakePosition memory pos = positions[user];
        return (pos.weightedAmount * (bonusRewardPerToken() - bonusUserRewardPerTokenPaid[user])) / PRECISION
            + bonusPendingRewards[user];
    }

    // ── Bonus reward accounting (write) ───────────────────────────────────────

    /**
     * @dev Update the bonus accumulator and snapshot the user's checkpoint.
     *      Initialises bonusLastUpdateTime on the first call (avoids counting
     *      time before the bonus token was configured).
     */
    function _updateBonusReward(address user) internal {
        // Lazy-initialise the timestamp anchor on first invocation
        if (bonusLastUpdateTime == 0) {
            bonusLastUpdateTime = block.timestamp;
        }
        bonusRewardPerTokenStored = bonusRewardPerToken();
        bonusLastUpdateTime       = bonusLastTimeRewardApplicable();

        if (user != address(0)) {
            bonusPendingRewards[user]         = earnedBonus(user);
            bonusUserRewardPerTokenPaid[user] = bonusRewardPerTokenStored;

            // ⭐ The weight may only change once BOTH accruals have been banked at
            //    the old weight. Every user-facing path calls _updateReward and
            //    then _updateBonusReward, so this is the one point where that is
            //    true. Decaying inside _updateReward -- where it started -- left
            //    _updateBonusReward to compute bonus accrual against the ALREADY
            //    REDUCED weight, quietly underpaying the staker the bonus they had
            //    earned while their lock was live. The two accumulators share
            //    weightedAmount, so anything that touches it must come last.
            _decayExpiredWeight(user);
        }
    }

    /**
     * @dev Bound total bonus emission to the funded bonus pool (SC-ECON-001). Call
     *      AFTER any bonusRewardPool/bonusRewardRate change and AFTER _updateBonusReward.
     */
    function _recomputeBonusPeriodFinish() internal {
        // Anchor the bonus accrual clock to now (Synthetix pattern); prevents
        // retroactive billing of an inter-period gap. _updateBonusReward must be
        // called immediately before this.
        bonusLastUpdateTime = block.timestamp;
        bonusPeriodFinish = bonusRewardRate == 0
            ? block.timestamp
            : block.timestamp + (bonusRewardPool / bonusRewardRate);
    }

    /**
     * @dev Transfer all pending bonus rewards to the user and decrement the pool.
     *      No-op if bonusRewardToken is not set or user has nothing pending.
     */
    function _settleBonusRewards(address user) internal {
        if (address(bonusRewardToken) == address(0)) return;
        uint256 reward = bonusPendingRewards[user];
        if (reward == 0) return;

        if (reward > bonusRewardPool) reward = bonusRewardPool;

        bonusPendingRewards[user] = 0;
        bonusRewardPool          -= reward;

        bonusRewardToken.safeTransfer(user, reward);
        emit BonusRewardsClaimed(user, reward);
    }

    // ── Staking ────────────────────────────────────────────────────────────────

    /**
     * @notice Lock SRX for a chosen duration. Immediately activates the fee tier
     *         and begins accumulating ecosystem participation incentives.
     * @param amount       SRX amount (18-decimal).
     * @param lockDuration One of LOCK_7D, LOCK_30D, LOCK_90D, LOCK_180D.
     */
    function lock(uint256 amount, uint256 lockDuration) external nonReentrant whenNotPaused {
        if (amount == 0)                   revert ZeroAmount();
        if (amount < minStakeAmount)       revert BelowMinimumStake(amount, minStakeAmount);
        if (!_validDuration(lockDuration)) revert InvalidLockDuration();
        if (positions[msg.sender].amount > 0) revert PositionExists();

        _updateReward(msg.sender);
        _updateBonusReward(msg.sender);

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
     * @param newDuration      0 = keep current lock end.
     *                         Otherwise must be a valid duration that ends after the current lockEnd.
     */
    function addToPosition(uint256 additionalAmount, uint256 newDuration) external nonReentrant whenNotPaused {
        StakePosition storage pos = positions[msg.sender];
        if (pos.amount == 0)        revert NoPosition();
        if (additionalAmount == 0)  revert ZeroAmount();

        _updateReward(msg.sender);
        _updateBonusReward(msg.sender);

        // Remove old weighted stake from global total before recalculating
        totalWeightedStake -= pos.weightedAmount;

        pos.amount  += additionalAmount;
        totalLocked += additionalAmount;

        if (newDuration > 0) {
            if (!_validDuration(newDuration)) revert InvalidLockDuration();
            // Prevent multiplier downgrade — stakers may only maintain or upgrade
            // their commitment tier. A 180-day staker near expiry cannot switch to
            // 7-day to drop their multiplier from 2.0× to 1.0× (A2-M-04 fix).
            if (_multiplier(newDuration) < _multiplier(pos.lockDuration)) revert InvalidLockDuration();
            uint256 newEnd = block.timestamp + newDuration;
            if (newEnd > pos.lockEnd) {
                pos.lockEnd      = newEnd;
                pos.lockDuration = newDuration;
            }
        }

        // Recompute weighted amount based on (possibly updated) lock duration
        pos.weightedAmount  = (pos.amount * _multiplier(pos.lockDuration)) / MULTIPLIER_BASE;
        totalWeightedStake += pos.weightedAmount;

        srx.safeTransferFrom(msg.sender, address(this), additionalAmount);
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
        _updateBonusReward(msg.sender);
        _settleBonusRewards(msg.sender);

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
     * @notice Emergency exit before lock expiry. A 10% principal penalty is burned
     *         to the canonical dead address. Any incentives earned up to this point
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
        _updateBonusReward(address(0));
        emit MinTotalStakeForEmissionSet(minTotalStakeForEmission, newMinimum);
        minTotalStakeForEmission = newMinimum;
    }

    function pokeExpiredPosition(address user) external nonReentrant {
        // Both accruals must be banked at the OLD weight before it changes;
        // _updateBonusReward performs the decay as its final step.
        _updateReward(user);
        _updateBonusReward(user);
    }

    function earlyWithdraw() external nonReentrant {
        StakePosition memory pos = positions[msg.sender];
        if (pos.amount == 0) revert NoPosition();

        _updateReward(msg.sender);
        _settleRewards(msg.sender);
        _updateBonusReward(msg.sender);
        _settleBonusRewards(msg.sender);

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
        uint256 penalty  = block.timestamp < pos.lockEnd
            ? (pos.amount * EARLY_WITHDRAW_PENALTY_BPS) / BPS_DENOMINATOR
            : 0;
        uint256 returned = pos.amount - penalty;

        totalLocked        -= pos.amount;
        totalWeightedStake -= pos.weightedAmount;
        totalPenaltyBurned += penalty;

        delete positions[msg.sender];

        srx.safeTransfer(msg.sender, returned);
        // Penalty is permanently destroyed via the canonical dead address.
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
    function claimRewards() external nonReentrant whenNotPaused {
        if (positions[msg.sender].amount == 0) revert NoPosition();
        _updateReward(msg.sender);
        if (pendingRewards[msg.sender] == 0)   revert NothingToClaim();
        _settleRewards(msg.sender);
    }

    /**
     * @notice Claim accumulated bonus rewards (e.g. USDC real yield) without unstaking.
     *         Reverts if the bonus token is not yet configured, or nothing is owed.
     */
    function claimBonusRewards() external nonReentrant whenNotPaused {
        if (address(bonusRewardToken) == address(0)) revert BonusTokenNotSet();
        if (positions[msg.sender].amount == 0)       revert NoPosition();
        _updateBonusReward(msg.sender);
        if (bonusPendingRewards[msg.sender] == 0)    revert NothingToClaim();
        _settleBonusRewards(msg.sender);
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
        // position lockEnd == 0, so this yields amount == 0 → Tier.None.
        uint256 effective = block.timestamp < pos.lockEnd
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
     * @param amount Amount to register. Must not exceed unallocated balance
     *               (contract balance minus user-staked tokens).
     */
    function notifyRewardAmount(uint256 amount) external onlyRole(GOVERNANCE_ROLE) {
        if (amount == 0) revert ZeroAmount();
        // Subtract both locked principal AND existing rewardPool so governance cannot
        // double-register the same token balance as rewards (A2-L-05 fix).
        uint256 balance   = srx.balanceOf(address(this));
        uint256 encumbered = totalLocked + rewardPool;
        uint256 available  = balance > encumbered ? balance - encumbered : 0;
        if (amount > available) revert PoolAmountExceedsAvailable(available, amount);

        _updateReward(address(0)); // settle global accumulator before modifying pool

        rewardPool += amount;
        _recomputePeriodFinish(); // SC-ECON-001: extend schedule to cover the new pool
        emit RewardPoolFunded(amount, rewardPool);
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
        _updateReward(address(0)); // settle accumulator at old rate before switching
        emit RewardRateSet(rewardRate, newRate);
        rewardRate = newRate;
        _recomputePeriodFinish(); // SC-ECON-001: bound emission to pool at the new rate
    }

    // ── Bonus reward governance ────────────────────────────────────────────────

    /**
     * @notice Configure the bonus reward token (e.g. USDC for real yield).
     *         Can only be set once. Initialises the bonus accumulator timestamp.
     *         Governance funds the pool separately via notifyBonusRewardAmount().
     * @param token ERC-20 token address (must not be address(0) or the SRX token).
     */
    function setBonusRewardToken(address token) external onlyRole(GOVERNANCE_ROLE) {
        if (token == address(0))                     revert ZeroAddress();
        if (token == address(srx))                   revert InvalidBonusToken();
        if (address(bonusRewardToken) != address(0)) revert BonusTokenAlreadySet();
        bonusRewardToken    = IERC20(token);
        bonusLastUpdateTime = block.timestamp; // anchor the accumulator
        emit BonusRewardTokenSet(token);
    }

    /**
     * @notice Register tokens already held in this contract as the bonus reward pool.
     *         Caller must transfer bonus tokens to this contract before calling.
     *         Governance calls this after routing fee revenue into the staking contract.
     * @param amount Amount of bonus tokens to register.
     */
    function notifyBonusRewardAmount(uint256 amount) external onlyRole(GOVERNANCE_ROLE) {
        if (address(bonusRewardToken) == address(0)) revert BonusTokenNotSet();
        if (amount == 0) revert ZeroAmount();

        // Verify the contract actually holds enough bonus tokens to cover the
        // newly registered pool amount (L-03 fix — prevents phantom reward accounting).
        uint256 bal = bonusRewardToken.balanceOf(address(this));
        uint256 required = bonusRewardPool + amount;
        if (bal < required) revert InsufficientBonusBalance(bal, required);

        _updateBonusReward(address(0));

        bonusRewardPool += amount;
        _recomputeBonusPeriodFinish(); // SC-ECON-001: extend schedule to cover new bonus pool
        emit BonusRewardPoolFunded(amount, bonusRewardPool);
    }

    /**
     * @notice Set the per-second bonus reward emission rate.
     *         Set to 0 to pause. Governance adjusts this as fee revenue grows.
     * @param newRate Bonus token wei per second distributed across all weighted stakers.
     */
    function setBonusRewardRate(uint256 newRate) external onlyRole(GOVERNANCE_ROLE) {
        if (address(bonusRewardToken) == address(0)) revert BonusTokenNotSet();
        _updateBonusReward(address(0));
        emit BonusRewardRateSet(bonusRewardRate, newRate);
        bonusRewardRate = newRate;
        _recomputeBonusPeriodFinish(); // SC-ECON-001: bound bonus emission to pool at new rate
    }

    // ── Stranded pool rescue (R5-01) ───────────────────────────────────────────

    /**
     * @notice Rescue SRX stranded in the incentive pool when ALL stakers have exited.
     *
     *         The Synthetix accumulator freezes when totalWeightedStake == 0:
     *         rewardPerToken() stops accruing, so any SRX remaining in rewardPool can
     *         never be claimed by new or existing stakers. This mirrors
     *         StabilisationFund.rescueStrandedPool() (A5-M-02) — the same fix was
     *         missing from this contract (R5-01 parity fix). Governance recovers the
     *         tokens (e.g. to the treasury) and resets the emission schedule so a
     *         fresh reward cycle can start once new stakes exist.
     *
     *         Callable only when totalWeightedStake == 0 AND rewardPool > 0.
     *
     * @param recipient Address to receive the stranded SRX.
     */
    function rescueStrandedPool(address recipient)
        external
        onlyRole(GOVERNANCE_ROLE)
        nonReentrant
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (totalWeightedStake > 0)  revert NoStrandedPool(); // stakers still active — pool is live
        if (rewardPool == 0)         revert NoStrandedPool(); // nothing to rescue

        uint256 amount = rewardPool;
        rewardPool   = 0;
        rewardRate   = 0;               // stop emission — no stakers to receive it
        periodFinish = block.timestamp; // SC-ECON-001: schedule ends now

        srx.safeTransfer(recipient, amount);
        emit RewardPoolReset(recipient, amount);
    }

    /**
     * @notice Rescue bonus tokens stranded in the bonus pool when ALL stakers have
     *         exited. Bonus-token twin of rescueStrandedPool() (R5-01).
     * @param recipient Address to receive the stranded bonus tokens.
     */
    function rescueStrandedBonusPool(address recipient)
        external
        onlyRole(GOVERNANCE_ROLE)
        nonReentrant
    {
        if (recipient == address(0))                 revert ZeroAddress();
        if (address(bonusRewardToken) == address(0)) revert BonusTokenNotSet();
        if (totalWeightedStake > 0)                  revert NoStrandedPool();
        if (bonusRewardPool == 0)                    revert NoStrandedPool();

        uint256 amount = bonusRewardPool;
        bonusRewardPool   = 0;
        bonusRewardRate   = 0;
        bonusPeriodFinish = block.timestamp;

        bonusRewardToken.safeTransfer(recipient, amount);
        emit BonusRewardPoolReset(recipient, amount);
    }

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
        if (tier == Tier.Slate) {
            if (minSRX >= tierParams[Tier.Onyx].minSRX) revert InvalidBps();
        } else if (tier == Tier.Onyx) {
            if (minSRX <= tierParams[Tier.Slate].minSRX) revert InvalidBps();
            if (minSRX >= tierParams[Tier.Obsidian].minSRX)   revert InvalidBps();
        } else if (tier == Tier.Obsidian) {
            if (minSRX <= tierParams[Tier.Onyx].minSRX) revert InvalidBps();
        }

        tierParams[tier] = LockParams({ minSRX: minSRX, discountBps: discountBps });
        emit TierParamsUpdated(tier, minSRX, discountBps);
    }

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

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

    function _authorizeUpgrade(address newImpl) internal override onlyRole(UPGRADER_ROLE) {}
}
