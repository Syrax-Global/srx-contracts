// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";
import {SRXOFTNative} from "../../../contracts/bridge/SRXOFTNative.sol";
import {MockLZEndpoint} from "../../../contracts/mocks/MockLZEndpoint.sol";
import {SendParam, MessagingFee} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

/**
 * @title BridgeHandler
 * @notice Drives an Ethereum hub (SRXToken) and one spoke (SRXOFTNative) through
 *         random honest bridging, FORGED spoke mints (a compromised DVN or delegate,
 *         external disclosure A), returns that are refused and retried later, limit
 *         changes, freezes and the passage of time. Neither endpoint relays: the
 *         handler delivers each message by pranking the destination endpoint, which is
 *         what LayerZero's executor does. Ghost state lets BridgeConservationInvariant
 *         check the accounting after every call.
 */
contract BridgeHandler is Test {
    uint32 public constant HUB = 40161;
    uint32 public constant SPOKE = 40102;
    uint256 internal constant UNIT = 1e18; // whole SRX: shared decimals (6) never drop dust

    SRXToken public hub;
    SRXOFTNative public spoke;
    MockLZEndpoint public hubEp;
    MockLZEndpoint public spokeEp;
    address public admin;
    address public alice = address(0xA11CE);
    address public attacker = address(0xBAD);

    struct Pending { address to; uint256 amount; uint64 nonce; bool forged; }
    Pending[] internal pending;
    uint64 internal nonce;

    // Ghost state.
    uint256 public ghost_forgedMinted;   // SRX forged on the spoke
    uint256 public ghost_credited;       // SRX the hub has credited from the spoke
    uint256 public ghost_pendingSum;     // returns sent from the spoke, not yet credited
    uint256 public ghost_lmax;           // highest limit governance ever set
    uint256 public ghost_t0;             // when the campaign started
    uint256 public ghost_refusals;       // returns the hub refused (so the run is known to exercise them)

    constructor(SRXToken _hub, SRXOFTNative _spoke, MockLZEndpoint _hubEp, MockLZEndpoint _spokeEp, address _admin) {
        hub = _hub; spoke = _spoke; hubEp = _hubEp; spokeEp = _spokeEp; admin = _admin;
        ghost_t0 = block.timestamp;
        ghost_lmax = hub.inboundLimit(SPOKE);
    }

    function pendingCount() external view returns (uint256) { return pending.length; }

    function _msg(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(uint160(to))), uint64(amount / 1e12));
    }

    function _param(uint32 dst, address to, uint256 amount) internal pure returns (SendParam memory) {
        return SendParam(dst, bytes32(uint256(uint160(to))), amount, amount, "", "", "");
    }

    function _deliverToSpoke(address to, uint256 amount) internal {
        vm.prank(address(spokeEp));
        spoke.lzReceive(Origin(HUB, bytes32(uint256(uint160(address(hub)))), ++nonce), bytes32(0), _msg(to, amount), address(0), "");
    }

    // ── Actions ────────────────────────────────────────────────────────────

    /// Honest: alice sends from Ethereum to the spoke; delivered at once.
    function sendToSpoke(uint256 whole) external {
        uint256 bal = hub.balanceOf(alice) / UNIT;
        if (bal == 0) return;
        uint256 amount = bound(whole, 1, bal) * UNIT;
        vm.prank(alice);
        hub.send(_param(SPOKE, alice, amount), MessagingFee(0, 0), alice);
        _deliverToSpoke(alice, amount);
    }

    /// Honest: alice sends from the spoke back to Ethereum; the message waits for delivery.
    function returnToHub(uint256 whole) external {
        uint256 bal = spoke.balanceOf(alice) / UNIT;
        if (bal == 0) return;
        uint256 amount = bound(whole, 1, bal) * UNIT;
        vm.prank(alice);
        spoke.send(_param(HUB, alice, amount), MessagingFee(0, 0), alice);
        pending.push(Pending(alice, amount, ++nonce, false));
        ghost_pendingSum += amount;
    }

    /// Attacker: a forged message mints on the spoke, which is sent straight back.
    function forgeAndReturn(uint256 whole) external {
        uint256 amount = bound(whole, 1, 50_000_000) * UNIT;
        _deliverToSpoke(attacker, amount);
        ghost_forgedMinted += amount;
        vm.prank(attacker);
        spoke.send(_param(HUB, attacker, amount), MessagingFee(0, 0), attacker);
        pending.push(Pending(attacker, amount, ++nonce, true));
        ghost_pendingSum += amount;
    }

    /// The executor delivers (or retries) one waiting return.
    function deliver(uint256 index) external {
        if (pending.length == 0) return;
        uint256 i = bound(index, 0, pending.length - 1);
        Pending memory p = pending[i];
        vm.prank(address(hubEp));
        try hub.lzReceive(Origin(SPOKE, bytes32(uint256(uint160(address(spoke)))), p.nonce), bytes32(0), _msg(p.to, p.amount), address(0), "") {
            ghost_credited += p.amount;
            ghost_pendingSum -= p.amount;
            pending[i] = pending[pending.length - 1];
            pending.pop();
        } catch {
            ghost_refusals++; // stays pending: LayerZero keeps a refused message retryable
        }
    }

    function wait(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 2 days));
    }

    function setLimit(uint256 whole) external {
        uint256 limit = bound(whole, 0, 100_000_000) * UNIT;
        vm.prank(admin);
        hub.setInboundLimit(SPOKE, limit);
        if (limit > ghost_lmax) ghost_lmax = limit;
    }

    function freeze() external { vm.prank(admin); hub.freezeInbound(SPOKE); }
    function unfreeze() external { vm.prank(admin); hub.unfreezeInbound(SPOKE); }
}
