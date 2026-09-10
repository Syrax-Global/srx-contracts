// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal mock of LayerZero EndpointV2 for unit tests.
// Only implements functions called during SRXToken/SRXOFTNative construction.
// Does NOT simulate message passing — use the LZ test harness for cross-chain tests.
contract MockLZEndpoint {
    uint32 public immutable eid;

    constructor(uint32 _eid) {
        eid = _eid;
    }

    // Called by OAppCore constructor
    function setDelegate(address) external {}

    // Called by OFT send path (not needed for unit tests but avoids revert)
    function send(
        address, uint32, bytes32, uint256, uint256, bytes calldata, address, bytes calldata
    ) external payable {}

    // Fallback so any unexpected OApp call silently succeeds in tests
    fallback() external payable {}
    receive()  external payable {}
}
