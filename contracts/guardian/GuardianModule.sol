// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title GuardianModule
 * @notice Standalone modular security layer for the Syrax SRX token ecosystem.
 *
 * Design principles:
 *  1. Immutable sunset — MAXIMUM_SUNSET is set at construction and can never increase.
 *     Governance may only reduce it. Once expired, guardian powers are permanently gone.
 *  2. Non-upgradeable — an upgradeable guardian could extend its own sunset. This contract
 *     is deployed once and holds PAUSER_ROLE on the Ethereum protocol contracts (not on the
 *     spoke chains, whose pause is held directly; internal audit M4, open).
 *  3. Per-module granularity — guardian pauses a single module at a time (except emergencies).
 *  4. Governance override — governance can force-unpause anything the guardian paused,
 *     at any time. The guardian cannot block that, but it can pause again once its
 *     cooldown has passed, until the sunset. In the deployed topology governance is
 *     the 48 h SRXTimelock, so an override is a Governor proposal with a delay.
 *  5. Cooldown enforcement — pauseModule cannot pause a module again within
 *     PAUSE_COOLDOWN of its last pause, so the guardian cannot cycle it one module at
 *     a time. pauseAll, the emergency stop, ignores per-module cooldowns by design and
 *     has its own (PAUSE_ALL_COOLDOWN); the token's run limit applies to both (M7). Unpausing itself has no delay, so a false alarm can be
 *     lifted at once (corrected 7 Oct 2026: this line used to say "flash-unpausing"
 *     was prevented; lastUnpauseTime is a record, read by nothing on chain).
 *  6. Circuit breaker — off-chain monitor reports bridge volume into a draining bucket
 *     (not a fixed or rolling window); auto-trip if the threshold is reached. A trip
 *     lasts until governance calls resetCircuitBreaker; it never clears itself, and
 *     the guardian cannot re-open a tripped module (G-L1). Reporting ends at sunset.
 *     ⛔ BRIDGE ONLY (Security ruling, 12 Oct 2026). MODULE_BRIDGE targets SRXToken, and
 *     it used to call the token's pause(), so a trip froze EVERY SRX transfer until a
 *     ~10-day governance vote, and CIRCUIT_BREAKER_ROLE is a hot key on a monitoring
 *     server: one stolen key could freeze all SRX, repeatedly. The breaker can now be
 *     configured on MODULE_BRIDGE only, and MODULE_BRIDGE drives the token's
 *     bridge-only stop (setBridgePaused), never pause().
 *  7. Cross-chain signaling — emit structured events that relayers can forward to remote chains.
 *  8. Full audit trail — every guardian action is logged with reason and timestamp.
 *  9. Guardian token pauses are bounded (Security ruling, 12 Oct 2026). A pause of
 *     MODULE_TOKEN by the guardian ends after TOKEN_PAUSE_MAX_DURATION; anyone can then
 *     end it (lapseTokenPause), sunset or not. After a lapse the guardian cannot pause
 *     the token again for TOKEN_REPAUSE_BLOCK, and its token pauses add up to at most
 *     TOKEN_PAUSE_BUDGET. The guardian's whole life is at most MAX_SUNSET_DURATION, so
 *     that budget is also the most in any MAX_SUNSET_DURATION. A longer pause needs
 *     governance (governanceHoldTokenPause, or its own vote).
 *
 * Roles:
 *  DEFAULT_ADMIN_ROLE — the admin Safe at deployment; the SRXTimelock after the launch
 *                       hand-over (scripts/ops/migrate_roles.js, MULTISIG_SPEC.md)
 *  GOVERNANCE_ROLE    — SRXTimelock (all governance overrides, sunset reduction, circuit config)
 *  GUARDIAN_ROLE      — GuardianMultisig (pause with cooldown, unpause, bridge freeze;
 *                       all within the sunset window)
 *  CIRCUIT_BREAKER_ROLE — Off-chain monitor / LZ Compose reporter (records bridge activity)
 */
contract GuardianModule is AccessControl, ReentrancyGuard {

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant GOVERNANCE_ROLE      = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant GUARDIAN_ROLE        = keccak256("GUARDIAN_ROLE");
    bytes32 public constant CIRCUIT_BREAKER_ROLE = keccak256("CIRCUIT_BREAKER_ROLE");

    // ── Module IDs ─────────────────────────────────────────────────────────────

    bytes32 public constant MODULE_TOKEN    = keccak256("TOKEN");
    bytes32 public constant MODULE_BRIDGE   = keccak256("BRIDGE");
    bytes32 public constant MODULE_STAKING  = keccak256("STAKING");
    bytes32 public constant MODULE_FEE      = keccak256("FEE_CONTROLLER");
    bytes32 public constant MODULE_TREASURY = keccak256("TREASURY");
    bytes32 public constant MODULE_SSF      = keccak256("STABILISATION_FUND");

    // ── Cooldowns ──────────────────────────────────────────────────────────────

    uint256 public constant PAUSE_COOLDOWN     = 1 hours;
    uint256 public constant PAUSE_ALL_COOLDOWN = 30 minutes;

    // ── Token pause limits (Security ruling, 12 Oct 2026) ──────────────────────

    uint256 public constant TOKEN_PAUSE_MAX_DURATION = 14 days;
    /// @notice Longest reason a guardian or governance action may log.
    uint256 public constant MAX_REASON_LENGTH = 280;
    uint256 public constant TOKEN_REPAUSE_BLOCK      = 7 days;
    uint256 public constant TOKEN_PAUSE_BUDGET       = 30 days;

    /// @notice When the guardian's current token pause started (0 when none is running).
    uint256 public tokenPauseStartedAt;
    /// @notice When the guardian's current token pause ends; anyone may lift it from then.
    uint256 public tokenPauseEndsAt;
    /// @notice Guardian token-pause time used so far, against TOKEN_PAUSE_BUDGET.
    uint256 public tokenPauseUsed;
    /// @notice The guardian may not pause the token again before this (set by a lapse).
    uint256 public tokenRepauseAt;
    /// @notice Guardian token-pause time in the current run: pauses separated by less than
    ///         TOKEN_REPAUSE_BLOCK count as one, against TOKEN_PAUSE_MAX_DURATION
    ///         (internal audit M7, 16 Oct 2026).
    uint256 public tokenRunUsed;
    /// @notice When the last guardian token pause ended (0 before the first).
    uint256 public tokenPauseLastEnd;
    /// @notice True for a module whose current pause only governance may lift: a token pause
    ///         governance holds, or a pause made outside this module that a batch adopted
    ///         (internal audit M12, 16 Oct 2026).
    mapping(bytes32 => bool) public governanceOnlyUnpause;

    // ── Sunset ─────────────────────────────────────────────────────────────────

    /// @notice The longest guardian life the constructor accepts. ⛔ It was only the deploy
    ///         script's default (GUARDIAN_SUNSET_DAYS), so a deployment could set any
    ///         sunset (Security, 12 Oct 2026).
    uint256 public constant MAX_SUNSET_DURATION = 180 days;

    uint256 public immutable MAXIMUM_SUNSET;  // Cryptographic ceiling — never increases
    uint256 public effectiveSunset;           // Governance may only reduce this

    // ── Structs ────────────────────────────────────────────────────────────────

    struct ModuleConfig {
        address target;       // Protocol contract implementing pause/unpause
        bool    registered;
        bool    paused;
        uint256 lastPauseTime;
        uint256 lastUnpauseTime;
        uint256 pauseCount;
    }

    /// @dev Volume is a draining bucket: reports add to volumeInFlight, which drains
    ///      linearly at volumeThreshold per windowDuration, and the breaker trips when it
    ///      reaches the threshold. ⛔ It was a fixed window that reset at once, so 90% of
    ///      the threshold just before a reset and 90% just after never tripped (internal
    ///      review, 7 Oct 2026).
    struct CircuitBreaker {
        uint256 volumeThreshold; // Tokens (18-decimal) in flight that trip the breaker
        uint256 windowDuration;  // Seconds for a full threshold to drain
        uint256 updatedAt;       // When volumeInFlight was last updated
        uint256 volumeInFlight;  // Reported volume not yet drained, as of updatedAt
        uint256 tripCount;       // Historical trips (audit)
        bool    tripped;         // Tripped until governance resets it
    }

    // ── State ──────────────────────────────────────────────────────────────────

    mapping(bytes32 => ModuleConfig)   public modules;
    mapping(bytes32 => CircuitBreaker) public circuitBreakers;

    // Cross-chain pause intent: dstEid => moduleId => signaled
    mapping(uint32 => mapping(bytes32 => bool)) public crossChainPauseIntent;

    uint256 public lastPauseAllTime;

    // ── Events ─────────────────────────────────────────────────────────────────

    event ModuleRegistered(bytes32 indexed moduleId, address target);
    event ModuleTargetUpdated(bytes32 indexed moduleId, address oldTarget, address newTarget);

    event GuardianAction(
        bytes32 indexed moduleId,
        address indexed actor,
        ActionType       action,
        string           reason,
        uint256          timestamp
    );

    event GovernanceOverride(
        bytes32 indexed moduleId,
        address indexed actor,
        string           reason,
        uint256          timestamp
    );

    event CircuitBreakerConfigured(
        bytes32 indexed moduleId,
        uint256 volumeThreshold,
        uint256 windowDuration
    );

    event CircuitBreakerTripped(
        bytes32 indexed moduleId,
        uint256 volumeInWindow,
        uint256 threshold,
        uint256 timestamp
    );

    event CircuitBreakerReset(bytes32 indexed moduleId, address indexed by);

    event CrossChainPauseSignal(
        uint32  indexed dstEid,
        bytes32 indexed moduleId,
        bool            paused,
        address         guardian,
        uint256         timestamp
    );

    event SunsetReached(uint256 timestamp);
    event SunsetReduced(uint256 oldSunset, uint256 newSunset, address by);

    /// @notice A batch pause/unpause skipped a module because the call reverted (R7-02) —
    ///         typically because it was already in the requested state on-target. Emitted
    ///         so a skipped module is never silently swallowed by the batch.
    /// @param pausing True if the skipped call was pause(), false if unpause().
    event ModuleCallSkipped(bytes32 indexed moduleId, address target, bool pausing);

    /// @notice Local paused-state was corrected to match the target contract's own view,
    ///         after a direct pause/unpause by another PAUSER_ROLE holder desynced it.
    event ModuleStateReconciled(bytes32 indexed moduleId, bool paused);

    /// @notice A guardian token pause started; it ends at `endsAt` at the latest.
    event TokenPauseStarted(uint256 endsAt, uint256 usedBefore);
    /// @notice A guardian token pause ended, adding `duration` to tokenPauseUsed.
    ///         `fullTerm` is true when it ran its full term (which starts the repause block).
    event TokenPauseEnded(uint256 duration, uint256 usedAfter, bool fullTerm);
    /// @notice Governance took over the guardian's token pause; it no longer lapses.
    event TokenPauseHeldByGovernance(address indexed by, string reason);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error GuardianExpired(uint256 expiredAt, uint256 currentTime);
    error ModuleNotRegistered(bytes32 moduleId);
    error ModuleAlreadyRegistered(bytes32 moduleId);
    error ModuleAlreadyPaused(bytes32 moduleId);
    error ModuleNotPaused(bytes32 moduleId);
    error CooldownActive(bytes32 moduleId, uint256 availableAt);
    error PauseAllCooldownActive(uint256 availableAt);
    error CannotExtendSunset(uint256 current, uint256 attempted);
    error NewSunsetMustBeFuture();
    error CircuitBreakerAlreadyTripped(bytes32 moduleId);
    error CircuitBreakerNotTripped(bytes32 moduleId);
    error InvalidThreshold();
    error ZeroAddress();
    error EmptyReason();
    error CallFailed(bytes32 moduleId, bytes returnData);
    error SunsetTooLong(uint256 duration, uint256 maximum);
    error CircuitBreakerBridgeOnly(bytes32 moduleId);
    error TokenRepauseBlocked(uint256 availableAt);
    error TokenPauseBudgetSpent(uint256 used, uint256 budget);
    error TokenPauseNotLapsed(uint256 endsAt);
    /// @notice Only governance may lift this pause (internal audit M12).
    error GovernanceOnlyUnpause(bytes32 moduleId);
    /// @notice A reason longer than MAX_REASON_LENGTH bytes was refused.
    error ReasonTooLong(uint256 maxLength);
    /// @notice The guardian has not reached its sunset yet.
    error GuardianNotExpired(uint256 sunset);

    // ── Action enum ────────────────────────────────────────────────────────────

    enum ActionType {
        Pause,
        Unpause,
        PauseAll,
        CircuitBreakerTrip,
        CrossChainSignal,
        BridgeInboundFreeze // appended (disclosure A): earlier values keep their numbers
    }

    // ── Constructor ────────────────────────────────────────────────────────────

    /**
     * @param _admin            Gnosis Safe — holds DEFAULT_ADMIN_ROLE initially (the
     *                          launch hand-over moves it to the SRXTimelock)
     * @param _guardian         Guardian multisig — holds GUARDIAN_ROLE
     * @param _governance       SRXTimelock — holds GOVERNANCE_ROLE
     * @param _sunsetDuration   Seconds from deployment until guardian authority expires
     *                          (e.g. 15_552_000 = 6 months, 31_536_000 = 12 months)
     */
    constructor(
        address _admin,
        address _guardian,
        address _governance,
        uint256 _sunsetDuration
    ) {
        if (_admin == address(0) || _guardian == address(0) || _governance == address(0))
            revert ZeroAddress();
        if (_sunsetDuration > MAX_SUNSET_DURATION) revert SunsetTooLong(_sunsetDuration, MAX_SUNSET_DURATION);

        uint256 sunset = block.timestamp + _sunsetDuration;
        MAXIMUM_SUNSET  = sunset;
        effectiveSunset = sunset;

        _grantRole(DEFAULT_ADMIN_ROLE,   _admin);
        _grantRole(GOVERNANCE_ROLE,      _governance);
        _grantRole(GUARDIAN_ROLE,        _guardian);
    }

    // ── Modifiers ──────────────────────────────────────────────────────────────

    modifier notExpired() {
        // Note: events emitted before a revert are NOT included in the transaction
        // receipt — the emit is a no-op on reverted calls. SunsetReached is therefore
        // not emitted here. Use isExpired() view or listen for GuardianExpired revert
        // to detect expiry off-chain (A2-L-04 fix).
        if (block.timestamp >= effectiveSunset) {
            revert GuardianExpired(effectiveSunset, block.timestamp);
        }
        _;
    }

    modifier moduleExists(bytes32 moduleId) {
        if (!modules[moduleId].registered) revert ModuleNotRegistered(moduleId);
        _;
    }

    modifier validReason(string calldata reason) {
        if (bytes(reason).length == 0) revert EmptyReason();
        // Branch tests, 22 Oct (Info): no upper bound; a 5,000-byte reason was accepted.
        if (bytes(reason).length > MAX_REASON_LENGTH) revert ReasonTooLong(MAX_REASON_LENGTH);
        _;
    }

    // ── Module registration (governance only) ─────────────────────────────────

    /**
     * @notice Register a protocol contract so the guardian can pause it.
     *         The GuardianModule must already hold PAUSER_ROLE on the target contract.
     */
    function registerModule(bytes32 moduleId, address target)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        if (target == address(0))         revert ZeroAddress();
        if (modules[moduleId].registered) revert ModuleAlreadyRegistered(moduleId);

        modules[moduleId] = ModuleConfig({
            target:         target,
            registered:     true,
            paused:         false,
            lastPauseTime:  0,
            lastUnpauseTime: 0,
            pauseCount:     0
        });

        emit ModuleRegistered(moduleId, target);
    }

    /**
     * @notice Update the target address for a module. No SRX contract is upgradeable (REG-53),
     *         so this is needed only when a module is replaced by a successor contract.
     */
    function updateModuleTarget(bytes32 moduleId, address newTarget)
        external
        onlyRole(GOVERNANCE_ROLE)
        moduleExists(moduleId)
    {
        if (newTarget == address(0)) revert ZeroAddress();
        address old = modules[moduleId].target;
        modules[moduleId].target = newTarget;
        // Sweep 22 Oct (Info): the pause flags described the OLD target. Start from the new
        // target's own state: a pause it already carries is governance's (as any adopted
        // pause), and a guardian token term on the old target ends.
        modules[moduleId].paused        = false;
        governanceOnlyUnpause[moduleId] = false;
        if (moduleId == MODULE_TOKEN) _endTokenPause();
        _reconcilePausedState(moduleId, newTarget);
        emit ModuleTargetUpdated(moduleId, old, newTarget);
    }

    // ── Guardian actions ───────────────────────────────────────────────────────

    /**
     * @notice Pause a single protocol module. Guardian only, within sunset window.
     * @param moduleId  One of MODULE_TOKEN, MODULE_BRIDGE, etc.
     * @param reason    Short description logged on-chain for audit transparency.
     */
    function pauseModule(bytes32 moduleId, string calldata reason)
        external
        onlyRole(GUARDIAN_ROLE)
        notExpired
        moduleExists(moduleId)
        validReason(reason)
        nonReentrant
    {
        ModuleConfig storage m = modules[moduleId];

        // The target's own state decides (SWEEP-02 and the branch tests, 22 Oct 2026). A target
        // already paused, by anyone, is not the guardian's to take over; a target reopened
        // directly while this module still believed it paused is stale and may be stopped.
        if (_actualPaused(moduleId, m.target)) revert ModuleAlreadyPaused(moduleId);
        if (m.paused) _forgetStale(moduleId);

        uint256 availableAt = m.lastPauseTime + PAUSE_COOLDOWN;
        if (block.timestamp < availableAt) revert CooldownActive(moduleId, availableAt);

        if (moduleId == MODULE_TOKEN) _startTokenPause();

        m.paused        = true;
        m.lastPauseTime = block.timestamp;
        m.pauseCount   += 1;

        _callPause(moduleId, m.target);

        emit GuardianAction(moduleId, msg.sender, ActionType.Pause, reason, block.timestamp);
    }

    /**
     * @notice Unpause a single protocol module. Guardian only, within sunset window.
     */
    function unpauseModule(bytes32 moduleId, string calldata reason)
        external
        onlyRole(GUARDIAN_ROLE)
        notExpired
        moduleExists(moduleId)
        validReason(reason)
        nonReentrant
    {
        ModuleConfig storage m = modules[moduleId];

        if (!m.paused) revert ModuleNotPaused(moduleId);
        // Reopened directly already: correct the record instead of failing (branch tests,
        // 22 Oct: the strict unpause reverted and the flag could not be cleared).
        if (!_actualPaused(moduleId, m.target)) {
            _forgetStale(moduleId);
            return;
        }
        // ⛔ G-L1: a breaker that tripped is governance's to reset. The guardian
        //    could reopen the module while cb.tripped stayed true, which also made
        //    every further recordBridgeActivity revert for the rest of the window:
        //    the module was live again and its monitoring was blind.
        if (circuitBreakers[moduleId].tripped) revert CircuitBreakerAlreadyTripped(moduleId);
        // ⛔ Internal audit M12 (CONTROL-06, CLAIMS-01; 16 Oct 2026): the guardian could lift
        //    a token pause governance had voted to hold, and a pause governance made itself
        //    once a pauseAll had adopted it. The override was ineffective against the very
        //    key it exists to override. Like a tripped breaker, those are governance's to lift.
        if (governanceOnlyUnpause[moduleId]) revert GovernanceOnlyUnpause(moduleId);

        m.paused          = false;
        m.lastUnpauseTime = block.timestamp;
        if (moduleId == MODULE_TOKEN) _endTokenPause();

        _callUnpause(moduleId, m.target);

        emit GuardianAction(moduleId, msg.sender, ActionType.Unpause, reason, block.timestamp);
    }

    /**
     * @notice Emergency: pause ALL registered modules in one call.
     *         Subject to pauseAll cooldown (30 min) and per-module cooldowns are bypassed
     *         in a genuine emergency — this is intentional.
     */
    // slither-disable-next-line reentrancy-no-eth -- reviewed 8 Oct 2026: calls only governance-registered SRX module targets; nonReentrant; the state written after each call is that module's own paused flag and counters
    function pauseAll(string calldata reason)
        external
        onlyRole(GUARDIAN_ROLE)
        notExpired
        validReason(reason)
        nonReentrant
    {
        uint256 availableAt = lastPauseAllTime + PAUSE_ALL_COOLDOWN;
        if (block.timestamp < availableAt) revert PauseAllCooldownActive(availableAt);

        lastPauseAllTime = block.timestamp;

        bytes32[6] memory ids = [
            MODULE_TOKEN,
            MODULE_BRIDGE,
            MODULE_STAKING,
            MODULE_FEE,
            MODULE_TREASURY,
            MODULE_SSF
        ];

        for (uint256 i = 0; i < ids.length; i++) {
            bytes32 id = ids[i];
            if (!modules[id].registered) continue;
            // Read the target first. Already paused: leave it, and if this module did not
            // pause it, it is governance's (SWEEP-02). Reopened directly while this module
            // still believed it paused: the flag is stale, so stop it now (branch tests,
            // 22 Oct: the emergency stop used to skip it silently).
            if (_actualPaused(id, modules[id].target)) {
                if (!modules[id].paused) {
                    modules[id].paused = true;
                    governanceOnlyUnpause[id] = true;
                    emit ModuleStateReconciled(id, true);
                }
                continue;
            }
            if (modules[id].paused) _forgetStale(id);
            // The token-pause limits hold here too. A token pause the limits refuse is
            // skipped, visibly, rather than failing the whole emergency stop (R7-02).
            if (id == MODULE_TOKEN && !_tokenPauseAvailable()) {
                emit ModuleCallSkipped(id, modules[id].target, true);
                continue;
            }

            // R7-02: best-effort. One module failing (e.g. already paused directly by the
            // admin Safe) must not revert the whole emergency stop. State is only marked
            // paused on an actual successful transition; failures reconcile from-target.
            if (_tryPause(id, modules[id].target)) {
                modules[id].paused        = true;
                modules[id].lastPauseTime = block.timestamp;
                modules[id].pauseCount   += 1;
                if (id == MODULE_TOKEN) _startTokenPause();
            }
        }

        emit GuardianAction(bytes32(0), msg.sender, ActionType.PauseAll, reason, block.timestamp);
    }

    /**
     * @notice Signal intent to pause a module on a remote chain.
     *         Emits a structured event that off-chain relayers observe and replicate.
     *         Does NOT transmit a LayerZero message directly — avoids tight coupling.
     */
    function signalCrossChainPause(
        uint32  dstEid,
        bytes32 moduleId,
        bool    pause_,
        string calldata reason
    )
        external
        onlyRole(GUARDIAN_ROLE)
        notExpired
        validReason(reason)
    {
        crossChainPauseIntent[dstEid][moduleId] = pause_;

        emit CrossChainPauseSignal(dstEid, moduleId, pause_, msg.sender, block.timestamp);
        emit GuardianAction(moduleId, msg.sender, ActionType.CrossChainSignal, reason, block.timestamp);
    }

    /**
     * @notice Freeze bridge returns from one remote chain on the token (external
     *         disclosure A, 7 Oct 2026), without pausing the whole token. This module
     *         holds the token's PAUSER_ROLE after the launch hand-over, so without
     *         this the token's freezeInbound() would be unreachable. Only governance
     *         lifts a freeze (SRXToken.unfreezeInbound).
     */
    function freezeBridgeInbound(uint32 eid, string calldata reason)
        external
        onlyRole(GUARDIAN_ROLE)
        notExpired
        moduleExists(MODULE_TOKEN)
        validReason(reason)
        nonReentrant
    {
        _callFreezeInbound(eid);
        emit GuardianAction(MODULE_TOKEN, msg.sender, ActionType.BridgeInboundFreeze, reason, block.timestamp);
    }

    // ── Governance overrides ───────────────────────────────────────────────────

    /**
     * @notice Force-unpause a single module, bypassing guardian cooldowns and sunset.
     *         Governance can always restore operations — guardian cannot block this,
     *         though it may pause again after its cooldown. Governance is the 48 h
     *         SRXTimelock in the deployed topology, so this runs after a Governor
     *         proposal and the delay, not at once.
     */
    function governanceUnpause(bytes32 moduleId, string calldata reason)
        external
        onlyRole(GOVERNANCE_ROLE)
        moduleExists(moduleId)
        validReason(reason)
        nonReentrant
    {
        ModuleConfig storage m = modules[moduleId];

        if (!m.paused) revert ModuleNotPaused(moduleId);
        _clearTrip(moduleId);
        if (!_actualPaused(moduleId, m.target)) {
            _forgetStale(moduleId);
            emit GovernanceOverride(moduleId, msg.sender, reason, block.timestamp);
            return;
        }

        m.paused          = false;
        m.lastUnpauseTime = block.timestamp;
        governanceOnlyUnpause[moduleId] = false;
        if (moduleId == MODULE_TOKEN) _endTokenPause();

        _callUnpause(moduleId, m.target);

        emit GovernanceOverride(moduleId, msg.sender, reason, block.timestamp);
    }

    /**
     * @notice Emergency: governance force-unpauses ALL modules, bypassing all guardian state.
     */
    // slither-disable-next-line reentrancy-no-eth -- reviewed 8 Oct 2026: GOVERNANCE_ROLE (Timelock) only; calls only registered SRX module targets; nonReentrant
    function emergencyUnpauseAll(string calldata reason)
        external
        onlyRole(GOVERNANCE_ROLE)
        validReason(reason)
        nonReentrant
    {
        bytes32[6] memory ids = [
            MODULE_TOKEN,
            MODULE_BRIDGE,
            MODULE_STAKING,
            MODULE_FEE,
            MODULE_TREASURY,
            MODULE_SSF
        ];

        for (uint256 i = 0; i < ids.length; i++) {
            bytes32 id = ids[i];
            if (!modules[id].registered || !modules[id].paused) continue;

            // R7-02: best-effort — governance's emergency recovery must never be blocked
            // by a single module that was already unpaused directly on-target.
            if (_tryUnpause(id, modules[id].target)) {
                modules[id].paused          = false;
                modules[id].lastUnpauseTime = block.timestamp;
                governanceOnlyUnpause[id]   = false;
                _clearTrip(id);
            }
            if (id == MODULE_TOKEN && !modules[id].paused) _endTokenPause();
        }

        emit GovernanceOverride(bytes32(0), msg.sender, reason, block.timestamp);
    }

    /**
     * @notice End a guardian token pause that has run its full term. Anyone may call it,
     *         at any time after tokenPauseEndsAt, before or after the sunset: a holder
     *         never depends on the guardian or a vote to end a pause that has lapsed.
     *         The guardian then cannot pause the token for TOKEN_REPAUSE_BLOCK.
     */
    // slither-disable-next-line reentrancy-no-eth -- reviewed 12 Oct 2026: the only external call is the governance-registered SRXToken's unpause(); the pause accounting it depends on is written first; nonReentrant
    function lapseTokenPause() external nonReentrant {
        uint256 endsAt = tokenPauseEndsAt;
        if (endsAt == 0 || block.timestamp < endsAt) revert TokenPauseNotLapsed(endsAt);

        _endTokenPause(); // ran its full term, so this also starts the repause block

        ModuleConfig storage m = modules[MODULE_TOKEN];
        m.lastUnpauseTime = block.timestamp;
        // Tolerant: if the token was already unpaused on-target, reconcile rather than
        // leave the lapse unable to complete.
        if (_tryUnpause(MODULE_TOKEN, m.target)) m.paused = false;
    }

    /**
     * @notice After the guardian's sunset, anyone may lift a pause the guardian left in place.
     * @dev ⛔ Internal audit L15 (CONTROL-09, CLAIMS-07; 16 Oct 2026): a guardian pause still
     *      standing at the sunset could then be lifted only by a vote, so "all contracts
     *      function normally after the sunset" was false, and a staking or fund pause left
     *      there let anyone wind the product down for good after 30 days. A pause that is
     *      governance's (a hold, an adopted outside pause, a tripped breaker) stays governance's.
     */
    // slither-disable-next-line reentrancy-no-eth -- reviewed 16 Oct 2026: calls only the governance-registered module target's unpause(); the module state it depends on is written first; nonReentrant
    function releaseAfterSunset(bytes32 moduleId) external nonReentrant moduleExists(moduleId) {
        if (block.timestamp < effectiveSunset) revert GuardianNotExpired(effectiveSunset);
        ModuleConfig storage m = modules[moduleId];
        if (!m.paused) revert ModuleNotPaused(moduleId);
        if (governanceOnlyUnpause[moduleId] || circuitBreakers[moduleId].tripped) revert GovernanceOnlyUnpause(moduleId);
        m.paused          = false;
        m.lastUnpauseTime = block.timestamp;
        if (moduleId == MODULE_TOKEN) _endTokenPause();
        _callUnpause(moduleId, m.target);
        emit GuardianAction(moduleId, msg.sender, ActionType.Unpause, "released after sunset", block.timestamp);
    }

    /**
     * @notice Governance takes over the guardian's running token pause, so it no longer
     *         lapses. It then lasts until governanceUnpause. This is the only way a
     *         guardian token pause outlasts TOKEN_PAUSE_MAX_DURATION, and it is a vote
     *         with the Timelock's delay.
     */
    function governanceHoldTokenPause(string calldata reason)
        external
        onlyRole(GOVERNANCE_ROLE)
        validReason(reason)
    {
        if (tokenPauseEndsAt == 0) revert ModuleNotPaused(MODULE_TOKEN);
        _endTokenPause();
        governanceOnlyUnpause[MODULE_TOKEN] = true; // M12: the guardian cannot lift it now
        emit TokenPauseHeldByGovernance(msg.sender, reason);
    }

    /**
     * @notice Reduce the effective guardian sunset. Governance-only. Irreversible.
     *         Cannot increase beyond MAXIMUM_SUNSET — that value is immutable.
     * @param newSunset Unix timestamp. Must be < effectiveSunset and > block.timestamp.
     */
    function reduceSunset(uint256 newSunset)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        if (newSunset >= effectiveSunset) revert CannotExtendSunset(effectiveSunset, newSunset);
        if (newSunset <= block.timestamp) revert NewSunsetMustBeFuture();

        uint256 old = effectiveSunset;
        effectiveSunset = newSunset;

        emit SunsetReduced(old, newSunset, msg.sender);
    }

    // ── Circuit breaker ────────────────────────────────────────────────────────

    /**
     * @notice Configure the circuit breaker for a module (typically MODULE_BRIDGE).
     * @param volumeThreshold Tokens (18-decimal) in flight that trip the breaker.
     * @param windowDuration  Seconds for a full threshold to drain (e.g. 3600 = 1 hour).
     *                        A draining bucket: reports add to it, it empties linearly
     *                        at volumeThreshold per windowDuration. Not a fixed or
     *                        rolling window.
     */
    function configureCircuitBreaker(
        bytes32 moduleId,
        uint256 volumeThreshold,
        uint256 windowDuration
    )
        external
        onlyRole(GOVERNANCE_ROLE)
        moduleExists(moduleId)
    {
        if (moduleId != MODULE_BRIDGE) revert CircuitBreakerBridgeOnly(moduleId);
        // Internal audit (16 Oct 2026), the sibling of TB-02 and MONEY-06: a threshold
        // above 2^128 would overflow the drain in recordBridgeActivity, so reports would
        // revert and the breaker could never trip.
        if (volumeThreshold == 0 || windowDuration == 0 || volumeThreshold > type(uint128).max) {
            revert InvalidThreshold();
        }

        // Sweep 22 Oct (Info): reconfiguring clears a trip; say so, as resetCircuitBreaker does.
        if (circuitBreakers[moduleId].tripped) emit CircuitBreakerReset(moduleId, msg.sender);
        circuitBreakers[moduleId] = CircuitBreaker({
            volumeThreshold: volumeThreshold,
            windowDuration:  windowDuration,
            updatedAt:       block.timestamp,
            volumeInFlight:  0,
            tripCount:       circuitBreakers[moduleId].tripCount, // preserve history
            tripped:         false
        });

        emit CircuitBreakerConfigured(moduleId, volumeThreshold, windowDuration);
    }

    /**
     * @notice Record bridge volume. Called by an off-chain monitor or LZ Compose reporter.
     *         If the volume in flight reaches the threshold, the circuit breaker trips
     *         automatically: the module is paused via the guardian mechanism. A trip lasts
     *         until governance resets it, and reporting ends at the guardian's sunset.
     * @param moduleId Target module (typically MODULE_BRIDGE).
     * @param amount   Volume transferred (18-decimal).
     */
    function recordBridgeActivity(bytes32 moduleId, uint256 amount)
        external
        onlyRole(CIRCUIT_BREAKER_ROLE)
        notExpired
        moduleExists(moduleId)
        nonReentrant
    {
        // Belt and braces: configureCircuitBreaker accepts MODULE_BRIDGE only, so no other
        // module can have a threshold; refuse loudly rather than rely on that alone.
        if (moduleId != MODULE_BRIDGE) revert CircuitBreakerBridgeOnly(moduleId);
        CircuitBreaker storage cb = circuitBreakers[moduleId];
        if (cb.volumeThreshold == 0) return; // Not configured — ignore

        // ⛔ G-L1 BYPASS (internal review, 7 Oct 2026): this used to clear `tripped` when
        //    the window rolled, while the module stayed paused. unpauseModule() checks only
        //    `tripped`, so after one routine report in the next window the GUARDIAN could
        //    reopen a module that only governance may reopen. A trip now lasts until
        //    resetCircuitBreaker() (governance); reports are refused meanwhile.
        if (cb.tripped) revert CircuitBreakerAlreadyTripped(moduleId);

        uint256 volume = _drainedVolume(cb) + amount;
        cb.volumeInFlight = volume;
        cb.updatedAt      = block.timestamp;

        if (volume >= cb.volumeThreshold) {
            cb.tripped    = true;
            cb.tripCount += 1;

            ModuleConfig storage m = modules[moduleId];
            if (!m.paused) {
                m.paused        = true;
                m.lastPauseTime = block.timestamp;
                m.pauseCount   += 1;
            }
            // SWEEP-02: always stop the bridge on a trip. The module's flag can be stale (the
            // bridge reopened directly by another pauser), and the stop is idempotent.
            _callPause(moduleId, m.target);

            emit CircuitBreakerTripped(
                moduleId,
                cb.volumeInFlight,
                cb.volumeThreshold,
                block.timestamp
            );
            emit GuardianAction(
                moduleId,
                msg.sender,
                ActionType.CircuitBreakerTrip,
                "circuit_breaker_threshold_exceeded",
                block.timestamp
            );
        }
    }

    /**
     * @notice Reset a tripped circuit breaker. Governance only.
     *         Does NOT automatically unpause — call governanceUnpause separately.
     */
    function resetCircuitBreaker(bytes32 moduleId)
        external
        onlyRole(GOVERNANCE_ROLE)
        moduleExists(moduleId)
    {
        if (!circuitBreakers[moduleId].tripped) revert CircuitBreakerNotTripped(moduleId);
        _clearTrip(moduleId);
    }

    /// @dev Sweep 22 Oct (Info): governance reopening a tripped module without a reset left
    ///      the breaker latched, so every later report reverted and the breaker was blind
    ///      until someone remembered the reset. Reopening by governance now resets it too.
    function _clearTrip(bytes32 moduleId) internal {
        CircuitBreaker storage cb = circuitBreakers[moduleId];
        if (!cb.tripped) return;
        cb.tripped        = false;
        cb.volumeInFlight = 0;
        cb.updatedAt      = block.timestamp;
        emit CircuitBreakerReset(moduleId, msg.sender);
    }

    // ── View ───────────────────────────────────────────────────────────────────

    function isExpired() external view returns (bool) {
        return block.timestamp >= effectiveSunset;
    }

    function secondsUntilSunset() external view returns (uint256) {
        if (block.timestamp >= effectiveSunset) return 0;
        return effectiveSunset - block.timestamp;
    }

    /// @notice Whether the guardian could start a token pause now, and for how long.
    function tokenPauseAvailable() external view returns (bool available, uint256 maxDuration) {
        available = _tokenPauseAvailable();
        if (available) {
            uint256 left = TOKEN_PAUSE_BUDGET - tokenPauseUsed;
            uint256 runLeft = _tokenRunLeft();
            maxDuration = left < runLeft ? left : runLeft;
        }
    }

    function isModulePaused(bytes32 moduleId) external view returns (bool) {
        return modules[moduleId].paused;
    }

    function getCircuitBreakerStatus(bytes32 moduleId)
        external
        view
        returns (
            bool   tripped,
            uint256 volumeInFlight,
            uint256 volumeThreshold,
            uint256 windowDuration,
            uint256 tripCount
        )
    {
        CircuitBreaker storage cb = circuitBreakers[moduleId];
        return (
            cb.tripped,
            cb.volumeThreshold == 0 ? 0 : _drainedVolume(cb),
            cb.volumeThreshold,
            cb.windowDuration,
            cb.tripCount
        );
    }

    /// @dev Reported volume after draining at volumeThreshold per windowDuration.
    function _drainedVolume(CircuitBreaker storage cb) internal view returns (uint256) {
        uint256 drained = ((block.timestamp - cb.updatedAt) * cb.volumeThreshold) / cb.windowDuration;
        return cb.volumeInFlight > drained ? cb.volumeInFlight - drained : 0;
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    function _tokenPauseAvailable() internal view returns (bool) {
        return block.timestamp >= tokenRepauseAt && tokenPauseUsed < TOKEN_PAUSE_BUDGET
            && _tokenRunLeft() > 0;
    }

    /// @dev What is left of TOKEN_PAUSE_MAX_DURATION in the current run. A break of at least
    ///      TOKEN_REPAUSE_BLOCK since the last guardian token pause ended starts a new run.
    // slither-disable-next-line incorrect-equality -- reviewed 16 Oct 2026: tokenPauseLastEnd == 0 is the "no guardian token pause has ended yet" sentinel, never a time comparison
    function _tokenRunLeft() internal view returns (uint256) {
        if (tokenPauseLastEnd == 0 || block.timestamp >= tokenPauseLastEnd + TOKEN_REPAUSE_BLOCK) {
            return TOKEN_PAUSE_MAX_DURATION;
        }
        return tokenRunUsed < TOKEN_PAUSE_MAX_DURATION ? TOKEN_PAUSE_MAX_DURATION - tokenRunUsed : 0;
    }

    /// @dev Start the clock on a guardian token pause, within the repause block and budget.
    // slither-disable-next-line incorrect-equality -- reviewed 16 Oct 2026: runLeft is our own bounded arithmetic (0 = run used up, the maximum = a new run); only the guardian reaches this, and an exact match can only shorten its pause, never lengthen it
    function _startTokenPause() internal {
        if (block.timestamp < tokenRepauseAt) revert TokenRepauseBlocked(tokenRepauseAt);
        uint256 used = tokenPauseUsed;
        if (used >= TOKEN_PAUSE_BUDGET) revert TokenPauseBudgetSpent(used, TOKEN_PAUSE_BUDGET);
        // ⛔ Internal audit M7 (CONTROL-01, CLAIMS-02; 16 Oct 2026): every pause got a fresh
        //    14-day term, so unpausing 1 s before the term ended and pausing again kept the
        //    token frozen for the whole 30-day budget without a break, and the repause block
        //    (set only by a FULL term) never started. Pauses separated by less than
        //    TOKEN_REPAUSE_BLOCK are now one run, and a run lasts at most 14 days.
        uint256 runLeft = _tokenRunLeft();
        if (runLeft == 0) revert TokenRepauseBlocked(tokenPauseLastEnd + TOKEN_REPAUSE_BLOCK);
        if (runLeft == TOKEN_PAUSE_MAX_DURATION) tokenRunUsed = 0; // a new run
        uint256 left = TOKEN_PAUSE_BUDGET - used;
        uint256 term = left < runLeft ? left : runLeft;
        tokenPauseStartedAt = block.timestamp;
        tokenPauseEndsAt    = block.timestamp + term;
        emit TokenPauseStarted(block.timestamp + term, used);
    }

    /// @dev Stop the clock on the running guardian token pause, if any, charging the
    ///      time it ran (never more than its term) to the budget. A pause that ran its full
    ///      term starts the repause block however it ends, so the guardian cannot dodge the
    ///      block by unpausing at the end of the term and pausing again after its cooldown.
    // slither-disable-next-line incorrect-equality -- reviewed 12 Oct 2026: endsAt == 0 is the "no guardian token pause running" sentinel, never a time comparison; a caller cannot make block.timestamp equal 0
    function _endTokenPause() internal {
        uint256 endsAt = tokenPauseEndsAt;
        if (endsAt == 0) return;
        bool fullTerm = block.timestamp >= endsAt;
        if (fullTerm) tokenRepauseAt = block.timestamp + TOKEN_REPAUSE_BLOCK;
        uint256 until = block.timestamp < endsAt ? block.timestamp : endsAt;
        uint256 ran = until - tokenPauseStartedAt;
        tokenPauseUsed     += ran;
        tokenRunUsed       += ran;
        tokenPauseLastEnd   = block.timestamp;
        tokenPauseStartedAt = 0;
        tokenPauseEndsAt    = 0;
        emit TokenPauseEnded(ran, tokenPauseUsed, fullTerm);
    }

    /// @dev MODULE_BRIDGE drives the token's bridge-only stop, never its pause() (Security
    ///      ruling, 12 Oct 2026); every other module uses pause()/unpause()/paused().
    function _pauseCall(bytes32 moduleId) internal pure returns (bytes memory) {
        return moduleId == MODULE_BRIDGE
            ? abi.encodeWithSignature("setBridgePaused(bool)", true)
            : abi.encodeWithSignature("pause()");
    }

    function _unpauseCall(bytes32 moduleId) internal pure returns (bytes memory) {
        return moduleId == MODULE_BRIDGE
            ? abi.encodeWithSignature("setBridgePaused(bool)", false)
            : abi.encodeWithSignature("unpause()");
    }

    function _pausedSig(bytes32 moduleId) internal pure returns (string memory) {
        return moduleId == MODULE_BRIDGE ? "bridgePaused()" : "paused()";
    }

    function _callPause(bytes32 moduleId, address target) internal {
        (bool ok, bytes memory ret) = target.call(_pauseCall(moduleId));
        if (!ok) revert CallFailed(moduleId, ret);
    }

    function _callFreezeInbound(uint32 eid) internal {
        (bool ok, bytes memory ret) = modules[MODULE_TOKEN].target.call(abi.encodeWithSignature("freezeInbound(uint32)", eid));
        if (!ok) revert CallFailed(MODULE_TOKEN, ret);
    }

    function _callUnpause(bytes32 moduleId, address target) internal {
        (bool ok, bytes memory ret) = target.call(_unpauseCall(moduleId));
        if (!ok) revert CallFailed(moduleId, ret);
    }

    // ── Best-effort variants for BATCH operations (R7-02) ──────────────────────
    //
    // Every protocol contract grants PAUSER_ROLE to the admin/Safe as well as to this
    // module, so there are two independent pause authorities. This module's
    // `modules[id].paused` flag only tracks calls made THROUGH this module, so a direct
    // pause() by the admin desynchronises it from on-chain reality.
    //
    // With the strict `_call*` helpers above, that desync was fatal to the batch: a
    // module already paused on-target reverts EnforcedPause, which reverted the ENTIRE
    // pauseAll() — disabling the emergency stop for every other module, at exactly the
    // moment it is needed. The batch paths therefore use these tolerant variants: a
    // single module can fail without taking the emergency response down with it.
    //
    // Single-module calls (pauseModule / unpauseModule / governanceUnpause) keep the
    // strict helpers — there the caller asked for one specific thing and should be told
    // loudly if it did not happen.

    /// @dev Attempts pause(); returns false instead of reverting. Emits on failure so a
    ///      skipped module is always visible on-chain rather than silently ignored.
    function _tryPause(bytes32 moduleId, address target) internal returns (bool ok) {
        (ok, ) = target.call(_pauseCall(moduleId));
        if (!ok) {
            emit ModuleCallSkipped(moduleId, target, true);
            _reconcilePausedState(moduleId, target);
        }
    }

    /// @dev Attempts unpause(); returns false instead of reverting.
    function _tryUnpause(bytes32 moduleId, address target) internal returns (bool ok) {
        (ok, ) = target.call(_unpauseCall(moduleId));
        if (!ok) {
            emit ModuleCallSkipped(moduleId, target, false);
            _reconcilePausedState(moduleId, target);
        }
    }

    /// @dev The target's own paused view (paused() / bridgePaused()) when it answers; this
    ///      module's flag when it does not.
    function _actualPaused(bytes32 moduleId, address target) internal view returns (bool) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature(_pausedSig(moduleId)));
        if (ok && ret.length >= 32) return abi.decode(ret, (bool));
        return modules[moduleId].paused;
    }

    /// @dev This module believed `moduleId` paused but the target is open: drop the stale
    ///      flags, and end a guardian token term that is no longer running.
    function _forgetStale(bytes32 moduleId) internal {
        modules[moduleId].paused        = false;
        modules[moduleId].lastUnpauseTime = block.timestamp;
        governanceOnlyUnpause[moduleId] = false;
        if (moduleId == MODULE_TOKEN) _endTokenPause();
        emit ModuleStateReconciled(moduleId, false);
    }

    /// @dev Re-syncs the local `paused` flag from the target's own `paused()` view, so
    ///      local state converges on reality after a desync rather than staying wrong.
    ///      If the target exposes no `paused()` view the local flag is left untouched.
    function _reconcilePausedState(bytes32 moduleId, address target) internal {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature(_pausedSig(moduleId)));
        if (ok && ret.length >= 32) {
            bool actual = abi.decode(ret, (bool));
            if (modules[moduleId].paused != actual) {
                modules[moduleId].paused = actual;
                // M12: a pause this module did not make is not the guardian's to lift.
                governanceOnlyUnpause[moduleId] = actual;
                emit ModuleStateReconciled(moduleId, actual);
            }
        }
    }
}
