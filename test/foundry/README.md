# Foundry Test Suite

This directory contains Foundry-based property and invariant tests that
complement the 642 Hardhat unit tests in `../*.test.js`.

## Why Foundry alongside Hardhat?

Hardhat is excellent for unit tests with rich mocha/chai assertions.
Foundry is excellent for two specific things:

1. **Invariant testing** — runs randomized sequences of calls and asserts
   that a property holds at every step. Catches multi-step state-corruption
   bugs that example-based tests miss.
2. **Property-based fuzzing** — runs a function under thousands of random
   inputs and asserts a property each time. Catches input-dependent edge
   cases.

We keep Hardhat as the primary harness. Foundry runs:
- Locally via `forge test`
- In CI via `.github/workflows/ci.yml`
- Nightly via the heavier `[profile.ci]` configuration

## Layout

```
test/foundry/
├── README.md                       # this file
├── invariant/                      # invariant test contracts
│   ├── SRXTokenInvariant.t.sol     # SC-INV-001 supply equation
│   ├── ERC20VotesInvariant.t.sol   # SC-INV-002 voting power conservation
│   ├── StakingInvariant.t.sol      # SC-INV-003 accumulator monotonicity
│   └── TreasuryInvariant.t.sol     # accounting consistency
├── property/                       # property-based fuzz tests
│   ├── PreSaleRoundFuzz.t.sol      # presale tier math under random USD inputs
│   └── BuybackBurnerFuzz.t.sol     # burn accounting under random balances
└── helpers/
    └── Actors.sol                  # actor handlers for invariant tests
```

## Running

```bash
# All Foundry tests
forge test -vv

# Invariant tests only (with default 256 runs × 50 depth)
forge test --match-path "test/foundry/invariant/*"

# Heavy CI profile (1024 runs × 100 depth)
FOUNDRY_PROFILE=ci forge test --match-path "test/foundry/invariant/*"

# A single invariant test, very verbose
forge test --match-test invariant_totalSupplyEquation -vvvv
```

## Setup (one-time)

Foundry is a Rust binary. Install via:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Then install forge-std (required for `Test.sol`, `console.sol`, helpers):

```bash
forge install foundry-rs/forge-std --no-commit
```

Verify:

```bash
forge --version
forge build
```

The Hardhat suite is unaffected — `forge build` and `npx hardhat compile`
produce artefacts in separate directories (`foundry-out/` vs `artifacts/`).

## Writing new invariants

1. Identify the property that must hold (e.g. "total supply equals genesis minus burns")
2. Write a handler contract in `helpers/` that exposes the operations
   Foundry should randomize over (transfers, stakes, claims, etc.)
3. Write the invariant test in `invariant/` that asserts the property
   after every randomized sequence
4. Run locally; if it fails, Foundry will minimize the failing sequence

See the existing `SRXTokenInvariant.t.sol` for an annotated template.
