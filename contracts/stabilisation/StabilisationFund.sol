// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 }                   from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 }                from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { PausableUpgradeable }      from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { UUPSUpgradeable }          from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable }            from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// ReentrancyGuardUpgradeable was removed in OZ v5.1+. Inline implementation below.

/**
 * @title StabilisationFund
 * @notice The Syrax Stabilisation Fund (SSF) — on-chain implementation of the
 *         Syrax Liquidity Resilience Whitepaper.
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
 *   • Capped at `maxDeployerBps` of the SRX balance at stress start (default 30%).
 *   • No governance vote required. Fastest possible response.
 *
 *  Tier 2 — GUARDIAN_ROLE (Broader multi-sig, e.g. 4-of-7: founders + lead investors + DAO delegates)
 *   • Deploys SRX immediately during an active stress event.
 *   • Combined cap with Tier 1: total (deployer + guardian) SRX deployed must not
 *     exceed `maxGuardianBps` of stress-start SRX balance (default 70%).
 *   • Also authorised to TRIGGER a stress event (alongside ORACLE_REPORTER_ROLE).
 *   • No governance vote required. Used when Tier 1 is insufficient.
 *
 *  Tier 3 — GOVERNANCE_ROLE (SRXTimelock, 48-hour delay)
 *   • Unrestricted: any token, any amount, any time.
 *   • The authoritative, fully decentralised path. Used for non-emergency
 *     deployments and for amounts beyond the Tier 1/2 caps.
 *   • Only GOVERNANCE can resolve a stress event — closing the fast-path window.
 *
 * Rationale: Tier 1 and 2 provide sub-minute response capability during a
 * genuine market crisis (flash crashes, coordinated sell-offs, exchange collapses)
 * while the 48-hour governance window remains available for larger or
 * non-emergency capital moves. Caps prevent abuse: the maximum reachable via
 * fast paths is 70% of the fund's SRX balance at stress start.
 *
 * ── Reserve Layers ───────────────────────────────────────────────────────────
 *
 *  Layer                Target    Assets
 *  ─────────────────── ─────── ────────────────────────────────
 *  Stable Reserves         50%  USDC, USDT
 *  Core Assets             30%  ETH, SRX (TGE seed is initial Core)
 *  Yield Assets            20%  DeFi positions (managed off-chain, reported back)
 *
 * Layer targets are governance-adjustable via `setLayerTargetBps()`.
 *
 * ── Contributor Rewards ──────────────────────────────────────────────────────
 *
 * Any SRX holder may contribute to the fund and earn a proportional share of
 * platform fee income routed on-chain. Reward accounting uses the Synthetix
 * reward-per-token pattern (gas-efficient, safe under concurrent deposits/
 * withdrawals, no iteration over all contributors). A 30-day withdrawal lock
 * prevents flash-contribution reward exploits.
 *
 * ── Reentrancy ───────────────────────────────────────────────────────────────
 *
 * OZ v5.1 removed ReentrancyGuardUpgradeable. Inline guard is used throughout,
 * consistent with SRXStaking and SRXTreasury.
 *
 * ── UUPS Upgradeable ─────────────────────────────────────────────────────────
 *
 * Only GOVERNANCE_ROLE (Timelock) can authorise an upgrade. The contract address
 * is permanent; only logic evolves. Upgrades require a full DAO vote.
 */
contract StabilisationFund is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
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

    /// @notice Authorises UUPS upgrades. SEPARATED from GOVERNANCE_ROLE (SC-TRUST-001 fix)
    ///         so upgrade authority can be homed exclusively on the SRXTimelock. MUST be
    ///         migrated to the Timelock and revoked from the admin EOA before mainnet
    ///         (enforced by verify_roles.js).
    bytes32 public constant UPGRADER_ROLE        = keccak256("UPGRADER_ROLE");

    // ── Constants ──────────────────────────────────────────────────────────────

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @dev Internal precision scalar for reward-per-token accumulator.
    uint256 private constant PRECISION = 1e18;

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

    IERC20 public srxToken;

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

    /// @notice SRX balance snapshotted when a stress event is triggered.
    ///         Caps for Tier 1 and Tier 2 are calculated against this value.
    uint256 public stressStartSRXBalance;

    /// @notice Cumulative SRX deployed by DEPLOYER_ROLE in the current stress period.
    uint256 public deployerSRXUsed;

    /// @notice Cumulative SRX deployed by GUARDIAN_ROLE in the current stress period
    ///         (tracked separately; cap check uses deployer+guardian combined).
    uint256 public guardianSRXUsed;

    // ── State: deployment caps ─────────────────────────────────────────────────

    /// @notice Tier 1 cap — maximum fraction of stress-start SRX balance that DEPLOYER_ROLE
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

    /// @notice Target allocation for Yield Assets (DeFi positions). Default: 2000 = 20%.
    uint256 public yieldTargetBps;

    // ── State: audit counters ──────────────────────────────────────────────────

    uint256 public totalDeployed;
    uint256 public totalRecovered;

    // ── State: fast-path deployment allowlist (SC-TRUST-003 fix) ───────────────
    //
    // Fast-path deployments (DEPLOYER_ROLE / GUARDIAN_ROLE during a stress event)
    // may only send SRX to a governance-approved destination (DEX pool, vetted
    // market-maker vault). This removes the arbitrary-`target` drain vector where a
    // compromised fast-path multisig could trigger stress and move up to 70% of the
    // fund — including public contributor principal — to an attacker address.
    // The GOVERNANCE_ROLE (Timelock) path remains unrestricted; its 48h delay is the
    // guard there.
    mapping(address => bool) public approvedDeployTarget;

    /// @dev Storage gap for future upgrades (R7-1 + SC-UUPS-001 fix).
    ///
    ///      DISCIPLINE: Every upgrade that adds N new state variables MUST shrink this
    ///      gap by exactly N. Append new state ABOVE this gap. DO NOT insert variables
    ///      below the gap. Wrong shrinkage causes storage slot collision on subsequent
    ///      upgrades. (Reduced 50 → 49 for approvedDeployTarget (SC-TRUST-003),
    ///      then 49 → 48 for periodFinish (SC-ECON-001).)
    ///
    ///      VERIFICATION: Every upgrade PR must run `hardhat-upgrades` validateUpgrade
    ///      and the upgrade runbook must include a "Storage Layout Diff" section.
    // solhint-disable-next-line var-name-mixedcase
    uint256[48] private __gap;

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
    event LiquidityRecovered(
        address indexed by,
        address indexed source,
        address indexed token,
        uint256 amount
    );
    event Contributed(address indexed contributor, uint256 amount, uint256 newTotal);
    event ContributionWithdrawn(address indexed contributor, uint256 amount);
    event RewardsClaimed(address indexed contributor, uint256 amount);
    event FeesReceived(address indexed token, uint256 amount);
    event StableContributed(address indexed contributor, address indexed token, uint256 amount);
    event RewardPoolFunded(uint256 amount, uint256 newTotal);
    event RewardPoolReset(address indexed recipient, uint256 amount); // R7-2: distinct event for rescueStrandedPool()
    event RewardRateSet(uint256 oldRate, uint256 newRate);
    event MaxDeployerBpsSet(uint256 oldBps, uint256 newBps);
    event MaxGuardianBpsSet(uint256 oldBps, uint256 newBps);
    event StressCooldownDurationSet(uint256 oldDuration, uint256 newDuration);
    event WithdrawLockDurationSet(uint256 oldDuration, uint256 newDuration);
    event LayerTargetsSet(uint256 stableBps, uint256 coreBps, uint256 yieldBps);
    event ETHReceived(address indexed sender, uint256 amount);
    event DeployTargetSet(address indexed target, bool approved); // SC-TRUST-003

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
    error NoStrandedPool();    // A5-M-02: rescue only valid when pool is stranded
    error StressInCooldown(uint256 cooldownEndsAt); // A6-E-03: cooldown between stress events
    error TargetNotApproved(address target); // SC-TRUST-003: fast-path target not on allowlist

    // ── Constructor ────────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ── Initializer ────────────────────────────────────────────────────────────

    /**
     * @notice Initialise the StabilisationFund proxy.
     * @param _srxToken             SRX token contract address.
     * @param _admin                Initial admin (deployer; transfers to Timelock/multisig post-deploy).
     * @param _maxDeployerBps       Tier 1 cap in BPS. Must be <= _maxGuardianBps. Suggested: 3000.
     * @param _maxGuardianBps       Tier 2 combined cap in BPS. Must be <= 10000. Suggested: 7000.
     * @param _withdrawLockDuration Contributor lock period in seconds. Suggested: 30 days.
     */
    function initialize(
        address _srxToken,
        address _admin,
        uint256 _maxDeployerBps,
        uint256 _maxGuardianBps,
        uint256 _withdrawLockDuration
    ) external initializer {
        if (_srxToken == address(0) || _admin == address(0)) revert ZeroAddress();
        if (_maxDeployerBps > _maxGuardianBps)              revert InvalidBps();
        if (_maxGuardianBps > BPS_DENOMINATOR)              revert InvalidBps();

        __AccessControl_init();
        __Pausable_init();
        _status = _NOT_ENTERED;

        // SC-UUPS-002 fix: set state BEFORE granting roles (defensive ordering).
        srxToken               = IERC20(_srxToken);
        maxDeployerBps         = _maxDeployerBps;
        maxGuardianBps         = _maxGuardianBps;
        withdrawLockDuration   = _withdrawLockDuration;
        stressCooldownDuration = 7 days; // A6-E-03: default 7-day cooldown between stress events
        lastUpdateTime         = block.timestamp;

        // Default reserve layer targets
        stableTargetBps = 5_000; // 50%
        coreTargetBps   = 3_000; // 30%
        yieldTargetBps  = 2_000; // 20%

        // Grant roles LAST — after state is fully consistent
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNANCE_ROLE,   _admin);
        _grantRole(PAUSER_ROLE,       _admin);
        // SC-TRUST-001 fix: upgrade authority granted to admin for deployment bootstrap.
        // MUST be migrated to the SRXTimelock and revoked from admin pre-mainnet
        // (verify_roles.js enforces this end state).
        _grantRole(UPGRADER_ROLE,     _admin);
    }

    // ── ETH acceptance ─────────────────────────────────────────────────────────

    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }

    // ── Contributor functions ──────────────────────────────────────────────────

    /**
     * @notice Contribute SRX to the fund. Earns a proportional share of platform
     *         fee income distributed via the reward pool. Applies a 30-day
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
        if (amount == 0) revert ZeroAmount();

        _updateReward(msg.sender);

        contributions[msg.sender].srxAmount  += amount;
        contributions[msg.sender].depositTime = block.timestamp;
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

        uint256 unlockTime = c.depositTime + withdrawLockDuration;
        if (block.timestamp < unlockTime) revert WithdrawLockActive(unlockTime);

        _updateReward(msg.sender);

        c.srxAmount        -= amount;
        totalContributions -= amount;

        srxToken.safeTransfer(msg.sender, amount);
        emit ContributionWithdrawn(msg.sender, amount);
    }

    /**
     * @notice Claim accumulated platform fee rewards without touching the principal.
     *         The contribution position remains active; the fee tier is unaffected.
     *
     *         Note: Rewards may also be claimed after a full principal withdrawal.
     *         Any accrued-but-unclaimed rewards stored in pendingRewards are claimable
     *         regardless of the current contribution balance (M-09 fix).
     */
    function claimRewards() external nonReentrant whenNotPaused {
        _updateReward(msg.sender);
        if (pendingRewards[msg.sender] == 0) revert NothingToClaim();
        _settleRewards(msg.sender);
    }

    /**
     * @notice Contribute USDC, USDT, or any other ERC-20 stable asset to the fund.
     *         Stable contributions do NOT participate in the SRX reward pool —
     *         they are held as Stable Reserves in the three-layer allocation model.
     *         Caller must have pre-approved this contract for `amount`.
     *
     * @param token  ERC-20 stable token address.
     * @param amount Amount in that token's native decimals.
     */
    function contributeStable(address token, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit StableContributed(msg.sender, token, amount);
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
    function lastTimeRewardApplicable() public view returns (uint256) {
        if (periodFinish == 0) return block.timestamp; // no schedule set yet — uncapped (rate is 0)
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
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
        rewardPerTokenStored = rewardPerToken();
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
        periodFinish = rewardRate == 0
            ? block.timestamp
            : block.timestamp + (rewardPool / rewardRate);
    }

    /**
     * @dev Transfer all pending rewards to the user. Decrements rewardPool.
     *      Silently does nothing if pendingRewards[user] == 0.
     */
    function _settleRewards(address user) internal {
        uint256 reward = pendingRewards[user];
        if (reward == 0) return;

        // Safety cap — protects against accounting drift in edge cases.
        if (reward > rewardPool) reward = rewardPool;

        pendingRewards[user] = 0;
        rewardPool          -= reward;

        srxToken.safeTransfer(user, reward);
        emit RewardsClaimed(user, reward);
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
     *         Only GOVERNANCE_ROLE can resolve a stress event. This ensures the
     *         fast-path window cannot be opened and closed unilaterally.
     */
    function triggerStressEvent() external whenNotPaused {
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
        stressStartSRXBalance  = srxToken.balanceOf(address(this));
        deployerSRXUsed        = 0;
        guardianSRXUsed        = 0;

        emit StressEventTriggered(stressEventCount, msg.sender, stressStartSRXBalance, block.timestamp);
    }

    /**
     * @notice Resolve the active stress event. Closes Tier 1 and Tier 2 fast-path
     *         windows. Only GOVERNANCE_ROLE (Timelock) can call this, ensuring the
     *         full DAO must agree before fast-path authority ends.
     *
     *         Capital recovery (recoverLiquidity) proceeds normally after resolution.
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
     * primary use of the stress mechanism is SRX price support via DEX liquidity.
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

        totalDeployed += amount;
        IERC20(token).safeTransfer(target, amount);
        emit LiquidityDeployed(msg.sender, target, token, amount, reason);
    }

    /**
     * @notice Recover previously deployed liquidity back into the fund.
     *         GOVERNANCE_ROLE only — recovery is not time-sensitive.
     *         Caller must have pre-approved this contract to pull `amount` of `token`
     *         from `source`, OR the source contract must push tokens directly.
     *
     * @param source Address from which to pull tokens (e.g. a market-maker vault).
     * @param token  ERC-20 token to recover.
     * @param amount Amount to recover.
     */
    function recoverLiquidity(
        address source,
        address token,
        uint256 amount
    ) external onlyRole(GOVERNANCE_ROLE) nonReentrant whenNotPaused {
        if (source == address(0)) revert ZeroAddress();
        if (amount == 0)          revert ZeroAmount();

        IERC20(token).safeTransferFrom(source, address(this), amount);
        totalRecovered += amount;
        emit LiquidityRecovered(msg.sender, source, token, amount);
    }

    // ── Fee routing ────────────────────────────────────────────────────────────

    /**
     * @notice Route platform fees into the fund. Called by the gateway fee-splitter
     *         contract or governance. Caller must have pre-approved this contract.
     *         No role restriction — tokens flow TO the fund, so there is no drain risk.
     *
     * @param token  ERC-20 token (USDC, SRX, etc.).
     * @param amount Amount to route.
     */
    function receiveFees(address token, uint256 amount) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit FeesReceived(token, amount);
    }

    // ── Reward pool governance ─────────────────────────────────────────────────

    /**
     * @notice Register SRX already in this contract as the contributor reward pool.
     *         The tokens must be present (TGE seed or fees); this is pure accounting.
     *         No tokens move. The pool is drawn down over time as contributors claim.
     *
     *         Available = balance − contributor principal − existing rewardPool.
     *         This ensures contributor principal is always fully backed.
     *
     * @param amount SRX to register. Must not exceed the unencumbered balance.
     */
    function notifyRewardAmount(uint256 amount) external onlyRole(GOVERNANCE_ROLE) {
        if (amount == 0) revert ZeroAmount();
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
        rewardPool += amount;
        _recomputePeriodFinish(); // SC-ECON-001: extend schedule to cover the new pool
        emit RewardPoolFunded(amount, rewardPool);
    }

    /**
     * @notice Rescue SRX tokens stranded in the reward pool when all contributors exit.
     *
     *         The Synthetix accumulator freezes when totalContributions == 0: rewardPerToken()
     *         stops accruing, so any SRX remaining in rewardPool can never be claimed by new
     *         or existing contributors. This function allows governance to recover those tokens
     *         to a specified address (e.g. the treasury) and reset the pool state so a fresh
     *         reward cycle can be started once new contributions are established (A5-M-02 fix).
     *
     *         Can only be called when totalContributions == 0 AND rewardPool > 0.
     *
     * @param recipient  Address to receive the stranded SRX tokens.
     */
    function rescueStrandedPool(address recipient)
        external
        onlyRole(GOVERNANCE_ROLE)
        nonReentrant
    {
        if (recipient == address(0))    revert ZeroAddress();
        if (totalContributions > 0)    revert NoStrandedPool(); // contributions still exist; pool is live
        if (rewardPool == 0)           revert NoStrandedPool(); // nothing to rescue

        uint256 amount = rewardPool;
        rewardPool   = 0;
        rewardRate   = 0; // stop emission — no contributors to receive it
        periodFinish = block.timestamp; // SC-ECON-001: schedule ends now

        srxToken.safeTransfer(recipient, amount);
        emit RewardPoolReset(recipient, amount); // R7-2: dedicated event — distinct from RewardPoolFunded
    }

    /**
     * @notice Set the per-second SRX reward emission rate for contributors.
     *         Set to 0 to pause reward accrual without affecting the reward pool.
     *
     * @param newRate SRX wei per second distributed across all contributors.
     */
    function setRewardRate(uint256 newRate) external onlyRole(GOVERNANCE_ROLE) {
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
     * @notice Update the contributor withdrawal lock duration.
     * @param newDuration Duration in seconds (0 = no lock, but not recommended).
     */
    function setWithdrawLockDuration(uint256 newDuration) external onlyRole(GOVERNANCE_ROLE) {
        emit WithdrawLockDurationSet(withdrawLockDuration, newDuration);
        withdrawLockDuration = newDuration;
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
     *         GOVERNANCE_ROLE path is unrestricted and does not consult this list.
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

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

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
    function getGuardianCapRemaining() external view returns (uint256) {
        if (!stressActive || stressStartSRXBalance == 0) return 0;
        uint256 limit = (stressStartSRXBalance * maxGuardianBps) / BPS_DENOMINATOR;
        uint256 used  = deployerSRXUsed + guardianSRXUsed;
        return used >= limit ? 0 : limit - used;
    }

    // ── UUPS ───────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImpl) internal override onlyRole(UPGRADER_ROLE) {}
}
