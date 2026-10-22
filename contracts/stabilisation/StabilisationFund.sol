// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { IERC20 }                   from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 }                from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ITGEAllocationSource }     from "../token/ITGEAllocationSource.sol";
import { ISuccessorOf } from "../token/ISuccessorOf.sol";
// ReentrancyGuardUpgradeable was removed in OZ v5.1+. Inline implementation below.

/**
 * @title StabilisationFund
 * @notice The Syrax Stabilisation Fund (SSF): a governed reserve of SRX that can
 *         supply market liquidity during a declared stress event.
 *
 * ⛔ NO FEE INCOME REACHES THIS FUND OR ITS DEPOSITORS (REG-50, 11 Oct 2026).
 *    receiveFees() was REMOVED: platform fees are routed to the Treasury, never here.
 *    Depositor rewards are paid in SRX only, against rewardBacking: the SRX the launch
 *    distribution (TGEDistributor, fixed at deployment) records it delivered here,
 *    capped at rewardAllocation, a fixed amount set once at deployment (at most
 *    MAX_REWARD_ALLOCATION, the fund's own 1.5 billion SRX launch allocation) that no
 *    function can raise. Registrations are counted cumulatively, and the SRX still
 *    backing unregistered rewards can never be deployed out (_reservedSRX). So no fee
 *    revenue, buy-back proceeds or later transfer can extend depositor rewards or pay
 *    for them, and depositors have no entitlement to Syrax's fee income, present or
 *    contingent (law agents' preliminary view REG-0023 (1), (4); Security review
 *    11 Oct 2026 on the backing).
 * ⛔ No caller, governance included, can deploy SRX that belongs to depositors
 *    (their principal) or backs rewards (the pool and the unregistered backing).
 *    Before 12 Oct 2026 governance could deploy depositors' principal.
 * ⛔ recoverLiquidity() was REMOVED too (R7-16): it let GOVERNANCE_ROLE pull any token
 *    from ANY address that had approved this fund, a depositor's wallet included.
 *    Deployed liquidity now comes back only by being sent here by its holder.
 *
 * ── Purpose ─────────────────────────────────────────────────────────────────
 *
 * The 1,500,000,000 SRX Strategic Reserve (15% of total supply) is seeded into
 * this contract at TGE. On-chain governance replaces the raw wallet, making every
 * capital deployment publicly verifiable and tamper-resistant.
 *
 * ── Three-Tier Emergency Response ───────────────────────────────────────────
 *
 * Market stress events require speed. The fund operates a tiered response
 * architecture to balance urgency against decentralisation:
 *
 *  Tier 1 — DEPLOYER_ROLE (Treasurer multi-sig)
 *   • Deploys SRX immediately during an active stress event.
 *   • Capped at `maxDeployerBps` of the free SRX at stress start (default 30%). Free
 *     SRX is the balance less contributor principal and the reward pool (SSF-M1).
 *   • No governance vote required. Fastest possible response.
 *
 *  Tier 2 — GUARDIAN_ROLE (Broader multi-sig, e.g. 4-of-7: founders + lead investors + DAO delegates)
 *   • Deploys SRX immediately during an active stress event.
 *   • Combined cap with Tier 1: total (deployer + guardian) SRX deployed must not
 *     exceed `maxGuardianBps` of stress-start free SRX (default 70%).
 *   • Also authorised to TRIGGER a stress event (alongside ORACLE_REPORTER_ROLE).
 *   • No governance vote required. Used when Tier 1 is insufficient.
 *
 *  Tier 3 — GOVERNANCE_ROLE (SRXTimelock, 48-hour delay)
 *   • Any token, any destination. For SRX, never more than the free balance: depositors'
 *     principal, the reward pool and the SRX still backing unregistered rewards are never
 *     deployable by anyone (REG-50, 12 Oct 2026).
 *   • The authoritative, fully decentralised path. Used for non-emergency
 *     deployments and for amounts beyond the Tier 1/2 caps.
 *   • Only GOVERNANCE resolves a stress event, closing the fast-path window; winding the
 *     fund down (REG-53) also ends one.
 *
 * Rationale: Tier 1 and 2 provide sub-minute response capability during a
 * genuine market crisis (flash crashes, coordinated sell-offs, exchange collapses)
 * while the 48-hour governance window remains available for larger or
 * non-emergency capital moves. Caps prevent abuse: the maximum reachable via
 * fast paths is 70% of the fund's free SRX at stress start, and a fast path can
 * never spend contributor principal or the reward pool.
 *
 * ── Reserve Layers ───────────────────────────────────────────────────────────
 *
 *  Layer                Target    Assets
 *  ─────────────────── ─────── ────────────────────────────────
 *  Stable Reserves         50%  USDC, USDT
 *  Core Assets             30%  ETH, SRX (TGE seed is initial Core)
 *  Deployed Assets         20%  DeFi positions (managed off-chain, reported back);
 *                               any return on them stays in the fund and is never
 *                               paid to depositors or holders. (Stored as
 *                               yieldTargetBps; the name predates REG-50.)
 *
 * Layer targets are governance-adjustable via `setLayerTargetBps()`.
 *
 * ── Contributor Rewards ──────────────────────────────────────────────────────
 *
 * Any SRX holder may contribute SRX to the fund and receive SRX rewards in
 * proportion to their contribution, paid only from the fixed rewardAllocation
 * (REG-50; never from fees). Reward accounting uses the Synthetix
 * reward-per-token pattern (gas-efficient, safe under concurrent deposits/
 * withdrawals, no iteration over all contributors). A 30-day withdrawal lock
 * prevents flash-contribution reward exploits.
 *
 * ── Reentrancy ───────────────────────────────────────────────────────────────
 *
 * OZ v5.1 removed ReentrancyGuardUpgradeable. Inline guard is used throughout,
 * consistent with SRXStaking and SRXTreasury.
 *
 * ── Not upgradeable ──────────────────────────────────────────────────────────
 *
 * ⛔ NOT UPGRADEABLE (REG-53, Jared, 12 Oct 2026). A plain contract: its code can never
 *    change and no role can replace it. The pause (PAUSER_ROLE, held by GuardianModule)
 *    stays. A fix ships as a new contract that holders choose to move to
 *    (docs/MIGRATION.md), never as a forced or in-place change.
 * ⛔ WIND-DOWN (REG-53, Security requirement 12 Oct 2026). Without upgrades, a bug plus a
 *    pause could otherwise trap depositors' SRX. startWindDown() is ONE-WAY: no new
 *    contributions, reward registrations or stress events ever again, any active stress
 *    event ends, emission stops, and exitAfterWindDown() returns exactly the caller's own
 *    principal, with no lock wait, even while the fund is paused. Rewards accrued up to the
 *    switch stay claimable (claimRewards works in wind-down even while paused). Nothing
 *    moves anyone's tokens for them; governance may still move only the fund's FREE SRX
 *    (never principal or reward SRX). Switched by the Timelock (GOVERNANCE_ROLE), the
 *    guardian Safe (WIND_DOWN_ROLE), or by anyone once the fund has been paused for
 *    PAUSE_EXIT_DELAY in total within one run of pauses (pauses less than PAUSE_BREAK
 *    apart are one run; only time actually paused counts). A token-wide SRXToken pause
 *    still stops every
 *    transfer, exits included.
 */
/// @notice What a successor contract must answer: the allocation source it was deployed with.

contract StabilisationFund is AccessControl, Pausable {
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────────

    /// @notice SRXTimelock — all unrestricted capital moves, parameter changes, stress resolution.
    bytes32 public constant GOVERNANCE_ROLE      = keccak256("GOVERNANCE_ROLE");

    /// @notice Broad multi-sig (e.g. 4-of-7). Instant SRX deployment during stress, up to
    ///         combined 70% cap. Also authorised to trigger a stress event.
    bytes32 public constant GUARDIAN_ROLE        = keccak256("GUARDIAN_ROLE");

    /// @notice Treasurer multi-sig. Instant SRX deployment during stress, up to 30% cap.
    bytes32 public constant DEPLOYER_ROLE        = keccak256("DEPLOYER_ROLE");

    /// @notice Off-chain monitor or Chainlink Automation. Triggers stress detection.
    bytes32 public constant ORACLE_REPORTER_ROLE = keccak256("ORACLE_REPORTER_ROLE");

    /// @notice GuardianModule. Emergency pause authority.
    bytes32 public constant PAUSER_ROLE          = keccak256("PAUSER_ROLE");

    /// @notice May deposit stablecoins into the reserve: Syrax's treasury only (Security
    ///         review, 12 Oct). The deposit keeps no per-user record and nothing returns it,
    ///         so it must never be open to the public.
    bytes32 public constant TREASURY_ROLE        = keccak256("TREASURY_ROLE");

    /// @notice May switch on wind-down without the Timelock's delay: the guardian Safe.
    bytes32 public constant WIND_DOWN_ROLE       = keccak256("WIND_DOWN_ROLE");

    /// @notice After this much time paused within one run (pauses less than PAUSE_BREAK
    ///         apart), anyone may switch on wind-down, so a
    ///         pause can never become permanent confinement of depositors' SRX.
    uint256 public constant PAUSE_EXIT_DELAY = 30 days;
    /// @notice Pauses less than this far apart are one run; only time actually paused
    ///         counts towards PAUSE_EXIT_DELAY, and a gap this long or longer starts a new run
    ///         (internal audit L2, 16 Oct 2026).
    uint256 public constant PAUSE_BREAK = 7 days;
    /// @notice The longest withdrawal lock governance may set (internal audit L3).
    uint256 public constant MAX_WITHDRAW_LOCK = 90 days;


    // ── Constants ──────────────────────────────────────────────────────────────

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @dev Internal precision scalar for reward-per-token accumulator.
    uint256 private constant PRECISION = 1e18;

    /// @notice The largest rewardAllocation any deployment may set: the fund's own
    ///         1.5 billion SRX launch allocation (deploy config ALLOCATIONS.strategic).
    uint256 public constant MAX_REWARD_ALLOCATION = 1_500_000_000 * 10 ** 18;

    // ── Reentrancy guard (inline — ReentrancyGuardUpgradeable removed in OZ v5.1+) ──

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED     = 2;
    uint256 private _status;

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    // ── State: core ────────────────────────────────────────────────────────────

    IERC20 public immutable srxToken;

    // ── State: stress event ────────────────────────────────────────────────────

    bool    public stressActive;
    uint256 public stressEventCount;
    uint256 public stressTriggeredAt;
    /// @notice Timestamp of the most recent stress event resolution. Used to enforce
    ///         the cooldown period before a new event can be triggered (A6-E-03 fix).
    uint256 public stressResolvedAt;
    /// @notice Minimum seconds between stress events (resolve → next trigger).
    ///         Default: 7 days. Prevents rapid cycling that would let fast-path actors
    ///         exploit the cap reset across consecutive stress events.
    uint256 public stressCooldownDuration;

    /// @notice Free SRX (balance less contributor principal and the reward pool)
    ///         snapshotted when a stress event is triggered.
    ///         Caps for Tier 1 and Tier 2 are calculated against this value.
    uint256 public stressStartSRXBalance;

    /// @notice Cumulative SRX deployed by DEPLOYER_ROLE in the current stress period.
    uint256 public deployerSRXUsed;

    /// @notice Cumulative SRX deployed by GUARDIAN_ROLE in the current stress period
    ///         (tracked separately; cap check uses deployer+guardian combined).
    uint256 public guardianSRXUsed;

    // ── State: deployment caps ─────────────────────────────────────────────────

    /// @notice Tier 1 cap — maximum fraction of stress-start free SRX that DEPLOYER_ROLE
    ///         can deploy in a single stress period. Default: 3000 (30%).
    uint256 public maxDeployerBps;

    /// @notice Tier 2 cap — maximum combined (deployer + guardian) fraction.
    ///         Default: 7000 (70%). Must always be >= maxDeployerBps.
    uint256 public maxGuardianBps;

    // ── State: contributor positions ───────────────────────────────────────────

    struct Contribution {
        uint256 srxAmount;   // principal contributed
        uint256 depositTime; // timestamp of most recent deposit (resets lock)
    }
    mapping(address => Contribution) public contributions;

    /// @notice Total SRX principal contributed by the public. Never includes the TGE seed.
    uint256 public totalContributions;

    /// @notice Withdrawal lock duration. Contributors cannot exit within this window
    ///         of their most recent deposit. Default: 30 days.
    uint256 public withdrawLockDuration;

    // ── State: Synthetix reward accounting ────────────────────────────────────

    /// @notice SRX wei per second distributed across all contributors' principal.
    ///         Set to 0 to pause reward emissions.
    uint256 public rewardRate;

    /// @notice Monotonically increasing accumulator (× PRECISION). Updated on every
    ///         deposit, withdrawal, or claim. Stores reward per unit of contribution.
    uint256 public rewardPerTokenStored;

    /// @notice block.timestamp at the last accumulator update.
    uint256 public lastUpdateTime;

    /// @notice Remaining undistributed SRX registered as contributor rewards.
    uint256 public rewardPool;

    /// @notice Timestamp after which reward accrual stops (SC-ECON-001 fix).
    ///         Recomputed on every rewardPool/rewardRate change as
    ///         block.timestamp + rewardPool/rewardRate, so total emission can never
    ///         exceed the funded pool. lastTimeRewardApplicable() caps accrual at this.
    uint256 public periodFinish;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public pendingRewards;

    // ── State: reserve layer targets ───────────────────────────────────────────

    /// @notice Target allocation for Stable Reserves (USDC/USDT). Default: 5000 = 50%.
    uint256 public stableTargetBps;

    /// @notice Target allocation for Core Assets (ETH/SRX). Default: 3000 = 30%.
    uint256 public coreTargetBps;

    /// @notice Target allocation for Deployed Assets (DeFi positions; any return stays in
    ///         the fund, never paid to holders, REG-50). Default: 2000 = 20%.
    uint256 public yieldTargetBps;

    // ── State: audit counters ──────────────────────────────────────────────────

    uint256 public totalDeployed;
    // totalRecovered removed with recoverLiquidity() (R7-16, REG-50).

    // ── State: fast-path deployment allowlist (SC-TRUST-003 fix) ───────────────
    //
    // Fast-path deployments (DEPLOYER_ROLE / GUARDIAN_ROLE during a stress event)
    // may only send SRX to a governance-approved destination (DEX pool, vetted
    // market-maker vault). This removes the arbitrary-`target` drain vector where a
    // compromised fast-path multisig could trigger stress and move up to 70% of the
    // fund — including public contributor principal — to an attacker address.
    // The GOVERNANCE_ROLE (Timelock) path does not consult this list; its 48h delay and
    // the free-balance bound (REG-50) are the guard there.
    mapping(address => bool) public approvedDeployTarget;

    // ── Appended 23 Sep 2026 (pre-external-audit sweep, SSF-H2) ───────────────
    /// @notice Sum of every contributor's accrued-but-unclaimed pendingRewards.
    /// @dev ⛔ rewardPool alone is NOT the free balance: it still holds rewards
    ///      that have accrued and are merely unclaimed. Scheduling against the
    ///      whole pool re-promised them, the defect fixed in SRXStaking as F1/F1b
    ///      and never carried over here. Appended above the gap, gap shrunk by 1.
    uint256 public totalPendingRewards;

    // ── Appended 1 Oct 2026 (SSF-L1, reported by ibnu76) ──────────────────────
    /// @notice Smallest SRX position a contributor may hold (default 100 SRX, the
    ///         same as SRXStaking.minStakeAmount). A position is either 0 or at least
    ///         this much: contribute() refuses to leave one below it, and a partial
    ///         withdrawContribution() may not either (withdraw it all instead).
    /// @dev ⛔ A 1-wei position kept totalContributions above zero, which blocked
    ///      the (since removed) rescueStrandedPool() and let a dust contributor sit on the whole reward
    ///      stream with no capital at risk. Appended above the gap, gap shrunk by 1.
    uint256 public minContribution;

    // ── Appended 11 Oct 2026 (REG-50) ─────────────────────────────────────────
    /// @notice The most SRX that can EVER be registered as depositor rewards. Set once
    ///         at deployment from the deploy configuration (SSF.REWARD_ALLOCATION),
    ///         at most MAX_REWARD_ALLOCATION. No function writes it afterwards.
    uint256 public immutable rewardAllocation;

    /// @notice Every SRX amount ever registered via notifyRewardAmount(), summed. Never
    ///         decreases: claims and releases do not give room back.
    uint256 public totalRewardsRegistered;

    /// @notice The launch distributor whose record of what it delivered here is the only
    ///         thing depositor rewards can be backed by. Fixed at deployment.
    address public immutable tgeDistributor;

    /// @notice SRX the launch distribution delivered here, capped at rewardAllocation.
    ///         Set once, by syncAllocation(), after distribution.
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
    /// @notice When each contributor's principal may leave: fixed at their latest deposit,
    ///         so a later change to withdrawLockDuration never reaches it (internal audit L3).
    mapping(address => uint256) public contributionUnlockAt;
    /// @notice Total contributions below which emission does not accrue (the twin of
    ///         SRXStaking.minTotalStakeForEmission; internal audit L4). 0 = inactive.
    uint256 public minTotalForEmission;


    // ── Events ─────────────────────────────────────────────────────────────────

    event StressEventTriggered(
        uint256 indexed eventId,
        address indexed triggeredBy,
        uint256 srxBalanceSnapshot,
        uint256 timestamp
    );
    event StressEventResolved(
        uint256 indexed eventId,
        uint256 deployerSRXUsed,
        uint256 guardianSRXUsed,
        uint256 timestamp
    );
    event LiquidityDeployed(
        address indexed by,
        address indexed target,
        address indexed token,
        uint256 amount,
        string  reason
    );
    event Contributed(address indexed contributor, uint256 amount, uint256 newTotal);
    event ContributionWithdrawn(address indexed contributor, uint256 amount);
    event RewardsClaimed(address indexed contributor, uint256 amount);
    event RewardShortfall(address indexed contributor, uint256 unpaid);
    event StableReserveDeposited(address indexed by, address indexed token, uint256 amount);
    event RewardPoolFunded(uint256 amount, uint256 newTotal);
    event MinTotalForEmissionSet(uint256 oldMinimum, uint256 newMinimum);
    event RewardRateSet(uint256 oldRate, uint256 newRate);
    event MaxDeployerBpsSet(uint256 oldBps, uint256 newBps);
    event MaxGuardianBpsSet(uint256 oldBps, uint256 newBps);
    event StressCooldownDurationSet(uint256 oldDuration, uint256 newDuration);
    event WithdrawLockDurationSet(uint256 oldDuration, uint256 newDuration);
    event LayerTargetsSet(uint256 stableBps, uint256 coreBps, uint256 yieldBps);
    event DeployTargetSet(address indexed target, bool approved); // SC-TRUST-003
    event MinContributionSet(uint256 oldMinimum, uint256 newMinimum); // SSF-L1
    /// @notice REG-50: the launch allocation delivered here, and the part of it that
    ///         may back depositor rewards (capped at rewardAllocation).
    event AllocationSynced(address indexed distributor, uint256 delivered, uint256 backing);
    /// @notice The fund is now exit-only for depositors, for good.
    event WindDownStarted(address indexed by, bool byPauseTimeout);
    /// @notice A depositor took back exactly their principal after wind-down.
    event ExitedAfterWindDown(address indexed contributor, uint256 principal);
    /// @notice Unused launch reward allocation moved to a successor contract after wind-down.
    event RewardAllocationReleased(address indexed successor, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error StressNotActive();
    error StressAlreadyActive();
    error DeployerCapExceeded(uint256 available, uint256 requested);
    error GuardianCapExceeded(uint256 available, uint256 requested);
    error FastPathSRXOnly();
    error FastPathRequiresStress();
    error WithdrawLockActive(uint256 unlockTime);
    error NoContribution();
    error AmountExceedsContribution(uint256 contributed, uint256 requested);
    error InvalidBps();
    error NothingToClaim();
    error PoolAmountExceedsAvailable(uint256 available, uint256 requested);
    error EmptyReason();
    error UnauthorisedCaller();
    error InvalidDuration(); // internal audit L3: above MAX_WITHDRAW_LOCK
    error StressInCooldown(uint256 cooldownEndsAt); // A6-E-03: cooldown between stress events
    error TargetNotApproved(address target); // SC-TRUST-003: fast-path target not on allowlist
    error InsufficientFreeBalance(uint256 free, uint256 requested); // SSF-M1
    error BelowMinimumContribution(uint256 position, uint256 minimum); // SSF-L1
    /// @notice REG-50: registering `requested` would take cumulative depositor rewards
    ///         past rewardAllocation; `remaining` is what is left of it.
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


    // ── Constructor ────────────────────────────────────────────────────────────

    /**
     * @notice Deploy the StabilisationFund.
     * @param _srxToken             SRX token contract address.
     * @param _admin                Initial admin (deployer; transfers to Timelock/multisig post-deploy).
     * @param _maxDeployerBps       Tier 1 cap in BPS. Must be <= _maxGuardianBps. Suggested: 3000.
     * @param _maxGuardianBps       Tier 2 combined cap in BPS. Must be <= 10000. Suggested: 7000.
     * @param _withdrawLockDuration Contributor lock period in seconds. Suggested: 30 days.
     * @param _rewardAllocation     REG-50: the fixed SRX amount depositor rewards may ever
     *                              total. At most MAX_REWARD_ALLOCATION; 0 means no
     *                              depositor rewards at all. Cannot be changed later.
     * @param _tgeDistributor       The launch TGEDistributor (deploy step 03). REG-50: its
     *                              record of what it delivers here is the only backing
     *                              depositor rewards can have.
     */
    constructor(
        address _srxToken,
        address _admin,
        uint256 _maxDeployerBps,
        uint256 _maxGuardianBps,
        uint256 _withdrawLockDuration,
        uint256 _rewardAllocation,
        address _tgeDistributor
    ) {
        if (_srxToken == address(0) || _admin == address(0) || _tgeDistributor == address(0)) revert ZeroAddress();
        if (_maxDeployerBps > _maxGuardianBps)              revert InvalidBps();
        if (_maxGuardianBps > BPS_DENOMINATOR)              revert InvalidBps();
        if (_rewardAllocation > MAX_REWARD_ALLOCATION) {
            revert RewardAllocationExceeded(MAX_REWARD_ALLOCATION, _rewardAllocation);
        }

        _status = _NOT_ENTERED;

        // Set state BEFORE granting roles (defensive ordering, SC-UUPS-002).
        srxToken               = IERC20(_srxToken);
        maxDeployerBps         = _maxDeployerBps;
        maxGuardianBps         = _maxGuardianBps;
        withdrawLockDuration   = _withdrawLockDuration;
        stressCooldownDuration = 7 days; // A6-E-03: default 7-day cooldown between stress events
        lastUpdateTime         = block.timestamp;
        minContribution        = 100 * 10 ** 18; // SSF-L1: as SRXStaking.minStakeAmount
        rewardAllocation       = _rewardAllocation; // REG-50: fixed for the life of the contract
        tgeDistributor         = _tgeDistributor;

        // Default reserve layer targets
        stableTargetBps = 5_000; // 50%
        coreTargetBps   = 3_000; // 30%
        yieldTargetBps  = 2_000; // 20%

        // Grant roles LAST — after state is fully consistent
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNANCE_ROLE,   _admin);
        _grantRole(PAUSER_ROLE,       _admin);
        _grantRole(WIND_DOWN_ROLE,    _admin); // the guardian Safe (REG-53)
    }

    // ── No ETH (REG-53) ────────────────────────────────────────────────────────
    // ⛔ The fund used to accept ETH through receive(), yet no function could send ETH out
    //    (deployLiquidity moves ERC-20s only); while the fund was upgradeable an upgrade was
    //    the way out. Now that it is not, ETH sent here would be locked for good, so the
    //    fund has no receive() and plain ETH transfers revert (Slither locked-ether,
    //    12 Oct 2026).

    // ── Contributor functions ──────────────────────────────────────────────────

    /**
     * @notice Contribute SRX to the fund. Accrues a proportional share of the SRX
     *         reward pool, which is funded only from the fixed rewardAllocation
     *         (REG-50), never from fees. Applies a 30-day
     *         (governance-adjustable) withdrawal lock from the point of last deposit.
     *
     *         This function participates in the Synthetix reward accounting — rewards
     *         are checkpointed before the contribution is updated so no accrual is lost.
     *
     * ⚠️  LOCK RESET BEHAVIOUR (A6-SF-03): Every call to `contribute()`, including
     *     top-ups of any size, resets the full `withdrawLockDuration` clock for the
     *     entire contributed principal. A contributor who adds even 1 wei to an
     *     existing position will lose all accumulated lock progress. If you do not
     *     wish to restart your lock, do not call `contribute()` again until you are
     *     ready to accept a fresh lock period.
     *
     * @param amount SRX amount (18-decimal). Must be > 0.
     */
    function contribute(uint256 amount) external nonReentrant whenNotPaused {
        if (windDown)    revert WoundDown();
        if (amount == 0) revert ZeroAmount();
        // SSF-L1: the resulting position must reach the minimum (a top-up of an
        // existing position may be smaller, as long as the total reaches it).
        uint256 position = contributions[msg.sender].srxAmount + amount;
        if (position < minContribution) revert BelowMinimumContribution(position, minContribution);

        _updateReward(msg.sender);

        contributions[msg.sender].srxAmount  += amount;
        contributions[msg.sender].depositTime = block.timestamp;
        contributionUnlockAt[msg.sender]      = block.timestamp + withdrawLockDuration;
        totalContributions                   += amount;

        srxToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Contributed(msg.sender, amount, totalContributions);
    }

    /**
     * @notice Withdraw contributed SRX principal. The withdrawal lock must have
     *         elapsed since the contributor's most recent deposit.
     *
     *         Accrued rewards are NOT automatically claimed here — call `claimRewards()`
     *         before or after to collect them. This avoids re-entrancy complexity and
     *         keeps two operations cleanly separable.
     *
     * @param amount SRX amount to withdraw. Must be <= contributed principal.
     */
    function withdrawContribution(uint256 amount) external nonReentrant whenNotPaused {
        Contribution storage c = contributions[msg.sender];
        if (c.srxAmount == 0)          revert NoContribution();
        if (amount > c.srxAmount)      revert AmountExceedsContribution(c.srxAmount, amount);
        // SSF-L1: a partial withdrawal may not leave a dust position behind.
        uint256 remaining = c.srxAmount - amount;
        if (remaining != 0 && remaining < minContribution) revert BelowMinimumContribution(remaining, minContribution);

        uint256 unlockTime = contributionUnlockAt[msg.sender];
        if (block.timestamp < unlockTime) revert WithdrawLockActive(unlockTime);

        _updateReward(msg.sender);

        c.srxAmount        -= amount;
        totalContributions -= amount;

        srxToken.safeTransfer(msg.sender, amount);
        emit ContributionWithdrawn(msg.sender, amount);
    }

    /**
     * @notice Claim accrued SRX rewards without touching the principal.
     *         The contribution position remains active; the fee tier is unaffected.
     *
     *         Note: Rewards may also be claimed after a full principal withdrawal.
     *         Any accrued-but-unclaimed rewards stored in pendingRewards are claimable
     *         regardless of the current contribution balance (M-09 fix).
     */
    // slither-disable-next-line incorrect-equality -- reviewed 7 Oct 2026: a `== 0` nothing-to-do guard on internal accounting or our own balance; no outsider can move it to bypass or block anything
    function claimRewards() external nonReentrant {
        // REG-53: rewards accrued before wind-down stay claimable, even while paused.
        if (paused() && !windDown) revert EnforcedPause();
        _updateReward(msg.sender);
        if (pendingRewards[msg.sender] == 0) revert NothingToClaim();
        _settleRewards(msg.sender);
    }

    /**
     * @notice Deposit USDC, USDT or another ERC-20 stable asset into the fund's Stable Reserves.
     *         TREASURY_ROLE only. ⛔ This was open to anyone, kept no per-user record and had
     *         no way back, so a member of the public who used it could never recover the
     *         funds (Security review, 12 Oct 2026). It is the treasury's reserve-funding
     *         path, not a deposit product; stable deposits earn nothing and are never repaid.
     *         Caller must have pre-approved this contract for `amount`.
     *
     * @param token  ERC-20 stable token address.
     * @param amount Amount in that token's native decimals.
     */
    function depositStableReserve(address token, uint256 amount) external onlyRole(TREASURY_ROLE) nonReentrant whenNotPaused {
        if (windDown)    revert WoundDown();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit StableReserveDeposited(msg.sender, token, amount);
    }

    // ── Synthetix reward accounting ────────────────────────────────────────────

    /**
     * @notice Current accumulated reward per unit of contributed SRX.
     *         Increases monotonically while rewardRate > 0 and totalContributions > 0.
     */
    /**
     * @notice The latest time reward accrual is valid — capped at periodFinish so
     *         emission never exceeds the funded pool (SC-ECON-001 fix).
     */
    // slither-disable-next-line incorrect-equality -- reviewed 7 Oct 2026: a `== 0` nothing-to-do guard on internal accounting or our own balance; no outsider can move it to bypass or block anything
    function lastTimeRewardApplicable() public view returns (uint256) {
        if (periodFinish == 0) return block.timestamp; // no schedule set yet — uncapped (rate is 0)
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        // Internal audit L4 (MONEY-05): as in SRXStaking, emission does not accrue into
        // negligible participation, so a lone minimum position cannot take the stream.
        if (totalContributions < minTotalForEmission) return rewardPerTokenStored;
        if (totalContributions == 0) return rewardPerTokenStored;
        uint256 applicable = lastTimeRewardApplicable();
        if (applicable <= lastUpdateTime) return rewardPerTokenStored;
        uint256 elapsed = applicable - lastUpdateTime;
        return rewardPerTokenStored + (rewardRate * elapsed * PRECISION) / totalContributions;
    }

    /**
     * @notice Total earned-but-unclaimed rewards for a contributor.
     */
    function earned(address user) public view returns (uint256) {
        Contribution memory c = contributions[user];
        return (c.srxAmount * (rewardPerToken() - userRewardPerTokenPaid[user])) / PRECISION
            + pendingRewards[user];
    }

    /**
     * @dev Update the global accumulator and snapshot the user's checkpoint.
     *      Must be called before any change to totalContributions or a user's srxAmount.
     *      Pass address(0) when only the global state needs updating (no user checkpoint).
     */
    function _updateReward(address user) internal {
        uint256 newRPT = rewardPerToken();
        // Accrual applies to the whole contribution base by construction, so it
        // is tracked here, not per caller: a global update (the funding and rate
        // paths) must still count every contributor's new liability.
        if (newRPT > rewardPerTokenStored && totalContributions != 0) {
            totalPendingRewards += (totalContributions * (newRPT - rewardPerTokenStored)) / PRECISION;
        }
        rewardPerTokenStored = newRPT;
        lastUpdateTime       = lastTimeRewardApplicable();

        if (user != address(0)) {
            pendingRewards[user]         = earned(user);
            userRewardPerTokenPaid[user] = rewardPerTokenStored;
        }
    }

    /**
     * @dev Recompute periodFinish so total emission is bounded by the funded pool
     *      (SC-ECON-001). Call AFTER any change to rewardPool or rewardRate, and
     *      AFTER _updateReward has settled accrual to the current time.
     *      periodFinish = now + rewardPool/rewardRate (rate>0), else now (no accrual).
     */
    function _recomputePeriodFinish() internal {
        // Anchor the accrual clock to now (Synthetix pattern). Without this, a gap
        // between a previously-ended period and this rate/pool change would be
        // retroactively billed under the new schedule (off-by-one over-accrual).
        // _updateReward must be called immediately before this.
        lastUpdateTime = block.timestamp;
        // ⛔ This divided the whole rewardPool, which still contains everything
        //    accrued-but-unclaimed, so every rate change or top-up re-granted that
        //    liability as fresh runway and promised the same tokens twice.
        uint256 unaccrued = rewardPool > totalPendingRewards ? rewardPool - totalPendingRewards : 0;
        periodFinish = rewardRate == 0
            ? block.timestamp
            : block.timestamp + (unaccrued / rewardRate);
    }

    /**
     * @dev Transfer all pending rewards to the user. Decrements rewardPool.
     *      Silently does nothing if pendingRewards[user] == 0.
     */
    // slither-disable-next-line incorrect-equality -- reviewed 7 Oct 2026: a `== 0` nothing-to-do guard on internal accounting or our own balance; no outsider can move it to bypass or block anything
    function _settleRewards(address user) internal {
        uint256 owed = pendingRewards[user];
        if (owed == 0) return;

        // Safety cap. ⛔ It used to zero pendingRewards after capping, so a
        // shortfall was destroyed with no event. The remainder now stays owed.
        uint256 reward = owed > rewardPool ? rewardPool : owed;

        pendingRewards[user] = owed - reward;
        // Clamped: per-update rounding can leave the global total a few wei
        // below the sum of individual claims (SRXStaking M-1), and an underflow
        // here would wrap and freeze every future schedule.
        totalPendingRewards = totalPendingRewards > reward ? totalPendingRewards - reward : 0;
        rewardPool         -= reward;

        srxToken.safeTransfer(user, reward);
        emit RewardsClaimed(user, reward);
        if (reward < owed) emit RewardShortfall(user, owed - reward);
    }

    // ── Stress event lifecycle ─────────────────────────────────────────────────

    /**
     * @notice Declare a market stress event. Activates Tier 1 and Tier 2 fast-path
     *         deployment authority and snapshots the current SRX balance for cap
     *         calculation.
     *
     *         Callable by ORACLE_REPORTER_ROLE (off-chain monitor or Chainlink
     *         Automation) or GUARDIAN_ROLE (multi-sig). This allows the broader
     *         multi-sig to declare stress if the oracle is unavailable.
     *
     *         Only GOVERNANCE_ROLE resolves a stress event (and wind-down ends one), so
     *         the fast-path window cannot be opened and closed unilaterally.
     */
    function triggerStressEvent() external whenNotPaused {
        if (windDown) revert WoundDown();
        if (!hasRole(ORACLE_REPORTER_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert UnauthorisedCaller();
        }
        if (stressActive) revert StressAlreadyActive();
        // A6-E-03: enforce cooldown period after the previous stress event resolved.
        // Without this, fast-path actors could cycle (trigger → deploy cap → governance resolves → trigger)
        // to deplete more than the intended per-event cap.
        if (stressResolvedAt > 0) {
            uint256 cooldownEndsAt = stressResolvedAt + stressCooldownDuration;
            if (block.timestamp < cooldownEndsAt) revert StressInCooldown(cooldownEndsAt);
        }

        stressActive           = true;
        stressEventCount      += 1;
        stressTriggeredAt      = block.timestamp;
        // The caps are a share of what the fund may actually spend: its SRX less
        // contributor principal and the reward pool. ⛔ The whole balance was
        // snapshotted, so a 70% cap could reach into contributors' own deposits.
        stressStartSRXBalance  = _freeSRX();
        deployerSRXUsed        = 0;
        guardianSRXUsed        = 0;

        emit StressEventTriggered(stressEventCount, msg.sender, stressStartSRXBalance, block.timestamp);
    }

    /**
     * @notice Resolve the active stress event. Closes Tier 1 and Tier 2 fast-path
     *         windows. Only GOVERNANCE_ROLE (Timelock) can call this, ensuring the
     *         full DAO must agree before fast-path authority ends.
     *
     *         Deployed liquidity is returned by its holder sending it back to the fund
     *         (recoverLiquidity was removed, R7-16).
     */
    function resolveStressEvent() external onlyRole(GOVERNANCE_ROLE) {
        if (!stressActive) revert StressNotActive();

        stressActive     = false;
        stressResolvedAt = block.timestamp; // A6-E-03: snapshot resolve time for cooldown enforcement

        emit StressEventResolved(
            stressEventCount,
            deployerSRXUsed,
            guardianSRXUsed,
            block.timestamp
        );
    }

    // ── Liquidity deployment ───────────────────────────────────────────────────

    /**
     * @notice Deploy capital from the fund.
     *
     * Permission matrix:
     * ┌─────────────────┬─────────────┬──────────┬────────────────────────────────┐
     * │ Caller          │ Stress req. │ Token    │ Cap                            │
     * ├─────────────────┼─────────────┼──────────┼────────────────────────────────┤
     * │ DEPLOYER_ROLE   │ Yes         │ SRX only │ maxDeployerBps of snapshot     │
     * │ GUARDIAN_ROLE   │ Yes         │ SRX only │ maxGuardianBps combined w/ dep │
     * │ GOVERNANCE_ROLE │ No          │ Any      │ None (Timelock delay is guard) │
     * └─────────────────┴─────────────┴──────────┴────────────────────────────────┘
     *
     * Fast paths (DEPLOYER / GUARDIAN) are intentionally SRX-only because the
     * primary use of the stress mechanism is supplying SRX liquidity to markets.
     * Deploying ETH or stablecoins during stress is rare and can wait for governance.
     *
     * @param target Address to send tokens to (DEX pool, market maker, etc.).
     * @param token  ERC-20 token to deploy. Fast paths require this == srxToken.
     * @param amount Amount to deploy.
     * @param reason On-chain justification string (required for audit trail).
     */
    function deployLiquidity(
        address        target,
        address        token,
        uint256        amount,
        string calldata reason
    ) external nonReentrant whenNotPaused {
        if (target == address(0))      revert ZeroAddress();
        if (amount == 0)               revert ZeroAmount();
        if (bytes(reason).length == 0) revert EmptyReason();

        bool isGovernance = hasRole(GOVERNANCE_ROLE, msg.sender);
        bool isGuardian   = hasRole(GUARDIAN_ROLE,   msg.sender);
        bool isDeployer   = hasRole(DEPLOYER_ROLE,   msg.sender);

        if (!isGovernance && !isGuardian && !isDeployer) revert UnauthorisedCaller();

        if (!isGovernance) {
            // ── Fast-path rules ──────────────────────────────────────────────
            if (!stressActive)                  revert FastPathRequiresStress();
            if (token != address(srxToken))     revert FastPathSRXOnly();
            // SC-TRUST-003: fast-path may only send to a governance-approved target.
            // Closes the arbitrary-destination drain vector for compromised fast-path roles.
            if (!approvedDeployTarget[target])  revert TargetNotApproved(target);

            if (isDeployer && !isGuardian) {
                // Tier 1: deployer cap — accounts for combined deployer + guardian usage
                // so a separate compromised guardian cannot exhaust the full combined cap
                // while the deployer still has its individual limit available (A2-M-06 fix).
                uint256 limit = (stressStartSRXBalance * maxDeployerBps) / BPS_DENOMINATOR;
                uint256 used  = deployerSRXUsed + guardianSRXUsed;
                uint256 available = limit > used ? limit - used : 0;
                if (amount > available) revert DeployerCapExceeded(available, amount);
                deployerSRXUsed += amount;

            } else if (isGuardian) {
                // Tier 2: combined (deployer + guardian) cap
                // A GUARDIAN who also holds DEPLOYER_ROLE uses the guardian cap (higher authority).
                uint256 limit    = (stressStartSRXBalance * maxGuardianBps) / BPS_DENOMINATOR;
                uint256 used     = deployerSRXUsed + guardianSRXUsed;
                uint256 available = limit > used ? limit - used : 0;
                if (amount > available) revert GuardianCapExceeded(available, amount);
                guardianSRXUsed += amount;
            }
        }

        // ⛔ SSF-M1: contributor principal and the reward pool are never spendable
        //    by a fast path, whatever the snapshot said. Before this, a guardian
        //    deploying its full cap could leave the fund unable to repay the last
        //    contributors, and a stale snapshot allowed more than 70% of what was
        //    left.
        // ⛔ REG-50 (12 Oct 2026): governance is now bound too. Depositors' principal,
        //    the reward pool and the SRX still backing unregistered rewards are never
        //    deployable by anyone. Otherwise backing SRX could be sent out and later
        //    replaced by fee SRX, and governance could spend depositors' deposits.
        //    The backing is read first, so no launch SRX can leave before it is known.
        if (token == address(srxToken)) {
            _syncAllocation(); // read live (internal audit M1)
            if (amount > _freeSRX()) revert InsufficientFreeBalance(_freeSRX(), amount);
        }

        totalDeployed += amount;
        IERC20(token).safeTransfer(target, amount);
        emit LiquidityDeployed(msg.sender, target, token, amount, reason);
    }

    // ── Reward pool governance ─────────────────────────────────────────────────

    /**
     * @notice Register SRX already in this contract as the contributor reward pool.
     *         The tokens must be present (the TGE seed); this is pure accounting.
     *
     *         ⛔ REG-50: cumulative registrations can never exceed rewardBacking (the
     *            launch SRX delivered here, at most rewardAllocation), so SRX reaching
     *            the fund any other way can neither extend depositor rewards nor pay
     *            for them.
     *         No tokens move. The pool is drawn down over time as contributors claim.
     *
     *         Available = balance − contributor principal − existing rewardPool.
     *         This ensures a reward registration can never promise contributor
     *         principal, or the existing pool, a second time. (Since REG-50 governance's
     *         own deployLiquidity of SRX is bound by the free balance too.)
     *
     * @param amount SRX to register. Must not exceed the unencumbered balance.
     */
    function notifyRewardAmount(uint256 amount) external onlyRole(GOVERNANCE_ROLE) {
        if (windDown)    revert WoundDown();
        if (amount == 0) revert ZeroAmount();
        _syncAllocation(); // read live (internal audit M1)
        uint256 remaining = rewardBacking - totalRewardsRegistered;
        if (amount > remaining) revert RewardAllocationExceeded(remaining, amount);
        // Require at least one contributor exists before registering a reward pool.
        // With zero contributions the Synthetix accumulator denominator is zero —
        // rewards would accrue to nobody and could be drained by the first tiny
        // contribution (A2-M-01 fix).
        if (totalContributions == 0) revert NoContribution();

        uint256 balance     = srxToken.balanceOf(address(this));
        uint256 encumbered  = totalContributions + rewardPool;
        uint256 available   = balance > encumbered ? balance - encumbered : 0;
        if (amount > available) revert PoolAmountExceedsAvailable(available, amount);

        _updateReward(address(0));
        totalRewardsRegistered += amount;
        rewardPool             += amount;
        _recomputePeriodFinish(); // SC-ECON-001: extend schedule to cover the new pool
        emit RewardPoolFunded(amount, rewardPool);
    }

    // ⛔ Internal audit L1 (MONEY-02, CLAIMS-04; 16 Oct 2026): rescueStrandedPool(recipient)
    //    sent the unaccrued pool to ANY address whenever nobody had contributed, against
    //    its own twin releaseRewardAllocation, which pays only a successor. A pool with no
    //    contributors is not stranded: accrual resumes when contributors return. After
    //    wind-down, releaseRewardAllocation is the only way out (MIGRATION.md). Removed,
    //    as in SRXStaking.

    /**
     * @notice Read how much SRX the allocation source delivered here; at most
     *         rewardAllocation of it can ever back depositor rewards (REG-50).
     * @dev Permissionless: the amount comes from the source fixed at deployment, not the
     *      caller, and it can only be read after distribution. Also run by every
     *      notifyRewardAmount(), every SRX deployLiquidity() and startWindDown().
     *
     * ⛔ Internal audit M1 (MONEY-01, 16 Oct 2026): this was one-shot. A successor's source
     *    is its wound-down predecessor, whose record grows with each release, so anyone
     *    who synced the successor before the release fixed its backing at 0 for good and
     *    the released launch SRX arrived as free SRX that governance could deploy anywhere.
     *    The record is now re-read until this fund winds down, and the backing only ever
     *    rises: a TGEDistributor's record is final once distributed, and a predecessor's
     *    releasedTo only grows. Before wind-down nothing reduces rewardBacking.
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
        if (d.token() != address(srxToken)) revert WrongDistributorToken(d.token());
        if (!d.distributed())               revert DistributionNotComplete();
        uint256 delivered = d.allocatedTo(address(this));
        uint256 backing   = delivered > rewardAllocation ? rewardAllocation : delivered;
        allocationSynced = true;
        if (backing > rewardBacking) rewardBacking = backing;
        emit AllocationSynced(address(d), delivered, rewardBacking);
    }

    /**
     * @notice Set the per-second SRX reward emission rate for contributors.
     *         Set to 0 to pause reward accrual without affecting the reward pool.
     *
     * @param newRate SRX wei per second distributed across all contributors.
     */
    function setRewardRate(uint256 newRate) external onlyRole(GOVERNANCE_ROLE) {
        if (windDown) revert WoundDown();
        _updateReward(address(0)); // settle accumulator at old rate before switching
        emit RewardRateSet(rewardRate, newRate);
        rewardRate = newRate;
        _recomputePeriodFinish(); // SC-ECON-001: bound emission to pool at the new rate
    }

    // ── Governance parameters ──────────────────────────────────────────────────

    /**
     * @notice Update the Tier 1 (DEPLOYER) deployment cap.
     *         Must be <= maxGuardianBps.
     */
    function setMaxDeployerBps(uint256 newBps) external onlyRole(GOVERNANCE_ROLE) {
        if (newBps > maxGuardianBps) revert InvalidBps();
        emit MaxDeployerBpsSet(maxDeployerBps, newBps);
        maxDeployerBps = newBps;
    }

    /**
     * @notice Update the Tier 2 combined (GUARDIAN) deployment cap.
     *         Must be >= maxDeployerBps and <= BPS_DENOMINATOR.
     */
    function setMaxGuardianBps(uint256 newBps) external onlyRole(GOVERNANCE_ROLE) {
        if (newBps > BPS_DENOMINATOR) revert InvalidBps();
        if (newBps < maxDeployerBps)  revert InvalidBps();
        emit MaxGuardianBpsSet(maxGuardianBps, newBps);
        maxGuardianBps = newBps;
    }

    /**
     * @notice Update the minimum cooldown period required between stress events.
     *         Prevents fast-path cap cycling. Default: 7 days (A6-E-03).
     * @param newDuration Cooldown in seconds. Set to 0 to disable (not recommended).
     */
    function setStressCooldownDuration(uint256 newDuration) external onlyRole(GOVERNANCE_ROLE) {
        emit StressCooldownDurationSet(stressCooldownDuration, newDuration);
        stressCooldownDuration = newDuration;
    }

    /**
     * @notice Update the contributor withdrawal lock duration, for deposits made from now on.
     * @param newDuration Duration in seconds, at most MAX_WITHDRAW_LOCK (0 = no lock).
     * @dev ⛔ Internal audit L3 (MONEY-04, 16 Oct 2026): this applied retroactively to every
     *      existing deposit and had no upper bound, so one proposal could confine principal
     *      already past its lock without any pause (and type(uint256).max made every
     *      withdrawal overflow). Each deposit now keeps the lock it was made under.
     */
    function setWithdrawLockDuration(uint256 newDuration) external onlyRole(GOVERNANCE_ROLE) {
        if (newDuration > MAX_WITHDRAW_LOCK) revert InvalidDuration();
        emit WithdrawLockDurationSet(withdrawLockDuration, newDuration);
        withdrawLockDuration = newDuration;
    }

    /**
     * @notice Set the total contributions below which emission does not accrue.
     * @dev Banks accrual under the old threshold first, as SRXStaking does.
     */
    function setMinTotalForEmission(uint256 newMinimum) external onlyRole(GOVERNANCE_ROLE) {
        _updateReward(address(0));
        emit MinTotalForEmissionSet(minTotalForEmission, newMinimum);
        minTotalForEmission = newMinimum;
    }

    /**
     * @notice Set the smallest SRX position a contributor may hold (SSF-L1).
     * @dev Existing positions are not changed; the minimum applies to the next
     *      contribute() or partial withdrawal of each position.
     */
    function setMinContribution(uint256 newMinimum) external onlyRole(GOVERNANCE_ROLE) {
        emit MinContributionSet(minContribution, newMinimum);
        minContribution = newMinimum;
    }

    /**
     * @notice Update the three-layer reserve target allocations.
     *         The three values must sum to exactly BPS_DENOMINATOR.
     *
     * @param _stableBps Target for Stable Reserves (USDC/USDT).
     * @param _coreBps   Target for Core Assets (ETH/SRX).
     * @param _yieldBps  Target for Yield Assets (DeFi positions).
     */
    function setLayerTargetBps(
        uint256 _stableBps,
        uint256 _coreBps,
        uint256 _yieldBps
    ) external onlyRole(GOVERNANCE_ROLE) {
        if (_stableBps + _coreBps + _yieldBps != BPS_DENOMINATOR) revert InvalidBps();
        stableTargetBps = _stableBps;
        coreTargetBps   = _coreBps;
        yieldTargetBps  = _yieldBps;
        emit LayerTargetsSet(_stableBps, _coreBps, _yieldBps);
    }

    /**
     * @notice Approve or revoke a fast-path deployment destination (SC-TRUST-003 fix).
     *         DEPLOYER_ROLE / GUARDIAN_ROLE fast-path deployments may only send SRX to
     *         an approved target (e.g. a DEX pool or vetted market-maker vault). The
     *         GOVERNANCE_ROLE path does not consult this list (it is bound by the free
     *         balance and the Timelock's delay instead).
     *         Governance-only; manage the allowlist ahead of any stress event.
     * @param target   Destination address to approve/revoke.
     * @param approved True to allow fast-path deployment to `target`; false to revoke.
     */
    function setDeployTarget(address target, bool approved) external onlyRole(GOVERNANCE_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        approvedDeployTarget[target] = approved;
        emit DeployTargetSet(target, approved);
    }

    // ── Pause ──────────────────────────────────────────────────────────────────

    // ⛔ Internal audit L2 (MONEY-03, STAKING-04, CLAIMS-03; 16 Oct 2026): unpause zeroed
    //    pausedSince, so an unpause and re-pause in one block restarted the 30-day clock
    //    after which anyone may wind down; depositors, who have no exit while the fund is
    //    paused, were held 203 days in the proof. A break shorter than PAUSE_BREAK now
    //    continues the same pause.
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
     * @notice Make the fund exit-only for depositors, for good. Emission stops now and any
     *         stress event ends; accrued rewards stay claimable; every depositor can take
     *         back their principal with exitAfterWindDown(). No function reverses this.
     * @dev The Timelock (GOVERNANCE_ROLE) or the guardian Safe (WIND_DOWN_ROLE) may call it
     *      at any time; anyone may once the fund has been paused for a total of
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
        if (stressActive) {        // the fast paths close with it, visibly (sweep 22 Oct, Info)
            stressActive     = false;
            stressResolvedAt = block.timestamp;
            emit StressEventResolved(stressEventCount, deployerSRXUsed, guardianSRXUsed, block.timestamp);
        }
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
     * @notice After wind-down: take back exactly your own principal, with no lock wait, even
     *         while the fund is paused. Rewards accrued up to the switch are recorded and
     *         stay claimable with claimRewards().
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
        uint256 bal  = srxToken.balanceOf(address(this));
        uint256 kept = totalContributions + totalPendingRewards;
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
        srxToken.safeTransfer(successor, amount);
        emit RewardAllocationReleased(successor, amount);
    }

    // ── As an allocation source for a successor (ITGEAllocationSource) ────────

    /// @notice The token this contract releases (ITGEAllocationSource).
    function token() external view returns (address) { return address(srxToken); }

    /// @notice True once wound down: from then on releasedTo() is this contract's final word
    ///         to a successor (ITGEAllocationSource).
    function distributed() external view returns (bool) { return windDown; }

    /// @notice What this contract released to `destination` (ITGEAllocationSource).
    function allocatedTo(address destination) external view returns (uint256) { return releasedTo[destination]; }

    function exitAfterWindDown() external nonReentrant {
        if (!windDown) revert NotWoundDown();
        uint256 principal = contributions[msg.sender].srxAmount;
        if (principal == 0) revert NoContribution();

        // Bank accrued rewards (emission stopped at the switch): kept claimable, never paid
        // out of principal.
        pendingRewards[msg.sender]         = earned(msg.sender);
        userRewardPerTokenPaid[msg.sender] = rewardPerTokenStored;

        totalContributions -= principal;
        delete contributions[msg.sender];

        srxToken.safeTransfer(msg.sender, principal);
        emit ExitedAfterWindDown(msg.sender, principal);
    }

    // ── View helpers ───────────────────────────────────────────────────────────

    /// @notice Current SRX balance of the fund (includes TGE seed + contributions + rewards).
    function srxBalance() external view returns (uint256) {
        return srxToken.balanceOf(address(this));
    }

    /// @notice Current ETH balance of the fund.
    function ethBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Current balance of any ERC-20 token held by the fund.
    function tokenBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /**
     * @notice How much SRX the DEPLOYER_ROLE can still deploy in the current stress period.
     *         Returns 0 if stress is not active.
     *
     *         The remaining capacity subtracts BOTH deployer and guardian usage because
     *         the Tier 1 enforcement in deployLiquidity() uses `deployerSRXUsed + guardianSRXUsed`
     *         as the combined "used" figure against the deployer cap. This view reflects that
     *         same formula so callers are not misled by an inflated available figure (A3-M-01 fix).
     */
    // slither-disable-next-line incorrect-equality -- reviewed 7 Oct 2026: a `== 0` nothing-to-do guard on internal accounting or our own balance; no outsider can move it to bypass or block anything
    function getDeployerCapRemaining() external view returns (uint256) {
        if (!stressActive || stressStartSRXBalance == 0) return 0;
        uint256 limit = (stressStartSRXBalance * maxDeployerBps) / BPS_DENOMINATOR;
        uint256 used  = deployerSRXUsed + guardianSRXUsed;
        return used >= limit ? 0 : limit - used;
    }

    /**
     * @notice How much SRX the GUARDIAN_ROLE can still deploy in the current stress period
     *         (combined capacity remaining after accounting for DEPLOYER usage).
     *         Returns 0 if stress is not active.
     */
    // slither-disable-next-line incorrect-equality -- reviewed 7 Oct 2026: a `== 0` nothing-to-do guard on internal accounting or our own balance; no outsider can move it to bypass or block anything
    function getGuardianCapRemaining() external view returns (uint256) {
        if (!stressActive || stressStartSRXBalance == 0) return 0;
        uint256 limit = (stressStartSRXBalance * maxGuardianBps) / BPS_DENOMINATOR;
        uint256 used  = deployerSRXUsed + guardianSRXUsed;
        return used >= limit ? 0 : limit - used;
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    /// @dev SRX the fund holds beyond what is reserved: contributor principal, the
    ///      reward pool, and the launch SRX still backing unregistered rewards (REG-50).
    function _freeSRX() internal view returns (uint256) {
        uint256 bal = srxToken.balanceOf(address(this));
        uint256 encumbered = _reservedSRX();
        return bal > encumbered ? bal - encumbered : 0;
    }

    function _reservedSRX() internal view returns (uint256) {
        // Before syncAllocation() the backing is not yet known, so the whole possible
        // rewardAllocation is held back (no SRX deployment runs before the sync:
        // deployLiquidity syncs first); afterwards only the unregistered remainder.
        uint256 unregistered = allocationSynced
            ? rewardBacking - totalRewardsRegistered
            : rewardAllocation;
        return totalContributions + rewardPool + unregistered;
    }

}
