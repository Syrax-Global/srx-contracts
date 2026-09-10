# SRX Token — Contract Reference

The SRX suite is 13 production contracts. The token itself is non-upgradeable;
four peripheral contracts are UUPS-upgradeable with upgrade authority held by the
governance Timelock.

---

## Core

### SRXToken (`contracts/token/SRXToken.sol`)
The canonical SRX ERC-20 on Ethereum. Non-upgradeable.
- **Standards:** ERC-20, ERC-2612 Permit, ERC20Votes (governance), LayerZero V2 OFT.
- **Supply:** fixed 10B, minted once via `genesis()`; `buyAndBurn()` is the only supply-reducing path.
- **Launch protection:** optional, time-limited max-transfer / max-wallet limits with an exemption list.
- **Emergency:** `pause()`/`unpause()` (PAUSER_ROLE, held by GuardianModule).
- **Bridge:** `setPeer` overridden with `whenNotPaused`; ownership → Timelock pre-mainnet.

### TGEDistributor (`contracts/token/TGEDistributor.sol`)
One-shot genesis distributor. Receives the full 10B mint and sends each allocation to
its destination; `distribute()` is single-use and verifies the total equals MAX_SUPPLY.

### SRXOFTNative (`contracts/bridge/SRXOFTNative.sol`)
SRX representation on remote chains (BNB, zkSync, …). No genesis mint — all supply
originates on Ethereum and is minted here only against a verified LayerZero burn message.

> **Integrator note (cross-chain precision):** Per the LayerZero OFT standard, cross-chain
> transfers operate at the OFT `sharedDecimals` granularity (6 decimals). When sending SRX
> across chains, any value below 1e-6 SRX (the bottom 12 of 18 decimals) is "dust" and is
> trimmed on send — it is **not** lost; the OFT `_debit` step leaves it in the sender's
> balance on the source chain. Same-chain ERC-20 transfers use full 18-decimal precision.

---

## Distribution & Vesting

### VestingVault (`contracts/vesting/VestingVault.sol`)
Single-beneficiary linear vesting with optional TGE unlock and cliff. Admin can revoke
unvested tokens (paid: vested→beneficiary, unvested→treasury). Used for all team/investor/
ecosystem allocations.

### PreSaleRound (`contracts/presale/PreSaleRound.sol`)
On-chain presale accepting ETH/USDC/USDT/WBTC with Chainlink pricing, participation-tier
bonuses, and per-investor vault deployment. Oracle reads carry staleness + completeness +
price-bound checks (per-feed staleness configurable). Invest paths are `nonReentrant`.

### SRXAirdrop (`contracts/airdrop/SRXAirdrop.sol`)
Merkle-tree claimable airdrop. Leaves are chain-bound and double-hashed:
`keccak256(keccak256(abi.encode(chainId, recipient, amount)))` (replay + second-preimage hardened).

---

## Staking, Fees & Treasury

### SRXStaking (`contracts/staking/SRXStaking.sol`) — UUPS
Lock SRX for fee-discount tiers (Slate/Onyx/Obsidian) and Synthetix-pattern incentive
rewards (primary SRX pool + optional bonus/real-yield pool). Emission is bounded by the
funded pool (`periodFinish`). 10% early-exit penalty burned.

### FeeController (`contracts/staking/FeeController.sol`) — UUPS
Pure fee calculator (read via `eth_call` by the gateway). Applies payment-type multipliers
and staking-tier discounts; SRX payments are always zero-fee. Holds no funds.

### SRXTreasury (`contracts/treasury/SRXTreasury.sol`) — UUPS
DAO treasury. **All spend requires `SPENDER_ROLE`, held only by the Timelock.** Executes
quarterly buy-and-burn. Upgrade authority is a dedicated Timelock-only `UPGRADER_ROLE`.

### StabilisationFund (`contracts/stabilisation/StabilisationFund.sol`) — UUPS
The 1.5B Strategic Reserve with a three-tier emergency-response model (DEPLOYER 30% /
GUARDIAN 70% fast paths during a declared stress event; GOVERNANCE unrestricted). Fast-path
deployment is restricted to a governance-approved target allowlist. Contributor rewards use
the pool-bounded Synthetix pattern.

---

## Governance & Security

### SRXGovernor (`contracts/governance/SRXGovernor.sol`)
OpenZeppelin Governor: 1-day voting delay, 7-day period, 1M-SRX proposal threshold,
4% quorum, timestamp clock. Token-weighted via ERC20Votes delegation.

### SRXTimelock (`contracts/governance/SRXTimelock.sol`)
48-hour TimelockController. Proposer = Governor; executor = anyone (post-delay); canceller =
guardian during the transition period. Controls treasury spend, upgrades, fee/staking params, bridge peers.

### GuardianModule (`contracts/guardian/GuardianModule.sol`)
Standalone, non-upgradeable security layer with an **immutable sunset** (can only be reduced).
Per-module pause/unpause with cooldowns, an emergency pause-all, a bridge-volume circuit
breaker, and governance override (governance can always unpause; guardian cannot block governance).

### ZkSyncMigrator (`contracts/migration/ZkSyncMigrator.sol`)
Burn-to-migrate path for the future Syrax Chain transition. Users burn SRX; a bridge oracle
issues native SRX on the destination. One-way enable; governance-closable window.

---

## Role Topology (post-deployment target)

| Role | Holder (mainnet) |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Gnosis Safe (≥3/5) |
| `UPGRADER_ROLE` (UUPS) | SRXTimelock **only** |
| `GOVERNANCE_ROLE` | SRXTimelock |
| `SPENDER_ROLE` (Treasury) | SRXTimelock |
| `PAUSER_ROLE` | GuardianModule |
| SSF `DEPLOYER_ROLE` / `GUARDIAN_ROLE` | distinct multisigs |
| Bridge `owner()` (`setPeer`) | SRXTimelock (preferred) |

Enforced pre-mainnet by `scripts/verify/verify_roles.js` (`npm run verify:roles`), which
fails unless the deployer EOA holds zero roles and `UPGRADER_ROLE` is Timelock-only.
See [`MULTISIG_SPEC.md`](../MULTISIG_SPEC.md) for the migration runbook.
