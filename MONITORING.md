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

All 13 contracts in the SRX token suite. Priority order:

1. `SRXToken` — supply, transfers, pauses
2. `StabilisationFund` — ETH reserve, stress events
3. `SRXTreasury` — ETH and token balances
4. `BuybackBurner` — burn activity, ETH holdings
5. `SRXOFTNative` — bridge messages, peer config changes
6. `PreSaleRound` — investment activity, oracle health
7. `SRXStaking` — stake/unstake volume
8. `VestingVault` — vesting releases
9. `SRXAirdrop` — claim activity
10. `GuardianModule` — circuit breaker triggers
11. `FeeController` — fee parameter changes
12. `LaunchProtection` — limit changes
13. `SRXOFTAdapter` — bridge adapter activity

---

## Alert Rules

### CRITICAL — Page immediately (24/7)

| Event | Contract | Threshold |
|---|---|---|
| `Paused()` | SRXToken | Any trigger |
| `RoleGranted(DEFAULT_ADMIN_ROLE, ...)` | Any | Any new grantee |
| `RoleRevoked(DEFAULT_ADMIN_ROLE, ...)` | Any | Any revocation |
| `GenesisExecuted` | SRXToken | Any (should fire exactly once) |
| `Upgraded` (UUPS) | Any upgradeable contract | Any |
| ETH balance drop > 20% in 1 block | StabilisationFund | Any |
| `PeerSet` on bridge | SRXOFTNative | Any — validate new peer address |
| Total supply change outside burn/bridge | SRXToken | Any deviation |

### HIGH — Alert within 15 minutes

| Event | Contract | Threshold |
|---|---|---|
| `BuyAndBurn` | SRXToken | Single burn > 10M SRX |
| `StressEventTriggered` | StabilisationFund | Any |
| `CircuitBreakerTriggered` | GuardianModule | Any |
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

Sentinel 3: StabilisationFund — Reserve Health
  Contract: StabilisationFund
  Events: StressEventTriggered, ETHWithdrawn
  Alert channel: PagerDuty HIGH

Sentinel 4: Bridge — Peer and Message Monitoring
  Contract: SRXOFTNative
  Events: PeerSet, all LZ receive events
  Alert channel: PagerDuty CRITICAL

Sentinel 5: All Contracts — Role Changes
  Contracts: All 13
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
