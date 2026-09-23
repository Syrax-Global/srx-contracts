// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    MessagingParams, MessagingReceipt, MessagingFee
} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

// Minimal mock of LayerZero EndpointV2 for unit tests.
// Implements what SRXToken/SRXOFTNative construction and an outbound send() call.
// Does NOT deliver messages — tests impersonate the endpoint to call lzReceive.
contract MockLZEndpoint {
    uint32 public immutable eid;
    uint64 public nonce;

    constructor(uint32 _eid) {
        eid = _eid;
    }

    // Mirrors EndpointV2: an OApp names the address that may configure it.
    // Recorded so the launch gate's delegate check can run against the mock.
    mapping(address => address) public delegates;

    // Called by OAppCore constructor and OAppCore.setDelegate
    function setDelegate(address _delegate) external {
        delegates[msg.sender] = _delegate;
    }

    // Called by OFT.quoteSend — free in tests.
    function quote(MessagingParams calldata, address) external pure returns (MessagingFee memory fee) {
        return fee;
    }

    // Called by OFT.send. Records nothing and delivers nothing; the burn and the
    // outflow accounting happen in the OFT before this call.
    function send(MessagingParams calldata, address)
        external
        payable
        returns (MessagingReceipt memory receipt)
    {
        receipt.nonce = ++nonce;
        receipt.guid = keccak256(abi.encode(address(this), receipt.nonce));
    }

    // Fallback so any unexpected OApp call silently succeeds in tests
    fallback() external payable {}
    receive()  external payable {}
}
