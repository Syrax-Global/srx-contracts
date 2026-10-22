/**
 * bridge_events.js — which token logs the circuit-breaker monitor reports, and how much
 * (internal audit 16 Oct 2026, CONTROL-08).
 *
 * The monitor reported OFTSent only: tokens leaving. The attack the breaker exists for is
 * forged RETURNS to Ethereum, which the hub records as OFTReceived and which never emit
 * OFTSent on the hub, so a flood of returns would have left the breaker at zero. Both
 * directions now count against the same bridge volume.
 *
 * Signatures are LayerZero's own (node_modules/@layerzerolabs/oft-evm IOFT.sol).
 * Pure: no network, no environment.
 */
const { ethers } = require("ethers");

const OFT_SENT_SIG     = "OFTSent(bytes32,uint32,address,uint256,uint256)";
const OFT_RECEIVED_SIG = "OFTReceived(bytes32,uint32,address,uint256)";
const OFT_SENT_TOPIC     = ethers.id(OFT_SENT_SIG);
const OFT_RECEIVED_TOPIC = ethers.id(OFT_RECEIVED_SIG);

const OFT_EVENTS_ABI = [
  "event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)",
  "event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)",
];

/**
 * One raw log -> what to report, or null if it is not a bridge movement we count.
 * Anything not from tokenAddr, with another topic, or that does not decode, is ignored.
 *
 * @returns {{ direction: "out"|"in", amount: bigint, eid: number, account: string, guid: string } | null}
 */
function bridgeActivityFromLog(iface, log, tokenAddr) {
  if (tokenAddr && log.address && ethers.getAddress(log.address) !== ethers.getAddress(tokenAddr)) return null;
  let parsed;
  try { parsed = iface.parseLog(log); } catch { return null; }
  if (!parsed) return null;
  if (parsed.name === "OFTSent") {
    return { direction: "out", amount: parsed.args.amountSentLD, eid: Number(parsed.args.dstEid), account: parsed.args.fromAddress, guid: parsed.args.guid };
  }
  if (parsed.name === "OFTReceived") {
    return { direction: "in", amount: parsed.args.amountReceivedLD, eid: Number(parsed.args.srcEid), account: parsed.args.toAddress, guid: parsed.args.guid };
  }
  return null;
}

module.exports = { OFT_SENT_TOPIC, OFT_RECEIVED_TOPIC, OFT_EVENTS_ABI, bridgeActivityFromLog };
