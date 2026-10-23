// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// TEST ONLY (review 22 Oct 2026). Forces ETH into a contract with no receive():
/// SELFDESTRUCT still transfers the balance after Cancun (EIP-6780).
contract Review2210ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}

/// TEST ONLY. A buyer contract (e.g. a smart-contract wallet module) that can pay
/// ETH into the round but cannot receive ETH back.
contract Review2210NoReceiveBuyer {
    address public immutable round;

    constructor(address _round) {
        round = _round;
    }

    function buyETH() external payable {
        (bool ok, bytes memory ret) = round.call{ value: msg.value }(abi.encodeWithSignature("invest()"));
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }

    /// @dev Review round 22 Oct (C3): the refund is paid to `to`, not necessarily to this contract.
    function claim(address asset, address to) external {
        (bool ok, bytes memory ret) = round.call(abi.encodeWithSignature("claimRefund(address,address)", asset, to));
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
    // no receive(), no payable fallback
}

/// TEST ONLY. Stands in for a Safe executing a Transaction Builder batch: every call
/// in one transaction, in order, all-or-nothing (as MultiSend does).
contract Review2210BatchExecutor {
    function exec(address[] calldata targets, bytes[] calldata datas) external {
        for (uint256 i = 0; i < targets.length; i++) {
            (bool ok, bytes memory ret) = targets[i].call(datas[i]);
            if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
}
