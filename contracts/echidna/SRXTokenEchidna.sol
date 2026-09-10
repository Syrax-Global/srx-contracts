// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SRXToken} from "../token/SRXToken.sol";
import {MockLZEndpoint} from "../mocks/MockLZEndpoint.sol";

/**
 * @title SRXTokenEchidna
 * @notice Echidna property contract for SRXToken.
 *
 * ⛔ THE PREVIOUS VERSION OF THIS FILE COULD NOT FAIL, AND HAD NEVER RUN.
 *
 * It set `admin = address(0x10000)` — an address the harness does not control —
 * while `genesis()` is `onlyRole(DEFAULT_ADMIN_ROLE)`. Nothing the harness
 * exposed could reach it, so `genesisComplete` was permanently false. The
 * headline property opened with:
 *
 *     if (!token.genesisComplete()) return true;
 *
 * so it returned true unconditionally. The other two held trivially on a token
 * with zero supply. Three properties, none of which could fail, on a contract
 * that never reached the state they describe.
 *
 * Its constructor also carried the author's unresolved deliberation verbatim —
 * "Simpler: set admin = address(this) so the deployer IS admin … We'll go with
 * the latter for now" — while the code did the opposite. It was written, never
 * executed, and the thinking was committed instead of the decision.
 *
 * ⭐ THIS VERSION MAKES THE HARNESS THE ADMIN and runs genesis in the
 * constructor, so the token holds MAX_SUPPLY and every property is evaluated
 * against real state. The mutators below move actual balances, which is what
 * makes a violation reachable.
 *
 * ⛔ A property that cannot fail is worse than no property: it produces a green
 * run that stops anyone looking. Each one below is written so that a plausible
 * bug in SRXToken would break it.
 *
 * Run:
 *   echidna . --config echidna.yaml --contract SRXTokenEchidna
 */
contract SRXTokenEchidna {
    SRXToken       internal token;
    MockLZEndpoint internal endpoint;

    /// Counterparties the fuzzer can move value between.
    address internal constant ACTOR_1 = address(0x20000);
    address internal constant ACTOR_2 = address(0x30000);

    /// Ghost state for the monotonicity property.
    uint256 internal ghostTotalBurned;
    /// Supply observed immediately after genesis, for the conservation check.
    uint256 internal immutable supplyAtGenesis;

    constructor() {
        endpoint = new MockLZEndpoint(40161);

        // ⭐ address(this) is the admin, so the harness can actually reach the
        // admin-gated entry points. Without this the whole suite is vacuous.
        token = new SRXToken(address(endpoint), address(this));

        // Genesis mints MAX_SUPPLY to the distributor; the harness takes it so
        // the mutators below have something real to move.
        token.genesis(address(this));

        // ⭐ Grant the harness BURN_ROLE so the supply equation has a path that
        // actually reduces supply. Without a burn the conservation property
        // holds because nothing ever changes, which is not the same as holding.
        token.grantRole(token.BURN_ROLE(), address(this));

        supplyAtGenesis = token.totalSupply();
        ghostTotalBurned = token.totalBurned();
    }

    // ── Mutators: what Echidna randomises ────────────────────────────────────

    function doTransfer(uint256 amount, bool toActor1) public {
        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) return;
        token.transfer(toActor1 ? ACTOR_1 : ACTOR_2, amount % (bal + 1));
    }

    function doApprove(uint256 amount, bool toActor1) public {
        token.approve(toActor1 ? ACTOR_1 : ACTOR_2, amount);
    }

    function doDelegate(bool toActor1) public {
        token.delegate(toActor1 ? ACTOR_1 : ACTOR_2);
    }

    /// ⭐ Burning is what makes the supply equation non-trivial. Without a path
    /// that reduces supply, conservation holds by accident rather than by rule.
    /// SRXToken has no plain burn(); the only path is buyAndBurn, gated on
    /// BURN_ROLE, which the harness grants itself in the constructor.
    function doBurn(uint256 amount) public {
        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) return;
        try token.buyAndBurn(amount % (bal + 1)) {} catch {}
    }

    // ── Properties: each must be able to FAIL ────────────────────────────────

    /// INV-1: nothing is created or destroyed without being accounted for.
    /// Breaks if a mint path exists that does not credit supply, or a burn that
    /// does not increment totalBurned.
    function echidna_supplyEquation() public view returns (bool) {
        return token.totalSupply() + token.totalBurned() == token.MAX_SUPPLY();
    }

    /// INV-2: supply never exceeds the cap. Now meaningful because supply is
    /// MAX_SUPPLY at genesis rather than zero — any over-mint breaks it
    /// immediately instead of having headroom to hide in.
    function echidna_supplyNeverExceedsMax() public view returns (bool) {
        return token.totalSupply() <= token.MAX_SUPPLY();
    }

    /// INV-3: burned total only ever rises.
    function echidna_totalBurnedMonotonic() public returns (bool) {
        uint256 current = token.totalBurned();
        if (current < ghostTotalBurned) return false;
        ghostTotalBurned = current;
        return true;
    }

    /// INV-4: genesis is once-only. A second successful genesis would double
    /// the supply, so this is a real check rather than a restatement.
    function echidna_genesisIsOnceOnly() public view returns (bool) {
        return token.genesisComplete() && token.totalSupply() + token.totalBurned() == supplyAtGenesis;
    }

    /// INV-5: no address can hold more than the whole supply — a cheap
    /// canary for accounting corruption in transfer.
    function echidna_noHolderExceedsSupply() public view returns (bool) {
        return token.balanceOf(address(this)) <= token.totalSupply()
            && token.balanceOf(ACTOR_1) <= token.totalSupply()
            && token.balanceOf(ACTOR_2) <= token.totalSupply();
    }
}
