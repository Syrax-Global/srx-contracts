// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { SRXToken } from "../token/SRXToken.sol";

/// @notice TEST ONLY. Exposes a raw mint so a test can prove SRXToken._update enforces
///         MAX_SUPPLY on every mint path, independently of the bridge ledger that normally
///         stops an over-cap credit first (sweep 22 Oct 2026: no test failed when the cap
///         check was removed).
contract SRXTokenMintHarness is SRXToken {
    constructor(address endpoint, address admin) SRXToken(endpoint, admin) {}
    function harnessMint(address to, uint256 amount) external { _mint(to, amount); }
}
