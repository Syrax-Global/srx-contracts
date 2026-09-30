// docs/TOKENOMICS.md must be exactly what scripts/docs/tokenomics.js generates from
// scripts/deploy/00_config.js — so no tokenomics figure can be hand-edited out of line
// with the contracts' configuration again.
const { expect } = require("chai");
const fs = require("fs");
const { render, OUT } = require("../scripts/docs/tokenomics");

describe("docs/TOKENOMICS.md — generated from the configuration", function () {
  it("is up to date (run: node scripts/docs/tokenomics.js)", function () {
    const onDisk = fs.readFileSync(OUT, "utf8").replace(/\r\n/g, "\n");
    expect(onDisk, "docs/TOKENOMICS.md is out of date — run: node scripts/docs/tokenomics.js").to.equal(render());
  });

  it("states the 5% launch float and the 10B supply", function () {
    const text = render();
    expect(text).to.include("**500,000,000 SRX (5.00%) is transferable the moment the token launches**");
    expect(text).to.include("**Maximum supply:** 10,000,000,000 SRX");
  });

  it("carries no price, valuation or market figure (the repo is mirrored publicly)", function () {
    const text = render();
    expect(text).to.not.match(/\$\s?\d/);
    expect(text).to.not.match(/\b(FDV|market cap|valuation|per SRX)\b/i);
  });
});
