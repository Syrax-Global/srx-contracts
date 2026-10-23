/**
 * Step 6b — Genesis buyers' vaults (run straight after Step 6)
 *
 * The Genesis round is funded from the seed allocation (lib/genesis_seed.js): at
 * launch the Genesis contract (PreSaleRound) receives exactly what it sold. This step
 * creates each buyer's VestingVault from that balance and starts its clock, on the
 * seed schedule (0% at launch, 273 days held, 730 days of release).
 *
 * ⛔ Before SRXToken's maxWalletBalance is switched on (PSR-09): a new vault cannot
 *    be exempted in advance, so a large allocation would revert. The script refuses
 *    while a limit is set.
 *
 * ⛔ The Genesis contract must hold EXACTLY what its buyers are owed. Less, and a
 *    vault cannot be funded. More (a refund recorded after Step 3), and the excess
 *    could leave through recoverSRX() unlocked. Either way the script stops and sends
 *    nothing: it is a finding to resolve, not something to paper over.
 *
 * Both calls are the Genesis contract's admin's (the admin Safe). A Safe batch is ONE
 * transaction, and each vault is a contract creation (about 961,000 gas per buyer for the
 * deploy and the trigger; Ethereum caps one transaction at 16,777,216 gas), so each run queues
 * at most GENESIS_VAULT_CHUNK buyers (default 12, about 11.5M gas). The script estimates every
 * chunk first and refuses one above 15,000,000 gas (C5). Re-run after the Safe executes each batch
 * until it reports every vault created and running. Re-running is always safe: the
 * contract skips vaults already created or already started.
 *
 * Run: npx hardhat run scripts/deploy/06b_genesis_vaults.js --network sepolia
 */
const { ethers, network } = require("hardhat");
const { VESTING, WALLETS } = require("./00_config");
const { createAdminBatch } = require("./lib/adminTx");
const { readGenesisSold } = require("./lib/genesis_seed");
const { checkRevokeRecipients } = require("./lib/gate_checks");
const { chunkFromEnv, estimateChunkGas, assertChunkWithinLimit, TX_GAS_CAP, CHUNK_GAS_LIMIT } = require("./lib/genesis_chunk");

function env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

async function main() {
  const NET = network.name.toUpperCase();
  const tokenAddr = env(`SRX_TOKEN_${NET}`);
  const token = await ethers.getContractAt("SRXToken", tokenAddr);

  console.log(`\n── Genesis buyers' vaults — ${NET} ──`);
  const genesis = await readGenesisSold({ networkName: network.name, provider: ethers.provider, tokenAddress: tokenAddr });
  if (genesis.sold === 0n) {
    console.log("No Genesis round sold anything. Nothing to do.");
    return;
  }
  if (!(await token.genesisComplete())) throw new Error("SRX has not been launched yet (Step 6). Nothing was sent.");

  const round = await ethers.getContractAt("PreSaleRound", genesis.address);
  const investors = await round.getInvestorList();
  const pending = await round.pendingDeployment();
  const held = await token.balanceOf(genesis.address);
  console.log(`Genesis contract ${genesis.address}: ${investors.length} buyers, ${ethers.formatUnits(genesis.sold, 18)} SRX sold`);
  console.log(`  owed to buyers without a vault yet: ${ethers.formatUnits(pending, 18)} SRX · held: ${ethers.formatUnits(held, 18)} SRX`);

  if (held < pending) {
    throw new Error(`The Genesis contract holds ${ethers.formatUnits(pending - held, 18)} SRX LESS than its buyers are owed, so their vaults cannot all be funded. Check Step 6's distribution. Nothing was sent.`);
  }
  if (held > pending) {
    // Internal audit L6: anyone can send SRX here, so a surplus is not a reason to stop.
    // recoverSRX() returns only the surplus; it can no longer reach buyers' SRX.
    console.log(`  ⚠️ ${ethers.formatUnits(held - pending, 18)} SRX above what buyers are owed (a donation or a refund after Step 3). It stays recoverable with recoverSRX(); buyers' SRX is not.`);
  }

  // Which buyers still need a vault, or a started clock.
  const todo = [];
  for (let i = 0; i < investors.length; i++) {
    const v = await round.getVault(investors[i]);
    if (v === ethers.ZeroAddress) { todo.push(i); continue; }
    const vault = await ethers.getContractAt("VestingVault", v);
    if (!(await vault.tgeTriggered())) todo.push(i);
  }

  if (todo.length > 0) {
    const cap = await token.maxWalletBalance();
    if (cap !== 0n && pending > 0n) {
      throw new Error(`maxWalletBalance is already set (${ethers.formatUnits(cap, 18)} SRX): creating a vault above it would revert (PSR-09). Create the Genesis vaults before the limit is switched on. Nothing was sent.`);
    }

    const chunk = chunkFromEnv();
    const batch = createAdminBatch("06b_genesis_vaults");
    const adminExecuting = await batch.isAdmin();

    // The admin Safe signs one batch per run; an admin signer (testnets) runs it all now.
    let next = todo[0];
    do {
      const end = Math.min(next + chunk, investors.length);
      // C5: one Safe transaction creates AND starts these vaults (about 961,000 gas a buyer), and Ethereum
      // caps a transaction at 16,777,216. Refuse a chunk that could not be mined, before queuing it.
      const est = await estimateChunkGas({ round, from: WALLETS.admin, start: next, end });
      console.log(`  chunk ${next}–${end - 1}: ${end - next} buyers, estimated ${est.gas} gas (model ${est.model}${est.node ? `, node ${est.node}` : `, node estimate unavailable: ${est.nodeError}`}); limit ${CHUNK_GAS_LIMIT} of the ${TX_GAS_CAP} a transaction may use`);
      assertChunkWithinLimit({ chunk: end - next, gas: est.gas });
      await batch.send(round, "batchDeployVaults", [next, end], `Genesis: create buyers' vaults ${next}–${end - 1}`);
      await batch.send(round, "batchTriggerTGE", [next, end], `Genesis: start the clock on vaults ${next}–${end - 1}`);
      next = end;
    } while (adminExecuting && next < investors.length);

    const wrote = await batch.flush();
    if (wrote) {
      console.log(`\n📝 Queued for the admin Safe: ${wrote}`);
      console.log(`   Re-run this script after the Safe executes it, until it reports every vault running.`);
      return;
    }
  }

  // ── Every buyer's vault exists, runs on the seed schedule, and is fully funded ──
  const seed = VESTING.seedInvestors;
  const failures = [];
  let inVaults = 0n;
  for (const investor of investors) {
    const addr = await round.getVault(investor);
    if (addr === ethers.ZeroAddress) { failures.push(`${investor}: no vault`); continue; }
    const vault = await ethers.getContractAt("VestingVault", addr);
    const [ben, cliff, vest, bps, started, bal] = await Promise.all([
      vault.beneficiary(), vault.cliffDuration(), vault.vestingDuration(), vault.tgeUnlockBps(),
      vault.tgeTriggered(), token.balanceOf(addr),
    ]);
    const owed = (await round.investors(investor)).srxAllocation;
    if (ethers.getAddress(ben) !== ethers.getAddress(investor)) failures.push(`${investor}: vault pays ${ben}`);
    if (cliff !== seed.cliffDuration || vest !== seed.vestingDuration || bps !== seed.tgeUnlockBps) failures.push(`${investor}: vault is not on the seed schedule`);
    if (!started) failures.push(`${investor}: vault clock not started`);
    if (bal !== owed) failures.push(`${investor}: vault holds ${ethers.formatUnits(bal, 18)} SRX, owed ${ethers.formatUnits(owed, 18)}`);
    inVaults += bal;
  }
  const left = await token.balanceOf(genesis.address);
  if (left !== 0n) failures.push(`the Genesis contract still holds ${ethers.formatUnits(left, 18)} SRX`);
  if (inVaults !== genesis.sold) failures.push(`buyers' vaults hold ${ethers.formatUnits(inVaults, 18)} SRX, the round sold ${ethers.formatUnits(genesis.sold, 18)}`);

  // E-02: the Genesis contract and every buyer's vault send revoked SRX to the SRXTreasury contract.
  {
    const r = await checkRevokeRecipients({
      provider: ethers.provider, treasury: env(`TREASURY_${NET}`), tokenAddress: tokenAddr, genesisRound: genesis.address,
    });
    failures.push(...r.failures);
    if (r.failures.length === 0) console.log(`✅ revoke recipient: the Genesis contract and all ${investors.length} buyer vaults name the SRXTreasury (${r.checked} checks)`);
  }

  if (failures.length) {
    for (const f of failures) console.error(`❌ ${f}`);
    throw new Error(`${failures.length} Genesis vault check(s) failed`);
  }
  console.log(`\n✅ GENESIS VAULTS COMPLETE — ${investors.length} vaults running on the seed schedule, ${ethers.formatUnits(inVaults, 18)} SRX locked, 0 left in the Genesis contract`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
