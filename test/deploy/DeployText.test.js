// E-08 (review E, 22 Oct 2026): what the deploy scripts and the runbook SAY must match what they DO.
//
//  - no SRX contract is upgradeable since REG-53, but 04, 05 and 05b still described UUPS proxies that
//    are "initialized";
//  - the runbook told the operator to run `--network mainnet` and set `*_MAINNET` variables, but the
//    network is called `ethereum` (00_config LZ_ENDPOINTS, the variable suffix is the upper-cased
//    network name) and hardhat.config.js defines no mainnet network at all;
//  - 05b printed STABILISATION_FUND_<NET> and 08 printed GUARDIAN_<NET>, while the role scripts read
//    STABILISATION_<NET> and GUARDIAN_MODULE_<NET>.
const { expect } = require("chai");
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { lookupEnv, envNamesFor, ENV_ALIASES } = require("../../scripts/deploy/lib/launch_order");
const { liveRoles } = require("../../scripts/deploy/lib/tge_targets");

const ROOT = path.join(__dirname, "..", "..");
const src = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("E-08: no SRX contract is upgradeable, and the scripts no longer say it is", function () {
  for (const [file, label] of [
    ["scripts/deploy/04_deploy_staking.js", "04"], ["scripts/deploy/05_deploy_treasury.js", "05"], ["scripts/deploy/05b_deploy_stabilisation.js", "05b"],
  ]) {
    it(`${label}: no UUPS / proxy / implementation / initialize wording, and it says the contract is plain (REG-53)`, function () {
      const s = src(file);
      expect(s, "UUPS").to.not.match(/UUPS/);
      expect(s, "ERC1967").to.not.match(/ERC1967Proxy/);
      expect(s, "proxy label").to.not.match(/\w+ proxy:|Proxy:|proxy wrapper|\(UUPS|proxyAddr|stakingProxy|feeProxy|treasuryProxy/);
      expect(s, "initializes").to.not.match(/then initializes|implementation contract/);
      expect(s, "must say plain / not upgradeable").to.match(/not upgradeable/);
      expect(s, "must cite REG-53").to.match(/REG-53/);
    });

    it(`${label}: the script no longer imports the upgrades plugin it does not use`, function () {
      expect(src(file)).to.not.match(/\bupgrades\b/);
    });
  }

  it("verify_roles.js agrees: it fails a proxy (REG-53)", function () {
    expect(src("scripts/verify/verify_roles.js")).to.match(/requires a plain contract/);
  });
});

describe("E-08: the runbook uses the network name the scripts expect", function () {
  const rb = () => src("TGE_DEPLOYMENT_RUNBOOK.md");

  it("says `--network ethereum` and `_ETHEREUM`, never `mainnet` / `_MAINNET`", function () {
    expect(rb()).to.not.match(/--network mainnet/);
    expect(rb()).to.not.match(/_MAINNET\b/);
    expect(rb()).to.match(/--network ethereum/);
    expect(rb()).to.match(/`SRX_TOKEN_ETHEREUM`/);
  });

  it("states that there is no network called mainnet and that hardhat.config.js defines none yet", function () {
    expect(rb()).to.match(/There is no network called `mainnet`/);
    expect(rb()).to.match(/`hardhat\.config\.js` does \*\*not\*\* define a mainnet\s+network/);
  });

  it("and that statement is TRUE of the configuration (if a mainnet network is added, this fails: update the runbook)", function () {
    expect(hre.config.networks.ethereum, "ethereum is now defined in hardhat.config.js").to.equal(undefined);
    expect(hre.config.networks.mainnet).to.equal(undefined);
    // the suffix the scripts read is the upper-cased network name, and `ethereum` is the key they know
    const { LZ_ENDPOINTS, currentNetwork } = require("../../scripts/deploy/00_config");
    expect(LZ_ENDPOINTS.ethereum).to.be.a("string");
    expect(LZ_ENDPOINTS.mainnet).to.equal(undefined);
    expect(currentNetwork()).to.equal("hardhat");
  });
});

describe("E-08: one name per deployed address, and the older names are still read", function () {
  it("the aliases are STABILISATION -> STABILISATION_FUND and GUARDIAN -> GUARDIAN_MODULE", function () {
    expect(envNamesFor("STABILISATION_FUND")).to.deep.equal(["STABILISATION_FUND", "STABILISATION"]);
    expect(envNamesFor("GUARDIAN_MODULE")).to.deep.equal(["GUARDIAN_MODULE", "GUARDIAN"]);
    expect(envNamesFor("TIMELOCK")).to.deep.equal(["TIMELOCK"]);
    expect(ENV_ALIASES.GUARDIAN_MODULE).to.deep.equal(["GUARDIAN"]);
  });

  it("lookupEnv: the canonical name wins over an alias, suffixed over bare, and nothing is invented", function () {
    expect(lookupEnv("GUARDIAN_MODULE", "ethereum", { GUARDIAN_ETHEREUM: A })).to.deep.equal({ name: "GUARDIAN_ETHEREUM", value: A });
    expect(lookupEnv("GUARDIAN_MODULE", "ethereum", { GUARDIAN_ETHEREUM: A, GUARDIAN_MODULE_ETHEREUM: B })).to.deep.equal({ name: "GUARDIAN_MODULE_ETHEREUM", value: B });
    expect(lookupEnv("STABILISATION_FUND", "ethereum", { STABILISATION_ETHEREUM: A }).value).to.equal(A);
    expect(lookupEnv("STABILISATION_FUND", "ethereum", { STABILISATION_FUND: A }).value).to.equal(A); // bare
    expect(lookupEnv("STABILISATION_FUND", "ethereum", { STABILISATION_FUND: A }, { bare: false })).to.equal(null);
    expect(lookupEnv("STABILISATION_FUND", "ethereum", { STABILISATION_FUND_BSC: A })).to.equal(null); // another network
    expect(lookupEnv("STABILISATION_FUND", "ethereum", { STABILISATION_FUND_ETHEREUM: "  " })).to.equal(null);
  });

  it("the TGE gate's role lookup accepts GUARDIAN_<NET> as well as GUARDIAN_MODULE_<NET>", function () {
    const base = { ADMIN_ADDRESS: ethers_addr(1), TIMELOCK_ETHEREUM: ethers_addr(2), GOVERNOR_ETHEREUM: ethers_addr(3) };
    expect(liveRoles({ networkName: "ethereum", env: { ...base, GUARDIAN_ETHEREUM: ethers_addr(4) } }).guardianModule).to.equal(ethers_addr(4));
    expect(liveRoles({ networkName: "ethereum", env: { ...base, GUARDIAN_MODULE_ETHEREUM: ethers_addr(5) } }).guardianModule).to.equal(ethers_addr(5));
    expect(liveRoles({ networkName: "ethereum", env: base }).guardianModule).to.equal(null);
  });

  it("08 prints GUARDIAN_MODULE_<NET>; 05b prints STABILISATION_FUND_<NET>; the role scripts read those names", function () {
    expect(src("scripts/deploy/08_deploy_guardian.js")).to.match(/console\.log\(`GUARDIAN_MODULE_\$\{NET\}=\$\{guardianAddr\}`\)/);
    expect(src("scripts/deploy/08_deploy_guardian.js")).to.not.match(/console\.log\(`GUARDIAN_\$\{NET\}=/);
    expect(src("scripts/deploy/05b_deploy_stabilisation.js")).to.match(/`STABILISATION_FUND_\$\{NET\}=/);
    for (const p of ["scripts/verify/verify_roles.js", "scripts/ops/migrate_roles.js"]) {
      expect(src(p), p).to.match(/envAddr\("STABILISATION_FUND"/);
      expect(src(p), p).to.match(/envAddr\("GUARDIAN_MODULE"/);
      expect(src(p), p).to.not.match(/envAddr\("STABILISATION"/);
    }
  });
});

/** A fixed, valid, checksummed address for tests. */
function ethers_addr(n) {
  return hre.ethers.getAddress("0x" + String(n).padStart(40, "0"));
}
