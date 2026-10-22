/**
 * spokeOps.js — a spoke chain's bridge authority behind a 48-hour Timelock (SPOKE-01).
 *
 * ⛔ WHY (external disclosure A, reported 3 Oct 2026, Jared 7 Oct: "full fix"). A spoke's
 *    Ownable owner sets its LayerZero peers and enforced options, and its LayerZero
 *    DELEGATE sets the DVNs and libraries that decide which messages are believed. Both
 *    were the Safe, acting instantly. A compromised Safe key on one spoke could forge a
 *    mint there and bring it back to Ethereum. SPOKE-01 had been ACCEPTED on the claim
 *    that the hub would contain it; the report proved that claim false.
 *
 * ⭐ Now each spoke has its own SRXTimelock (the Safe proposes and can cancel, anyone
 *    executes once the delay has passed, nobody administers it), and that Timelock is
 *    the spoke's owner AND its LayerZero delegate. Any change to peers or DVNs is a
 *    public proposal that waits the delay; the guardian and the hub's per-chain freeze
 *    and daily limit (SRXToken) are the fast defences meanwhile. Pausing stays fast:
 *    PAUSER_ROLE is unchanged.
 *
 * The steps take a `send(contract, fn, args, description)` callback, so 07_deploy_bridge
 * routes them through the admin Safe batch and the tests call them directly.
 */
const { ethers } = require("hardhat");

const ACCEPT_SALT = ethers.id("SRX:SRXOFTNative.acceptOwnership:spoke");
const ENDPOINT_ABI = ["function delegates(address) view returns (address)"];

/** A spoke's own Timelock: the Safe proposes and cancels, anyone executes, no admin. */
async function deploySpokeTimelock({ deployer, safe, minDelay }) {
  const F = await ethers.getContractFactory("SRXTimelock", deployer);
  const tl = await F.deploy(minDelay, [safe], [ethers.ZeroAddress], ethers.ZeroAddress);
  await tl.waitForDeployment();
  return tl;
}

function acceptOp(spokeAddr) {
  const data = new ethers.Interface(["function acceptOwnership()"]).encodeFunctionData("acceptOwnership");
  return { target: spokeAddr, value: 0, data, predecessor: ethers.ZeroHash, salt: ACCEPT_SALT };
}

async function delegateOf(spoke) {
  const ep = new ethers.Contract(await spoke.endpoint(), ENDPOINT_ABI, spoke.runner);
  return ethers.getAddress(await ep.delegates(await spoke.getAddress()));
}

/**
 * Step 1, by the current owner (the Safe): make the Timelock the LayerZero delegate,
 * start the two-step ownership transfer, and schedule the Timelock's acceptance.
 * Idempotent: each part is skipped once done.
 */
async function handoverSpoke({ spoke, timelock, send }) {
  const tlAddr = ethers.getAddress(await timelock.getAddress());
  const spokeAddr = await spoke.getAddress();
  if ((await delegateOf(spoke)) !== tlAddr) {
    await send(spoke, "setDelegate", [tlAddr], `SRXOFTNative.setDelegate(Timelock ${tlAddr})`);
  }
  const owner = ethers.getAddress(await spoke.owner());
  const pending = ethers.getAddress(await spoke.pendingOwner());
  if (owner !== tlAddr && pending !== tlAddr) {
    await send(spoke, "transferOwnership", [tlAddr], `SRXOFTNative.transferOwnership(Timelock) — pending until the Timelock accepts`);
  }
  const op = acceptOp(spokeAddr);
  const id = await timelock.hashOperation(op.target, op.value, op.data, op.predecessor, op.salt);
  if (owner !== tlAddr && !(await timelock.isOperation(id))) {
    const delay = await timelock.getMinDelay();
    await send(timelock, "schedule", [op.target, op.value, op.data, op.predecessor, op.salt, delay],
      `Timelock: schedule SRXOFTNative.acceptOwnership() (ready after ${delay}s)`);
  }
  return id;
}

/** Step 2, after the delay, by anyone: execute the scheduled acceptance. */
async function finalizeSpoke({ spoke, timelock, signer }) {
  const op = acceptOp(await spoke.getAddress());
  const id = await timelock.hashOperation(op.target, op.value, op.data, op.predecessor, op.salt);
  if (await timelock.isOperationDone(id)) return false;
  if (!(await timelock.isOperationReady(id))) {
    const at = Number(await timelock.getTimestamp(id));
    throw new Error(at ? `The acceptance is not ready until ${new Date(at * 1000).toISOString()}. Nothing was sent.`
                       : "The acceptance was never scheduled. Run the hand-over first. Nothing was sent.");
  }
  await (await timelock.connect(signer).execute(op.target, op.value, op.data, op.predecessor, op.salt)).wait();
  return true;
}

/**
 * What must be true of a handed-over spoke. Returns a list of failures (empty = pass).
 * `requiredDelay` is the minimum the Timelock must enforce on this network.
 */
async function checkSpoke({ spoke, timelock, hubAddress, hubEid, safe, requiredDelay }) {
  const failures = [];
  const tlAddr = ethers.getAddress(await timelock.getAddress());
  const owner = ethers.getAddress(await spoke.owner());
  if (owner !== tlAddr) failures.push(`spoke owner is ${owner}, not the spoke Timelock ${tlAddr}`);
  const delegate = await delegateOf(spoke);
  if (delegate !== tlAddr) failures.push(`spoke LayerZero delegate is ${delegate}, not the spoke Timelock`);
  const expectedHub = ethers.zeroPadValue(ethers.getAddress(hubAddress), 32).toLowerCase();
  if ((await spoke.hubPeer()).toLowerCase() !== expectedHub) failures.push("spoke hubPeer is not the hub token");
  if (BigInt(await spoke.hubEid()) !== BigInt(hubEid)) failures.push("spoke hubEid is not the hub's endpoint id");
  const peer = (await spoke.peers(hubEid)).toLowerCase();
  if (peer !== expectedHub) failures.push(`spoke peer for the hub is ${peer}, not the hub token`);
  const delay = await timelock.getMinDelay();
  if (delay < BigInt(requiredDelay)) failures.push(`spoke Timelock delay ${delay}s is below the required ${requiredDelay}s`);
  if (!(await timelock.hasRole(await timelock.PROPOSER_ROLE(), safe))) failures.push("the Safe is not a proposer on the spoke Timelock");
  if (!(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress))) failures.push("execution on the spoke Timelock is not open to anyone");
  const ADMIN = await timelock.DEFAULT_ADMIN_ROLE();
  if (await timelock.hasRole(ADMIN, safe)) failures.push("the Safe administers the spoke Timelock (it must have no admin but itself)");
  return failures;
}

module.exports = { ACCEPT_SALT, deploySpokeTimelock, handoverSpoke, finalizeSpoke, checkSpoke, delegateOf };
