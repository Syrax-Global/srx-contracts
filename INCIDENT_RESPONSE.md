# SRX Token — Incident Response Playbook

## Severity Definitions

| Severity | Definition | Examples |
|---|---|---|
| **SEV-1** | Active exploit or imminent loss of funds | Reentrancy draining contracts, unauthorized role grant, bridge manipulation |
| **SEV-2** | Protocol malfunction affecting users | Token transfers paused unexpectedly, oracle failure, presale accepting wrong prices |
| **SEV-3** | Degraded functionality, no immediate fund risk | UI down, RPC errors, slow oracle updates |
| **SEV-4** | Informational, no user impact | Unusual on-chain activity with no confirmed exploit |

---

## Response Team

| Role | Responsibility |
|---|---|
| **Incident Commander** | Founder — owns the incident end-to-end |
| **Technical Lead** | CTO — leads technical diagnosis and fix |
| **Comms Lead** | Founder or designated — manages external communication |
| **Safe Signer 1–5** | Available for emergency multisig transactions |

All SEV-1 and SEV-2 incidents require the Incident Commander to be active
within 15 minutes of the first alert.

---

## SEV-1 Playbook — Active Exploit

### Immediate actions (first 15 minutes)

1. **Confirm the exploit** — Check on-chain data (Etherscan, Tenderly).
   Do not act on unconfirmed reports.

2. **Pause the token** — Assemble 3 Safe signers immediately.
   ```
   Safe tx: SRXToken.pause()
   ```
   This halts all transfers, bridging, and staking deposits.

3. **Pause all other contracts** — If exploit spans multiple contracts:
   ```
   Safe tx: each affected contract .pause()
   ```

4. **Revoke compromised roles** — If an admin key is compromised:
   ```
   Safe tx: contract.revokeRole(role, compromisedAddress)
   ```
   Grant role to a fresh address if needed.

5. **Freeze bridge peers** — If LayerZero bridge is involved:
   ```
   Safe tx: SRXOFTNative.setPeer(chainId, bytes32(0))
   ```
   Setting peer to zero32 blocks all inbound/outbound bridge messages.

6. **Notify LayerZero** — Contact security@layerzero.network immediately
   if the exploit involves the bridge layer.

### Containment (15 minutes – 2 hours)

7. **Quantify the damage** — Total funds at risk, funds already drained,
   affected users.

8. **Preserve evidence** — Save all transaction hashes, block numbers,
   attacker addresses. Do not wipe any logs.

9. **Draft user communication** — Acknowledge the incident publicly.
   Do NOT disclose exploit details until contained.
   Template: *"We are investigating unusual activity on the SRX protocol.
   Token transfers have been temporarily paused as a precaution.
   Funds are being assessed. Update in 1 hour."*

10. **Engage Halborn** — Contact your Halborn account manager for
    emergency incident support.

### Recovery (2 hours onwards)

11. **Root cause analysis** — Identify the exact vulnerability.

12. **Write and audit the fix** — Do not deploy an unreviewed fix.
    Even under time pressure, a second set of eyes is mandatory.

13. **Deploy fix on testnet first** — Verify the fix closes the vector
    without breaking other functionality.

14. **Deploy fix on mainnet** — Via Safe multisig only.

15. **Unpause gradually** — Unpause contracts one at a time, monitor
    for 30 minutes between each.

16. **Post-mortem** — Write a full post-mortem within 72 hours.
    Publish it publicly (see disclosure policy in `SECURITY.md`).

---

## SEV-2 Playbook — Protocol Malfunction

### Oracle failure (StalePriceFeed errors)

1. Confirm Chainlink feed is down (check feeds.chain.link).
2. If feed is down, the presale will revert on all ETH/BTC investments.
   USDC/USDT investments still work if stablecoin feeds are set.
3. Notify users via social channels that ETH/BTC presale is temporarily paused.
4. No Safe action needed unless the outage exceeds 24 hours.
5. If > 24 hours: pause the presale via Safe.

### Unexpected token pause

1. Confirm who called `pause()` — check Etherscan.
2. If called by the Safe, confirm it was an authorised action.
3. If called by an unknown address, treat as SEV-1.
4. If authorised: communicate to users, provide ETA for unpause.

### Bridge message failure

1. Check LayerZero scan (layerzeroscan.com) for the failed message.
2. Failed messages can be retried — they are not lost.
3. Contact LayerZero support if retry fails.
4. Do not freeze peers unless there is evidence of an exploit.

---

## SEV-3 / SEV-4 Playbook

1. Log the event in the incident register (below).
2. Assign an engineer to investigate within 1 hour (SEV-3) or next
   business day (SEV-4).
3. Resolve and close with a brief note.

---

## Communication Templates

### Initial alert (post within 15 minutes of SEV-1/SEV-2 confirmation)
> We are aware of an issue affecting [component]. Our team is actively
> investigating. Token transfers have been [paused/not affected].
> We will provide an update within [timeframe]. User funds are [status].

### Resolved notice
> The issue affecting [component] has been resolved. [Brief explanation
> of what happened and what was fixed]. A full post-mortem will be
> published within 72 hours. Thank you for your patience.

---

## Incident Register

All incidents must be logged here, regardless of severity.

| Date | Severity | Summary | Status | Post-mortem |
|---|---|---|---|---|
| — | — | No incidents recorded | — | — |

---

## Post-Mortem Template

Every SEV-1 and SEV-2 must produce a post-mortem published publicly.

```
Title: [Date] SRX Token Incident Post-Mortem
Severity: SEV-X
Date/time: UTC
Duration: X hours

Summary:
[2-3 sentence summary of what happened]

Timeline:
- HH:MM UTC — Alert triggered
- HH:MM UTC — Team assembled
- HH:MM UTC — Root cause identified
- HH:MM UTC — Fix deployed
- HH:MM UTC — Services restored

Root Cause:
[Technical explanation]

Impact:
[Funds at risk, users affected, duration]

Resolution:
[What was done to fix it]

Prevention:
[What changes prevent recurrence]
```

---

## Emergency Contacts

| Contact | Purpose |
|---|---|
| security@layerzero.network | LayerZero bridge issues |
| Halborn account manager | Audit firm emergency support |
| OpenZeppelin Defender support | Monitoring platform issues |
| Chainlink support | Oracle feed issues |

---

## Pre-Mainnet Checklist

- [ ] All team members have read this playbook
- [ ] Safe signing flow tested with all 5 signers
- [ ] `pause()` transaction pre-staged in Safe for 1-click execution
- [ ] Emergency contact list verified and current
- [ ] Incident communication channels confirmed (Twitter/X, Discord, Telegram)
- [ ] Post-mortem template shared with comms lead
