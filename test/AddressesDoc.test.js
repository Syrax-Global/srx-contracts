// docs/ADDRESSES.md is the one place deployed addresses are published (GitHub Standards,
// 1 Oct 2026: the README pointed readers at this repo for addresses while two documents
// listed May's superseded Sepolia addresses as "Deployed & Verified").
const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { render, records, OUT } = require("../scripts/docs/addresses");

const ROOT = path.join(__dirname, "..");
// Documents a reader might take an address from. Each must link to docs/ADDRESSES.md instead.
const DOCS = ["README.md", "SRX_TOKEN_COMPLETE_OVERVIEW.md", "TGE_DEPLOYMENT_RUNBOOK.md", "AUDIT_SCOPE.md",
  "SECURITY.md", "MULTISIG_SPEC.md", "docs/CONTRACTS.md", "docs/README.md", "docs/TOKENOMICS.md"];
// Addresses that are not deployments: the burn address and the zero address.
const NOT_DEPLOYMENTS = new Set(["0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"]);

describe("docs/ADDRESSES.md — the one published address list", function () {
  it("is up to date with deployments/<network>.json (run: node scripts/docs/addresses.js)", function () {
    const onDisk = fs.readFileSync(OUT, "utf8").replace(/\r\n/g, "\n");
    expect(onDisk, "docs/ADDRESSES.md is out of date — run: node scripts/docs/addresses.js").to.equal(render());
  });

  it("lists the Sepolia hub, and says plainly there is no mainnet deployment", function () {
    expect(records().map((r) => r.net)).to.include("sepolia");
    const text = render();
    expect(text).to.include("SRX is not deployed on any mainnet");
    expect(text).to.not.match(/mainnet\s*\|/i);
  });

  for (const doc of DOCS) {
    it(`${doc} lists no deployed address of its own`, function () {
      const p = path.join(ROOT, doc);
      // A missing document fails rather than skips: a rename must update this list, not hide from it.
      expect(fs.existsSync(p), `${doc} is listed here but does not exist`).to.equal(true);
      const found = (fs.readFileSync(p, "utf8").match(/0x[0-9a-fA-F]{40}\b/g) || [])
        .filter((a) => !NOT_DEPLOYMENTS.has(a.toLowerCase()));
      expect(found, `${doc} repeats addresses; link to docs/ADDRESSES.md instead`).to.deep.equal([]);
    });
  }
});
