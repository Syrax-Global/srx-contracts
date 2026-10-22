# SRX Token — On-Chain Monitoring Specification

## Overview

On-chain monitoring detects anomalies in real time and triggers alerts before
they become incidents. This document specifies what to monitor, the alert
thresholds, and the tooling stack.

---

## Monitoring Stack

| Tool | Purpose | Cost |
|---|---|---|
| **OpenZeppelin Defender** | Contract monitoring, autotasks, relayer | Free tier covers alerts |
| **Tenderly** | Transaction simulation, alerting, gas tracking | Free tier available |
| **Etherscan webhooks** | Event-based notifications | Free |
| **PagerDuty / OpsGenie** | Alert routing and on-call escalation | On-call for critical alerts |

Primary: OpenZeppelin Defender (Sentinel) for contract event monitoring.
Secondary: Tenderly for simulation and deeper transaction analysis.

---

## Monitored Contracts

All 16 contracts in the SRX token suite (15 in the audit scope, plus `GenesisAgreementRegistry`).
Launch protection lives inside `SRXToken`, and there is no separate bridge adapter: the hub
side of the bridge is `SRXToken` itself. Priority order:

1. `SRXToken` — supply, transfers, pauses, launch limits, bridge stop and inbound limits
2. `StabilisationFund` — stress events, wind-down, stable reserves (it refuses ETH since REG-53)
3. `SRXTreasury` — ETH and token balances
4. `BuybackBurner` — burn activity, ETH holdings
5. `SRXOFTNative` — bridge messages, peer config changes (every spoke)
6. `PreSaleRound` — investment activity, oracle health
7. `SRXStaking` — stake/unstake volume, wind-down
8. `VestingVault` — vesting releases
9. `SRXAirdrop` — claim activity
10. `GuardianModule` — pauses, circuit breaker triggers
11. `FeeController` — fee parameter changes
12. `SRXTimelock` — scheduled and executed operations, role changes
13. `SRXGovernor` — proposals and votes
14. `TGEDistributor` — the one-shot distribution
15. `ZkSyncMigrator` — migration requests
16. `GenesisAgreementRegistry` — agreements recorded

---

## Alert Rules

### CRITICAL — Page immediately (24/7)

| Event | Contract | Threshold |
|---|---|---|
| `Paused()` | SRXToken | Any trigger |
| `TokenPauseStarted` | GuardianModule | Any. The guardian paused the token; `endsAt` is when anyone may lift it. Decide within the first day whether governance must hold it longer (`governanceHoldTokenPause`, ~10-day vote) |
| Guardian token pause reaches `tokenPauseEndsAt` | GuardianModule | Any. Keeper calls `lapseTokenPause()` (anyone may) unless governance has held it |
| `BridgePausedSet(true)` | SRXToken | Any. Bridge sends and returns stopped (guardian or circuit breaker); ordinary transfers continue |
| `WindDownExitAdded` | SRXToken | Any. A contract was added as a wind-down exit (the list is add-only); only SRXStaking, StabilisationFund and their opt-in successors should ever be added |
| `RoleGranted(DEFAULT_ADMIN_ROLE, ...)` | Any | Any new grantee |
| `RoleRevoked(DEFAULT_ADMIN_ROLE, ...)` | Any | Any revocation |
| `GenesisExecuted` | SRXToken | Any (should fire exactly once) |
| `Upgraded` (EIP-1967) | Any SRX contract | Any. Should never fire: no SRX contract is upgradeable (REG-53), so this would mean a proxy where none belongs |
| `WindDownStarted` | SRXStaking, StabilisationFund | Any. Irreversible exit-only mode; confirm who started it (`by`, `byPauseTimeout`) |
| 21 days of pause accumulated in the current run | SRXStaking, StabilisationFund | Any. Once 30 days of pause have accumulated in the run, anyone may switch the contract to exit-only (`windDownOpenToAllAt()` gives the time while paused). Pauses less than 7 days apart (`PAUSE_BREAK`) are one run and only time actually paused counts, so alert at `windDownOpenToAllAt() - 9 days` while paused (or track `pausedInRun` plus the current pause), not on the latest `Paused`. Governance decides before then: lift the pause, or wind down deliberately (Security condition, 12 Oct 2026) |
| `RewardAllocationReleased` | SRXStaking, StabilisationFund | Any. Only after wind-down, by the Timelock, to a successor contract that names the old one as its source; confirm the successor |
| `StableReserveDeposited` from an unexpected address | StabilisationFund | Any (only the treasury holds TREASURY_ROLE; the fund refuses ETH since REG-53) |
| `PeerSet` on bridge | SRXOFTNative | Any — validate new peer address |
| Total supply change outside burn/bridge | SRXToken | Any deviation |

### HIGH — Alert within 15 minutes

| Event | Contract | Threshold |
|---|---|---|
| `BuyAndBurn` | SRXToken | Single burn > 10M SRX |
| `StressEventTriggered` | StabilisationFund | Any |
| `ExitedAfterWindDown` | SRXStaking, StabilisationFund | Volume digest (once wind-down is on, principal is returned with no penalty) |
| `CircuitBreakerTripped` | GuardianModule | Any. Since 12 Oct a trip stops the bridge only (`BridgePausedSet`), never ordinary transfers; only governance reopens |
| `TokenPauseHeldByGovernance` | GuardianModule | Any. Governance took over a guardian token pause; it no longer lapses, and only governance can lift it |
| `TokenPauseEnded` | GuardianModule | Any. A guardian token pause ended (`fullTerm` says whether it ran its whole term); check the run and the 30-day budget it leaves |
| `ModuleCallSkipped` | GuardianModule | Any. A `pauseAll` or unpause could not reach a module (token limits refused it, or its target failed). The emergency did not do what it was meant to |
| `InboundLimitSet` | SRXToken | Any. A chain's return limit changed (a limit of 0 refuses every return; none can exceed `MAX_SUPPLY`) |
| Oracle price deviation | PreSaleRound | ETH price moves > 20% in 1 hour |
| `StalePriceFeed` revert rate | PreSaleRound | > 3 reverts in 10 minutes |
| Bridge message failures | SRXOFTNative | Any failed receive |
| `TokenRescued` | Any contract | Any |
| `ETHRescued` | BuybackBurner | Any |

### MEDIUM — Alert within 1 hour

| Event | Contract | Threshold |
|---|---|---|
| Large transfer | SRXToken | Single transfer > 100M SRX |
| Presale cap approaching | PreSaleRound | > 90% of round cap reached |
| Staking TVL drop | SRXStaking | > 10% drop in 24 hours |
| Vesting claim spike | VestingVault | > 50M SRX claimed in 1 hour |
| Airdrop claim spike | SRXAirdrop | > 100 claims in 1 hour |
| `MaxTransferAmountUpdated` | SRXToken | Any change |
| `MaxWalletBalanceUpdated` | SRXToken | Any change |

### LOW — Daily digest

| Metric | Description |
|---|---|
| Daily burn total | Sum of all `BuyAndBurn` events in 24h |
| Daily bridge volume | Sum of OFT sends/receives in 24h |
| Presale investment totals | Per-token investment volume |
| Oracle feed health | Last update timestamps for all feeds |
| Gas usage trends | Average gas per contract function |

---

## OpenZeppelin Defender Setup

### Sentinels to create at TGE:

```
Sentinel 1: SRXToken — Critical Events
  Contract: SRXToken (mainnet address)
  Events: Paused, RoleGranted, RoleRevoked, GenesisExecuted
  Alert channel: PagerDuty CRITICAL

Sentinel 2: SRXToken — Supply Monitoring
  Contract: SRXToken
  Events: BuyAndBurn, Transfer (filter: amount > 100M SRX)
  Alert channel: Slack #srx-alerts

Sentinel 3: StabilisationFund — Stress and Wind-down
  Contract: StabilisationFund
  Events: StressEventTriggered, StableReserveDeposited, WindDownStarted
  Alert channel: PagerDuty HIGH

Sentinel 4: Bridge — Peer and Message Monitoring
  Contract: SRXOFTNative
  Events: PeerSet, all LZ receive events
  Alert channel: PagerDuty CRITICAL

Sentinel 5: All Contracts — Role Changes
  Contracts: All 16
  Events: RoleGranted, RoleRevoked
  Alert channel: PagerDuty CRITICAL
```

---

## Incident Escalation Matrix

| Severity | Response time | Who gets paged |
|---|---|---|
| CRITICAL | Immediate (< 5 min) | Founder + CTO + on-call |
| HIGH | < 15 minutes | CTO + on-call |
| MEDIUM | < 1 hour | On-call engineer |
| LOW | Next business day | Engineering team |

---

## Pre-Mainnet Checklist

- [ ] OpenZeppelin Defender account created under `jared@syrax.global`
- [ ] All 5 Sentinels configured and tested on Sepolia
- [ ] PagerDuty integration configured
- [ ] Slack `#srx-alerts` channel created and webhook connected
- [ ] Alert runbook linked to each Sentinel (see `INCIDENT_RESPONSE.md`)
- [ ] Test alert fired and confirmed received by all escalation paths
- [ ] Monitoring dashboard created in Tenderly
