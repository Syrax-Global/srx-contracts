/**
 * bridge_proof.js — prove the hub-and-spoke bridge on real test networks (disclosure A).
 *
 * TEST NETWORKS ONLY. Modes (set MODE=…):
 *   status   — this chain's view: balances, peer, and on the hub the outstanding amount,
 *              the daily return limit, what is available now, and the freeze flag
 *   send     — send AMOUNT whole SRX from the deployer to itself on the other chain;
 *              prints the source transaction (for LayerZero Scan and for retry)
 *   retry    — on the DESTINATION chain: re-deliver the last message sent from the other
 *              chain (read from PROOF_LOG), which was refused earlier. SRC_RPC = the
 *              source chain's RPC.
 *
 * PROOF_LOG (a local JSON file) records each send's transaction, so no hash is ever typed
 * into a command (the workspace secret guard cannot tell a public tx hash from a key).
 *              LayerZero V2 keeps a refused message verified; anyone may retry it.
 *   limit    — hub only: setInboundLimit(spoke, AMOUNT whole SRX)          (governance)
 *   freeze / unfreeze — hub only: freezeInbound / unfreezeInbound(spoke)   (pauser / governance)
 *   guardian-freeze — hub only: GuardianModule.freezeBridgeInbound(spoke)  (the guardian)
 *
 *   MODE=send AMOUNT=1000 npx hardhat run scripts/ops/bridge_proof.js --network sepolia
 *
 * Reads SRX_TOKEN_SEPOLIA and SRX_OFT_NATIVE_BSCTESTNET. No key is read or printed here:
 * the signer is the one hardhat.config.js loads.
 */
const { ethers, network } = require("hardhat");
const { LZ_EIDS, TESTNET_CHAINS } = require("../deploy/00_config");

const HUB = { network: "sepolia", eid: LZ_EIDS.sepolia, env: "SRX_TOKEN_SEPOLIA", artifact: "SRXToken" };
const SPOKE = { network: "bscTestnet", eid: LZ_EIDS.bscTestnet, env: "SRX_OFT_NATIVE_BSCTESTNET", artifact: "SRXOFTNative" };
const E = (n) => ethers.parseUnits(String(n), 18);
const f = (v) => ethers.formatUnits(v, 18);

// PacketV1: version(1) nonce(8) srcEid(4) sender(32) dstEid(4) receiver(32) guid(32) message(...)
function decodePacket(hex) {
  const b = ethers.getBytes(hex);
  const slice = (s, n) => ethers.hexlify(b.slice(s, s + n));
  return {
    nonce: BigInt(slice(1, 8)), srcEid: Number(BigInt(slice(9, 4))), sender: slice(13, 32),
    dstEid: Number(BigInt(slice(45, 4))), receiver: ethers.getAddress("0x" + slice(49, 32).slice(26)),
    guid: slice(81, 32), message: ethers.hexlify(b.slice(113)),
  };
}

async function main() {
  if (!TESTNET_CHAINS.has(network.name)) throw new Error(`Refusing ${network.name}: test networks only`);
  const here = network.name === HUB.network ? HUB : network.name === SPOKE.network ? SPOKE : null;
  if (!here) throw new Error(`${network.name} is neither ${HUB.network} nor ${SPOKE.network}`);
  const there = here === HUB ? SPOKE : HUB;
  const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
  const [me] = await ethers.getSigners();
  const token = await ethers.getContractAt(here.artifact, need(here.env));
  const mode = process.env.MODE || "status";

  if (mode === "status") {
    console.log(`${network.name} ${await token.getAddress()} · deployer balance ${f(await token.balanceOf(me.address))} SRX · supply ${f(await token.totalSupply())}`);
    console.log(`  peer for ${there.network}: ${await token.peers(there.eid)}`);
    if (here === HUB) {
      console.log(`  outstanding to ${there.network}: ${f(await token.outstandingByEid(there.eid))} SRX`);
      console.log(`  daily return limit: ${f(await token.inboundLimit(there.eid))} · available now: ${f(await token.inboundAvailable(there.eid))} · frozen: ${await token.inboundFrozen(there.eid)}`);
    }
    return;
  }

  if (mode === "send") {
    const amt = E(need("AMOUNT"));
    const p = { dstEid: there.eid, to: ethers.zeroPadValue(me.address, 32), amountLD: amt, minAmountLD: amt,
      extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" };
    const fee = await token.quoteSend(p, false);
    const tx = await token.send(p, { nativeFee: fee.nativeFee, lzTokenFee: 0n }, me.address, { value: fee.nativeFee });
    const r = await tx.wait();
    console.log(`sent ${f(amt)} SRX ${network.name} → ${there.network}: ${r.hash} (fee ${ethers.formatEther(fee.nativeFee)})`);
    console.log(`  track: https://testnet.layerzeroscan.com/tx/${r.hash}`);
    if (process.env.PROOF_LOG) {
      const fsx = require("fs");
      const log = fsx.existsSync(process.env.PROOF_LOG) ? JSON.parse(fsx.readFileSync(process.env.PROOF_LOG, "utf8")) : {};
      log[`last_from_${network.name}`] = r.hash; log.last = r.hash;
      fsx.writeFileSync(process.env.PROOF_LOG, JSON.stringify(log, null, 1));
    }
    return;
  }

  if (mode === "retry") {
    const src = new ethers.JsonRpcProvider(need("SRC_RPC"));
    const proofLog = JSON.parse(require("fs").readFileSync(need("PROOF_LOG"), "utf8"));
    const srcTx = proofLog[`last_from_${there.network}`];
    if (!srcTx) throw new Error(`PROOF_LOG has no send from ${there.network}`);
    const receipt = await src.getTransactionReceipt(srcTx);
    const PS = new ethers.Interface(["event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)"]);
    const log = receipt.logs.map((l) => { try { return PS.parseLog(l); } catch { return null; } }).find(Boolean);
    if (!log) throw new Error("no PacketSent in that transaction");
    const p = decodePacket(log.args.encodedPayload);
    if (p.dstEid !== here.eid) throw new Error(`that packet goes to eid ${p.dstEid}, not ${network.name}`);
    const endpoint = new ethers.Contract(await token.endpoint(), [
      "function lzReceive(tuple(uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable",
    ], me);
    if (process.env.DRY === "1") {
      try { const g = await endpoint.lzReceive.estimateGas({ srcEid: p.srcEid, sender: p.sender, nonce: p.nonce }, p.receiver, p.guid, p.message, "0x"); console.log(`simulation: would succeed, ${g} gas including the 21,000 base`); }
      catch (e) { const why = e.data ? (token.interface.parseError(e.data)?.name || e.data) : e.shortMessage; console.log(`simulation reverts: ${why}`); }
      return;
    }
    const tx = await endpoint.lzReceive({ srcEid: p.srcEid, sender: p.sender, nonce: p.nonce }, p.receiver, p.guid, p.message, "0x");
    console.log(`re-delivered nonce ${p.nonce} (guid ${p.guid}): ${(await tx.wait()).hash}`);
    return;
  }

  if (here !== HUB) throw new Error(`${mode} applies to the hub (${HUB.network}) only`);
  let tx;
  if (mode === "limit") tx = await token.setInboundLimit(there.eid, E(need("AMOUNT")));
  else if (mode === "freeze") tx = await token.freezeInbound(there.eid);
  else if (mode === "guardian-freeze") {
    // The production path: the guardian multisig freezes one chain through GuardianModule,
    // which holds the token's PAUSER_ROLE after the hand-over.
    const rec = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "..", "deployments", `${network.name}.json`), "utf8"));
    const gm = await ethers.getContractAt("GuardianModule", rec.contracts.GuardianModule);
    tx = await gm.freezeBridgeInbound(there.eid, "testnet proof: freeze one chain (disclosure A)");
  }
  else if (mode === "unfreeze") tx = await token.unfreezeInbound(there.eid);
  else throw new Error(`unknown MODE ${mode}`);
  console.log(`${mode}: ${(await tx.wait()).hash}`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
