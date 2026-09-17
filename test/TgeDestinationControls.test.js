const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const {
  ALLOCATIONS, VESTING, TESTNET_WALLET_DEFAULTS, WALLETS, walletFor,
} = require("../scripts/deploy/00_config");
const {
  MAX_SUPPLY, buildTgeAllocations, liveRoles, checkAgainstManifest, checkOnChain, runTgeTargetChecks,
} = require("../scripts/deploy/lib/tge_targets");

/**
 * TGE destination controls — where the 10B SRX goes.
 *
 * Covers the board row "TGE destination controls: every layer around where 10B SRX
 * goes is inoperative": built-in fallback addresses used on any network, a
 * pre-flight gate nothing called, and a gate that rebuilt the list by copy.
 */
describe("TGE destination controls", function () {
  const addr = () => ethers.Wallet.createRandom().address;
  const Z = ethers.ZeroAddress;

  function fullEnv(net, over = {}) {
    const N = net.toUpperCase();
    return {
      [`VESTING_FOUNDERS_${N}`]: addr(),
      [`VESTING_CORE_TEAM_${N}`]: addr(),
      [`VESTING_SEED_${N}`]: addr(),
      [`VESTING_PRESALE_${N}`]: addr(),
      [`VESTING_ECOSYSTEM_${N}`]: addr(),
      [`STAKING_${N}`]: addr(),
      [`TREASURY_${N}`]: addr(),
      [`STABILISATION_FUND_${N}`]: addr(),
      WALLET_LIQUIDITY: addr(),
      ADMIN_ADDRESS: addr(),
      [`TIMELOCK_${N}`]: addr(),
      [`GOVERNOR_${N}`]: addr(),
      [`GUARDIAN_MODULE_${N}`]: addr(),
      ...over,
    };
  }

  /** A manifest that agrees with `allocations` and `roles`. */
  function manifestFor(net, chainId, allocations, roles) {
    const tgeAllocations = {};
    for (const a of allocations) {
      tgeAllocations[a.label] = {
        destination: a.destination,
        amountSRX: ethers.formatUnits(a.amount, 18).replace(/\.0$/, ""),
        isVestingVault: a.isVestingVault,
        ...(a.isVestingVault ? { beneficiary: addr() } : {}),
      };
    }
    return { network: net, chainId, roles: { ...roles }, tgeAllocations };
  }

  function mainnetCase(over = {}) {
    const env = fullEnv("ethereum", over);
    const allocations = buildTgeAllocations({ networkName: "ethereum", env });
    const roles = liveRoles({ networkName: "ethereum", env });
    const manifest = manifestFor("ethereum", 1, allocations, roles);
    return { env, allocations, roles, manifest };
  }

  // ── Wallet addresses: built-in ones are testnet-only ─────────────────────────
  describe("walletFor", function () {
    it("uses the built-in address on a testnet when the variable is unset", function () {
      expect(walletFor("liquidity", "sepolia", {})).to.equal(TESTNET_WALLET_DEFAULTS.liquidity);
    });

    it("refuses to fall back on a real network", function () {
      expect(() => walletFor("liquidity", "ethereum", {}))
        .to.throw(/WALLET_LIQUIDITY is not set.*not a testnet/);
    });

    it("refuses to fall back when the network is unknown", function () {
      expect(() => walletFor("admin", null, {})).to.throw(/ADMIN_ADDRESS is not set/);
    });

    it("rejects a built-in testnet address on a real network, even when set explicitly", function () {
      expect(() => walletFor("liquidity", "ethereum", { WALLET_LIQUIDITY: TESTNET_WALLET_DEFAULTS.treasury }))
        .to.throw(/built-in TESTNET address/);
    });

    it("rejects the zero address and a bad checksum on a real network", function () {
      expect(() => walletFor("treasury", "bsc", { WALLET_TREASURY: Z })).to.throw(/zero address/);
      const good = addr();
      const bad = good.slice(0, 2) + good.slice(2).split("").map((c) =>
        /[a-f]/.test(c) ? c.toUpperCase() : /[A-F]/.test(c) ? c.toLowerCase() : c).join("");
      expect(() => walletFor("treasury", "bsc", { WALLET_TREASURY: bad })).to.throw(/not a valid checksummed/);
    });

    it("returns a set, valid address checksummed", function () {
      const a = addr();
      expect(walletFor("founders", "ethereum", { WALLET_FOUNDERS: a.toLowerCase() })).to.equal(a);
    });

    it("WALLETS resolves against the network Hardhat is running on", function () {
      expect(require("../scripts/deploy/00_config").currentNetwork()).to.equal("hardhat");
      const saved = process.env.WALLET_STRATEGIC;
      delete process.env.WALLET_STRATEGIC;
      try {
        expect(WALLETS.strategic).to.equal(TESTNET_WALLET_DEFAULTS.strategic);
      } finally {
        if (saved !== undefined) process.env.WALLET_STRATEGIC = saved;
      }
    });
  });

  // ── The allocation list ──────────────────────────────────────────────────────
  describe("buildTgeAllocations", function () {
    it("builds all nine allocations, summing to MAX_SUPPLY", function () {
      const { allocations } = mainnetCase();
      expect(allocations.map((a) => a.label)).to.deep.equal([
        "Founders", "CoreTeam", "SeedInvestors", "Presale", "EcosystemDAO",
        "Liquidity", "Staking", "Treasury", "StabilisationFund",
      ]);
      expect(allocations.reduce((s, a) => s + a.amount, 0n)).to.equal(MAX_SUPPLY);
      expect(allocations.find((a) => a.label === "Staking").amount).to.equal(ALLOCATIONS.staking);
    });

    it("has no staking fallback: an unset STAKING stops the build", function () {
      const env = fullEnv("ethereum");
      delete env.STAKING_ETHEREUM;
      expect(() => buildTgeAllocations({ networkName: "ethereum", env })).to.throw(/STAKING_ETHEREUM is not set/);
    });

    it("reads only the network-suffixed variable, as the TGE script always has", function () {
      const env = fullEnv("ethereum");
      env.TREASURY = env.TREASURY_ETHEREUM;
      delete env.TREASURY_ETHEREUM;
      expect(() => buildTgeAllocations({ networkName: "ethereum", env })).to.throw(/TREASURY_ETHEREUM is not set/);
    });

    it("has no liquidity fallback on a real network", function () {
      const env = fullEnv("ethereum");
      delete env.WALLET_LIQUIDITY;
      expect(() => buildTgeAllocations({ networkName: "ethereum", env })).to.throw(/WALLET_LIQUIDITY/);
    });
  });

  // ── The manifest ─────────────────────────────────────────────────────────────
  describe("checkAgainstManifest", function () {
    const run = (c, extra = {}) => checkAgainstManifest({
      allocations: c.allocations, manifest: c.manifest, roles: c.roles,
      networkName: "ethereum", chainId: 1n, ...extra,
    });

    it("passes when everything agrees", function () {
      expect(run(mainnetCase())).to.deep.equal([]);
    });

    it("fails on a destination mismatch", function () {
      const c = mainnetCase();
      c.manifest.tgeAllocations.Liquidity.destination = addr();
      expect(run(c).join("\n")).to.match(/Liquidity DESTINATION mismatch/);
    });

    it("fails on an amount mismatch", function () {
      const c = mainnetCase();
      c.manifest.tgeAllocations.Treasury.amountSRX = "900000001";
      expect(run(c).join("\n")).to.match(/Treasury AMOUNT mismatch/);
    });

    it("fails on a missing label and on an extra one", function () {
      const c = mainnetCase();
      delete c.manifest.tgeAllocations.Presale;
      c.manifest.tgeAllocations.Marketing = { destination: addr(), amountSRX: "1" };
      const out = run(c).join("\n");
      expect(out).to.match(/Presale: not in the manifest/);
      expect(out).to.match(/manifest lists "Marketing"/);
    });

    it("fails when two allocations share a destination", function () {
      const c = mainnetCase();
      const t = c.allocations.find((a) => a.label === "Treasury");
      t.destination = c.allocations.find((a) => a.label === "Liquidity").destination;
      c.manifest.tgeAllocations.Treasury.destination = t.destination;
      expect(run(c).join("\n")).to.match(/share the destination/);
    });

    it("fails when the amounts do not sum to MAX_SUPPLY", function () {
      const c = mainnetCase();
      const l = c.allocations.find((a) => a.label === "Liquidity");
      l.amount -= 1n;
      c.manifest.tgeAllocations.Liquidity.amountSRX = ethers.formatUnits(l.amount, 18);
      expect(run(c).join("\n")).to.match(/≠ MAX_SUPPLY/);
    });

    it("fails on the wrong network or chain id", function () {
      const c = mainnetCase();
      expect(run(c, { chainId: 56n }).join("\n")).to.match(/chainId 1 does not match the connected chain 56/);
      c.manifest.network = "sepolia";
      expect(run(c).join("\n")).to.match(/manifest is for network "sepolia"/);
    });

    it("fails on a real network when a role is unpinned — it used to be a warning", function () {
      const c = mainnetCase();
      c.manifest.roles.timelock = Z;
      expect(run(c).join("\n")).to.match(/role timelock: not pinned/);
    });

    it("allows an unpinned role on a testnet", function () {
      const env = fullEnv("sepolia");
      const allocations = buildTgeAllocations({ networkName: "sepolia", env });
      const roles = liveRoles({ networkName: "sepolia", env });
      const manifest = manifestFor("sepolia", 11155111, allocations, roles);
      manifest.roles = {};
      expect(checkAgainstManifest({ allocations, manifest, roles, networkName: "sepolia", chainId: 11155111n }))
        .to.deep.equal([]);
    });

    it("fails on a role mismatch, and when a pinned role is not set for the network", function () {
      const c = mainnetCase();
      c.manifest.roles.governor = addr();
      c.roles.guardianModule = null;
      const out = run(c).join("\n");
      expect(out).to.match(/role governor mismatch/);
      expect(out).to.match(/role guardianModule: pinned in the manifest but not set/);
    });

    it("fails on a real network when a vault's beneficiary is not pinned", function () {
      const c = mainnetCase();
      delete c.manifest.tgeAllocations.Founders.beneficiary;
      expect(run(c).join("\n")).to.match(/Founders: manifest does not pin the vault's beneficiary/);
    });
  });

  // ── The chain ────────────────────────────────────────────────────────────────
  describe("checkOnChain", function () {
    const DAY = 86400n;

    async function chainFixture() {
      const [admin] = await ethers.getSigners();
      const Endpoint = await ethers.getContractFactory("MockLZEndpoint");
      const endpoint = await Endpoint.deploy(40161);
      const SRX = await ethers.getContractFactory("SRXToken");
      const token = await SRX.deploy(await endpoint.getAddress(), admin.address);
      const other = await SRX.deploy(await endpoint.getAddress(), admin.address);
      const Mock = await ethers.getContractFactory("MockERC20");
      const Vault = await ethers.getContractFactory("VestingVault");

      const schedules = {
        Founders: VESTING.founders, CoreTeam: VESTING.coreTeam, SeedInvestors: VESTING.seedInvestors,
        Presale: VESTING.presale, EcosystemDAO: VESTING.ecosystem,
      };
      const beneficiaries = {};
      const destinations = {};
      for (const [label, s] of Object.entries(schedules)) {
        beneficiaries[label] = addr();
        const v = await Vault.deploy(await token.getAddress(), beneficiaries[label], admin.address,
          s.cliffDuration, s.vestingDuration, s.tgeUnlockBps);
        destinations[label] = await v.getAddress();
      }
      for (const label of ["Staking", "Treasury", "StabilisationFund"]) {
        const m = await Mock.deploy("x", "x", 18);
        destinations[label] = await m.getAddress();
      }
      destinations.Liquidity = addr(); // a plain wallet is allowed here

      return { token, other, Vault, admin, beneficiaries, destinations };
    }

    function build(f, overrides = {}) {
      const d = { ...f.destinations, ...overrides };
      const allocations = [
        ["Founders", ALLOCATIONS.founders, true], ["CoreTeam", ALLOCATIONS.coreTeam, true],
        ["SeedInvestors", ALLOCATIONS.seedInvestors, true], ["Presale", ALLOCATIONS.presale, true],
        ["EcosystemDAO", ALLOCATIONS.ecosystem, true], ["Liquidity", ALLOCATIONS.liquidity, false],
        ["Staking", ALLOCATIONS.staking, false], ["Treasury", ALLOCATIONS.treasury, false],
        ["StabilisationFund", ALLOCATIONS.strategic, false],
      ].map(([label, amount, isVestingVault]) => ({ label, destination: d[label], amount, isVestingVault }));
      const tgeAllocations = {};
      for (const a of allocations) {
        tgeAllocations[a.label] = { destination: a.destination, ...(a.isVestingVault ? { beneficiary: f.beneficiaries[a.label] } : {}) };
      }
      return { allocations, manifest: { tgeAllocations } };
    }

    async function run(f, allocations, manifest, tokenAddress) {
      return checkOnChain({
        allocations, manifest, provider: ethers.provider,
        vaultAt: (a) => f.Vault.attach(a),
        tokenAddress: tokenAddress ?? await f.token.getAddress(),
      });
    }

    it("passes against correctly deployed vaults and contracts", async function () {
      const f = await loadFixture(chainFixture);
      const { allocations, manifest } = build(f);
      expect(await run(f, allocations, manifest)).to.deep.equal([]);
    });

    it("fails when a contract destination has no code", async function () {
      const f = await loadFixture(chainFixture);
      const { allocations, manifest } = build(f, { Treasury: addr() });
      expect((await run(f, allocations, manifest)).join("\n")).to.match(/Treasury: no contract at/);
    });

    it("fails when a vault pays a different beneficiary than the manifest pins", async function () {
      const f = await loadFixture(chainFixture);
      const { allocations, manifest } = build(f);
      manifest.tgeAllocations.SeedInvestors.beneficiary = addr();
      expect((await run(f, allocations, manifest)).join("\n")).to.match(/SeedInvestors: vault beneficiary .* ≠ manifest/);
    });

    it("fails when a vault's schedule differs from the config", async function () {
      const f = await loadFixture(chainFixture);
      const s = VESTING.founders;
      const wrong = await f.Vault.deploy(await f.token.getAddress(), f.beneficiaries.Founders, f.admin.address,
        s.cliffDuration - DAY, s.vestingDuration, s.tgeUnlockBps);
      const { allocations, manifest } = build(f, { Founders: await wrong.getAddress() });
      expect((await run(f, allocations, manifest)).join("\n")).to.match(/Founders: vault cliff/);
    });

    it("fails when a vault pays out a different token", async function () {
      const f = await loadFixture(chainFixture);
      const { allocations, manifest } = build(f);
      const out = (await run(f, allocations, manifest, await f.other.getAddress())).join("\n");
      expect(out).to.match(/vault pays out .*, not SRX/);
    });

    it("fails when a vault destination is some other contract", async function () {
      const f = await loadFixture(chainFixture);
      const { allocations, manifest } = build(f, { Presale: await f.token.getAddress() });
      expect((await run(f, allocations, manifest)).join("\n")).to.match(/Presale: .* does not answer as a VestingVault/);
    });
  });

  // ── The whole gate ───────────────────────────────────────────────────────────
  describe("runTgeTargetChecks", function () {
    const tmp = (name) => path.join(os.tmpdir(), `tge-${process.pid}-${name}.json`);

    it("fails on a real network with no manifest", async function () {
      const r = await runTgeTargetChecks({
        networkName: "ethereum", env: fullEnv("ethereum"), manifestPath: tmp("absent"),
      });
      expect(r.skipped).to.equal(false);
      expect(r.failures.join("\n")).to.match(/no manifest at/);
    });

    it("skips the manifest only on hardhat/localhost", async function () {
      const r = await runTgeTargetChecks({
        networkName: "hardhat", env: fullEnv("hardhat"), manifestPath: tmp("absent"),
      });
      expect(r.skipped).to.equal(true);
      expect(r.failures).to.deep.equal([]);
    });

    it("fails on an unreadable manifest, and when the on-chain checks cannot run", async function () {
      const bad = tmp("bad");
      fs.writeFileSync(bad, "{ not json");
      try {
        const r = await runTgeTargetChecks({ networkName: "ethereum", env: fullEnv("ethereum"), manifestPath: bad });
        expect(r.failures.join("\n")).to.match(/not valid JSON/);
      } finally { fs.rmSync(bad, { force: true }); }

      const c = mainnetCase();
      const good = tmp("good");
      fs.writeFileSync(good, JSON.stringify(c.manifest));
      try {
        const r = await runTgeTargetChecks({ networkName: "ethereum", chainId: 1n, env: c.env, manifestPath: good });
        expect(r.failures).to.deep.equal(["no provider given — the on-chain checks did not run"]);
      } finally { fs.rmSync(good, { force: true }); }
    });
  });

  // ── The wiring — tripwires on the scripts themselves ─────────────────────────
  describe("script wiring", function () {
    const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

    it("06_execute_tge.js runs the gate before any transaction and sends the list it checked", function () {
      const src = read("scripts/deploy/06_execute_tge.js");
      const gateAt = src.indexOf("await runTgeTargetChecks(");
      expect(gateAt, "gate call").to.be.greaterThan(-1);
      // Match the calls, not the header comment that names them.
      for (const tx of ["await tge.setAllocations(", "await token.genesis(", "await tge.distribute(",
                        "await vault.triggerTGE(", "await staking.notifyRewardAmount("]) {
        const at = src.indexOf(tx);
        expect(at, tx).to.be.greaterThan(gateAt);
      }
      expect(src).to.match(/if \(gate\.failures\.length > 0\) \{[\s\S]{0,200}throw new Error/);
      expect(src).to.match(/const finalAllocations = gate\.allocations;/);
      expect(src, "no second allocation list").to.not.match(/WALLETS\./);
    });

    it("verify_tge_targets.js uses the same gate and exits non-zero on failure", function () {
      const src = read("scripts/verify/verify_tge_targets.js");
      expect(src).to.match(/require\("\.\.\/deploy\/lib\/tge_targets"\)/);
      expect(src).to.match(/process\.exitCode = 1/);
      expect(src, "no rebuilt list").to.not.match(/ALLOCATIONS\./);
    });

    it("verify_tge.js counts the direct-allocation balances in its verdict", function () {
      const src = read("scripts/ops/verify_tge.js");
      expect(src).to.match(/const ok = check\(bal === expectedWei,/);
    });
  });
});
