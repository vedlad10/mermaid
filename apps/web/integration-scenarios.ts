/**
 * The recorded result of the ten live Stedi TEST-mode scenarios.
 *
 * ── WHAT THIS IS, AND EQUALLY WHAT IT IS NOT ───────────────────────────────────────────────────
 * This is a TRANSCRIPT, not a live probe. Every field below was copied from the output of
 * `scripts/stedi-scenarios.mjs all` on the run recorded in `recordedAt` — the request paths, the X12
 * segments, the vendor's HTTP codes and its exact wording, the row counts, the audit actions.
 * Nothing is summarised into a verdict that the run did not itself print, and nothing is inferred.
 *
 * It is deliberately NOT wired to re-run on page load, and the page says so in as many words. Three
 * reasons, in order of how much they matter:
 *
 *   1. Running these costs real calls to a real clearinghouse. A screen that fires ten scenarios —
 *      including live 270/271 eligibility checks against Aetna — because somebody clicked a
 *      navigation tab is a screen that bills the practice for curiosity.
 *   2. Seven of the ten are BLOCKED by an account-provisioning gate that no amount of re-running
 *      will move. Re-running them would produce the same seven blocks and a new set of throwaway
 *      practices in the database each time.
 *   3. A page that re-runs on view can show a DIFFERENT answer to the one in the report it claims to
 *      be displaying, and then there are two sources of truth for whether the integration works.
 *
 * So: the harness is the instrument, this is the reading, and the page is the dial. To take a new
 * reading, run the harness and update this file — which is a deliberate act by a person who then
 * owns the numbers, exactly as it should be.
 *
 * ── THE RULE FOR EDITING THIS FILE ─────────────────────────────────────────────────────────────
 * A status here may only be `pass` if the harness printed PASS for that scenario. Not "it should
 * pass", not "it passes locally with the mock", not "it will pass once the account is upgraded".
 * The point of the screen is to be the one place in the product that cannot flatter itself.
 */

/** What the harness concluded. The three states it prints, and nothing else. */
export type ScenarioStatus = "pass" | "blocked" | "fail";

/**
 * Why a scenario is not passing.
 *
 * The distinction this screen exists to make: a `vendor-account` block is Stedi refusing to
 * provision an operation, and no change to Mermaid can clear it. A `mermaid` block would be ours.
 * Keeping them in one field, rather than leaving a reader to infer it from prose, is what stops
 * "seven blocked" reading as "seven broken".
 */
export type BlockedBy = "vendor-account" | "vendor-environment" | "mermaid" | null;

export interface ScenarioEvidence {
  /** The label as the harness printed it, e.g. "Stedi HTTP". */
  label: string;
  /** The value as the harness printed it. Multi-line values arrive as separate entries. */
  value: string;
}

export interface IntegrationScenario {
  n: number;
  name: string;
  status: ScenarioStatus;
  blockedBy: BlockedBy;
  /** One sentence: what this scenario set out to establish. */
  description: string;
  /** The synthetic identities used. Recorded so a reader can confirm no PHI was involved. */
  identifiers: string;
  /** What Mermaid did — routes called, X12 emitted, rows written, audit actions. */
  mermaidEvidence: ScenarioEvidence[];
  /** What Stedi said — endpoint, HTTP status, and the vendor's own words. */
  stediEvidence: ScenarioEvidence[];
  /** Bug ids surfaced by this scenario. Empty where it surfaced none. */
  bugs: string[];
  /** The harness's own closing note, verbatim. */
  note: string;
}

export interface IntegrationBug {
  id: string;
  title: string;
  /** 1 code · 2 X12 generation · 3 Stedi adapter · 4 Stedi TEST validation · 5 account · 6 vendor env. */
  category: string;
  severity: "critical" | "major" | "minor";
  rootCause: string;
  fix: string;
  test: string;
  commit: string;
}

export interface IntegrationReport {
  /** When the harness was run. Not when this page was loaded — the difference is the whole point. */
  recordedAt: string;
  /** The commit the harness ran against. */
  commit: string;
  harness: string;
  environment: string;
  totals: { pass: number; blocked: number; fail: number };
  verdict: "GREEN" | "YELLOW" | "RED";
  verdictReason: string;
  scenarios: IntegrationScenario[];
  bugs: IntegrationBug[];
  coverage: { capability: string; proven: "yes" | "partial" | "no"; detail: string }[];
  /** The one thing standing between seven BLOCKED and seven run. */
  blocker: { summary: string; vendorWords: string; remedy: string; citation: string };
}

const SCENARIOS: IntegrationScenario[] = [
  {
    n: 1,
    name: "Basic Subscriber Claim (837D)",
    status: "blocked",
    blockedBy: "vendor-account",
    description:
      "File a straightforward claim for a patient who holds the policy, and confirm the 837D that " +
      "goes on the wire is structurally complete.",
    identifiers: "Jordan Doe, member AETNA9wcSu",
    mermaidEvidence: [
      { label: "Mermaid API path", value: "POST /api/v1/claims/{id}/submit → HTTP 502" },
      { label: "837D on the wire", value: "843 bytes · ISA15=T (T = test)" },
      { label: "CLM", value: "CLM*MRM-87235174180D*142.50***11:B:1*Y*A*Y*Y" },
      { label: "Subscriber (2010BA)", value: "NM1*IL*1*Doe*Jordan****MI*AETNA9wcSu" },
      { label: "Service line", value: "SV3*AD:D0120*142.50****1" },
      { label: "State before", value: "claims.status=ready CLM01=null submission=null" },
      { label: "State after", value: "claims.status=ready CLM01=null submission=null" },
      { label: "Audit events", value: "login(success), post(success), review(success), post(success), submit(error)" },
      { label: "Ledger entries", value: "0" },
    ],
    stediEvidence: [
      { label: "Endpoint", value: "POST https://healthcare.us.stedi.com/dental-claims/raw-x12-submission" },
      { label: "HTTP", value: "400" },
      {
        label: "Vendor said",
        value: "This Stedi account does not have a provisioned environment for this operation. Contact Stedi support.",
      },
    ],
    bugs: [],
    note:
      "The 837D is well formed and reached Stedi, which refused it at the ACCOUNT level. That is a " +
      "vendor/account action, not a code defect. Mermaid correctly left the claim unfiled.",
  },
  {
    n: 2,
    name: "Dependent Claim (loop 2000C)",
    status: "blocked",
    blockedBy: "vendor-account",
    description:
      "File for a child on a parent's policy, and confirm the dependent occupies loop 2000C/2010CA " +
      "while the policy holder stays in 2010BA.",
    identifiers:
      "patient Jordan Doe (dependent, DOB 2001-07-14) under subscriber John Doe, member AETNA9wcSu — " +
      "Stedi's own published sandbox family",
    mermaidEvidence: [
      { label: "Mermaid API path", value: "POST /api/v1/claims/{id}/submit → HTTP 502" },
      { label: "Loop 2000C (PAT)", value: "PAT*19" },
      { label: "Loop 2010CA (NM1*QC)", value: "NM1*QC*1*Doe*Jordan" },
      { label: "Loop 2010BA (NM1*IL)", value: "NM1*IL*1*Doe*John****MI*AETNA9wcSu" },
      {
        label: "SBR (02 must be empty)",
        value: "SBR*P**0084321******CI — SBR02 is correctly blank; 005010X224A2 puts the relationship in PAT01",
      },
      { label: "State after", value: "claims.status=ready" },
    ],
    stediEvidence: [
      { label: "HTTP", value: "400" },
      {
        label: "Vendor said",
        value: "This Stedi account does not have a provisioned environment for this operation. Contact Stedi support.",
      },
      {
        label: "What that proves",
        value:
          "Stedi validates X12 structure BEFORE the provisioning gate — established by the invalid-NPI " +
          "probe, which reaches a 277CA instead. Reaching the gate means the validator passed loop 2000C.",
      },
    ],
    bugs: [],
    note:
      "Loop 2000C is correct and Stedi's X12 validator passed it — the claim got as far as the account " +
      "provisioning gate, which is downstream of structural validation. Forwarding is blocked at the account level.",
  },
  {
    n: 3,
    name: "Group Practice + Rendering Dentist (loop 2310B)",
    status: "blocked",
    blockedBy: "vendor-account",
    description:
      "File a claim naming the treating dentist separately from the billing group, and confirm loop " +
      "2310B carries both the name and the mandatory PRV specialty segment.",
    identifiers: "rendering dentist Rhea Mockdentist, NPI 1111111112, taxonomy 1223G0001X",
    mermaidEvidence: [
      { label: "Mermaid API path", value: "POST /api/v1/claims/{id}/rendering-provider, then /submit" },
      { label: "Loop 2310B (NM1*82)", value: "NM1*82*1*Mockdentist*Rhea****XX*1111111112" },
      { label: "Loop 2310B (PRV)", value: "PRV*PE*PXC*1223G0001X" },
      { label: "State after", value: "claims.status=ready" },
      {
        label: "Audit events",
        value: "login(success), post(success), review(success), post(success), rendering-provider(success), submit(error)",
      },
    ],
    stediEvidence: [
      { label: "HTTP", value: "400" },
      {
        label: "Vendor said",
        value: "This Stedi account does not have a provisioned environment for this operation. Contact Stedi support.",
      },
      {
        label: "What changed",
        value:
          'The earlier structural refusal — "Unexpected segment LX: segment PRV is the next required ' +
          'segment" at Loop 2310B — is gone.',
      },
    ],
    bugs: ["BUG-1"],
    note:
      "Loop 2310B now carries NM1*82 AND PRV, and Stedi's validator passed it. Forwarding is blocked at " +
      "the account provisioning gate, downstream of validation.",
  },
  {
    n: 4,
    name: "Claim Rejection / Invalid Claim",
    status: "pass",
    blockedBy: null,
    description:
      "Make the payer network reject a claim, and confirm Mermaid records a business rejection with " +
      "the payer's own reason rather than throwing a transport error or — worse — recording an acceptance.",
    identifiers: "billing NPI 1234567890 (deliberately bad check digit) · CLM01 MRM526428065",
    mermaidEvidence: [
      { label: "Adapter result", value: "ok=true status=rejected A7/562 control#=919821857" },
      { label: "Read as", value: "a business outcome — not a transport failure, and not an acceptance" },
      { label: "App path (valid NPI)", value: 'POST /submit → HTTP 502; claim stayed "ready", CLM01=null' },
      { label: "Audit events", value: "login(success), post(success), review(success), post(success), submit(error)" },
      { label: "Ledger entries", value: "0" },
    ],
    stediEvidence: [
      { label: "Endpoint", value: "POST https://healthcare.us.stedi.com/dental-claims/raw-x12-submission" },
      { label: "HTTP", value: "400 — carrying a real 277CA" },
      {
        label: "Vendor said",
        value:
          "ERROR 33: Invalid NPI. The Billing Provider NPI of 1234567890 is invalid. The National " +
          "Provider Identifier must be valid with 10 digits and no prefixes or dashes. Correct and resubmit.",
      },
      {
        label: "277CA hierarchy",
        value: "STC*A1`20 (receiver)   STC*A7`562`85 (BILLING PROVIDER — the refusal)   STC*A1`20 (claim)",
      },
    ],
    bugs: ["BUG-2", "BUG-3", "BUG-4"],
    note:
      "Stedi answered HTTP 400 carrying a real 277CA. Mermaid read it as a business rejection with the " +
      "payer's own A7/562 — not a transport error, and not the false acceptance the provider-level STC " +
      "used to produce.",
  },
  {
    n: 5,
    name: "277CA Acceptance",
    status: "blocked",
    blockedBy: "vendor-account",
    description: "Observe a payer accepting a claim and Mermaid recording the acknowledgement and control number.",
    identifiers: "Jordan Doe, member AETNA9wcSu",
    mermaidEvidence: [
      { label: "Mermaid API path", value: "POST /api/v1/claims/{id}/submit → HTTP 502" },
      { label: "State after", value: "claims.status=ready CLM01=null submission=null" },
      { label: "Expectation rows", value: "0" },
    ],
    stediEvidence: [
      { label: "HTTP", value: "400" },
      {
        label: "Vendor said",
        value: "This Stedi account does not have a provisioned environment for this operation. Contact Stedi support.",
      },
    ],
    bugs: [],
    note:
      "An ACCEPTED 277CA cannot be obtained on this account: every structurally valid claim is stopped " +
      "at the provisioning gate before it is forwarded, so no payer ever acknowledges one. The acceptance " +
      "PATH is exercised by unit tests against a real captured 277CA (x12-277ca-real-stedi.test.ts) but " +
      "has NOT been observed end to end against live Stedi.",
  },
  {
    n: 6,
    name: "Test ERA / 835",
    status: "blocked",
    blockedBy: "vendor-account",
    description: "Retrieve a test remittance advice from Stedi and ingest it.",
    identifiers: "—",
    mermaidEvidence: [
      { label: "Mermaid API path", value: "POST /api/v1/remittances/fetch → HTTP 200" },
      { label: "Response", value: '{"items":[],"note":"No claims are awaiting payment."}' },
      { label: "Remittances stored", value: "0" },
    ],
    stediEvidence: [
      { label: "Stedi calls made", value: "(none — there was no submitted claim to fetch a remittance for)" },
    ],
    bugs: [],
    note:
      "No live 835 can be obtained. Stedi generates a test ERA only for a successfully submitted claim, " +
      "and no claim on this account can be submitted past the provisioning gate. " +
      "StediEdiAdapter.fetchRemittance is additionally unimplemented (it says so in its own source); the " +
      "implemented vendor path is listRemittanceArtifacts against core.us.stedi.com, which has nothing " +
      "to list. 835 parsing itself is covered by unit tests — but not against a live Stedi ERA.",
  },
  {
    n: 7,
    name: "Duplicate Remittance",
    status: "blocked",
    blockedBy: "vendor-account",
    description: "Deliver the same remittance twice and confirm the money is posted exactly once.",
    identifiers: "—",
    mermaidEvidence: [
      { label: "Mermaid API path", value: "POST /api/v1/remittances/fetch twice → HTTP 200, 200" },
      { label: "Remittances stored", value: "0" },
      { label: "Postings", value: "0" },
      { label: "Ledger total", value: "0 cents" },
    ],
    stediEvidence: [{ label: "Stedi calls made", value: "(none — depends on scenario 6)" }],
    bugs: [],
    note:
      "Depends on S6: with no live 835 there is nothing to deliver twice. Idempotent ingestion is covered " +
      "by unit and live-database tests (an advice is keyed by payer control number, and a second delivery " +
      "posts no second time), but that has NOT been demonstrated against a real Stedi ERA.",
  },
  {
    n: 8,
    name: "Family / Identity Isolation",
    status: "pass",
    blockedBy: null,
    description:
      "Verify the same insurance member in two unrelated practices and confirm neither can see the " +
      "other's patient or claim.",
    identifiers: "the SAME member id AETNA9wcSu verified in two unrelated practices",
    mermaidEvidence: [
      { label: "Practice A", value: "1 patient · 1 claim" },
      { label: "Practice B", value: "1 patient · 1 claim" },
      { label: "A reading B's claim", value: "HTTP 404 — correct; it must not exist for A" },
      { label: "Rows per practice", value: "187af6d3=1, f7017af5=1" },
      { label: "Enforced by", value: "Postgres row-level security, over the real HTTP route" },
    ],
    stediEvidence: [
      { label: "Live calls", value: "two independent 270/271 eligibility checks, one per practice" },
    ],
    bugs: [],
    note:
      "Two practices verified the same member and each sees exactly one patient and one claim. Row-level " +
      "security refused the cross-tenant read over the real HTTP route.",
  },
  {
    n: 9,
    name: "Failure / Retry / Recovery",
    status: "pass",
    blockedBy: null,
    description:
      "Fail a submission at the clearinghouse and confirm the claim is left exactly as it was — " +
      "retryable, with no half-written state and no duplicate.",
    identifiers: "Jordan Doe, member AETNA9wcSu",
    mermaidEvidence: [
      { label: "Mermaid API path", value: "POST /submit twice → HTTP 502, then 409" },
      { label: "State after 1st", value: "claims.status=ready CLM01=null submission=null" },
      { label: "State after 2nd", value: "claims.status=ready CLM01=null submission=null" },
      { label: "Claims in practice", value: "1 — no duplicate was created" },
      { label: "Expectation rows", value: "0" },
      { label: "Ledger entries", value: "0" },
      {
        label: "Error surfaced",
        value:
          '{"error":{"code":"clearinghouse_error","message":"claim {id} submission failed (unavailable): ' +
          'Stedi refused the request (HTTP 400)."}}',
      },
      {
        label: "Audit events",
        value: "login(success), post(success), review(success), post(success), submit(error), submit(error)",
      },
    ],
    stediEvidence: [
      { label: "Stedi calls", value: "1" },
      {
        label: "Vendor said",
        value: "400 — This Stedi account does not have a provisioned environment for this operation.",
      },
    ],
    bugs: [],
    note:
      "Stedi refused both attempts; the claim stayed ready with no control number, no expectation row and " +
      "no duplicate. The failure is retryable and the error reached the caller.",
  },
  {
    n: 10,
    name: "Full RCM Lifecycle",
    status: "blocked",
    blockedBy: "vendor-account",
    description:
      "Run one patient the whole way — eligibility, estimate, claim, submission, remittance, posting, ledger.",
    identifiers: "Jordan Doe, member AETNA9wcSu · 2 lines (D0120 + D2750 on tooth 8) · $1,392.50",
    mermaidEvidence: [
      { label: "Stage 1 · eligibility", value: "1 live Stedi 270/271 call · verification → needs_review" },
      { label: "Stage 2 · claim built", value: "2 lines · $1392.50 · status ready" },
      { label: "Stage 3 · submission", value: "HTTP 502 — refused at the provisioning gate" },
      { label: "Stage 4 · remittance", value: 'HTTP 200 · {"items":[],"note":"No claims are awaiting payment."}' },
      {
        label: "Row counts",
        value: "patients=1, verifications=1, coverages=1, claims=1, remittances=0, postings=0, ledger_entries=0",
      },
      {
        label: "Audit events",
        value: "login(success), post(success), review(success), post(success), submit(error), post(success)",
      },
    ],
    stediEvidence: [
      { label: "Eligibility", value: "270/271 succeeded live" },
      {
        label: "Submission",
        value: "400 — This Stedi account does not have a provisioned environment for this operation.",
      },
    ],
    bugs: [],
    note:
      "The lifecycle runs end to end through eligibility (real 270/271), coverage snapshot and claim " +
      "construction, then stops at the account provisioning gate on submission. Everything downstream of " +
      "filing — acknowledgement, remittance, posting, ledger — cannot be reached on this account and is " +
      "NOT demonstrated here.",
  },
];

const BUGS: IntegrationBug[] = [
  {
    id: "BUG-1",
    title: "Loop 2310B was missing its mandatory PRV segment",
    category: "2 · Mermaid X12 generation",
    severity: "major",
    rootCause:
      "005010X224A2 makes PRV mandatory whenever loop 2310B is present. Mermaid emitted the rendering " +
      "dentist's NM1 and stopped, so every group-practice claim was structurally invalid. Solo-provider " +
      "claims were unaffected, which is why no test here caught it — the mock parses what it builds, so " +
      "an 837 missing a segment only the PAYER requires round-trips perfectly.",
    fix: "Emit PRV*PE*PXC*{taxonomy}, with taxonomyCode required end to end and shape-validated by the scrubber.",
    test: "platform/edi/__tests__/x12-837-rendering-provider.test.ts (+2)",
    commit: "08aa656",
  },
  {
    id: "BUG-2",
    title: "An HTTP 400 carrying a 277CA was discarded as a transport failure",
    category: "3 · Mermaid Stedi adapter",
    severity: "major",
    rootCause:
      "Stedi answers a claim it will not forward with HTTP 400 and a body carrying the payer's own 277CA. " +
      "The client dropped the body on any non-2xx, so submitClaim returned a transport error and the claim " +
      "stayed ready — a biller saw 'Stedi refused the request (HTTP 400)', never saw what the payer said, " +
      "and had a claim that looked unfiled when it had been rejected for a nameable reason.",
    fix:
      "A 277CA in an error body that reports on this claim is a business rejection. Account and structural " +
      "errors carry no x12 and remain transport failures — a claim no payer saw must not be marked rejected by one.",
    test: "platform/edi/__tests__/x12-277ca-real-stedi.test.ts",
    commit: "08aa656",
  },
  {
    id: "BUG-3",
    title: "The X12 component separator was hardcoded instead of read from ISA16",
    category: "2 · Mermaid X12 parsing",
    severity: "major",
    rootCause:
      "COMPONENT_SEPARATORS = /[:>^]/ described itself as 'every character X12 permits'. X12 permits any " +
      "character and declares it in ISA16 — and Stedi declares a BACKTICK. parse277CA was worse and split " +
      "on a literal colon. So STC*A1`20 parsed to statusCategory \"A1`20\" with a null code, and the " +
      "accept/reject decision was made on that string. In an 835 the same defect would have posted every " +
      "line against a procedure code no catalog holds.",
    fix: "componentSeparatorOf(raw) reads ISA16; the guessed set is now only a fallback for headerless fragments.",
    test: "platform/edi/__tests__/x12-835.test.ts (+2), x12-277ca-real-stedi.test.ts",
    commit: "08aa656",
  },
  {
    id: "BUG-4",
    title: "A rejected claim was recorded as ACCEPTED — the 277CA HL hierarchy was ignored",
    category: "2 · Mermaid X12 parsing",
    severity: "critical",
    rootCause:
      "005010X214 nests source → receiver → provider → patient, and only there does a claim live. The parser " +
      "read a flat sequence in which every TRN opened a claim, so the provider-level STC*A7`562`85 landed in " +
      "a pseudo-claim numbered '0' that matches no submission and that nothing reads. ackForClaim found the " +
      "patient-level A1 and returned ACCEPTED — for a claim Stedi had just refused with HTTP 400 and " +
      "'Invalid NPI … Correct and resubmit'. A claim recorded as filed that was never filed is never fixed, " +
      "never refiled, and discovered when timely filing has closed.",
    fix:
      "HL levels are tracked; level traces are no longer claims; a rejection at any ancestor level rejects " +
      "the claims beneath it.",
    test: "platform/edi/__tests__/x12-277ca-real-stedi.test.ts",
    commit: "08aa656",
  },
  {
    id: "BUG-5",
    title: "The payer's refusal reason was replaced by the parser's symptom",
    category: "3 · Mermaid Stedi adapter",
    severity: "major",
    rootCause:
      "Aetna answered an eligibility check with a complete 271 carrying AAA*N**71*C and no EB segments, plus " +
      "'Patient Birth Date Does Not Match That for the Patient on the Database. Please Correct and Resubmit.' " +
      "parse271 correctly refused it and threw '271 contained no EB benefit segments' — true, and useless. " +
      "That reached the front desk as a critical unknown-payer exception reading 'Benefits could not be " +
      "retrieved; verify manually with the payer', for a payer matched at 0.95 confidence. The adapter " +
      "consulted the errors array only when there was NO x12 at all, which is the rare shape.",
    fix: "The payer's stated reason is reported whenever the payer gave one; the parser's message is the fallback.",
    test: "platform/edi/__tests__/stedi-271-refusal-real.test.ts",
    commit: "66d58ec",
  },
];

/**
 * The recorded reading.
 *
 * `recordedAt` and `commit` are load-bearing: without them this is a screen asserting that the
 * integration works, present tense, forever. With them it is a dated measurement, which is the only
 * honest thing a transcript can be.
 */
export const INTEGRATION_REPORT: IntegrationReport = {
  recordedAt: "2026-08-24T00:05:00Z",
  commit: "66d58ec",
  harness: "scripts/stedi-scenarios.mjs all",
  environment:
    "Real Stedi account, TEST mode only — test_-prefixed key, ISA15=T, applicationMode \"test\". " +
    "MockEdiAdapter was not used in any scenario. All identities synthetic (Stedi's published sandbox family). No PHI.",
  totals: { pass: 3, blocked: 7, fail: 0 },
  verdict: "YELLOW",
  verdictReason:
    "Not GREEN: claim submission, 277CA acceptance, ERA retrieval and remittance posting have never " +
    "completed once end to end, because this account cannot submit claims at all. Not RED: no Mermaid " +
    "defect remains open, the 837D passes a real clearinghouse's structural validator, and the one live " +
    "payer verdict obtainable was handled correctly.",
  scenarios: SCENARIOS,
  bugs: BUGS,
  coverage: [
    {
      capability: "270/271 eligibility",
      proven: "yes",
      detail: "Real 271s received and parsed — both the success path and the AAA*71 refusal path.",
    },
    {
      capability: "837D generation",
      proven: "partial",
      detail: "Structurally accepted by Stedi's validator (validation precedes the provisioning gate). Never forwarded to a payer.",
    },
    {
      capability: "277CA acknowledgement",
      proven: "yes",
      detail: "A real 277CA received, parsed and correctly interpreted — as a rejection.",
    },
    {
      capability: "835 / ERA retrieval",
      proven: "no",
      detail: "No live 835 obtainable. Parser fixed and unit-tested only; fetchRemittance is unimplemented on the Stedi adapter.",
    },
    { capability: "Remittance posting", proven: "no", detail: "Nothing to post." },
    {
      capability: "Dependent claims (2000C)",
      proven: "partial",
      detail: "Structurally proven — Stedi's validator passed the loop. Not adjudicated.",
    },
    {
      capability: "Rendering provider (2310B)",
      proven: "partial",
      detail: "Structurally proven — the prior PRV refusal is gone. Not adjudicated.",
    },
    {
      capability: "Duplicate handling",
      proven: "partial",
      detail: "Submission proven (second submit → 409, no duplicate state). Remittance not proven.",
    },
    {
      capability: "Failure / retry",
      proven: "yes",
      detail: "A failed submission leaves the claim exactly as it was, and is retryable.",
    },
  ],
  blocker: {
    summary:
      "Seven of the ten scenarios are blocked by one thing, and it is not Mermaid: this Stedi account is a " +
      "sandbox account, and sandbox accounts cannot submit claims at all — not even test ones.",
    vendorWords:
      "This Stedi account does not have a provisioned environment for this operation. Contact Stedi support.",
    remedy:
      "Upgrade the Stedi account (Upgrade account in their console). That is a commercial action, not a code " +
      "change. Once done, Stedi's Test Payer workflow returns both test 277CA and test 835 responses, which " +
      "unblocks scenarios 5, 6, 7 and 10.",
    citation:
      "Stedi docs, Test mode: \"Test claim submission is only available for production accounts.\" and " +
      "\"Sandbox accounts can only operate in test mode.\"",
  },
};
