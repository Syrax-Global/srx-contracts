// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OFT } from "@layerzerolabs/oft-evm/contracts/OFT.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { ERC20Votes } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { Nonces } from "@openzeppelin/contracts/utils/Nonces.sol";
import { Time } from "@openzeppelin/contracts/utils/types/Time.sol";

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
 *  Total supply never exceeds MAX_SUPPLY. Bridge mints only occur when
 *  an equivalent burn is verified by the LayerZero message layer. The
 *  only supply-reducing operation is buyAndBurn, called by the treasury
 *  after open-market purchases.
 *
 * Role model:
 *  DEFAULT_ADMIN_ROLE  — grants/revokes all roles; transfer to Gnosis Safe pre-mainnet.
 *  PAUSER_ROLE         — emergency pause of all transfers (including bridging).
 *  GOVERNANCE_ROLE     — reserved for future parameter governance calls.
 *  BURN_ROLE           — treasury-controlled buy-and-burn.
 *
 * ⚠ Multi-sig prerequisite:
 *  Before mainnet deployment, DEFAULT_ADMIN_ROLE MUST be transferred from the
 *  EOA deployer to a Gnosis Safe with ≥3/5 threshold. Leaving an EOA as admin
 *  is a critical security risk on a token of this scale.
 */
contract SRXToken is OFT, ERC20Permit, ERC20Votes, AccessControl, Pausable {

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
     * @notice Addresses exempt from both maxTransferAmount and maxWalletBalance checks.
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
    error WalletExceedsMaxBalance(uint256 resultingBalance, uint256 limit);

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

    // ── Bridge Peer Configuration (SC-LZ-001 hardening) ────────────────────────

    /**
     * @notice Override setPeer to require the contract is NOT paused.
     *
     *         The base OFT `setPeer` is gated by `onlyOwner`. This override adds a
     *         second guard: while the token is paused (e.g. GuardianModule responding
     *         to a suspected key compromise), peer configuration cannot be changed.
     *         If an attacker compromises the Ownable owner key, the guardian can
     *         pause the contract to freeze peer changes until governance intervenes.
     *
     *         Calling pattern: pause first → investigate → either rotate ownership
     *         and unpause, OR governance executes an authorised setPeer.
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
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0)      revert ZeroAmount();
        if (token == address(this)) {
            // Use internal _transfer — the contract is the holder, no approval needed.
            // _update() launch-protection checks will run; mint/burn aren't involved.
            _transfer(address(this), to, amount);
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

    /**
     * @dev Hooks into every token transfer to:
     *  1. Block transfers while paused (emergency circuit breaker).
     *  2. Update ERC20Votes checkpoints for governance power tracking.
     */
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
        whenNotPaused
    {
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
            // Max wallet — recipient is not exempt
            if (maxWalletBalance != 0 && !isExemptFromLimits[to]) {
                if (balanceOf(to) + value > maxWalletBalance)
                    revert WalletExceedsMaxBalance(balanceOf(to) + value, maxWalletBalance);
            }
        }
        // ──────────────────────────────────────────────────────────────────────

        super._update(from, to, value);
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
