// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { OFT } from "@layerzerolabs/oft-evm/contracts/OFT.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { ERC20Votes } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { Nonces } from "@openzeppelin/contracts/utils/Nonces.sol";
import { Time } from "@openzeppelin/contracts/utils/types/Time.sol";

/// @dev The one view the token reads from a wind-down exit (SRXStaking, StabilisationFund).
interface IWindDownExit {
    function windDown() external view returns (bool);
}

/**
 * @title SRXToken
 * @notice Syrax Token — native utility and governance token.
 *
 * Architecture:
 *  - Deployed on Ethereum as the canonical OFT origin chain.
 *  - Genesis mints the entire fixed supply (10 billion SRX) to the TGEDistributor.
 *  - Cross-chain transfers use LayerZero V2 OFT burn/mint mechanics.
 *  - Voting power delegated for on-chain governance (ERC20Votes).
 *  - EIP-2612 Permit for gasless approvals.
 *
 * Supply guarantee:
 *  Total supply never exceeds MAX_SUPPLY (cap enforced in _update). Genesis is a
 *  one-shot mint of 10B. A bridge send BURNS on this chain (OFT _debit); a bridge
 *  return MINTS here, but only up to what was sent to that chain (outstandingByEid)
 *  and within that chain's inbound limit (a draining bucket, see below). The only
 *  PERMANENT supply reductions are buyAndBurn and ZkSyncMigrator.migrate (which
 *  calls buyAndBurn); both add to totalBurned. Genuine SRX across all chains is
 *  therefore 10B minus totalBurned (⚠️ open, internal audit M4/L9: a spoke's own
 *  buyAndBurn is a permanent reduction the hub does not see). A compromised spoke
 *  can forge SRX on that spoke, but can bring back to Ethereum at most the inbound
 *  limit at once, refilling at the limit per 24 hours until the guardian freezes it:
 *  the limit times (1 + days of reaction time) (test/BridgeConservation.property.test.js,
 *  test/security-triage-2026-10.test.js).
 *
 * Role model:
 *  DEFAULT_ADMIN_ROLE  — grants/revokes all roles. After the launch hand-over it is
 *                        held by the SRXTimelock (48 h), not the Safe (MULTISIG_SPEC.md).
 *  PAUSER_ROLE         — emergency pause of all transfers (including bridging), the
 *                        bridge-only stop, and the per-chain inbound freeze. Held by
 *                        GuardianModule after the hand-over, which bounds how long it
 *                        may keep the token paused.
 *
 * While paused, one kind of transfer still goes through (Security ruling, 12 Oct
 * 2026): out of a contract governance has listed as a wind-down exit (SRXStaking,
 * StabilisationFund) while that contract reports windDown() == true. A holder gets
 * their own deposit back into their own wallet; they cannot move it on until the
 * pause ends. A pause therefore never blocks an exit-only withdrawal.
 *  GOVERNANCE_ROLE     — launch limits (maxTransferAmount, maxWalletBalance), the
 *                        limit exemptions, setInboundLimit and unfreezeInbound.
 *  BURN_ROLE           — treasury-controlled buy-and-burn.
 *
 * ⚠ Hand-over prerequisite:
 *  Before mainnet launch the deployer EOA must hold no role here. scripts/ops/
 *  migrate_roles.js moves the roles to the Timelock and GuardianModule, and
 *  scripts/verify/verify_roles.js checks the end state (MULTISIG_SPEC.md).
 *  Leaving an EOA as admin is a critical security risk on a token of this scale.
 */
contract SRXToken is OFT, Ownable2Step, ERC20Permit, ERC20Votes, AccessControl, Pausable {

    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant PAUSER_ROLE     = keccak256("PAUSER_ROLE");
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant BURN_ROLE       = keccak256("BURN_ROLE");

    // ── Constants ──────────────────────────────────────────────────────────────

    uint256 public constant MAX_SUPPLY = 10_000_000_000 * 10 ** 18; // 10 billion SRX

    // ── State ──────────────────────────────────────────────────────────────────

    bool public genesisComplete;
    uint256 public totalBurned;

    // ── Launch Protection ──────────────────────────────────────────────────────

    /**
     * @notice Maximum SRX that may be transferred in a single transaction.
     *         Zero = no limit (default). Enabled at TGE launch via GOVERNANCE_ROLE,
     *         removed after the launch protection period (e.g. 30–60 days).
     *
     *         Suggested launch value: 50,000,000 SRX (0.5% of supply).
     */
    uint256 public maxTransferAmount;

    /**
     * @notice Maximum SRX balance any single wallet may hold after a transfer.
     *         Zero = no limit (default). Prevents single-wallet accumulation at launch.
     *
     *         Suggested launch value: 100,000,000 SRX (1% of supply).
     */
    uint256 public maxWalletBalance;

    /**
     * @notice Addresses exempt from the launch limits. An exempt sender OR recipient
     *         bypasses maxTransferAmount; only an exempt RECIPIENT bypasses
     *         maxWalletBalance (an exempt sender still cannot push an ordinary
     *         wallet over the cap).
     *         Must include: all vesting vaults, staking contract, treasury, SSF,
     *         presale contract, DEX liquidity pool addresses, and the bridge.
     *         Set via setExemptFromLimits() before enabling launch protection.
     */
    mapping(address => bool) public isExemptFromLimits;

    // ── Events ─────────────────────────────────────────────────────────────────

    event GenesisExecuted(address indexed distributor, uint256 amount);
    event BuyAndBurn(address indexed initiator, uint256 amount);
    event MaxTransferAmountUpdated(uint256 newAmount);
    event MaxWalletBalanceUpdated(uint256 newAmount);
    event ExemptionUpdated(address indexed account, bool exempt);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error GenesisAlreadyComplete();
    error ZeroAddress();
    error ZeroAmount();
    error TransferExceedsMaxAmount(uint256 amount, uint256 limit);
    /// @notice A mint would take totalSupply above MAX_SUPPLY.
    error SupplyCapExceeded(uint256 resultingSupply, uint256 cap);
    /// @notice An inbound bridge credit exceeds what this chain has sent to its source.
    error UnbackedInboundCredit(uint32 srcEid, uint256 amount, uint256 outstanding);
    /// @notice The bridge is stopped (bridgePaused): no sends, and returns wait to be retried.
    error BridgeStopped();

    // ── Bridge-only stop, and wind-down exits (Security ruling, 12 Oct 2026) ────
    //
    // ⛔ The circuit breaker drove pause(), freezing EVERY transfer from one hot key.
    //    GuardianModule's MODULE_BRIDGE now drives this stop instead: bridge sends and
    //    returns halt, ordinary transfers carry on. A refused return stays verified at
    //    the LayerZero endpoint and can be retried once the bridge restarts.

    /// @notice Bridge sends and returns are stopped; ordinary transfers are not.
    bool public bridgePaused;
    /// @notice Contracts whose transfers out continue during a pause while they report
    ///         windDown() == true (SRXStaking, StabilisationFund). Add-only: never unset.
    mapping(address => bool) public isWindDownExit;

    event BridgePausedSet(bool paused);
    event WindDownExitAdded(address indexed account);

    // ── Bridge accounting (N-01) ───────────────────────────────────────────────
    //
    // ⛔ N-01: the supply cap was checked PER CHAIN. Each chain compared its own
    //    totalSupply with 10B, so a compromised peer or DVN could credit up to
    //    10B minus local supply on every chain — N chains could hold N × 10B.
    //
    // ⭐ Hub-and-spoke (Jared, 23 Sep 2026). Ethereum is the only chain every
    //    other chain talks to (SRXOFTNative enforces that end), and Ethereum
    //    records how much SRX it has sent to each chain. It re-credits from a
    //    chain only up to that amount. A forged message on a remote chain can
    //    therefore never come back to Ethereum as more than was really sent
    //    there, and nothing can be credited here before genesis.

    /// @notice SRX sent from this chain to each remote chain and not yet returned.
    mapping(uint32 => uint256) public outstandingByEid;

    event BridgeOutflow(uint32 indexed dstEid, uint256 amount, uint256 outstanding);
    event BridgeInflow(uint32 indexed srcEid, uint256 amount, uint256 outstanding);

    // ── Inbound limits (external disclosure A, 7 Oct 2026) ──────────────────────
    //
    // ⛔ outstandingByEid bounds what a chain can return to what was sent there,
    //    but it cannot tell real SRX from forged: a compromised spoke owner or
    //    LayerZero delegate could mint on the spoke and bring back everything ever
    //    sent to it, leaving honest holders' SRX unbacked (reported 3 Oct).
    //
    // ⭐ So each chain's returns are rate-limited, and the guardian can freeze one
    //    chain's returns at once. The limit is a draining bucket (the model of
    //    LayerZero's RateLimiter): returns add to inboundInFlight, which drains
    //    linearly at inboundLimit per INBOUND_WINDOW, and a return that would take it
    //    above inboundLimit is refused. So at most inboundLimit can come back at any
    //    moment, refilling at inboundLimit per 24 hours; over any 24 hours, at most
    //    twice the limit. Fails closed: a chain with no limit returns nothing. A
    //    refused message reverts, and LayerZero V2 keeps it verified and retryable,
    //    so a real return is delayed, never lost. A single return above the limit
    //    waits for governance to raise it.
    // ⛔ The first version (7 Oct, same day) counted returns in fixed 24-hour windows
    //    that reset at once, so a full limit just before a reset and another just
    //    after brought back twice the limit within seconds (internal review).

    uint256 public constant INBOUND_WINDOW = 1 days;
    /// @notice Most SRX in flight from each remote chain at once, and its refill per window. 0 = none.
    mapping(uint32 => uint256) public inboundLimit;
    /// @notice Returns counted against the limit as of inboundUpdatedAt, before draining.
    mapping(uint32 => uint256) public inboundInFlight;
    /// @notice When inboundInFlight was last updated, per remote chain.
    mapping(uint32 => uint256) public inboundUpdatedAt;
    /// @notice Returns from this chain are refused until governance lifts it.
    mapping(uint32 => bool) public inboundFrozen;

    event InboundLimitSet(uint32 indexed eid, uint256 perWindow);
    event InboundFrozenSet(uint32 indexed eid, bool frozen);
    error InboundLimitExceeded(uint32 eid, uint256 amount, uint256 available);
    /// @notice A limit above MAX_SUPPLY would overflow the draining bucket (internal audit TB-02).
    error LimitTooHigh(uint256 perWindow, uint256 cap);
    error InboundChainFrozen(uint32 eid);
    error WalletExceedsMaxBalance(uint256 resultingBalance, uint256 limit);

    error OwnershipCannotBeRenounced();

    // ── Bridge ownership (N-02) ─────────────────────────────────────────────────
    //
    // The Ownable owner controls the LayerZero peers, enforced options and message
    // inspector — the bridge's real authority, outside the role model.
    // ⛔ Transfer was one step, so a typo sent it to an address nobody controls,
    //    and renounceOwnership() would have frozen peer configuration for good,
    //    including incident-response step 5 (set a compromised peer to zero).
    //    Transfer is now two-step and renouncing is disabled.

    function transferOwnership(address newOwner) public override(Ownable, Ownable2Step) onlyOwner {
        Ownable2Step.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal override(Ownable, Ownable2Step) {
        Ownable2Step._transferOwnership(newOwner);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }

    // ── Constructor ────────────────────────────────────────────────────────────

    /**
     * @param _lzEndpoint  LayerZero V2 EndpointV2 address on this chain.
     * @param _admin       Initial admin address. Replace with Gnosis Safe before mainnet.
     */
    constructor(
        address _lzEndpoint,
        address _admin
    )
        OFT("Syrax Token", "SRX", _lzEndpoint, _admin)
        Ownable(_admin)
        ERC20Permit("Syrax Token")
    {
        if (_admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNANCE_ROLE,    _admin);
        _grantRole(PAUSER_ROLE,        _admin);
        // External disclosure B (4 Oct 2026): SRX sent here by mistake must be
        // rescuable. Under launch limits, rescueTokens to an ordinary wallet
        // reverted above maxTransferAmount, so this contract exempts itself. The
        // recipient's wallet cap still applies, and nothing moves while paused.
        isExemptFromLimits[address(this)] = true;
        emit ExemptionUpdated(address(this), true);
    }

    // ── Genesis ────────────────────────────────────────────────────────────────

    /**
     * @notice One-shot mint of the entire MAX_SUPPLY to the TGE distributor.
     *         May only be called once. After this call the admin loses mint capability.
     * @param tgeDistributor Address of the deployed TGEDistributor contract.
     */
    function genesis(address tgeDistributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (genesisComplete) revert GenesisAlreadyComplete();
        if (tgeDistributor == address(0)) revert ZeroAddress();
        genesisComplete = true;
        _mint(tgeDistributor, MAX_SUPPLY);
        emit GenesisExecuted(tgeDistributor, MAX_SUPPLY);
    }

    // ── Treasury Buy-and-Burn ──────────────────────────────────────────────────

    /**
     * @notice Permanently burn SRX tokens held by the caller.
     *         Must be called by an address holding BURN_ROLE (treasury, migrator, etc.).
     *         Burns only from msg.sender's own balance — BURN_ROLE holders cannot burn
     *         tokens from third-party wallets (A2-H-01 fix).
     *
     *         Callers should transfer or receive tokens before calling this function:
     *           - Treasury: holds SRX from open-market purchases, then calls buyAndBurn.
     *           - ZkSyncMigrator: pulls tokens from user via safeTransferFrom, then burns.
     *
     *         While the token is paused, burns, migrations and buybacks stop: a burn
     *         is a token movement, and a pause stops every token movement. This is
     *         intended (external disclosure C, 4 Oct 2026). Admin controls such as
     *         setPeer keep working while paused.
     *
     * @param amount Amount to burn (18-decimal SRX). Must be > 0.
     */
    function buyAndBurn(uint256 amount) external onlyRole(BURN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        totalBurned += amount;
        _burn(msg.sender, amount);
        emit BuyAndBurn(msg.sender, amount);
    }

    // ── Launch Protection Controls ────────────────────────────────────────────

    /**
     * @notice Set the maximum SRX per transaction. Pass 0 to remove the limit.
     * @param amount Maximum transfer size in 18-decimal SRX units.
     */
    function setMaxTransferAmount(uint256 amount) external onlyRole(GOVERNANCE_ROLE) {
        maxTransferAmount = amount;
        emit MaxTransferAmountUpdated(amount);
    }

    /**
     * @notice Set the maximum SRX wallet balance. Pass 0 to remove the limit.
     * @param amount Maximum wallet holding in 18-decimal SRX units.
     */
    function setMaxWalletBalance(uint256 amount) external onlyRole(GOVERNANCE_ROLE) {
        maxWalletBalance = amount;
        emit MaxWalletBalanceUpdated(amount);
    }

    /**
     * @notice Exempt or un-exempt an address from launch protection limits.
     *         Vesting vaults, staking, treasury, SSF, presale, and DEX pools
     *         must be exempted before launch protection is enabled.
     * @param account Address to configure.
     * @param exempt  True to bypass limits; false to enforce them.
     */
    function setExemptFromLimits(address account, bool exempt) external onlyRole(GOVERNANCE_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        isExemptFromLimits[account] = exempt;
        emit ExemptionUpdated(account, exempt);
    }

    // ── Emergency Controls ─────────────────────────────────────────────────────

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Stop or restart bridge sends and returns, leaving ordinary transfers running.
    function setBridgePaused(bool paused_) external onlyRole(PAUSER_ROLE) {
        bridgePaused = paused_;
        emit BridgePausedSet(paused_);
    }

    /// @notice Add a wind-down exit. Governance only, and ADD-ONLY (Security, 12 Oct 2026):
    ///         there is no way to unlist, so no later vote can delist staking or the Fund and
    ///         silently break the exit promise. A listing only lets that contract's own
    ///         transfers out continue during a pause, and only while it is wound down.
    function addWindDownExit(address account) external onlyRole(GOVERNANCE_ROLE) {
        isWindDownExit[account] = true;
        emit WindDownExitAdded(account);
    }

    // ── Inbound bridge limits (disclosure A) ───────────────────────────────────

    /// @notice Set the most SRX `eid` may return per 24 hours. 0 refuses all returns.
    /// @dev ⛔ Internal audit TB-02 (16 Oct 2026): type(uint256).max as "no limit" overflowed
    ///      _drainedInFlight the next block, which bricked returns from that chain and this
    ///      setter with them. No chain can return more than the whole supply anyway.
    function setInboundLimit(uint32 eid, uint256 perWindow) external onlyRole(GOVERNANCE_ROLE) {
        if (perWindow > MAX_SUPPLY) revert LimitTooHigh(perWindow, MAX_SUPPLY);
        // Drain at the old rate up to now, so a new limit never rewrites the past.
        inboundInFlight[eid] = _drainedInFlight(eid);
        inboundUpdatedAt[eid] = block.timestamp;
        inboundLimit[eid] = perWindow;
        emit InboundLimitSet(eid, perWindow);
    }

    /// @notice SRX that `eid` could return right now.
    function inboundAvailable(uint32 eid) external view returns (uint256) {
        uint256 inFlight = _drainedInFlight(eid);
        uint256 limit = inboundLimit[eid];
        return limit > inFlight ? limit - inFlight : 0;
    }

    /// @notice Freeze returns from one chain at once (the guardian's fast path).
    function freezeInbound(uint32 eid) external onlyRole(PAUSER_ROLE) {
        inboundFrozen[eid] = true;
        emit InboundFrozenSet(eid, true);
    }

    /// @notice Lift a freeze. Governance only, so a compromised guardian cannot undo one.
    function unfreezeInbound(uint32 eid) external onlyRole(GOVERNANCE_ROLE) {
        inboundFrozen[eid] = false;
        emit InboundFrozenSet(eid, false);
    }

    // ── Bridge Peer Configuration (SC-LZ-001 hardening) ────────────────────────

    /**
     * @dev ⛔ THIS WAS `whenNotPaused`, WHICH MADE THE DOCUMENTED INCIDENT
     *      RESPONSE IMPOSSIBLE. INCIDENT_RESPONSE.md step 5 says to freeze bridge
     *      peers with `setPeer(chainId, bytes32(0))`, and pausing is what you do
     *      first in an incident -- so the one action the runbook prescribes for a
     *      bridge compromise reverted exactly when it was needed. Proven in
     *      test/audit-poc/bridge-supply-cap.test.js case C.
     *
     * ⭐ The pause is a TRANSFER circuit-breaker, not an admin lockout. Conflating
     *      the two removes the operator's controls at the moment of the incident.
     *      setPeer remains onlyOwner via OAppCore, and the protection against a
     *      compromised owner is that the owner is a Safe -- not a modifier that
     *      also disarms the defenders.
     */
    function setPeer(uint32 _eid, bytes32 _peer)
        public
        override
    {
        super.setPeer(_eid, _peer);
    }

    // ── Token Rescue ───────────────────────────────────────────────────────────

    /**
     * @notice Recover tokens accidentally sent to this contract address.
     *
     *         Users occasionally send the wrong token (or even SRX itself) to a
     *         well-known contract address. This function lets the admin recover
     *         those funds and return them.
     *
     *         SRX recovery rationale (SC-RT-001 fix):
     *         SRXToken has no business reason to hold its own tokens. The genesis
     *         mint sends the entire supply to the TGEDistributor; this contract is
     *         never an intended destination for SRX. Therefore any SRX held at
     *         address(this) is, by definition, accidentally sent — and safe to
     *         rescue. We use the internal _transfer (no approval dance needed
     *         since the contract is the holder).
     *
     *         For external ERC-20 tokens, uses SafeERC20.safeTransfer to handle
     *         non-standard tokens that do not return a bool on transfer (e.g. USDT).
     *
     * @param token   Address of the token to recover. Pass address(this) to
     *                rescue SRX accidentally sent to this contract.
     * @param to      Recipient address. Must not be the zero address.
     * @param amount  Amount to transfer in the token's native decimals. Must be > 0.
     */
    function rescueTokens(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0) || to == address(this)) revert ZeroAddress(); // self: a no-op that still emitted
        if (amount == 0)      revert ZeroAmount();
        if (token == address(this)) {
            // Use internal _transfer — the contract is the holder, no approval needed.
            // _update() launch-protection checks will run; mint/burn aren't involved.
            _transfer(address(this), to, amount);
        } else if (token == address(0)) {
            // Internal audit TB-05 / Aderyn H-1 (22 Oct 2026): native value an executor sends
            // with a bridge delivery (lzReceive is payable) had no way out. token == 0 is ETH.
            // slither-disable-next-line arbitrary-send-eth -- reviewed 22 Oct 2026: DEFAULT_ADMIN_ROLE (the Timelock, 48 h) only; moves only ETH stranded at this contract, which holds none for anyone
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert ZeroAmount();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit TokenRescued(token, to, amount);
    }

    // ── ERC6372 Clock (timestamp mode) ────────────────────────────────────────

    /**
     * @dev Use block.timestamp as the governance clock so that GovernorSettings
     *      parameters (votingDelay, votingPeriod) are interpreted in seconds,
     *      matching the human-readable values set in SRXGovernor (1 day, 7 days).
     *      OZ v5 ERC20Votes defaults to block.number — this override corrects that.
     */
    function clock() public view override returns (uint48) {
        return Time.timestamp();
    }

    function CLOCK_MODE() public view override returns (string memory) {
        return "mode=timestamp";
    }

    // ── Internal Overrides ─────────────────────────────────────────────────────

    function _debit(address _from, uint256 _amountLD, uint256 _minAmountLD, uint32 _dstEid)
        internal
        override
        returns (uint256 amountSentLD, uint256 amountReceivedLD)
    {
        if (bridgePaused) revert BridgeStopped();
        (amountSentLD, amountReceivedLD) = super._debit(_from, _amountLD, _minAmountLD, _dstEid);
        uint256 outstanding = outstandingByEid[_dstEid] + amountSentLD;
        outstandingByEid[_dstEid] = outstanding;
        emit BridgeOutflow(_dstEid, amountSentLD, outstanding);
    }

    function _credit(address _to, uint256 _amountLD, uint32 _srcEid)
        internal
        override
        returns (uint256 amountReceivedLD)
    {
        if (bridgePaused) revert BridgeStopped();
        uint256 outstanding = outstandingByEid[_srcEid];
        if (_amountLD > outstanding) revert UnbackedInboundCredit(_srcEid, _amountLD, outstanding);
        _consumeInbound(_srcEid, _amountLD); // disclosure A: frozen chains, and the daily limit
        unchecked { outstandingByEid[_srcEid] = outstanding - _amountLD; }
        emit BridgeInflow(_srcEid, _amountLD, outstanding - _amountLD);
        return super._credit(_to, _amountLD, _srcEid);
    }

    /// @dev In-flight returns after draining at inboundLimit per INBOUND_WINDOW.
    function _drainedInFlight(uint32 eid) internal view returns (uint256) {
        uint256 inFlight = inboundInFlight[eid];
        uint256 drained = ((block.timestamp - inboundUpdatedAt[eid]) * inboundLimit[eid]) / INBOUND_WINDOW;
        return inFlight > drained ? inFlight - drained : 0;
    }

    /// @dev Disclosure A: a frozen chain returns nothing; any other at most what its
    ///      draining bucket has room for.
    function _consumeInbound(uint32 eid, uint256 amount) internal {
        if (inboundFrozen[eid]) revert InboundChainFrozen(eid);
        uint256 inFlight = _drainedInFlight(eid);
        uint256 limit = inboundLimit[eid];
        uint256 available = limit > inFlight ? limit - inFlight : 0;
        if (amount > available) revert InboundLimitExceeded(eid, amount, available);
        inboundInFlight[eid] = inFlight + amount;
        inboundUpdatedAt[eid] = block.timestamp;
    }

    /**
     * @dev Hooks into every token transfer to:
     *  1. Block transfers while paused, except a wound-down exit's own transfers out.
     *  2. Update ERC20Votes checkpoints for governance power tracking.
     */
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        // The external call is made only for a listed exit, and only while paused.
        if (paused()) _requireWindDownExit(from);

        // ── Supply cap ─────────────────────────────────────────────────────────
        // ⛔ THE HEADLINE GUARANTEE OF THIS CONTRACT WAS NOT ENFORCED ANYWHERE.
        //    The natspec above states "Total supply never exceeds MAX_SUPPLY",
        //    and genesis() is one-shot, so the only other mint path is the
        //    LayerZero inbound credit -- OFT._credit -> _mint. SRXToken never
        //    overrode _credit, so a peer message minted without any check.
        //    Measured before this fix: totalSupply reached 2e28 against a 1e28
        //    cap (test/audit-poc/bridge-supply-cap.test.js case A).
        //
        // ⭐ Enforced HERE, in _update, rather than by overriding _credit,
        //    because _update is the single chokepoint every mint must pass --
        //    genesis, the bridge, and any path added later. Fixing _credit alone
        //    would leave the next mint path to rediscover this.
        if (from == address(0)) {
            // totalSupply() has not yet been increased at this point; super._update does it.
            uint256 resulting = totalSupply() + value;
            if (resulting > MAX_SUPPLY) revert SupplyCapExceeded(resulting, MAX_SUPPLY);
        }

        // ── Launch protection ──────────────────────────────────────────────────
        // Skips mint (from == 0), burn (to == 0), and self-transfers (from == to)
        // — limits apply only to value-moving transfers between distinct wallets.
        //
        // ⚠️ value != 0 is REQUIRED, not tidiness. ERC-20 mandates that a
        //    zero-value transfer be treated as a normal transfer and succeed.
        //    Without it, `balanceOf(to) + 0 > maxWalletBalance` reverts whenever
        //    the recipient is ALREADY over the cap, so a no-op transfer fails a
        //    conformance suite and breaks exchange integrations that probe with
        //    a zero-value call (test/audit-poc/token-standard-and-governance.test.js T1).
        if (from != address(0) && to != address(0) && from != to && value != 0) {
            // Max transfer — neither sender nor recipient is exempt
            if (maxTransferAmount != 0 && !isExemptFromLimits[from] && !isExemptFromLimits[to]) {
                if (value > maxTransferAmount)
                    revert TransferExceedsMaxAmount(value, maxTransferAmount);
            }
            // Max wallet — recipient is not exempt. ⛔ Internal audit L10 (TB-06, 16 Oct 2026):
            // a staker can build a principal above the cap in tranches, and every exit returns
            // it whole, so the cap blocked unlock and even exitAfterWindDown, which the docs
            // say cannot be blocked. Principal coming back from a listed exit (staking, the
            // fund) is the holder's own, so the cap does not apply to it.
            if (maxWalletBalance != 0 && !isExemptFromLimits[to] && !isWindDownExit[from]) {
                if (balanceOf(to) + value > maxWalletBalance)
                    revert WalletExceedsMaxBalance(balanceOf(to) + value, maxWalletBalance);
            }
        }
        // ──────────────────────────────────────────────────────────────────────

        super._update(from, to, value);
    }

    /// @dev While paused, only a listed exit that is wound down may send (Security ruling,
    ///      12 Oct 2026). Anything else gets the usual EnforcedPause.
    function _requireWindDownExit(address from) private view {
        if (!isWindDownExit[from] || !IWindDownExit(from).windDown()) _requireNotPaused();
    }

    /**
     * @dev Resolves the nonces() conflict between ERC20Permit and Nonces
     *      in the OpenZeppelin v5 multiple-inheritance chain.
     */
    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }

    // ── Access Control Overrides ───────────────────────────────────────────────

    /**
     * @dev Ensure supportsInterface covers both AccessControl and OFT (OApp) interfaces.
     */
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
