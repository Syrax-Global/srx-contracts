# SRX Token — Contract Reference

The SRX suite is 14 contracts in audit scope (`AUDIT_SCOPE.md` §3), plus `GenesisAgreementRegistry` (out of scope by default,
available on request) and `ZkSyncMigrator` (retired, not deployed), which is 16 contracts in all. None of them is upgradeable: the token and
every other contract are non-upgradeable, and SRXStaking, FeeController, StabilisationFund
and SRXTreasury are plain contracts deployed directly (REG-53). Their code can never change,
no role can upgrade or replace them, and there is no `UPGRADER_ROLE`, `initialize()` or storage
gap. Parameters stay adjustable through their normal roles (governance via the 48-hour
Timelock). A fix ships as a new contract that holders choose to move to, never forced and never
in place (see [`MIGRATION.md`](MIGRATION.md)).

---

## Core

### SRXToken (`contracts/token/SRXToken.sol`)
The canonical SRX ERC-20 on Ethereum. Non-upgradeable.
- **Standards:** ERC-20, ERC-2612 Permit, ERC20Votes (governance), LayerZero V2 OFT.
- **Supply:** fixed 10B, minted once via `genesis()`. Hub `totalSupply` never exceeds 10B (cap enforced in `_update`). A bridge send burns on the hub; a bridge return mints on the hub, only up to what was sent to that chain and within that chain's inbound limit. `buyAndBurn()` is the only permanent reduction on the hub (`totalBurned`; the migrator is retired, CH-13); genuine SRX across all chains is 10B minus `totalBurned`. ⚠️ Open: internal audit M4 and L9 (design pending): a spoke's own `buyAndBurn` reduces supply there, but the hub's `totalBurned` does not change, so this holds only while no spoke burns.
- **Bridge returns:** each remote chain has an inbound limit on the hub, a draining bucket (at most the limit in flight, draining at the limit per 24 hours). A chain with no limit set returns nothing, and no limit can exceed `MAX_SUPPLY`. The guardian can freeze one chain through `GuardianModule.freezeBridgeInbound`; only governance unfreezes, even after the guardian's sunset (deliberate: after it nobody else could re-freeze a compromised chain). While a chain is frozen, a send into that chain is refused too (`InboundChainFrozen`), so no SRX is burned that could not come back. A refused return stays retryable in LayerZero. The exact bound for a compromised chain is its limit, plus one more limit for each day before the guardian freezes it (not just "the limit").
- **Launch protection:** optional, time-limited max-transfer / max-wallet limits with an exemption list. The wallet cap does not apply to SRX leaving a listed wind-down exit (SRXStaking, StabilisationFund), so a holder's own principal always comes back.
- **Own address:** a plain transfer to the hub's own address is refused (`TransferToTokenContract`), as on the spoke. A bridge credit to it still lands, and `rescueTokens` recovers it.
- **Emergency:** `pause()`/`unpause()` (PAUSER_ROLE, held by GuardianModule).
- **Bridge:** `setPeer` has no pause guard (peers can be zeroed during an incident). Ownership is two-step and cannot be renounced; the owner and LayerZero delegate move to the Timelock at the launch hand-over.

### TGEDistributor (`contracts/token/TGEDistributor.sol`)
One-shot genesis distributor. Receives the full 10B mint and sends each allocation to
its destination; `distribute()` is single-use and verifies the total equals MAX_SUPPLY.

### SRXOFTNative (`contracts/bridge/SRXOFTNative.sol`)
SRX representation on remote chains (BNB, zkSync, …). No genesis mint — all supply
originates on Ethereum. It accepts LayerZero messages from the Ethereum hub only, at an address
fixed at deployment (`setPeer` accepts only the hub or zero), and sends to the hub only. Its supply
is capped at 10B on this chain. Its owner and LayerZero delegate are that chain's own SRXTimelock (48 h). It refuses plain transfers to its own address (bridge arrivals are still delivered), and its owner can recover anything stranded there with `rescueTokens`. ⚠️ Open: internal audit M4 (design pending): the admin Safe keeps `DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE` and `BURN_ROLE` on every spoke, and the spoke pause has none of the hub's limits.

> **Integrator note (cross-chain precision):** Per the LayerZero OFT standard, cross-chain
> transfers operate at the OFT `sharedDecimals` granularity (6 decimals). When sending SRX
> across chains, any value below 1e-6 SRX (the bottom 12 of 18 decimals) is "dust" and is
> trimmed on send — it is **not** lost; the OFT `_debit` step leaves it in the sender's
> balance on the source chain. Same-chain ERC-20 transfers use full 18-decimal precision.

---

## Distribution & Vesting

### VestingVault (`contracts/vesting/VestingVault.sol`)
Single-beneficiary linear vesting with optional TGE unlock and cliff. The admin can revoke
unvested tokens (paid: vested→beneficiary, unvested→recipient). For the launch vaults the admin
is the Timelock, so a revoke is a 48-hour governance proposal; a Genesis buyer's vault is
revocable by the presale admin. Nobody can accelerate a schedule. The unvested part goes to a recipient fixed at deployment (the Treasury), never the beneficiary (internal audit M2, fixed 22 Oct 2026). Used for all team/investor/
ecosystem allocations (parameters: `scripts/deploy/00_config.js`).

### PreSaleRound (`contracts/presale/PreSaleRound.sol`)
On-chain presale accepting ETH/USDC/USDT/WBTC with Chainlink pricing, participation-tier
bonuses, and per-investor vault deployment. Oracle reads carry staleness + completeness +
price-bound checks (per-feed staleness configurable). Invest paths are `nonReentrant`.
A payer chooses where its refund goes (`claimRefund(asset, to)`). `quoteStable(stablecoin, stableAmount, investor)`
quotes with that coin's own feed and decimals and reverts for a coin the round does not accept. The admin can put
ETH back after withdrawing it (`returnFunds()`, payable), so a late refund can still be paid.

### SRXAirdrop (`contracts/airdrop/SRXAirdrop.sol`)
Merkle-tree claimable airdrop. Leaves are chain-bound and double-hashed:
`keccak256(keccak256(abi.encode(chainId, recipient, amount)))` (replay + second-preimage hardened).

### GenesisAgreementRegistry (`contracts/genesis/GenesisAgreementRegistry.sol`)
Records that a wallet accepted a purchase agreement, and when, as a salted commitment: the
agreement and the salt stay off-chain, so the record reveals nothing about the person. One
function; no admin, no owner, no funds, no upgrade path.

---

## Staking, Fees & Treasury

### SRXStaking (`contracts/staking/SRXStaking.sol`) — plain, non-upgradeable
Lock SRX for fee-discount tiers (Slate/Onyx/Obsidian) and Synthetix-pattern staking
rewards. Rewards are paid in SRX only, from the fixed 1.7B SRX staking allocation delivered
at launch (capped by the constant `REWARD_ALLOCATION` and by what the launch TGEDistributor
recorded delivering); no fee revenue, buy-back proceeds or later transfer can extend or pay
for them (REG-50). The former second "bonus" reward stream was removed from the code.
Emission is bounded by the funded pool (`periodFinish`). 10% early-exit penalty is sent to the dead address
(`0xdEaD`), which is out of circulation but not counted in `SRXToken.totalBurned`.
Tier is based on the weighted stake (lock multiplier included) while a lock is running, and on the raw principal once the lock has ended or the contract has wound down. New SRX added with `addToPosition` always serves a full term of the position's lock duration. Tier thresholds must rise strictly with the tier, Slate needs more than 0, and discounts never fall as the tier rises (adjacent tiers may share a discount). There is no rescue function for the reward pool: after wind-down, unused allocation can leave only through `releaseRewardAllocation` to a named successor.

**Wind-down (exit-only) mode.** Irreversible. `startWindDown()` can be called by the Timelock
(`GOVERNANCE_ROLE`), by the admin Safe (`WIND_DOWN_ROLE`, which the Safe keeps after the launch
hand-over), or by anyone once the contract has been paused for a total of 30 days within one run of pauses
(`PAUSE_EXIT_DELAY`; pauses less than 7 days apart, `PAUSE_BREAK`, are one run, and only time actually paused counts).
Once on: no new deposits or locks, no reward registrations or rate changes,
and emission stops. `exitAfterWindDown()` returns exactly the caller's own principal with no
penalty and no lock wait, and works while the contract is paused; rewards accrued up to the switch
stay claimable (`claimRewards()` works in wind-down even while paused). No function moves anyone's
tokens for them. Exits have no deadline once wind-down is on; a token-wide `SRXToken` pause still
stops every transfer, exits included.

### FeeController (`contracts/staking/FeeController.sol`) — plain, non-upgradeable
Pure fee calculator (read via `eth_call` by the gateway). Applies payment-type multipliers
and staking-tier discounts; SRX payments are always zero-fee. A 15 bps fee floor applies
to other payments even at a 100% discount. Holds no funds. `GATEWAY_ROLE` is defined but gates
no function today (the backend only reads).

### SRXTreasury (`contracts/treasury/SRXTreasury.sol`) — plain, non-upgradeable
DAO treasury. **All spend requires `SPENDER_ROLE`, held only by the Timelock.** Executes
quarterly buy-and-burn. The contract is not upgradeable: its code can never change.

### StabilisationFund (`contracts/stabilisation/StabilisationFund.sol`) — plain, non-upgradeable
The 1.5B Strategic Reserve with a three-tier emergency-response model (DEPLOYER 30% /
GUARDIAN 70% fast paths during a declared stress event; GOVERNANCE has no percentage cap, but is bound by the free-balance check like the others).
Only governance can end a stress event, except that starting wind-down also ends it for good.
Fast-path deployment is restricted to a governance-approved target allowlist. Contributor
rewards use the pool-bounded Synthetix pattern and are paid in SRX only, from a fixed
`rewardAllocation` set once at deployment (at most the fund's 1.5B launch allocation) and
backed only by launch SRX the TGEDistributor delivered. Platform fees go to the Treasury,
never the fund (`receiveFees()` was removed). No caller, governance included, can deploy
depositors' principal or reward SRX; `recoverLiquidity()` was removed (finding R7-16). A
contributor's withdrawal lock is per position (per address): governance can change the lock length only for
later deposits, and to at most 90 days (also enforced in the constructor); a top-up can extend the unlock time,
never bring it forward. Below `minTotalForEmission` (governance-set; inactive at 0)
emission does not accrue. There is no rescue function for the reward pool, as in SRXStaking.

**Wind-down (exit-only) mode.** Irreversible, with the same three ways to start it as SRXStaking
(Timelock, the admin Safe's `WIND_DOWN_ROLE`, or anyone after a 30-day pause that no break of 7 days
or more has interrupted). Once on: no
new contributions, no reward registrations or rate changes, no stress events, and emission stops.
`exitAfterWindDown()` returns exactly the caller's own principal with no penalty and no lock wait,
and works while the contract is paused; rewards accrued up to the switch stay claimable. No function
moves anyone's tokens for them; governance can still move only the fund's free SRX. Exits have no
deadline once wind-down is on; a token-wide `SRXToken` pause still stops every transfer, exits
included.

---

## Governance & Security

### SRXGovernor (`contracts/governance/SRXGovernor.sol`)
OpenZeppelin Governor: 1-day voting delay, 7-day period, 1M-SRX proposal threshold,
timestamp clock. Quorum is 4% of the fixed 10B cap (400M SRX); For and Abstain both count toward
it, and a proposal also needs more For than Against. Token-weighted via ERC20Votes delegation.

### SRXTimelock (`contracts/governance/SRXTimelock.sol`)
48-hour TimelockController. Proposer = Governor; executor = anyone (post-delay); canceller =
guardian during the transition period. It has a delay floor (`minDelayFloor`, the deployment
delay, 48 h on mainnet): `updateDelay` below it reverts. Controls treasury spend,
fee/staking params, bridge peers. ⚠️ Open: internal audit M8 (design pending): the Safe's veto can cancel the very operation that would remove it.

### BuybackBurner (`contracts/buyback/BuybackBurner.sol`)
Burns SRX through `SRXToken.buyAndBurn()`, which reduces the supply of SRX: directly from SRX it holds,
or after a swap through an approved router. Swaps are capped per token, per swap and per
24 hours (a draining bucket, not a fixed or rolling window); a token with no caps cannot be
swapped; router approvals are exact and reset.

### GuardianModule (`contracts/guardian/GuardianModule.sol`)
Standalone, non-upgradeable security layer with an **immutable sunset**, at most 180 days after deployment (enforced in the constructor; it can only be reduced).
A guardian pause of the token runs at most 14 days, after which anyone may lift it (`lapseTokenPause`); a full term is followed by a 7-day block, and guardian token pauses total at most 30 days. Pauses less than 7 days apart count as one run of at most 14 days, so unpausing early and pausing again buys nothing. Only governance can hold one longer (`governanceHoldTokenPause`), and a pause governance holds, or an outside pause that `pauseAll` adopted, can be lifted only by governance. The circuit breaker stops the bridge only (the token's `setBridgePaused`), never ordinary transfers.
Per-module pause and unpause (`pauseModule` will not pause the same module again within an hour of its last pause; `pauseAll` ignores that per-module wait by design, with 30 minutes between uses of `pauseAll` itself; unpausing has no delay), an emergency pause-all, a per-chain bridge freeze (`freezeBridgeInbound`, lifted only by governance, even after the sunset), a bridge-volume circuit
breaker (a draining bucket; a trip lasts until governance calls `resetCircuitBreaker`, and the guardian cannot re-open it), and governance override (governance can always unpause, though the guardian can re-pause after its cooldown, except where the pause is governance's own). Governance is the 48 h Timelock in the deployed topology. Guardian powers, including breaker reporting, end at the sunset; after it, anyone may lift a pause the guardian left (`releaseAfterSunset`, which emits `ReleasedAfterSunset`). Only the six module ids can be registered, with one `pause()` module per target, and `updateModuleTarget` is refused while the guardian holds that module paused.

### ZkSyncMigrator (`contracts/migration/ZkSyncMigrator.sol`): RETIRED, not deployed
Retired by decision CH-13 (Jared, 22 Oct 2026); the contract and its tests stay in the repository as
history. SRX moves onto Syrax Chain through the chain's own bridge: a holder signs one deposit, the SRX
is locked 1:1 in the Ethereum vault and appears on Syrax Chain, withdrawable back at any time. Holders
on BNB Chain or ZKsync Era first return to the Ethereum hub over the existing OFT bridge. The retired
design burned SRX on Ethereum and relied on a Syrax-run oracle to issue the SRX on the destination; on
that chain SRX exists only as SRX locked on Ethereum, so it would have needed a funded reserve and a hot
key, and would have shrunk supply twice. Any future helper must be stateless and hold no funds and no
roles. `scripts/deploy/09_deploy_migrator.js` refuses to run and `scripts/verify/verify_roles.js` fails a
network that declares a migrator.

---

## Role Topology (post-deployment target)

| Role | Holder (mainnet) |
|---|---|
| `DEFAULT_ADMIN_ROLE` (core contracts) | SRXTimelock (the Safe holds none after the hand-over) |
| `DEFAULT_ADMIN_ROLE` (BuybackBurner, SRXAirdrop; PreSaleRound admin) | Gnosis Safe (≥3/5), by design: see `MULTISIG_SPEC.md` |
| `WIND_DOWN_ROLE` (SRXStaking, StabilisationFund) | Gnosis Safe (≥3/5): the Safe keeps it after the hand-over; never the deployer |
| `GOVERNANCE_ROLE` | SRXTimelock |
| `SPENDER_ROLE` (Treasury) | SRXTimelock |
| `PAUSER_ROLE` | GuardianModule |
| SSF `DEPLOYER_ROLE` / `GUARDIAN_ROLE` | distinct multisigs |
| Bridge `owner()` (`setPeer`), hub and each spoke | The SRXTimelock on that chain |

⚠️ Open: internal audit M4 (design pending). The table is the target. On each spoke the admin Safe
still holds `DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE` and `BURN_ROLE` directly; only the spoke's `owner()`
and LayerZero delegate move to the spoke Timelock.

Enforced pre-mainnet by `scripts/verify/verify_roles.js` (`npm run verify:roles`), which
fails unless the deployer EOA holds none of the roles it checks, the four contracts above are not
proxies, and `WIND_DOWN_ROLE` is held by the Safe (it checks the expected holders, not an
enumeration).
See [`MULTISIG_SPEC.md`](../MULTISIG_SPEC.md) for the migration runbook.
