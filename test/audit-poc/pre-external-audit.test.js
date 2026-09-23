// Pre-external-audit sweep, 23 Sep 2026.
//
// Every finding in this sweep is proven by a test before it counts, and every
// test here asserts the CORRECT behaviour: it was red against the code as found,
// and it is green now. Reintroducing a defect turns this file red.
//
// IDs match the sweep's record (REMEDIATION.md, "Pre-external-audit sweep").
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (n) => ethers.parseUnits(String(n), 18);

async function srxToken(admin) {
  const Ep = await ethers.getContractFactory("MockLZEndpoint");
  const ep = await Ep.deploy(40161);
  const T = await ethers.getContractFactory("SRXToken");
  const token = await T.deploy(await ep.getAddress(), admin.address);
  await token.connect(admin).genesis(admin.address);
  return { token, ep };
}

// ── PreSaleRound ──────────────────────────────────────────────────────────────
describe("PSR-01 — payment tokens are valued by their real decimals", function () {
  const PRICE = 1_250_000n;        // $0.0125
  const CAP = E(300_000_000);      // Genesis: 300M SRX

  async function round({ stableDecimals, feedDecimals = 8 }) {
    const [admin, buyer] = await ethers.getSigners();
    const { token } = await srxToken(admin);
    const M = await ethers.getContractFactory("MockERC20");
    const usdc = await M.deploy("USD Coin", "USDC", stableDecimals);
    const usdt = await M.deploy("Tether", "USDT", stableDecimals);
    const wbtc = await M.deploy("BTC", "BTCB", 18);
    const F = await ethers.getContractFactory("MockChainlinkFeed");
    const ethFeed = await F.deploy(2_500n * 10n ** 8n);
    const btcFeed = await F.deploy(60_000n * 10n ** 8n);
    if (feedDecimals !== 8) await ethFeed.setDecimals(feedDecimals);
    const R = await ethers.getContractFactory("PreSaleRound");
    const r = await R.deploy(
      await token.getAddress(), await usdc.getAddress(), await usdt.getAddress(), await wbtc.getAddress(),
      await ethFeed.getAddress(), await btcFeed.getAddress(), admin.address, CAP, PRICE, true, 5_000n,
    );
    await token.connect(admin).transfer(await r.getAddress(), CAP);
    return { r, usdc, usdt, wbtc, buyer, admin, F };
  }

  it("an 18-decimal USDT (BNB Chain) is not valued 10^12 too high", async function () {
    const { r, usdt, buyer } = await round({ stableDecimals: 18 });
    // Before the fix: 2.5e12 base units (0.0000025 USDT) was credited as
    // $2,500,000 and bought the entire 300M SRX cap.
    const dust = 2_500_000_000_000n;
    await usdt.mint(buyer.address, dust);
    await usdt.connect(buyer).approve(await r.getAddress(), dust);
    await r.connect(buyer).investWithUSDT(dust);
    const inv = await r.investors(buyer.address);
    expect(inv.srxAllocation).to.be.lessThan(E(1));          // a fraction of one SRX
    expect(await r.remainingCap()).to.be.greaterThan(CAP - E(1));
  });

  it("$10,000 buys the same 1,200,000 SRX whether USDT has 6 or 18 decimals", async function () {
    for (const d of [6, 18]) {
      const { r, usdt, buyer } = await round({ stableDecimals: d });
      const amount = 10_000n * 10n ** BigInt(d);
      await usdt.mint(buyer.address, amount);
      await usdt.connect(buyer).approve(await r.getAddress(), amount);
      await r.connect(buyer).investWithUSDT(amount);
      expect((await r.investors(buyer.address)).srxAllocation).to.equal(E(1_200_000), `${d} decimals`);
      expect(await r.usdtDecimals()).to.equal(d);
    }
  });

  it("an 18-decimal BTCB is valued at its real price", async function () {
    const { r, wbtc, buyer } = await round({ stableDecimals: 6 });
    const tenth = 10n ** 17n; // 0.1 BTC at $60,000 = $6,000 → 720,000 SRX at 120/$
    await wbtc.mint(buyer.address, tenth);
    await wbtc.connect(buyer).approve(await r.getAddress(), tenth);
    await r.connect(buyer).investWithWBTC(tenth);
    expect((await r.investors(buyer.address)).srxAllocation).to.equal(E(720_000));
  });

  it("a price feed that is not 8-decimal USD is refused, at deployment and when set later", async function () {
    await expect(round({ stableDecimals: 6, feedDecimals: 18 }))
      .to.be.revertedWithCustomError(await ethers.getContractFactory("PreSaleRound"), "UnsupportedFeedDecimals");
    const { r, admin, F } = await round({ stableDecimals: 6 });
    const bad = await F.deploy(10n ** 18n);
    await bad.setDecimals(18);
    await expect(r.connect(admin).setStablecoinFeeds(await bad.getAddress(), ethers.ZeroAddress))
      .to.be.revertedWithCustomError(r, "UnsupportedFeedDecimals");
  });
});

// ── StabilisationFund ─────────────────────────────────────────────────────────
async function ssfFixture() {
  const [admin, guardian, a, b, target] = await ethers.getSigners();
  const { token } = await srxToken(admin);
  const SSF = await ethers.getContractFactory("StabilisationFund");
  const ssf = await upgrades.deployProxy(
    SSF, [await token.getAddress(), admin.address, 3_000, 7_000, 30 * 86400],
    { kind: "uups", initializer: "initialize" },
  );
  await ssf.connect(admin).grantRole(await ssf.GUARDIAN_ROLE(), guardian.address);
  await ssf.connect(admin).setDeployTarget(target.address, true);
  const addr = await ssf.getAddress();
  for (const u of [a, b]) {
    await token.connect(admin).transfer(u.address, E(1_000_000_000));
    await token.connect(u).approve(addr, ethers.MaxUint256);
  }
  return { admin, guardian, a, b, target, token, ssf, addr };
}

describe("SSF-H2 — the fund never promises more rewards than it holds", function () {
  it("a routine rate reset mid-schedule keeps total rewards within the funded pool", async function () {
    const { admin, a, b, token, ssf, addr } = await ssfFixture();
    await ssf.connect(a).contribute(E(1_000));
    await ssf.connect(b).contribute(E(1_000));
    await token.connect(admin).transfer(addr, E(1_000));
    await ssf.connect(admin).notifyRewardAmount(E(1_000));
    await ssf.connect(admin).setRewardRate(E(1));

    await time.increase(500);
    await ssf.connect(admin).setRewardRate(E(1)); // no-op rate "reset"
    await time.increase(1_000);

    const owed = (await ssf.earned(a.address)) + (await ssf.earned(b.address));
    // Before the fix: 1,500 SRX promised against 1,000 funded, and the second
    // claimer silently lost 500.
    expect(owed).to.be.lessThanOrEqual(E(1_000));
    await ssf.connect(a).claimRewards();
    await ssf.connect(b).claimRewards();
    expect(await ssf.pendingRewards(b.address)).to.equal(0n);
  });
});

describe("SSF-M1 — a fast-path deployment can never spend contributors' own deposits", function () {
  it("after the guardian deploys its full cap, every contributor can still withdraw in full", async function () {
    const { admin, guardian, a, target, token, ssf, addr } = await ssfFixture();
    await token.connect(admin).transfer(addr, E(1_500_000_000));   // 1.5B seed
    await ssf.connect(a).contribute(E(700_000_000));               // 700M principal
    await ssf.connect(guardian).triggerStressEvent();
    const cap = await ssf.getGuardianCapRemaining();
    // Before the fix the cap was 70% of 2.2B (1.54B), so deploying it left 0.66B
    // against 0.7B of principal and the last withdrawal reverted.
    await ssf.connect(guardian).deployLiquidity(target.address, await token.getAddress(), cap, "stress");
    await time.increase(30 * 86400 + 1);
    await expect(ssf.connect(a).withdrawContribution(E(700_000_000))).to.not.be.reverted;
  });

  it("a fast path cannot deploy more than the fund's free SRX", async function () {
    const { admin, guardian, a, target, token, ssf, addr } = await ssfFixture();
    await token.connect(admin).transfer(addr, E(100));
    await ssf.connect(a).contribute(E(1_000_000));
    await ssf.connect(guardian).triggerStressEvent();
    await expect(ssf.connect(guardian).deployLiquidity(target.address, await token.getAddress(), E(101), "x"))
      .to.be.reverted;
  });
});

// ── SRXStaking ────────────────────────────────────────────────────────────────
async function stakingFixture() {
  const [admin, u1, u2] = await ethers.getSigners();
  const { token } = await srxToken(admin);
  const S = await ethers.getContractFactory("SRXStaking");
  const staking = await upgrades.deployProxy(S, [await token.getAddress(), admin.address], { kind: "uups" });
  const sa = await staking.getAddress();
  for (const u of [u1, u2]) {
    await token.connect(admin).transfer(u.address, E(10_000_000));
    await token.connect(u).approve(sa, ethers.MaxUint256);
  }
  return { admin, u1, u2, token, staking, sa };
}

describe("STK-H2 — the bonus stream never promises more than it holds", function () {
  it("a routine bonus-rate reset keeps total bonus within the funded pool", async function () {
    const { admin, u1, u2, staking, sa } = await stakingFixture();
    const M = await ethers.getContractFactory("MockERC20");
    const usdc = await M.deploy("USD Coin", "USDC", 6);
    await staking.connect(admin).setBonusRewardToken(await usdc.getAddress());
    await usdc.mint(sa, 1_000n * 10n ** 6n);
    await staking.connect(admin).notifyBonusRewardAmount(1_000n * 10n ** 6n);
    await staking.connect(u1).lock(E(1_000), 7 * 86400);
    await staking.connect(u2).lock(E(1_000), 7 * 86400);
    await staking.connect(admin).setBonusRewardRate(10n ** 6n);

    await time.increase(500);
    await staking.connect(admin).setBonusRewardRate(10n ** 6n);
    await time.increase(1_000);

    const owed = (await staking.earnedBonus(u1.address)) + (await staking.earnedBonus(u2.address));
    expect(owed).to.be.lessThanOrEqual(1_000n * 10n ** 6n);
  });
});

describe("STK-M1 — rounding can never wrap the reward liability and freeze emissions", function () {
  it("after many global updates and a full exit, the liability stays within the pool", async function () {
    const { admin, u1, token, staking, sa } = await stakingFixture();
    await token.connect(admin).transfer(sa, E(1_000_000));
    await staking.connect(admin).notifyRewardAmount(E(1_000_000));
    await staking.connect(admin).setRewardRate(E(1));
    // Weight 100 SRX + 100 wei at 1 SRX/s: each global update floors away ~1 wei
    // that the staker's own (single-division) accrual keeps.
    await staking.connect(u1).lock(E(100) + 100n, 7 * 86400);
    for (let i = 0; i < 60; i++) await staking.pokeExpiredPosition(ethers.ZeroAddress);
    await staking.pokeExpiredPosition(ethers.ZeroAddress);
    // The scenario is live: the staker is owed more than the tracked total.
    expect(await staking.earned(u1.address)).to.be.greaterThan(await staking.totalPendingRewards());
    await time.increase(7 * 86400 + 1);
    await staking.connect(u1).unlock();
    // Before the fix an unchecked subtraction wrapped this to ~2^256.
    expect(await staking.totalPendingRewards()).to.be.lessThanOrEqual(await staking.rewardPool());
  });
});

// ── Batch 2: guardian, airdrop, migrator, presale admin paths, bridge ownership ──
async function presale({ flat = true, bonus = 5_000n } = {}) {
  const [admin, i1, i2] = await ethers.getSigners();
  const { token } = await srxToken(admin);
  const M = await ethers.getContractFactory("MockERC20");
  const usdc = await M.deploy("USD Coin", "USDC", 6);
  const F = await ethers.getContractFactory("MockChainlinkFeed");
  const ethFeed = await F.deploy(2_500n * 10n ** 8n);
  const R = await ethers.getContractFactory("PreSaleRound");
  const r = await R.deploy(
    await token.getAddress(), await usdc.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress,
    await ethFeed.getAddress(), ethers.ZeroAddress, admin.address, E(300_000_000), 1_250_000n, flat, flat ? bonus : 0n,
  );
  await token.connect(admin).transfer(await r.getAddress(), E(300_000_000));
  await usdc.mint(i1.address, 1_000_000n * 10n ** 6n);
  await usdc.connect(i1).approve(await r.getAddress(), ethers.MaxUint256);
  return { admin, i1, i2, token, usdc, r };
}

describe("G-L1 — the guardian cannot reopen a tripped circuit breaker", function () {
  it("unpauseModule refuses while the breaker is tripped; governance must reset it", async function () {
    const [admin, guardian, governance, cbRole] = await ethers.getSigners();
    const Stub = await ethers.getContractFactory("PausableStub");
    const bridge = await Stub.deploy();
    const G = await ethers.getContractFactory("GuardianModule");
    const gm = await G.deploy(admin.address, guardian.address, governance.address, 15_552_000);
    await gm.connect(admin).grantRole(await gm.CIRCUIT_BREAKER_ROLE(), cbRole.address);
    const BRIDGE = await gm.MODULE_BRIDGE();
    await gm.connect(governance).registerModule(BRIDGE, await bridge.getAddress());
    await gm.connect(governance).configureCircuitBreaker(BRIDGE, 100n, 3600n);
    await gm.connect(cbRole).recordBridgeActivity(BRIDGE, 100n);   // trips and pauses
    await time.increase(3601);                                     // past the pause cooldown
    await expect(gm.connect(guardian).unpauseModule(BRIDGE, "reopen"))
      .to.be.revertedWithCustomError(gm, "CircuitBreakerAlreadyTripped");
  });
});

describe("N-06 — an airdrop round cannot be cut short", function () {
  it("a live round's deadline can move later but never earlier, and a round lasts at least 7 days", async function () {
    const [admin] = await ethers.getSigners();
    const { token } = await srxToken(admin);
    const A = await ethers.getContractFactory("SRXAirdrop");
    const ad = await A.deploy(await token.getAddress(), admin.address);
    const root = ethers.hexlify(ethers.randomBytes(32));
    const now = await time.latest();
    await expect(ad.connect(admin).setMerkleRoot(root, now + 3600))
      .to.be.revertedWithCustomError(ad, "ClaimWindowTooShort");
    await ad.connect(admin).setMerkleRoot(root, now + 30 * 86400);
    // Before the fix: this ended the round in the next block, and rescueUnclaimed
    // then swept every unclaimed allocation.
    await expect(ad.connect(admin).setMerkleRoot(root, now + 8 * 86400))
      .to.be.revertedWithCustomError(ad, "DeadlineCannotMoveEarlier");
    await ad.connect(admin).setMerkleRoot(root, now + 40 * 86400); // extending is fine
  });
});

describe("N-03 — a contract wallet can migrate to an address it controls on the Syrax Chain", function () {
  it("migrateTo records and emits the named recipient, and names the payer", async function () {
    const [admin, safe, recipient] = await ethers.getSigners();
    const { token } = await srxToken(admin);
    const Z = await ethers.getContractFactory("ZkSyncMigrator");
    const mig = await Z.deploy(await token.getAddress(), admin.address);
    await token.connect(admin).grantRole(await token.BURN_ROLE(), await mig.getAddress());
    await mig.connect(admin).enableMigration();
    await token.connect(admin).transfer(safe.address, E(1_000));
    await token.connect(safe).approve(await mig.getAddress(), E(1_000));
    const tx = await mig.connect(safe).migrateTo(E(1_000), recipient.address);
    const ev = (await tx.wait()).logs.map((l) => { try { return mig.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean);
    const req = ev.find((e) => e.name === "MigrationRequest");
    expect(req.args.user).to.equal(recipient.address);
    expect(ev.find((e) => e.name === "MigrationFunded").args.payer).to.equal(safe.address);
    expect(await mig.migrationUser(req.args.migrationId)).to.equal(recipient.address);
    await expect(mig.connect(safe).migrateTo(1n, ethers.ZeroAddress)).to.be.reverted;
  });
});

describe("PSR-02 — an allocation no payment could produce is refused", function () {
  it("updateAllocation inside the $400k tier jump reverts instead of inflating the recorded USD", async function () {
    const { admin, i1, r } = await presale({ flat: false });
    await r.connect(admin).addInvestor(i1.address, 350_000n * 10n ** 8n);
    // 38M SRX sits between $400k at +17.5% (37.6M) and $400k at +20% (38.4M).
    // Before the fix it recorded $431,818, and a $1 top-up then paid +3.45M SRX.
    await expect(r.connect(admin).updateAllocation(i1.address, E(38_000_000)))
      .to.be.revertedWithCustomError(r, "AllocationNotRepresentable");
  });
});

describe("PSR-05 — a minimum on-chain contribution", function () {
  it("dust purchases are refused once the minimum is set; admin-recorded entries are not bound by it", async function () {
    const { admin, i1, i2, r } = await presale();
    await r.connect(admin).setMinContribution(2_500n * 10n ** 8n);
    await expect(r.connect(i1).investWithUSDC(1n)).to.be.revertedWithCustomError(r, "BelowMinimumContribution");
    await r.connect(i1).investWithUSDC(2_500n * 10n ** 6n);
    await r.connect(admin).addInvestor(i2.address, 100n * 10n ** 8n);
  });
});

describe("PSR-07 — one already-triggered vault cannot block the launch-day batch", function () {
  it("batchTriggerTGE skips vaults that are already triggered", async function () {
    const { admin, i1, i2, r } = await presale();
    await r.connect(admin).addInvestor(i1.address, 10_000n * 10n ** 8n);
    await r.connect(admin).addInvestor(i2.address, 10_000n * 10n ** 8n);
    await r.connect(admin).batchDeployVaults(0, 2);
    await r.connect(admin).batchTriggerTGE(0, 1);
    // Before the fix an overlapping range reverted with TGEAlreadyTriggered.
    await expect(r.connect(admin).batchTriggerTGE(0, 2)).to.emit(r, "TGETriggeredForAll").withArgs(1n);
  });
});

describe("N-02 — bridge ownership is two-step and cannot be renounced", function () {
  it("a transfer needs the new owner to accept, and renouncing reverts", async function () {
    const [admin, next] = await ethers.getSigners();
    const { token, ep } = await srxToken(admin);
    await token.connect(admin).transferOwnership(next.address);
    expect(await token.owner()).to.equal(admin.address);
    await token.connect(next).acceptOwnership();
    expect(await token.owner()).to.equal(next.address);
    await expect(token.connect(next).renounceOwnership())
      .to.be.revertedWithCustomError(token, "OwnershipCannotBeRenounced");
    const N = await ethers.getContractFactory("SRXOFTNative");
    const native = await N.deploy(await ep.getAddress(), admin.address);
    await expect(native.connect(admin).renounceOwnership())
      .to.be.revertedWithCustomError(native, "OwnershipCannotBeRenounced");
  });
});
