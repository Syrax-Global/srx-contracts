// Review E, 22 Oct 2026 (fixes): the launch ORDER and what the launch gate checks about it.
//
//  E-02  A revoked vault's unvested SRX goes to a recipient that is fixed at deployment. Steps 3 and
//        10 ran BEFORE the SRXTreasury existed and fell back to the WALLET_TREASURY wallet. They now
//        require the SRXTreasury contract (no fallback), and the gate reads the result back.
//  E-01  (below, same file) Step 3 deploys a NEW TGEDistributor each run; staking and the fund fix
//        the distributor immutably. See the E-01 describe blocks.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { requireTreasury, assertStep3MayRun, REDEPLOY_ACK } = require("../../scripts/deploy/lib/launch_order");
const { checkRevokeRecipients, checkDistributorWiring } = require("../../scripts/deploy/lib/gate_checks");

const ROOT = path.join(__dirname, "..", "..");
const CLI = path.join(ROOT, "node_modules", "hardhat", "internal", "cli", "cli.js");
const src = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const rand = () => ethers.Wallet.createRandom().address;
const DAY = 86_400;

/** Run a deploy script on the in-process hardhat network with an explicit environment. */
function runScript(script, env) {
  const clean = { ...process.env };
  delete clean.HARDHAT_NETWORK;
  const r = spawnSync(process.execPath, [CLI, "run", script, "--network", "hardhat"], {
    cwd: ROOT, env: { ...clean, ...env }, encoding: "utf8", input: "yes\n", maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

async function world() {
  const [admin, timelock, buyer, other] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(30101);
  const SRX = await ethers.getContractFactory("SRXToken");
  const token = await SRX.deploy(await lz.getAddress(), admin.address);
  const otherToken = await SRX.deploy(await lz.getAddress(), admin.address);
  const Treasury = await ethers.getContractFactory("SRXTreasury");
  const treasury = await Treasury.deploy(await token.getAddress(), admin.address, timelock.address);
  const Vault = await ethers.getContractFactory("VestingVault");
  const vaultTo = async (recipient) => Vault.deploy(
    await token.getAddress(), buyer.address, timelock.address, 30n * BigInt(DAY), 180n * BigInt(DAY), 0n, recipient);
  // Step 3 / 4 / 5b: a distributor, and staking + the fund built for a given one (immutably).
  const Dist = await ethers.getContractFactory("TGEDistributor");
  const newDistributor = async () => Dist.deploy(await token.getAddress(), admin.address);
  const stakingFor = async (dist) => (await ethers.getContractFactory("SRXStaking")).deploy(await token.getAddress(), admin.address, await dist.getAddress());
  const fundFor = async (dist) => (await ethers.getContractFactory("StabilisationFund")).deploy(
    await token.getAddress(), admin.address, 3_000, 7_000, 30 * DAY, ethers.parseUnits("100000000", 18), await dist.getAddress());
  return { admin, timelock, buyer, other, lz, token, otherToken, treasury, vaultTo, newDistributor, stakingFor, fundFor };
}

// These groups run deploy scripts in a child `hardhat run`. Under coverage a child process
// rebuilds the project and the instrumented hit counts are lost (measured 23 Oct 2026: 87% with
// them, 96% without), so they are skipped there; they test the scripts, not the contracts.
const describeSpawning = require("hardhat").__SOLIDITY_COVERAGE_RUNNING ? describe.skip : describe;

describeSpawning("E-02: the SRXTreasury exists before Steps 10 and 03, and is every vault's revoke recipient", function () {
  this.timeout(180_000);

  describe("requireTreasury", function () {
    it("refuses when TREASURY_<NET> is unset: there is no fallback to a wallet", async function () {
      const w = await world();
      await expect(requireTreasury({ networkName: "hardhat", env: {}, provider: ethers.provider, tokenAddress: await w.token.getAddress() }))
        .to.be.rejectedWith(/TREASURY_HARDHAT is not set[\s\S]*no fallback to WALLET_TREASURY/);
      await expect(requireTreasury({ networkName: "ethereum", env: { WALLET_TREASURY: rand() }, provider: ethers.provider }))
        .to.be.rejectedWith(/TREASURY_ETHEREUM is not set/);
    });

    it("refuses the zero address, a malformed address, a wallet with no code and a contract that is not an SRXTreasury", async function () {
      const w = await world();
      const token = await w.token.getAddress();
      const call = (value) => requireTreasury({ networkName: "hardhat", env: { TREASURY_HARDHAT: value }, provider: ethers.provider, tokenAddress: token });
      await expect(call(ethers.ZeroAddress)).to.be.rejectedWith(/zero address/);
      await expect(call("0x1234")).to.be.rejectedWith(/not a valid checksummed address/);
      await expect(call(rand())).to.be.rejectedWith(/no contract at/);
      const safe = await (await ethers.getContractFactory("MockSafe")).deploy([rand()], 1);
      await expect(call(await safe.getAddress())).to.be.rejectedWith(/does not answer as an SRXTreasury/);
    });

    it("refuses the treasury of a different token", async function () {
      const w = await world();
      const wrong = await (await ethers.getContractFactory("SRXTreasury")).deploy(await w.otherToken.getAddress(), w.admin.address, w.timelock.address);
      await expect(requireTreasury({
        networkName: "hardhat", env: { TREASURY_HARDHAT: await wrong.getAddress() }, provider: ethers.provider, tokenAddress: await w.token.getAddress(),
      })).to.be.rejectedWith(/belongs to SRX .* not the launch token/);
    });

    it("returns the checksummed SRXTreasury of the launch token", async function () {
      const w = await world();
      const a = await w.treasury.getAddress();
      expect(await requireTreasury({
        networkName: "hardhat", env: { TREASURY_HARDHAT: a.toLowerCase() }, provider: ethers.provider, tokenAddress: await w.token.getAddress(),
      })).to.equal(a);
    });
  });

  describe("the scripts", function () {
    it("03_deploy_vesting.js and 10_deploy_presale.js have no WALLET_TREASURY fallback and use requireTreasury", function () {
      for (const p of ["scripts/deploy/03_deploy_vesting.js", "scripts/deploy/10_deploy_presale.js"]) {
        const s = src(p);
        expect(s, `${p} falls back to WALLETS.treasury`).to.not.match(/WALLETS\.treasury/);
        expect(s, `${p} reads TREASURY_<NET> without requiring it`).to.not.match(/TREASURY_\$\{[^}]*\}`\]\s*\|\|/);
        expect(s, `${p} must call requireTreasury`).to.match(/await requireTreasury\(/);
      }
    });

    it("03_deploy_vesting.js refuses without a treasury, before it deploys anything", function () {
      const r = runScript("scripts/deploy/03_deploy_vesting.js", {
        SRX_TOKEN_HARDHAT: rand(), TIMELOCK_HARDHAT: rand(), TREASURY_HARDHAT: "", STAKING_HARDHAT: "", STABILISATION_FUND_HARDHAT: "", PRESALE_ROUND_HARDHAT: "none",
      });
      expect(r.code).to.not.equal(0);
      expect(r.out).to.match(/TREASURY_HARDHAT is not set/);
      expect(r.out).to.not.match(/vault:\s+0x/);
    });

    it("03_deploy_vesting.js refuses a wallet in the treasury's place", function () {
      const r = runScript("scripts/deploy/03_deploy_vesting.js", {
        SRX_TOKEN_HARDHAT: rand(), TIMELOCK_HARDHAT: rand(), TREASURY_HARDHAT: rand(), STAKING_HARDHAT: "", STABILISATION_FUND_HARDHAT: "", PRESALE_ROUND_HARDHAT: "none",
      });
      expect(r.code).to.not.equal(0);
      expect(r.out).to.match(/no contract at/);
    });

    it("the documented order puts 05 before 10 and 03 in the headers and the runbook", function () {
      for (const p of ["scripts/deploy/03_deploy_vesting.js", "scripts/deploy/10_deploy_presale.js", "scripts/deploy/05_deploy_treasury.js"]) {
        expect(src(p), p).to.include("01 → 02 → 05 → 10 → 03 → 04 → 05b → 06 → 06b → 08");
      }
      expect(src("scripts/deploy/03_deploy_vesting.js")).to.not.match(/use WALLET_TREASURY as placeholder|Step 4 sets TREASURY/);
      const rb = src("TGE_DEPLOYMENT_RUNBOOK.md");
      expect(rb).to.include("01 token → 02 governance → 05 treasury → 10 Genesis round → 03 vesting + distributor");
    });
  });

  describe("the gate reads the recipients back (checkRevokeRecipients)", function () {
    it("passes when every vault names the SRXTreasury", async function () {
      const w = await world();
      const t = await w.treasury.getAddress();
      const vaults = [];
      for (const l of ["Founders", "CoreTeam"]) vaults.push({ label: l, address: await (await w.vaultTo(t)).getAddress() });
      const r = await checkRevokeRecipients({ provider: ethers.provider, treasury: t, tokenAddress: await w.token.getAddress(), vaults });
      expect(r.failures).to.deep.equal([]);
      expect(r.checked).to.equal(3); // the treasury and two vaults
    });

    it("fails a vault whose recipient is a plain wallet (what the old fallback produced), and says so", async function () {
      const w = await world();
      const t = await w.treasury.getAddress();
      const walletTreasury = rand();
      const bad = await w.vaultTo(walletTreasury);
      const good = await w.vaultTo(t);
      const r = await checkRevokeRecipients({
        provider: ethers.provider, treasury: t, tokenAddress: await w.token.getAddress(),
        vaults: [{ label: "Founders vault", address: await bad.getAddress() }, { label: "CoreTeam vault", address: await good.getAddress() }],
      });
      expect(r.failures).to.have.length(1);
      expect(r.failures[0]).to.match(/Founders vault: revokeRecipient is .* \(an address with NO CODE, i\.e\. a plain wallet\)/);
    });

    it("fails when the treasury it is given is not an SRXTreasury of the token", async function () {
      const w = await world();
      const wrong = await (await ethers.getContractFactory("SRXTreasury")).deploy(await w.otherToken.getAddress(), w.admin.address, w.timelock.address);
      const r = await checkRevokeRecipients({
        provider: ethers.provider, treasury: await wrong.getAddress(), tokenAddress: await w.token.getAddress(),
        vaults: [{ label: "v", address: await (await w.vaultTo(await wrong.getAddress())).getAddress() }],
      });
      expect(r.failures.join("\n")).to.match(/belongs to SRX/);
    });

    it("fails a Genesis contract whose vaultRevokeRecipient is not the treasury", async function () {
      const w = await world();
      const t = await w.treasury.getAddress();
      const Feed = await ethers.getContractFactory("MockChainlinkFeed");
      const ethFeed = await (await Feed.deploy(2_500n * 10n ** 8n)).getAddress();
      const btcFeed = await (await Feed.deploy(60_000n * 10n ** 8n)).getAddress();
      const tokenAddr = await w.token.getAddress();
      const Round = await ethers.getContractFactory("PreSaleRound");
      const mk = (recipient) => Round.deploy(
        tokenAddr, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethFeed, btcFeed,
        w.admin.address, ethers.parseUnits("300000000", 18), 1_250_000n, true, 5_000n, recipient);
      const bad = await mk(rand());
      const good = await mk(t);
      const args = { provider: ethers.provider, treasury: t, tokenAddress: await w.token.getAddress() };
      const rb = await checkRevokeRecipients({ ...args, genesisRound: await bad.getAddress() });
      expect(rb.failures.join("\n")).to.match(/PreSaleRound \(Genesis\) vaultRevokeRecipient: revokeRecipient is/);
      const rg = await checkRevokeRecipients({ ...args, genesisRound: await good.getAddress() });
      expect(rg.failures).to.deep.equal([]);
    });
  });


  describe("runTgeTargetChecks (the gate 06 runs) reads the wiring with no manifest", function () {
    const NL = String.fromCharCode(10);

    async function gateWorld() {
      const { TGE_PLAN } = require("../../scripts/deploy/00_config");
      const { runTgeTargetChecks } = require("../../scripts/deploy/lib/tge_targets");
      const w = await world();
      const t = await w.treasury.getAddress();
      const tokenAddress = await w.token.getAddress();
      const dist = await w.newDistributor();
      const staking = await w.stakingFor(dist);
      const fund = await w.fundFor(dist);
      const env = {
        WALLET_PRESALE: rand(), WALLET_LIQUIDITY: rand(), WALLET_MARKET_MAKER: rand(), ADMIN_ADDRESS: rand(),
        TREASURY_HARDHAT: t, STAKING_HARDHAT: await staking.getAddress(), STABILISATION_FUND_HARDHAT: await fund.getAddress(),
        TGE_DISTRIBUTOR_HARDHAT: await dist.getAddress(), PRESALE_ROUND_HARDHAT: "none",
      };
      for (const row of TGE_PLAN.filter((r) => r.kind === "vault")) {
        env[`${row.vaultEnv}_HARDHAT`] = await (await w.vaultTo(t)).getAddress();
      }
      const gate = (over = {}) => runTgeTargetChecks({
        networkName: "hardhat", chainId: 31337n, env: { ...env, ...over }, provider: ethers.provider,
        vaultAt: () => null, tokenAddress, genesisSold: 0n,
        manifestPath: path.join(ROOT, "deploy", "addresses.does-not-exist.json"),
      });
      return { w, gate, dist };
    }

    it("E-02: fails on a local chain when a launch vault revokes to a wallet, and passes when every one names the treasury", async function () {
      const { w, gate } = await gateWorld();
      const ok = await gate();
      expect(ok.skipped).to.equal(true); // a local chain needs no manifest, and the wiring still ran
      expect(ok.failures).to.deep.equal([]);
      expect(ok.notes.join(NL)).to.match(/revoke recipient: 6 launch vaults/);

      const walletVault = await (await w.vaultTo(rand())).getAddress();
      const bad = await gate({ VESTING_FOUNDERS_HARDHAT: walletVault });
      expect(bad.failures.join(NL)).to.match(/Founders vault: revokeRecipient is .* NO CODE/);
    });

    it("E-01: fails when 03 was re-run after 04 / 05b: TGE_DISTRIBUTOR is not the one staking and the fund were built for", async function () {
      const { w, gate, dist } = await gateWorld();
      const ok = await gate();
      expect(ok.failures).to.deep.equal([]);
      expect(ok.notes.join(NL)).to.match(/distributor: SRXStaking and the StabilisationFund both name 0x[0-9a-fA-F]{40}, the TGEDistributor that launches/);

      // The runbook's refund path: Step 3 again deploys a NEW distributor; .env now names it.
      const distB = await w.newDistributor();
      const bad = await gate({ TGE_DISTRIBUTOR_HARDHAT: await distB.getAddress() });
      const text = bad.failures.join(NL);
      expect(bad.failures).to.have.length(2);
      expect(text).to.match(/SRXStaking 0x[0-9a-fA-F]{40}: tgeDistributor\(\) is 0x[0-9a-fA-F]{40}, but the distributor that launches is/);
      expect(text).to.include(await dist.getAddress());
      expect(text).to.include(await distB.getAddress());
      expect(text).to.match(/Re-run Step 4 \(04_deploy_staking\.js\)/);
      expect(text).to.match(/Re-run Step 5b \(05b_deploy_stabilisation\.js\)/);
    });

    it("E-01: fails when staking and the fund were built for different distributors", async function () {
      const { w, gate } = await gateWorld();
      const fundB = await w.fundFor(await w.newDistributor());
      const bad = await gate({ STABILISATION_FUND_HARDHAT: await fundB.getAddress() });
      expect(bad.failures).to.have.length(1);
      expect(bad.failures[0]).to.match(/StabilisationFund .*tgeDistributor\(\) is .*Re-run Step 5b/);
    });

    it("E-01: fails when TGE_DISTRIBUTOR_<NET> is not set, instead of skipping the check", async function () {
      const { gate } = await gateWorld();
      const bad = await gate({ TGE_DISTRIBUTOR_HARDHAT: "" });
      expect(bad.failures.join(NL)).to.match(/TGE_DISTRIBUTOR is not set to a valid address/);
    });
  });
});

describeSpawning("E-01: Step 3 deploys a new TGEDistributor, so it must not run after Step 4 / 5b", function () {
  this.timeout(180_000);
  const NL = String.fromCharCode(10);

  describe("assertStep3MayRun", function () {
    it("allows a first run (nothing declared), and ignores 'none' and blanks", function () {
      expect(assertStep3MayRun({ networkName: "ethereum", env: {} }).redeploying).to.equal(false);
      expect(assertStep3MayRun({ networkName: "ethereum", env: { STAKING_ETHEREUM: "", STABILISATION_FUND_ETHEREUM: "none" } }).redeploying).to.equal(false);
    });

    it("refuses once staking is declared, or the fund (under either name), and says what to re-run", function () {
      for (const k of ["STAKING_ETHEREUM", "STABILISATION_FUND_ETHEREUM", "STABILISATION_ETHEREUM"]) {
        expect(() => assertStep3MayRun({ networkName: "ethereum", env: { [k]: rand() } }), k)
          .to.throw(new RegExp(k + "[\\s\\S]*re-run 04 and 05b[\\s\\S]*" + REDEPLOY_ACK));
      }
      expect(() => assertStep3MayRun({ networkName: "ethereum", env: { STAKING_ETHEREUM: rand(), STABILISATION_FUND_ETHEREUM: rand() } }))
        .to.throw(/STAKING_ETHEREUM and STABILISATION_FUND_ETHEREUM are already declared/);
    });

    it("lets an explicit acknowledgement through, and nothing weaker", function () {
      const base = { STAKING_ETHEREUM: rand() };
      expect(assertStep3MayRun({ networkName: "ethereum", env: { ...base, [REDEPLOY_ACK]: "yes" } }).redeploying).to.equal(true);
      for (const v of ["", "1", "true", "no"]) {
        expect(() => assertStep3MayRun({ networkName: "ethereum", env: { ...base, [REDEPLOY_ACK]: v } }), v).to.throw(/already declared/);
      }
    });
  });

  it("03_deploy_vesting.js refuses to run when staking is declared, before touching the chain", function () {
    const r = runScript("scripts/deploy/03_deploy_vesting.js", {
      SRX_TOKEN_HARDHAT: rand(), TIMELOCK_HARDHAT: rand(), TREASURY_HARDHAT: "", STAKING_HARDHAT: rand(), STABILISATION_FUND_HARDHAT: "", PRESALE_ROUND_HARDHAT: "none",
    });
    expect(r.code).to.not.equal(0);
    expect(r.out).to.match(/STAKING_HARDHAT is already declared/);
    expect(r.out).to.not.match(/vault:\s+0x|TGEDistributor:\s+0x/);
  });

  describe("checkDistributorWiring (the launch gate)", function () {
    it("reproduces the reviewer's scenario: staking and fund built for distributor A, launch through B", async function () {
      const w = await world();
      const distA = await w.newDistributor();
      const staking = await w.stakingFor(distA);
      const fund = await w.fundFor(distA);
      const targets = [
        { label: "SRXStaking", address: await staking.getAddress(), rerun: "Step 4" },
        { label: "StabilisationFund", address: await fund.getAddress(), rerun: "Step 5b" },
      ];
      const tokenAddress = await w.token.getAddress();
      const good = await checkDistributorWiring({ provider: ethers.provider, tgeDistributor: await distA.getAddress(), tokenAddress, targets });
      expect(good).to.deep.equal({ failures: [], checked: 3 });

      const distB = await w.newDistributor();
      const bad = await checkDistributorWiring({ provider: ethers.provider, tgeDistributor: await distB.getAddress(), tokenAddress, targets });
      expect(bad.failures).to.have.length(2);
      expect(bad.failures.join(NL)).to.match(/would strand its allocation/);
    });

    it("fails a distributor of another token, a distributor with no code, and an unset one", async function () {
      const w = await world();
      const other = await (await ethers.getContractFactory("TGEDistributor")).deploy(await w.otherToken.getAddress(), w.admin.address);
      const tokenAddress = await w.token.getAddress();
      const wrongToken = await checkDistributorWiring({ provider: ethers.provider, tgeDistributor: await other.getAddress(), tokenAddress });
      expect(wrongToken.failures.join(NL)).to.match(/distributes .*, not the launch token/);
      const none = await checkDistributorWiring({ provider: ethers.provider, tgeDistributor: rand(), tokenAddress });
      expect(none.failures.join(NL)).to.match(/has no code/);
      const unset = await checkDistributorWiring({ provider: ethers.provider, tgeDistributor: null, tokenAddress });
      expect(unset.failures.join(NL)).to.match(/not set to a valid address/);
    });
  });

  it("the runbook says a re-run of 03 after 04 / 05b requires re-running 04 and 05b", function () {
    const rb = fs.readFileSync(path.join(ROOT, "TGE_DEPLOYMENT_RUNBOOK.md"), "utf8");
    expect(rb).to.match(/re-run of Step 3 after Step 4 or 5b also requires re-running Step 4 and Step 5b/);
    expect(rb).to.include("ACK_REDEPLOY_STAKING_AND_FUND=yes");
  });
});
