/**
 * dvnCheck.js — the bridge's message verification, read from the LayerZero endpoint.
 *
 * Which messages a chain believes is decided by its receive library and the DVNs
 * (independent verifiers) configured on it. THREAT_MODEL requires at least two, and
 * 07_deploy_bridge.js says the LayerZero defaults are not an accepted configuration.
 * ⛔ Internal review, 7 Oct 2026: both rules were written down and checked nowhere.
 *    External disclosure A (a forged message credited as a return) is exactly what a
 *    single verifier, or a default someone else controls, would let through.
 *
 * Checked, per remote chain, on both the send and the receive side:
 *   - the library is set explicitly for this OApp (not the endpoint's default);
 *   - the effective ULN config needs at least `minDvns` DVNs to agree
 *     (required DVNs + the optional threshold), and lists no DVN twice.
 *
 * `endpoint` needs getSendLibrary, isDefaultSendLibrary, getReceiveLibrary and getConfig
 * (ILayerZeroEndpointV2). Returns failure strings; empty means the chain passes.
 */
const { ethers } = require("hardhat");

const CONFIG_TYPE_ULN = 2;
const ULN_TUPLE = "tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)";

function decodeUln(bytes) {
  const [c] = ethers.AbiCoder.defaultAbiCoder().decode([ULN_TUPLE], bytes);
  return {
    confirmations: c.confirmations,
    requiredDVNs: [...c.requiredDVNs],
    optionalDVNs: [...c.optionalDVNs],
    optionalDVNThreshold: Number(c.optionalDVNThreshold),
  };
}

function ulnFailures(label, uln, minDvns) {
  const out = [];
  const all = [...uln.requiredDVNs, ...uln.optionalDVNs].map((a) => a.toLowerCase());
  if (new Set(all).size !== all.length) out.push(`${label}: a DVN is listed twice`);
  const agreeing = uln.requiredDVNs.length + uln.optionalDVNThreshold;
  if (agreeing < minDvns) {
    out.push(`${label}: a message needs ${agreeing} DVN(s) to agree (${uln.requiredDVNs.length} required + threshold ${uln.optionalDVNThreshold} of ${uln.optionalDVNs.length} optional); at least ${minDvns} are required`);
  }
  return out;
}

async function checkDvnConfig({ endpoint, oapp, remoteEid, minDvns = 2, label = `eid ${remoteEid}` }) {
  const failures = [];
  const sendLib = await endpoint.getSendLibrary(oapp, remoteEid);
  if (await endpoint.isDefaultSendLibrary(oapp, remoteEid)) failures.push(`${label} send: uses the endpoint's default send library`);
  const [recvLib, recvIsDefault] = await endpoint.getReceiveLibrary(oapp, remoteEid);
  if (recvIsDefault) failures.push(`${label} receive: uses the endpoint's default receive library`);
  failures.push(...ulnFailures(`${label} send`, decodeUln(await endpoint.getConfig(oapp, sendLib, remoteEid, CONFIG_TYPE_ULN)), minDvns));
  failures.push(...ulnFailures(`${label} receive`, decodeUln(await endpoint.getConfig(oapp, recvLib, remoteEid, CONFIG_TYPE_ULN)), minDvns));
  return failures;
}

const ENDPOINT_ABI = [
  "function getSendLibrary(address sender, uint32 eid) view returns (address)",
  "function isDefaultSendLibrary(address sender, uint32 eid) view returns (bool)",
  "function getReceiveLibrary(address receiver, uint32 eid) view returns (address lib, bool isDefault)",
  "function getConfig(address oapp, address lib, uint32 eid, uint32 configType) view returns (bytes)",
];

/** LayerZero type-3 options: executor lzReceive gas (worker 1, option 1, uint128 gas). */
function lzReceiveOption(gas) {
  return ethers.solidityPacked(["uint16", "uint8", "uint16", "uint8", "uint128"], [3, 1, 17, 1, BigInt(gas)]);
}

/** A send with empty options must still pay for delivery: enforced options for SEND (msgType 1). */
async function checkEnforcedOptions({ oapp, remoteEid, label = `eid ${remoteEid}` }) {
  const opts = await oapp.enforcedOptions(remoteEid, 1);
  return opts === "0x" ? [`${label}: no enforced options for SEND, so a transfer with empty options cannot be delivered`] : [];
}

module.exports = { checkDvnConfig, checkEnforcedOptions, lzReceiveOption, decodeUln, ulnFailures, ULN_TUPLE, CONFIG_TYPE_ULN, ENDPOINT_ABI };
