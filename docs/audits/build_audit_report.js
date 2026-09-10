const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, LevelFormat, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageBreak, PageNumber, Footer,
} = require("docx");

// US Letter, 1in margins → content width 12240-1440-1440 = 9360 DXA.
// EVERY table must sum to <= 9300 (safety buffer); table() asserts this.
const CONTENT_WIDTH = 9300;

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const HEADER_FILL = "1F3864";
const SEV_FILL = { Critical: "C00000", High: "E36C0A", Medium: "BF9000", Low: "548235", Informational: "808080" };

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 100 },
    heading: opts.heading,
    pageBreakBefore: opts.pageBreakBefore || false,
    keepNext: opts.heading ? true : (opts.keepNext || false),
    keepLines: opts.heading ? true : false,
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italics, size: opts.size, color: opts.color })],
  });
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 50 },
    children: [new TextRun({ text, size: 20 })],
  });
}

function cell(text, opts = {}) {
  return new TableCell({
    borders,
    width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
    shading: opts.fill ? { fill: opts.fill, type: ShadingType.CLEAR } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({
      spacing: { line: 230, lineRule: "auto" },
      children: [new TextRun({ text, bold: opts.bold, color: opts.color || (opts.fill ? "FFFFFF" : undefined), size: opts.size || 17 })],
    })],
  });
}

function sevCell(sev) {
  return cell(sev, { fill: SEV_FILL[sev] || "808080", bold: true, color: "FFFFFF", size: 16 });
}

// cantSplit on every row: a row is never sliced across a page boundary.
function table(headers, rows, widths) {
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum > CONTENT_WIDTH) throw new Error(`Table width ${sum} exceeds ${CONTENT_WIDTH}: ${headers.join(",")}`);
  return new Table({
    width: { size: sum, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ cantSplit: true, children: headers.map((h, i) => cell(h, { width: widths[i], fill: HEADER_FILL, bold: true, size: 17 })) }),
      ...rows.map(r => new TableRow({ cantSplit: true, children: r.map((c, i) => {
        if (typeof c === "object" && c.sev) return sevCell(c.sev);
        return cell(String(c), { width: widths[i] });
      })})),
    ],
  });
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Calibri", size: 21 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Calibri", color: HEADER_FILL },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: "Calibri", color: HEADER_FILL },
        paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [{ reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }],
  },
  sections: [{
    properties: {
      page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
    },
    footers: {
      default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "SRX Token — Consolidated Internal Security Audit Report  |  Page ", size: 16 }),
          new TextRun({ children: [PageNumber.CURRENT], size: 16 }),
          new TextRun({ text: " of ", size: 16 }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16 }),
        ],
      })] }),
    },
    children: [
      // ── COVER ────────────────────────────────────────────────────────────────
      new Paragraph({ spacing: { before: 1800 }, alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "SRX TOKEN", bold: true, size: 56, color: HEADER_FILL })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
        children: [new TextRun({ text: "Consolidated Internal Security Audit Report", bold: true, size: 36 })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 800 },
        children: [new TextRun({ text: "Seven Internal Audit Rounds — Prepared for External Audit Engagement", italics: true, size: 24, color: "555555" })] }),

      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
        children: [new TextRun({ text: "Project: Syrax Token (SRX)", size: 22 })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
        children: [new TextRun({ text: "Repository: Syrax-Global/srx-token (private)", size: 22 })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
        children: [new TextRun({ text: "Audit Period: 19 May 2026 – 16 July 2026", size: 22 })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
        children: [new TextRun({ text: "Document Date: 16 July 2026", size: 22 })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
        children: [new TextRun({ text: "Classification: Confidential", size: 22 })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 600 },
        children: [new TextRun({ text: "Contact: security@syrax.global", size: 22 })] }),

      new Paragraph({ alignment: AlignmentType.CENTER, border: { top: { style: BorderStyle.SINGLE, size: 6, color: HEADER_FILL, space: 8 } },
        spacing: { before: 400 },
        children: [new TextRun({ text: "This document consolidates the findings, remediations, and verification evidence of seven internal security audit rounds performed on the SRX Token smart contract suite. It is provided to accelerate and inform the scope of an independent external audit engagement.", size: 20, italics: true })] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ── EXECUTIVE SUMMARY ────────────────────────────────────────────────────
      p("Executive Summary", { heading: HeadingLevel.HEADING_1 }),
      p("The SRX Token smart contract suite — 15 production contracts, approximately 5,900 lines of Solidity — has undergone seven internal security audit rounds between 19 May 2026 and 16 July 2026. This document consolidates all seven rounds into a single record for external audit reference."),
      p("The audit methodology applies seven mandatory review perspectives in every round, aligned with the review disciplines used by leading smart-contract audit firms: (1) code correctness, (2) economic/MEV and cross-contract attack modeling, (3) token invariant verification, (4) upgradeability and storage-layout integrity, (5) cross-chain bridge security, (6) operational stress and external-dependency failure modes, and (7) centralization/trust mapping. Rounds 4, 5 and 7 were each conducted by a reviewer independent of the team responsible for the preceding round, specifically to reduce reviewer-lineage bias."),

      p("Convergence, Then Drift", { heading: HeadingLevel.HEADING_2 }),
      p("Rounds 1 through 3 (23 May 2026) surfaced the bulk of code-correctness and economic findings — 24 in total, with zero Critical or High severity items persisting after fixes. Round 4 (29 May 2026, an independent reviewer pass) surfaced two governance-topology findings rated High — both architectural rather than code defects — and both were remediated the same day via a dedicated Timelock-only upgrade role and an automated on-chain verification gate. Round 5 (12 June 2026, a second independent pass explicitly targeting the Round 4 remediation code) found zero new Critical, High, or Medium findings. Round 6 (21 June 2026) extended scope beyond contract code to the surrounding deployment, operational, and organizational attack surface."),
      p("Round 7 (16 July 2026) is the most instructive round in the programme, and is reported here in full rather than summarised. After the six-round convergence, a change to the staking fee-tier and fee-floor logic was committed on 15 July — after every prior round had signed off. An independent seventh pass, scoped deliberately at post-sign-off code changes and at cross-contract composition, identified three Medium findings in that newly introduced surface. All were remediated and regression-tested."),
      p("The programme's conclusion is therefore not simply that the code converged, but something more useful to an incoming auditor: convergence is a property of a frozen codebase, and it does not survive change. The two mechanisms that caught the Round 7 issues — independent review of newly written code, and validating cross-contract composition rather than contracts in isolation — are the two areas where independent external scrutiny is most valuable."),

      p("Summary — All Rounds", { heading: HeadingLevel.HEADING_2 }),
      table(
        ["Round", "Date", "Findings", "Crit / High Open", "Status"],
        [
          ["R1", "19 May 2026", "6 (5 Low, 1 Info)", "0 / 0", "Resolved"],
          ["R2", "23 May 2026", "8 (1 High*, 3 Med, 2 Low, 2 Info)", "0 / 0", "Resolved"],
          ["R3", "23 May 2026", "11 (1 Med, 6 Low, 4 Info)", "0 / 0", "Resolved"],
          ["R4", "29 May 2026", "11 (2 High, 3 Med, 4 Low, 2 Info)", "0 / 2 → 0", "Resolved same day"],
          ["R5", "12 Jun 2026", "7 (4 Low, 3 Info)", "0 / 0", "Resolved, regression-tested"],
          ["R6", "21 Jun 2026", "1 critical process gap + 11 domain findings", "0 / 0 (code)", "Highest item remediated"],
          ["R7", "16 Jul 2026", "6 (3 Med, 1 Low, 2 Info)", "0 / 0", "Resolved, regression-tested"],
        ],
        [900, 1500, 3300, 1500, 2100],
      ),
      p("* SC-PR-002 (Round 2) was rated High under the single-EOA testnet admin model in effect at the time; it downgrades to Informational once the documented multisig-and-Timelock requirement is in place — a tracked mainnet precondition.", { size: 17, italics: true }),

      p("Verification Coverage", { heading: HeadingLevel.HEADING_2 }),
      bullet("692 Hardhat unit/integration tests (1 pending), covering every contract function and access-control path."),
      bullet("7 Foundry test suites: 4 system invariants + 3 property-fuzz tests, executing 51,200+ randomized calls with zero reverts. Invariants verified: total-supply conservation, sum-of-balances equals total supply, voting power never exceeds supply, burned amount never exceeds max supply."),
      bullet("Slither static analysis integrated into continuous integration (build fails on High-severity findings)."),
      bullet("Echidna property-based fuzzing configured for nightly campaigns."),
      bullet("Every fix across all seven rounds is accompanied by a targeted regression test proving the specific vulnerability class is closed, not merely that the general suite still passes."),

      p("External Audit Readiness", { heading: HeadingLevel.HEADING_2 }),
      p("The contract suite is assessed as ready for external audit engagement. All contract-code Critical, High, and Medium findings across seven rounds have been resolved and regression-tested. The security team does not consider this internal programme a substitute for an independent external audit: successive internal rounds share process and tooling assumptions that only an external, differently-resourced team can fully escape — and Round 7 demonstrates concretely that a codebase which has converged can still regress when it changes. This document exists to make the external engagement faster, cheaper, and more precisely targeted."),
      p("Section 11 (\"Focus Areas Requested for External Review\") identifies the specific areas where independent scrutiny is most valued."),

      new Paragraph({ children: [new PageBreak()] }),

      // ── METHODOLOGY ──────────────────────────────────────────────────────────
      p("1. Scope & Methodology", { heading: HeadingLevel.HEADING_1 }),
      p("1.1 Contract Scope", { heading: HeadingLevel.HEADING_2 }),
      p("15 production contracts, approximately 5,900 lines of Solidity (compiler 0.8.24, viaIR pipeline, optimizer at 200 runs, EVM target Cancun). Full contract-by-contract scope, line counts, and complexity notes are provided in the companion document AUDIT_SCOPE.md."),
      p("1.2 The Seven Mandatory Review Perspectives", { heading: HeadingLevel.HEADING_2 }),
      p("Every round applied — and every round's closing report explicitly accounted for — the following seven perspectives. A perspective producing zero findings in a given round is recorded as verified clean, never silently omitted:"),
      bullet("Code correctness — defensive bug-hunting: off-by-one errors, missing guards, incorrect operators, dead code, input validation."),
      bullet("Economic / MEV / cross-contract — sandwich attacks, oracle-timing arbitrage, tier-boundary gaming, and composition attacks where each contract is locally safe but the combination is not."),
      bullet("Token invariant verification — proof-by-inspection of supply conservation, reward-pool solvency, and voting-power conservation across every state-changing function."),
      bullet("Upgradeability / storage-layout integrity — UUPS proxy safety: initializer protection, storage-gap discipline, upgrade-authorization topology."),
      bullet("Cross-chain bridge security — endpoint trust, peer authorization, mint/burn conservation across chains, replay protection."),
      bullet("Operational stress / external dependencies — oracle failure modes, stablecoin depeg, feed staleness, gas-price stress on batch operations."),
      bullet("Centralization / trust mapping — a complete role-by-role, contract-by-contract matrix of every privileged capability and its compromise impact (a standing deliverable; see Section 9)."),
      p("1.3 Independent Re-Review Design", { heading: HeadingLevel.HEADING_2 }),
      p("Rounds 4, 5 and 7 were each conducted by a reviewer independent of the team responsible for the preceding rounds. Round 5 was scoped to treat all Round 4 remediation code as primary — rather than assumed-safe — attack surface. Round 7 applied the same principle to a code change that landed after every prior round had closed. This constitutes an internal second-opinion review and is the basis for the convergence-then-drift pattern described in the Executive Summary."),

      new Paragraph({ children: [new PageBreak()] }),

      // ── ROUNDS 1–3 ───────────────────────────────────────────────────────────
      p("2. Round 1 — New-Code Correctness Review (19 May 2026)", { heading: HeadingLevel.HEADING_1 }),
      p("Scope: four features added 21–23 May 2026 on top of an already-reviewed 13-contract base (Launch Protection in SRXToken, the new BuybackBurner contract, the new SRXAirdrop contract, and a new rescueTokens admin function). 634 tests passing at time of review."),
      table(
        ["ID", "Title", "Sev", "Status"],
        [
          ["SC-LP-001", "Self-transfer incorrectly blocked by wallet-cap check", { sev: "Low" }, "Fixed"],
          ["SC-BB-001", "buyAndBurnWithToken() lacked nonReentrant (defense in depth)", { sev: "Low" }, "Fixed"],
          ["SC-BB-002", "ETH sent to BuybackBurner had no recovery path", { sev: "Low" }, "Fixed"],
          ["SC-AD-001", "Airdrop Merkle leaves used single-hash, not the standard double-hash", { sev: "Low" }, "Fixed"],
          ["SC-RT-001", "rescueTokens() could not recover SRX mistakenly sent to the token contract", { sev: "Low" }, "Fixed"],
          ["SC-LP-002", "Governance can silently de-exempt a live contract mid-operation", { sev: "Informational" }, "Documented"],
        ],
        [1300, 4700, 900, 2400],
      ),

      p("3. Round 2 — Economic / MEV / Cross-Contract Review (23 May 2026)", { heading: HeadingLevel.HEADING_2 }),
      p("A full re-pass of the suite through an adversarial economic and cross-contract lens — the perspective most likely to surface exploitable dynamics that a pure code-correctness read misses."),
      table(
        ["ID", "Title", "Sev", "Status"],
        [
          ["SC-PR-002", "PreSaleRound admin could drain investor funds before vault deployment", { sev: "High" }, "Mitigated — multisig + Timelock required at mainnet"],
          ["SC-LP-003", "Launch protection could block large vesting unlocks without exemption", { sev: "Medium" }, "Resolved — cap-sizing policy + exemption checklist"],
          ["SC-PR-001", "Oracle staleness window enabled ETH/BTC price-drift arbitrage", { sev: "Medium" }, "Fixed — staleness window reduced, later per-feed"],
          ["SC-AD-002", "Airdrop Merkle root reuse across chains enabled double-claim replay", { sev: "Medium" }, "Fixed — chain ID bound into leaf encoding"],
          ["SC-BB-003", "Swap-and-burn flow vulnerable to public-mempool sandwich attacks", { sev: "Low" }, "Mitigated — private-mempool submission required"],
          ["SC-VV-001", "VestingVault.revoke() could stall if beneficiary is at launch cap", { sev: "Low" }, "Resolved — vault addresses exempt by policy"],
          ["SC-BR-001", "Cross-chain buyAndBurn reduces global, not chain-local, supply", { sev: "Informational" }, "Documented"],
          ["SC-PR-003", "Tier-boundary retroactive bonus upgrade is intentional design", { sev: "Informational" }, "Documented for auditor briefing"],
        ],
        [1300, 4300, 900, 2800],
      ),

      p("4. Round 3 — Invariants, Upgradeability, Bridge, Trust Map (23 May 2026)", { heading: HeadingLevel.HEADING_2 }),
      p("Completed the seven-perspective methodology by covering the four perspectives Rounds 1 and 2 had not yet exercised. Produced the first version of the Centralization Trust Matrix (see Section 9)."),
      table(
        ["ID", "Title", "Sev", "Status"],
        [
          ["SC-OPS-001", "Oracle price accepted with no plausibility bounds", { sev: "Medium" }, "Fixed — min/max price bounds added"],
          ["SC-UUPS-001", "No documented storage-gap discipline for future upgrades", { sev: "Low" }, "Fixed — NatSpec discipline + runbook requirement"],
          ["SC-UUPS-002", "Initializer granted roles before all state was set", { sev: "Low" }, "Fixed — state-before-roles ordering enforced"],
          ["SC-LZ-001", "Bridge setPeer is owner-gated with no Timelock delay", { sev: "Low" }, "Mitigated — pause guard added; carried to R4/R6"],
          ["SC-OPS-002", "USDC/USDT hardcoded at $1 with no depeg protection", { sev: "Low" }, "Fixed — optional Chainlink stablecoin feed added"],
          ["SC-OPS-003", "ETH withdrawal to a non-payable address had no partial option", { sev: "Low" }, "Fixed — partial-withdraw variant added"],
          ["SC-OPS-004", "Permit-deadline timing sensitivity (protocol-wide EIP limitation)", { sev: "Low" }, "Documented — integration guidance issued"],
          ["SC-INV-001/2/3", "Supply, voting-power, and reward invariants verified by inspection", { sev: "Informational" }, "Verified clean"],
        ],
        [1300, 4300, 900, 2800],
      ),

      p("5. Round 4 — Independent Full Re-Pass (29 May 2026)", { heading: HeadingLevel.HEADING_2 }),
      p("An independent reviewer pass across all seven perspectives against the complete suite, verifying Rounds 1–3 fixes were present and hunting new ground. Central finding: code-level security was strong, but the deployment-time role topology was off-chain and unenforced — the security narrative in the contract documentation was only true after a precise, unenforced post-deployment migration."),
      table(
        ["ID", "Title", "Sev", "Status"],
        [
          ["SC-TRUST-001", "Upgrade authority gated on the same multipurpose role the admin held, not the Timelock", { sev: "High" }, "Fixed same day — dedicated Timelock-only upgrade role"],
          ["SC-TRUST-002", "Privileged roles concentrated on the deployer address, no enforced migration", { sev: "High" }, "Fixed same day — automated verification gate added"],
          ["SC-LZ-001", "(Carried forward) Bridge peer-set authority not Timelock-gated", { sev: "Medium" }, "Documented as a deployment gate pre-mainnet"],
          ["SC-TRUST-003", "Emergency fast-path deployment had no destination allowlist", { sev: "Medium" }, "Fixed — governance-managed allowlist added"],
          ["SC-TRUST-004", "PreSaleRound admin could sweep funds / revoke vaults unilaterally", { sev: "Medium" }, "Documented — admin must be a multisig"],
          ["SC-ECON-001", "Reward-pool emission not bounded by the funded pool", { sev: "Low" }, "Fixed — emission capped to funded pool"],
          ["SC-ECON-002", "Single staleness threshold did not fit multiple feed heartbeats", { sev: "Low" }, "Fixed — per-feed staleness overrides added"],
          ["SC-OPS-001", "Stablecoin oracle feed lacked price-bound checks", { sev: "Low" }, "Fixed — bounds parity with ETH/BTC feeds"],
          ["SC-CR-001", "Contract documentation described the wrong leaf encoding", { sev: "Low" }, "Fixed — documentation corrected"],
        ],
        [1300, 4300, 900, 2800],
      ),

      p("6. Round 5 — Independent Adversarial Re-Pass (12 June 2026)", { heading: HeadingLevel.HEADING_2 }),
      p("A reviewer independent of the Round 4 team re-audited the full suite, explicitly treating all Round 4 remediation code as primary attack surface. Result: zero new Critical, High, or Medium findings."),
      table(
        ["ID", "Title", "Sev", "Status"],
        [
          ["R5-01", "Stranded reward-pool recovery applied to one contract but not its structural twin", { sev: "Low" }, "Fixed — matching recovery + regression tests"],
          ["R5-02", "Mid-round price change could interact unsafely with top-up accounting", { sev: "Low" }, "Fixed — price locked once first investor recorded"],
          ["R5-03", "Allocation-correction function omitted a bonus factor used elsewhere", { sev: "Low" }, "Fixed — corrected inverse, round-trip verified"],
          ["R5-04", "A read-only quote function used a different pricing path than live investment", { sev: "Low" }, "Fixed — quote path matches live path"],
          ["R5-05/06/07", "Minor rounding dust; standard bridge behavior; input-validation reminder", { sev: "Informational" }, "Documented / subsumed"],
        ],
        [1300, 4700, 900, 2400],
      ),

      p("7. Round 6 — Holistic Systemic Threat Model (21 June 2026)", { heading: HeadingLevel.HEADING_2 }),
      p("Round 6 audited what contract-code rounds structurally could not reach: deployment process, key custody, economic design, bridge configuration, governance mechanics, oracle infrastructure, supply-chain integrity, regulatory posture, post-launch operations, formal-verification coverage, and incident-response realism — twelve domains.", { keepNext: true }),
      p("The review found the genesis token-generation-event execution — which moves the full 10-billion-token supply to its destination addresses — relied on manually configured environment values with no automated destination allowlist. A single misconfigured address could have sent an unrecoverable share of total supply to the wrong destination. This was the most severe finding of the programme and was remediated within the same round.", { keepNext: true }),
      table(
        ["Finding", "Domain", "Sev", "Status"],
        [
          ["No automated destination allowlist for token-generation-event distribution", "Deployment", { sev: "Critical" }, "Remediated — automated pre-flight verification now gates execution"],
          ["Mainnet deployment signing relies on a single raw private key", "Deployment", { sev: "High" }, "Documented — hardware-wallet procedure specified"],
          ["A legacy migration script could be run by mistake, re-opening a resolved issue", "Deployment", { sev: "High" }, "Deprecated in favor of the verified tool"],
          ["No documented sell-pressure model for vesting unlock cliffs", "Economic design", { sev: "High" }, "Drafted — requires founder input"],
          ["Bridge verifier-set configuration not yet a specified deployment gate", "Bridge", { sev: "High" }, "Drafted — requires a verifier-set decision"],
          ["Multisig custody ceremony not yet documented", "Key management", { sev: "High" }, "Drafted — requires founder finalization"],
          ["Further findings across oracle config, build integrity, governance timeline, regulatory mapping, launch operations, formal verification, incident response", "6 further domains", "Med/Low", "Documented remediation backlog"],
        ],
        [3300, 1600, 900, 3500],
      ),

      new Paragraph({ children: [new PageBreak()] }),

      // ── ROUND 7 ──────────────────────────────────────────────────────────────
      p("8. Round 7 — Post-Change Independent Re-Pass (16 July 2026)", { heading: HeadingLevel.HEADING_1 }),
      p("On 15 July 2026 — after all six prior rounds had closed — a change was committed to the staking fee-tier and fee-floor logic, addressing two commercial concerns: that the top fee-discount tier implied a permanently zero platform fee, and that the tier could be obtained with no genuine duration commitment. Both concerns were legitimate. The change itself, however, had not been reviewed by any audit round, and its own commit message recorded that the Foundry suite had not been executed against it.", { keepNext: true }),
      p("Round 7 was scoped accordingly: newly introduced post-sign-off code, plus cross-contract composition — the two surfaces a converged, per-contract review programme is least able to cover. It produced three Medium findings, all in code introduced after Round 6, and all since remediated with dedicated regression tests.", { keepNext: true }),
      table(
        ["ID", "Title", "Sev", "Status"],
        [
          ["R7-01", "Fee tier persisted indefinitely after lock expiry — the duration multiplier granted a permanent entitlement for a finite commitment, halving the capital cost of the top tier", { sev: "Medium" }, "Fixed — multiplier now applies only while the lock is active; reverts to raw principal at expiry"],
          ["R7-02", "Guardian pause-state desynchronisation could revert the entire emergency stop, disabling it for every module", { sev: "Medium" }, "Fixed — batch pause/unpause made best-effort per module, with state reconciliation and events"],
          ["R7-06", "The pausable test double could not revert, so the guardian test suite could not detect the failure class in R7-02", { sev: "Medium" }, "Fixed — faithful test double added implementing real pause semantics"],
          ["R7-03", "Fee-floor could be configured above the base fee, inverting discounts into increases", { sev: "Low" }, "Fixed — invariant enforced across all three setters"],
          ["R7-04", "Scope changed after audit sign-off; Foundry suite unverified against the change", { sev: "Informational" }, "Resolved — Foundry executed and passing; branch freeze recommended"],
          ["R7-05", "Public tier documentation does not yet reflect duration weighting", { sev: "Informational" }, "Flagged for update before public launch"],
        ],
        [900, 4400, 900, 3000],
      ),
      p("Two observations from this round are worth surfacing to an incoming auditor.", { keepNext: true }),
      p("First, R7-02 existed only in the composition of the guardian module's locally tracked state with six external contracts, each exposing an independent pause authority. No single file was incorrect. Reviews that proceed contract-by-contract are structurally unable to detect this class of issue.", { keepNext: true }),
      p("Second, R7-06 explains why R7-02 survived six rounds: the pausable test double used throughout the guardian test suite implemented pause as an unguarded boolean assignment, so it could never revert. Every scenario depending on real pause semantics passed trivially. Test doubles that diverge from production behaviour are more dangerous than absent tests, because they produce confidence in an unexercised path. The suite has been given a faithful double; migrating the remaining guardian tests to it is recommended.", { keepNext: true }),
      p("A product decision is embedded in the R7-01 remediation and is flagged explicitly rather than left implicit: a staker who reached a tier via a long lock now returns to the tier their raw principal earns once that lock expires, restorable by re-locking. This treats the duration multiplier as pricing active commitment. If permanent tiers are instead intended, the thresholds require re-derivation, because under the prior behaviour the top tier's effective cost was half its nominal value."),

      new Paragraph({ children: [new PageBreak()] }),

      // ── TRUST MATRIX ─────────────────────────────────────────────────────────
      p("9. Centralization / Trust Matrix", { heading: HeadingLevel.HEADING_1 }),
      p("Produced as a standing deliverable under Perspective 7 and maintained across rounds. This is the authoritative map of every privileged capability in the system, its intended holder, and the impact of its compromise."),
      table(
        ["Contract", "Role", "Intended Holder (Mainnet)", "Compromise Impact"],
        [
          ["SRXToken", "Admin / Governance / Pauser", "Multisig → Timelock / Guardian module", "Total token control if unmigrated; mitigated post-migration"],
          ["SRXToken", "Bridge owner (setPeer)", "Timelock, or a hardened multisig", "Cross-chain mint-without-burn if compromised"],
          ["Treasury / Staking / Fee / Stabilisation", "Upgrade authority", "Timelock only, dedicated role", "Fund drain via malicious upgrade if misconfigured; closed by dedicated role + gate"],
          ["StabilisationFund", "Emergency fast-path deployment", "Distinct treasurer / guardian multisigs, allowlisted", "Bounded drain per stress cycle if a signer is compromised"],
          ["PreSaleRound", "Round administrator", "Multisig (mainnet requirement)", "Investor funds at discretion until vault deployment — disclosed"],
          ["Guardian module", "Guardian / governance override", "Guardian multisig / Timelock", "Time-bounded pause only; governance can always override"],
        ],
        [2400, 1700, 2200, 3000],
      ),
      p("Round 7 note: pause authority is currently held by both the guardian module and the admin multisig on every pausable contract. Consolidating it to the guardian module alone post-migration removes the desynchronisation source behind R7-02 at its root; the code is now tolerant of the condition either way."),

      // ── COVERAGE ─────────────────────────────────────────────────────────────
      p("10. Seven-Perspective Coverage Confirmation", { heading: HeadingLevel.HEADING_1 }),
      p("No round is considered complete without an explicit accounting of all seven perspectives — a perspective producing zero findings is recorded as verified clean, never silently omitted."),
      table(
        ["Perspective", "Rounds", "Cumulative Result"],
        [
          ["1. Code correctness", "R1, R4, R5, R7", "All findings resolved and regression-tested"],
          ["2. Economic / MEV / cross-contract", "R2, R4, R5, R7", "All resolved; R7 closed a fee-tier economic leak in newly added code"],
          ["3. Invariant verification", "R3, R4, R5, Foundry", "Verified clean every round; 51,200+ randomized calls, zero reverts"],
          ["4. Upgradeability / storage", "R3, R4, R5", "Storage-gap discipline enforced; upgrade authority isolated to a Timelock-only role"],
          ["5. Cross-chain bridge", "R3, R4, R5, R6", "Core bridge logic verified against its audited upstream base; verifier-set configuration tracked as a deployment gate"],
          ["6. Operational stress / external deps", "R3, R4, R5, R7", "Oracle and depeg protections tested; R7 hardened the emergency-pause path"],
          ["7. Centralization / trust map", "R3, R4, R5, R6, R7", "Full matrix maintained; role migration mechanically enforced by automated tooling"],
        ],
        [2800, 1600, 4900],
      ),

      new Paragraph({ children: [new PageBreak()] }),

      // ── FOCUS AREAS ──────────────────────────────────────────────────────────
      p("11. Focus Areas Requested for External Review", { heading: HeadingLevel.HEADING_1 }),
      p("The following areas are proactively flagged as where independent, differently-tooled scrutiny is most valued — not because internal review found unresolved issues, but because these are the highest-leverage areas for a second, independent opinion:"),
      bullet("The cross-chain bridge — mint/burn conservation, peer-authorization topology, and decentralized-verifier-network configuration."),
      bullet("The Timelock-only upgrade-authority separation introduced in Round 4 — confirmation that the role topology and its automated verification gate correctly close the upgrade-authority risk."),
      bullet("Cross-contract composition generally, and the guardian module's pause orchestration specifically. Round 7 found that the only Medium-severity composition issue in the suite was invisible to per-contract review; the remediation is new and would benefit from independent confirmation."),
      bullet("The staking fee-tier and fee-floor logic changed in July 2026 and remediated in Round 7 — the newest code in the suite, and correspondingly the least reviewed."),
      bullet("Presale contract oracle-pricing and tier-bonus mathematics — the most complex arithmetic in the suite, refined across four rounds."),
      bullet("The dual reward-accounting systems in the staking and stabilisation-fund contracts — emission-cap correctness under adversarial parameter changes."),
      bullet("Formal verification of the cross-contract supply-conservation invariant, which internal test coverage currently verifies only at the single-contract level."),

      p("12. Contact & Access", { heading: HeadingLevel.HEADING_1 }),
      p("Repository access, the current test suite, build instructions, and the full unabridged internal findings for each round are available on request. The audit commit will be tagged at engagement start so the review maps to an immutable tree. The team is available for scoping calls and ongoing questions throughout the engagement."),
      new Paragraph({ spacing: { before: 200 }, children: [
        new TextRun({ text: "Security contact: ", bold: true }), new TextRun("security@syrax.global"),
      ]}),
      new Paragraph({ children: [
        new TextRun({ text: "Repository: ", bold: true }), new TextRun("github.com/Syrax-Global/srx-token (private — read access available on request)"),
      ]}),
    ],
  }],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync("SRX_TOKEN_CONSOLIDATED_AUDIT_REPORT.docx", buf);
  console.log("DOCX written OK.");
});
