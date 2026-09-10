// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OFT } from "@layerzerolabs/oft-evm/contracts/OFT.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SRXOFTNative
 * @notice SRX token representation on remote chains (BSC, zkSync, and future chains).
 *
 * Deployed on every chain that is NOT the Ethereum origin chain. Tokens on
 * remote chains are minted exclusively when the LayerZero bridge receives a
 * verified burn message from the origin or another remote chain. They are burned
 * when the user sends tokens cross-chain.
 *
 * No genesis mint occurs here — all supply originates from Ethereum.
 *
 * For zkSync specifically, this contract serves as the placeholder token until
 * the Syrax Chain launches and SRX is migrated to a native gas token via
 * ZkSyncMigrator. At that point this contract will be deprecated.
 *
 * Governance note: Voting power is NOT tracked on remote chains. All governance
 * participation happens on Ethereum where full supply accountability is maintained.
 *
 * ⚠ Multi-sig prerequisite:
 *  DEFAULT_ADMIN_ROLE MUST be a Gnosis Safe before mainnet deployment.
 */
contract SRXOFTNative is OFT, AccessControl, Pausable {

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant BURN_ROLE   = keccak256("BURN_ROLE");

    // ── State ──────────────────────────────────────────────────────────────────

    uint256 public totalBurned;

    // ── Events ─────────────────────────────────────────────────────────────────

    event BuyAndBurn(address indexed initiator, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    /// @notice A mint would take this chain's supply above MAX_SUPPLY.
    error SupplyCapExceeded(uint256 resultingSupply, uint256 cap);

    // ── Constants ──────────────────────────────────────────────────────────────

    /// @notice Global SRX cap, mirrored from the origin SRXToken.
    /// @dev No genesis mint happens here and all supply originates on Ethereum,
    ///      so this chain can legitimately receive up to the entire supply --
    ///      but never MORE than it. Without this, a compromised or buggy peer
    ///      could mint without limit on a remote chain and then bridge the
    ///      excess back, and nothing in the system would notice.
    uint256 public constant MAX_SUPPLY = 10_000_000_000 * 10 ** 18; // 10 billion SRX

    // ── Constructor ────────────────────────────────────────────────────────────

    /**
     * @param _lzEndpoint  LayerZero V2 EndpointV2 address on this chain.
     * @param _admin       Initial admin. Must be replaced with Gnosis Safe pre-mainnet.
     */
    constructor(
        address _lzEndpoint,
        address _admin
    )
        OFT("Syrax Token", "SRX", _lzEndpoint, _admin)
        Ownable(_admin)
    {
        if (_admin == address(0)) revert ZeroAddress();
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
     *         Calling this reduces supply on this chain without minting on Ethereum —
     *         this is the intended deflationary mechanism.
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

    // ── Emergency Controls ─────────────────────────────────────────────────────

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ── Bridge Peer Configuration (SC-LZ-001 hardening) ────────────────────────

    /**
     * @notice Override setPeer to require the contract is NOT paused.
     *         Base OFT setPeer is `onlyOwner`. This override adds a pause guard so
     *         that if the owner key is compromised, the guardian can pause the
     *         contract to freeze peer changes until governance intervenes.
     */
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

    // ── Internal Overrides ─────────────────────────────────────────────────────

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
