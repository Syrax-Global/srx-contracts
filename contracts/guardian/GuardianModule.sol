// SPDX-License-Identifier: MIT
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
 *  2. Non-upgradeable — a UUPS proxy with immutable-sunset semantics is a contradiction;
 *     a new implementation could extend the sunset. This contract is deployed once and
 *     its address is hardcoded as PAUSER_ROLE on all protocol contracts.
 *  3. Per-module granularity — guardian pauses a single module at a time (except emergencies).
 *  4. Governance override — governance can force-unpause anything the guardian paused.
 *     Guardian cannot block governance from operating.
 *  5. Cooldown enforcement — prevent guardian from flash-pausing / flash-unpausing.
 *  6. Circuit breaker — off-chain monitor reports bridge volume; auto-trip if threshold breached.
 *  7. Cross-chain signaling — emit structured events that relayers can forward to remote chains.
 *  8. Full audit trail — every guardian action is logged with reason and timestamp.
 *
 * Roles:
 *  DEFAULT_ADMIN_ROLE — Gnosis Safe (transfers to timelock after governance matures)
 *  GOVERNANCE_ROLE    — SRXTimelock (all governance overrides, sunset reduction, circuit config)
 *  GUARDIAN_ROLE      — GuardianMultisig (pause/unpause within cooldown + sunset window)
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

    // ── Sunset ─────────────────────────────────────────────────────────────────

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

    struct CircuitBreaker {
        uint256 volumeThreshold; // Tokens (18-decimal) that trip the breaker in one window
        uint256 windowDuration;  // Rolling window in seconds
        uint256 windowStart;     // Timestamp when current window began
        uint256 volumeInWindow;  // Cumulative bridged volume this window
        uint256 tripCount;       // Historical trips (audit)
        bool    tripped;         // Is the bridge currently tripped?
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

    // ── Action enum ────────────────────────────────────────────────────────────

    enum ActionType {
        Pause,
        Unpause,
        PauseAll,
        CircuitBreakerTrip,
        CrossChainSignal
    }

    // ── Constructor ────────────────────────────────────────────────────────────

    /**
     * @param _admin            Gnosis Safe — holds DEFAULT_ADMIN_ROLE initially
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
     * @notice Update the target address for a module (e.g. after UUPS upgrade changes address).
     *         Only needed if the proxy address changed, which is unusual for UUPS.
     */
    function updateModuleTarget(bytes32 moduleId, address newTarget)
        external
        onlyRole(GOVERNANCE_ROLE)
        moduleExists(moduleId)
    {
        if (newTarget == address(0)) revert ZeroAddress();
        address old = modules[moduleId].target;
        modules[moduleId].target = newTarget;
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

        if (m.paused) revert ModuleAlreadyPaused(moduleId);

        uint256 availableAt = m.lastPauseTime + PAUSE_COOLDOWN;
        if (block.timestamp < availableAt) revert CooldownActive(moduleId, availableAt);

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

        m.paused          = false;
        m.lastUnpauseTime = block.timestamp;

        _callUnpause(moduleId, m.target);

        emit GuardianAction(moduleId, msg.sender, ActionType.Unpause, reason, block.timestamp);
    }

    /**
     * @notice Emergency: pause ALL registered modules in one call.
     *         Subject to pauseAll cooldown (30 min) and per-module cooldowns are bypassed
     *         in a genuine emergency — this is intentional.
     */
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
            if (!modules[id].registered || modules[id].paused) continue;

            // R7-02: best-effort. One module failing (e.g. already paused directly by the
            // admin Safe) must not revert the whole emergency stop. State is only marked
            // paused on an actual successful transition; failures reconcile from-target.
            if (_tryPause(id, modules[id].target)) {
                modules[id].paused        = true;
                modules[id].lastPauseTime = block.timestamp;
                modules[id].pauseCount   += 1;
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

    // ── Governance overrides ───────────────────────────────────────────────────

    /**
     * @notice Force-unpause a single module, bypassing guardian cooldowns and sunset.
     *         Governance can always restore operations — guardian cannot block this.
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

        m.paused          = false;
        m.lastUnpauseTime = block.timestamp;

        _callUnpause(moduleId, m.target);

        emit GovernanceOverride(moduleId, msg.sender, reason, block.timestamp);
    }

    /**
     * @notice Emergency: governance force-unpauses ALL modules, bypassing all guardian state.
     */
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
            }
        }

        emit GovernanceOverride(bytes32(0), msg.sender, reason, block.timestamp);
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
     * @param volumeThreshold Tokens (18-decimal) that, if bridged in one window, trip the breaker.
     * @param windowDuration  Rolling window in seconds (e.g. 3600 = 1 hour).
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
        if (volumeThreshold == 0 || windowDuration == 0) revert InvalidThreshold();

        circuitBreakers[moduleId] = CircuitBreaker({
            volumeThreshold: volumeThreshold,
            windowDuration:  windowDuration,
            windowStart:     block.timestamp,
            volumeInWindow:  0,
            tripCount:       circuitBreakers[moduleId].tripCount, // preserve history
            tripped:         false
        });

        emit CircuitBreakerConfigured(moduleId, volumeThreshold, windowDuration);
    }

    /**
     * @notice Record bridge volume. Called by an off-chain monitor or LZ Compose reporter.
     *         If cumulative volume in the current window exceeds the threshold, the circuit
     *         breaker trips automatically: the module is paused via the guardian mechanism.
     * @param moduleId Target module (typically MODULE_BRIDGE).
     * @param amount   Volume transferred (18-decimal).
     */
    function recordBridgeActivity(bytes32 moduleId, uint256 amount)
        external
        onlyRole(CIRCUIT_BREAKER_ROLE)
        moduleExists(moduleId)
        nonReentrant
    {
        CircuitBreaker storage cb = circuitBreakers[moduleId];
        if (cb.volumeThreshold == 0) return; // Not configured — ignore

        // Roll window BEFORE checking tripped state (A4-M-02 fix).
        // If the window has expired, a previous trip belongs to the old window and
        // should not permanently block future windows — auto-reset here.
        // Governance must still manually call resetCircuitBreaker() + governanceUnpause()
        // to re-open the bridge after a trip; this only clears the accumulator state.
        if (block.timestamp >= cb.windowStart + cb.windowDuration) {
            cb.windowStart    = block.timestamp;
            cb.volumeInWindow = 0;
            cb.tripped        = false; // auto-reset on new window boundary
        }

        if (cb.tripped) revert CircuitBreakerAlreadyTripped(moduleId);

        cb.volumeInWindow += amount;

        if (cb.volumeInWindow >= cb.volumeThreshold) {
            cb.tripped    = true;
            cb.tripCount += 1;

            ModuleConfig storage m = modules[moduleId];
            if (!m.paused) {
                m.paused        = true;
                m.lastPauseTime = block.timestamp;
                m.pauseCount   += 1;
                _callPause(moduleId, m.target);
            }

            emit CircuitBreakerTripped(
                moduleId,
                cb.volumeInWindow,
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

        circuitBreakers[moduleId].tripped         = false;
        circuitBreakers[moduleId].volumeInWindow   = 0;
        circuitBreakers[moduleId].windowStart      = block.timestamp;

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

    function isModulePaused(bytes32 moduleId) external view returns (bool) {
        return modules[moduleId].paused;
    }

    function getCircuitBreakerStatus(bytes32 moduleId)
        external
        view
        returns (
            bool   tripped,
            uint256 volumeInWindow,
            uint256 volumeThreshold,
            uint256 windowEnd,
            uint256 tripCount
        )
    {
        CircuitBreaker storage cb = circuitBreakers[moduleId];
        return (
            cb.tripped,
            cb.volumeInWindow,
            cb.volumeThreshold,
            cb.windowStart + cb.windowDuration,
            cb.tripCount
        );
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    function _callPause(bytes32 moduleId, address target) internal {
        (bool ok, bytes memory ret) = target.call(abi.encodeWithSignature("pause()"));
        if (!ok) revert CallFailed(moduleId, ret);
    }

    function _callUnpause(bytes32 moduleId, address target) internal {
        (bool ok, bytes memory ret) = target.call(abi.encodeWithSignature("unpause()"));
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
        (ok, ) = target.call(abi.encodeWithSignature("pause()"));
        if (!ok) {
            emit ModuleCallSkipped(moduleId, target, true);
            _reconcilePausedState(moduleId, target);
        }
    }

    /// @dev Attempts unpause(); returns false instead of reverting.
    function _tryUnpause(bytes32 moduleId, address target) internal returns (bool ok) {
        (ok, ) = target.call(abi.encodeWithSignature("unpause()"));
        if (!ok) {
            emit ModuleCallSkipped(moduleId, target, false);
            _reconcilePausedState(moduleId, target);
        }
    }

    /// @dev Re-syncs the local `paused` flag from the target's own `paused()` view, so
    ///      local state converges on reality after a desync rather than staying wrong.
    ///      If the target exposes no `paused()` view the local flag is left untouched.
    function _reconcilePausedState(bytes32 moduleId, address target) internal {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("paused()"));
        if (ok && ret.length >= 32) {
            bool actual = abi.decode(ret, (bool));
            if (modules[moduleId].paused != actual) {
                modules[moduleId].paused = actual;
                emit ModuleStateReconciled(moduleId, actual);
            }
        }
    }
}
