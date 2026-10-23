// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { OFT } from "@layerzerolabs/oft-evm/contracts/OFT.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SRXOFTNative
 * @notice SRX token representation on remote chains (BSC, zkSync, and future chains).
 *
 * Deployed on every chain that is NOT the Ethereum origin chain. Tokens on
 * remote chains are minted only when this contract receives a LayerZero message
 * from the Ethereum hub (the only peer it accepts, at an address fixed at
 * deployment). They are burned when the user sends tokens cross-chain, and a
 * send goes to the hub only. Spoke-to-spoke is two hops through Ethereum.
 *
 * No genesis mint occurs here — all supply originates from Ethereum. Each spoke
 * caps its own supply at MAX_SUPPLY. A compromised spoke can forge SRX on this
 * chain, but the hub re-credits Ethereum only up to what it sent here
 * (outstandingByEid) and within its per-chain inbound limit, which the guardian
 * can freeze (SRXToken).
 *
 * On ZKsync Era this contract is the spoke token. A holder who wants SRX on Syrax
 * Chain returns it to the Ethereum hub over the OFT bridge and then deposits it
 * through the Syrax Chain's own bridge (CH-13, 22 Oct 2026); there is no migrator
 * contract (ZkSyncMigrator is retired and not deployed).
 *
 * Governance note: Voting power is NOT tracked on remote chains. All governance
 * participation happens on Ethereum where full supply accountability is maintained.
 *
 * ⚠ Hand-over prerequisite:
 *  This chain's owner() and its LayerZero delegate must be this chain's own
 *  SRXTimelock (48 h) before launch (07_deploy_bridge.js steps D and E, checked by
 *  scripts/verify/verify_spoke.js; MULTISIG_SPEC.md). Pausing stays fast
 *  (PAUSER_ROLE). Never leave a single EOA as owner.
 */
/**
 * @notice The hub's own address (SRXToken on Ethereum), as a LayerZero peer, fixed at
 *         deployment: the hub peer may be set to this, or to zero to freeze the bridge,
 *         and to nothing else.
 * @dev ⛔ External disclosure A (3 Oct 2026): a compromised owner could point the hub
 *      peer at an attacker, accept a forged mint, and restore it. With the peer fixed,
 *      that path does not exist even for the owner. A separate base contract, so the
 *      address is recorded before OFT stores the name and symbol: as a fourth live
 *      constructor value it took the constructor past the EVM stack limit.
 */
abstract contract HubPeer {
    bytes32 public immutable hubPeer;
    constructor(address hub) {
        hubPeer = bytes32(uint256(uint160(hub)));
    }
}

contract SRXOFTNative is HubPeer, OFT, Ownable2Step, AccessControl, Pausable {
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant BURN_ROLE   = keccak256("BURN_ROLE");

    // ── State ──────────────────────────────────────────────────────────────────

    uint256 public totalBurned;

    // ── Events ─────────────────────────────────────────────────────────────────

    event BuyAndBurn(address indexed initiator, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    /// @notice An ordinary transfer to this contract's own address was refused.
    error TransferToTokenContract();
    /// @notice A mint would take this chain's supply above MAX_SUPPLY.
    error SupplyCapExceeded(uint256 resultingSupply, uint256 cap);
    /// @notice This chain sends to, and accepts from, the Ethereum hub only.
    error NotHub(uint32 eid, uint32 hubEid);

    /// @notice LayerZero endpoint id of the Ethereum hub (SRXToken). Fixed at deployment.
    /// @dev ⛔ N-01: with every chain peered to every other, SRX moved spoke to spoke
    ///      without Ethereum seeing it, so Ethereum could not bound what came back.
    ///      Hub-and-spoke (Jared, 23 Sep 2026): Ethereum tracks what it sent to
    ///      each chain; this contract refuses any other route.
    uint32 public immutable hubEid;

    /// @notice A peer other than the fixed hub address (or zero) was refused.
    error PeerNotHub(bytes32 peer, bytes32 hubPeer);

    // ── Constants ──────────────────────────────────────────────────────────────

    /// @notice Global SRX cap, mirrored from the origin SRXToken.
    /// @dev No genesis mint happens here and all supply originates on Ethereum,
    ///      so this chain can legitimately receive up to the entire supply --
    ///      but never MORE than it. Without this, a compromised or buggy peer
    ///      could mint without limit on a remote chain and then bridge the
    ///      excess back, and nothing in the system would notice.
    uint256 public constant MAX_SUPPLY = 10_000_000_000 * 10 ** 18; // 10 billion SRX

    error OwnershipCannotBeRenounced();
    error ETHRescueFailed();

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
     * @param _admin       Initial admin and owner, used during setup. Before launch the
     *                     owner and delegate move to this chain's own SRXTimelock.
     * @param _hubEid      LayerZero endpoint id of the Ethereum hub.
     * @param _hub         The hub's SRXToken address (fixed as the only allowed hub peer).
     */
    constructor(
        address _lzEndpoint,
        address _admin,
        uint32  _hubEid,
        address _hub
    )
        HubPeer(_hub)
        OFT("Syrax Token", "SRX", _lzEndpoint, _admin)
        Ownable(_admin)
    {
        if (_admin == address(0) || _hub == address(0)) revert ZeroAddress();
        if (_hubEid == 0) revert NotHub(0, 0);
        hubEid = _hubEid;
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(PAUSER_ROLE,        _admin);
        // BURN_ROLE granted to admin so buyAndBurn() is immediately usable.
        // Post-deployment: transfer BURN_ROLE to the chain's StabilisationFund or
        // treasury contract, then revoke from the admin EOA/multisig.
        _grantRole(BURN_ROLE,          _admin);
    }

    // ── Treasury Buy-and-Burn ──────────────────────────────────────────────────

    /**
     * @notice Burn SRX purchased on this chain's open market.
     *         Calling this reduces supply on this chain without minting on Ethereum.
     *         Note: SRX burned here was sent out from the hub, so the hub still counts
     *         it as outstanding (outstandingByEid) and totalBurned on the hub does not
     *         change; only the hub's own buyAndBurn adds to the hub's totalBurned.
     *
     *         Burns only from msg.sender's own balance — BURN_ROLE holders cannot burn
     *         tokens from arbitrary third-party wallets (A3-H-02 fix, mirrors A2-H-01
     *         applied to SRXToken on the origin chain).
     *
     *         Callers must hold the SRX to burn before calling this function.
     */
    function buyAndBurn(uint256 amount) external onlyRole(BURN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        totalBurned += amount;
        _burn(msg.sender, amount);
        emit BuyAndBurn(msg.sender, amount);
    }

    // ── Rescue (external report, 14 Oct 2026; board 585533e0) ───────────────────

    /**
     * @notice Recover tokens held at this contract's own address, through governance.
     * @dev ⛔ SRX sent here, by a bridge arrival addressed to this contract, could never
     *      leave: the spoke had no rescue, unlike SRXToken and
     *      BuybackBurner. Ordinary transfers to this address are now refused in _update;
     *      a bridge arrival is still accepted (reverting in _credit would strand the
     *      LayerZero message and leave the SRX locked on the hub), and this recovers it.
     *      onlyOwner: the owner is this chain's SRXTimelock (48 h), as for setPeer.
     *      Safe because this contract only mints and burns and never holds SRX for
     *      anyone, so any balance here is stray. A rescue is a transfer, not a mint or
     *      burn, so MAX_SUPPLY and the hub's outstandingByEid are unaffected. Like every
     *      transfer, it waits while the token is paused.
     */
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (token == address(this)) {
            _transfer(address(this), to, amount);
        } else if (token == address(0)) {
            // Internal audit TB-05 / Aderyn H-1 (22 Oct 2026): native value an executor sends
            // with a bridge delivery (lzReceive is payable) had no way out. token == 0 is ETH.
            // slither-disable-next-line arbitrary-send-eth -- reviewed 22 Oct 2026: onlyOwner (this chain's Timelock, 48 h) only; moves only ETH stranded at this contract, which holds none for anyone
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert ETHRescueFailed(); // review round 22 Oct: was ZeroAmount
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit TokenRescued(token, to, amount);
    }

    // ── Emergency Controls ─────────────────────────────────────────────────────

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
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
        // Disclosure A: the only peer is the hub, at its fixed address, or zero (frozen).
        if (_eid != hubEid) revert NotHub(_eid, hubEid);
        if (_peer != hubPeer && _peer != bytes32(0)) revert PeerNotHub(_peer, hubPeer);
        super.setPeer(_eid, _peer);
    }

    // ── Internal Overrides ─────────────────────────────────────────────────────

    function _debit(address _from, uint256 _amountLD, uint256 _minAmountLD, uint32 _dstEid)
        internal
        override
        returns (uint256 amountSentLD, uint256 amountReceivedLD)
    {
        if (_dstEid != hubEid) revert NotHub(_dstEid, hubEid);
        return super._debit(_from, _amountLD, _minAmountLD, _dstEid);
    }

    function _credit(address _to, uint256 _amountLD, uint32 _srcEid)
        internal
        override
        returns (uint256 amountReceivedLD)
    {
        if (_srcEid != hubEid) revert NotHub(_srcEid, hubEid);
        return super._credit(_to, _amountLD, _srcEid);
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20)
        whenNotPaused
    {
        // ⛔ This contract minted with NO cap at all. Its only mint path is the
        //    LayerZero inbound credit, so a faulty or hostile peer minted freely
        //    -- proven in test/audit-poc/bridge-supply-cap.test.js case E.
        //    Enforced in _update rather than _credit so it covers every present
        //    and future mint path, matching SRXToken.
        if (from == address(0)) {
            uint256 resulting = totalSupply() + value;
            if (resulting > MAX_SUPPLY) revert SupplyCapExceeded(resulting, MAX_SUPPLY);
        } else if (to == address(this)) {
            // Board 585533e0: a plain transfer here would be stranded. Mints (bridge
            // arrivals) are not refused; rescueTokens recovers those.
            revert TransferToTokenContract();
        }
        super._update(from, to, value);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
