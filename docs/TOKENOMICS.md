# SRX tokenomics

> **Generated from `scripts/deploy/00_config.js` by `scripts/docs/tokenomics.js`. Do not edit by hand:**
> change the configuration and run `node scripts/docs/tokenomics.js`. A test fails if this file is out of date.
>
> SRX has not been offered, sold or distributed. This describes the contracts and their configuration; it is
> not an offer, and it makes no statement about price or value.

**Maximum supply:** 10,000,000,000 SRX, minted once at genesis. No further SRX can be minted.

## Allocation

| Allocation | SRX | Share | Held by | Schedule |
|---|---:|---:|---|---|
| Founders | 1,000,000,000 | 10.00% | Vesting contract | 0% at launch; held 365 days, then released evenly over 1095 days |
| Core team | 600,000,000 | 6.00% | Vesting contract | 0% at launch; held 182 days, then released evenly over 730 days |
| Seed investors | 400,000,000 | 4.00% | Vesting contract | 0% at launch; held 273 days, then released evenly over 730 days |
| Presale: launch tranche | 250,000,000 | 2.50% | Multi-signature wallet | Transferable at launch |
| Presale: vesting | 1,150,000,000 | 11.50% | Vesting contract | 0% at launch; held 30 days, then released evenly over 180 days |
| Ecosystem fund | 1,300,000,000 | 13.00% | Vesting contract | 0% at launch; held 30 days, then released evenly over 1460 days |
| Liquidity: official pool | 50,000,000 | 0.50% | Multi-signature wallet | Transferable at launch |
| Liquidity: market maker | 200,000,000 | 2.00% | Multi-signature wallet | Transferable at launch |
| Liquidity: reserve | 950,000,000 | 9.50% | Vesting contract | 0% at launch; held 365 days, then released evenly over 730 days |
| Staking rewards | 1,700,000,000 | 17.00% | SRXStaking contract (reward pool) | Not time-locked; held by the contract |
| Treasury | 900,000,000 | 9.00% | SRXTreasury contract (48-hour governance delay) | Not time-locked; held by the contract |
| Stabilisation fund | 1,500,000,000 | 15.00% | StabilisationFund contract (governance rules) | Not time-locked; held by the contract |
| **Total** | **10,000,000,000** | **100.00%** | | |

## At launch

**500,000,000 SRX (5.00%) is transferable the moment the token launches**, and nothing else is:

| Source | SRX | Share |
|---|---:|---:|
| Presale: launch tranche | 250,000,000 | 2.50% |
| Liquidity: official pool | 50,000,000 | 0.50% |
| Liquidity: market maker | 200,000,000 | 2.00% |
| **Total** | **500,000,000** | **5.00%** |

Every vesting contract releases 0% at launch, including founders, core team and seed investors. Each
transferable allocation goes to a multi-signature wallet: the deployment refuses a single-key wallet.

## Release calendar

Cumulative SRX that vesting contracts have released, on top of the launch tranche, by days after launch.

| Days after launch | Released by vesting contracts | Launch tranche + released | Share of supply |
|---:|---:|---:|---:|
| 0 | 0 | 500,000,000 | 5.00% |
| 30 | 0 | 500,000,000 | 5.00% |
| 31 | 7,279,299 | 507,279,299 | 5.07% |
| 90 | 436,757,990 | 936,757,990 | 9.37% |
| 180 | 1,091,894,977 | 1,591,894,977 | 15.92% |
| 182 | 1,106,453,576 | 1,606,453,576 | 16.06% |
| 210 | 1,333,287,671 | 1,833,287,671 | 18.33% |
| 273 | 1,441,164,383 | 1,941,164,383 | 19.41% |
| 365 | 1,649,109,589 | 2,149,109,589 | 21.49% |
| 730 | 3,282,442,922 | 3,782,442,922 | 37.82% |
| 912 | 4,096,872,146 | 4,596,872,146 | 45.97% |
| 1003 | 4,429,292,237 | 4,929,292,237 | 49.29% |
| 1095 | 4,714,954,337 | 5,214,954,337 | 52.15% |
| 1460 | 5,373,287,671 | 5,873,287,671 | 58.73% |
| 1490 | 5,400,000,000 | 5,900,000,000 | 59.00% |

Released is not the same as circulating: SRX released to a company-held wallet and not placed on a trading
venue is not circulating (see below). The Treasury, Stabilisation Fund and staking reward pool are not in
this calendar: they are not time-locked, and move only under their contracts' governance rules.

## Circulating supply

> **Circulating ≈ vested SRX claimed + liquidity placed on trading venues + airdrop claimed − staking locks − burns.**
>
> Company-held inventory that is not on a trading venue is not circulating.
