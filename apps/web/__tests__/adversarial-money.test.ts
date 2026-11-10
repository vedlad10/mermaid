/**
 * The money scenarios a practice actually meets, each driven end to end and reconciled independently.
 *
 * ── WHY THIS FILE RE-DERIVES EVERY FIGURE ──────────────────────────────────────────────────────
 * The rest of the suite asserts that Mermaid agrees with itself. That catches regressions and
 * proves nothing about correctness: a wrong number computed once and read twice agrees perfectly.
 *
 * So every assertion here recomputes the answer from the payer's own statement — the charge, the
 * CAS groups, the CLP status — and compares. Where a figure has a name in X12, the X12 name is what
 * it is checked against, not what a Mermaid type calls it.
 *
 * ── AND WHY IT DRIVES REAL X12 ─────────────────────────────────────────────────────────────────
 * A hand-built posting proves the view layer can add. These go through `MockEdiAdapter` →
 * `parse835` → `ingestArtifact` → the safety gate → the repository, which is the path a payer's
 * file actually takes. Every scenario below is selected by the member-ID suffix the mock uses to
 * decide how a payer behaves, so the fixture and the adjudication cannot drift apart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { cents, type Cents } from "@mermaid/shared";
import { buildServices, type Services } from "../wiring.ts";

const RECEIVED = new Date("2026-08-10T09:00:00Z");
const FEE = cents(1000);
const EXPECTED = cents(600);

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

const expectation = (memberId: string, control: string) => ({
  claimId: `claim-${control}`,
  verificationId: `ver-${control}`,
  submittedAt: "2026-07-28T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Test", lastName: "Patient", dateOfBirth: "1990-01-01", memberId },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber: control,
  payerControlNumber: "556677889",
  totalFee: FEE,
  expectedInsurancePays: EXPECTED,
  serviceDate: "2026-07-27",
});

/** One claim through the real path. `mutate` lets a scenario edit the payer's own file. */
async function adjudicate(
  memberId: string,
  control = "MRM-ADV1",
  mutate: (raw: string) => string = (r) => r,
  services?: Services
): Promise<{ services: Services; raw: string; view: Rem }> {
  const svc = services ?? buildServices({ inMemory: true });
  await svc.remittance.recordExpectation(expectation(memberId, control) as never);
  const fetched = await new MockEdiAdapter().fetchRemittance({
    payerId: "delta-dental",
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    paymentDate: "2026-08-10",
    claims: [
      {
        patientControlNumber: control,
        payerControlNumber: "556677889",
        patientFirstName: "Test",
        patientLastName: "Patient",
        memberId,
        lines: [{ procedureCode: "D2750", charged: FEE, quantity: 1 }],
        expectedInsurancePays: EXPECTED,
      },
    ],
  });
  const raw = mutate(fetched.raw!);
  const views = await svc.remittance.ingestArtifact(
    raw,
    { resolution: "source-credential", vendor: "mock", artifactId: `f-${control}`, expectedPayeeId: null } as never,
    RECEIVED
  );
  return { services: svc, raw, view: views[0] as unknown as Rem };
}

type Posting = {
  chargedAmount: number;
  paidAmount: number;
  patientResponsibility: number;
  adjustments: { group: string; code: string; amount: number; category: string }[];
};

/**
 * What a posting says happened to the charge.
 *
 * `Posting` deliberately carries no `contractualAdjustment` or `coordinationPending` field — the
 * buckets live in `adjustments`, each tagged with the category the CARC catalogue assigns it, and
 * summing by category is the only reading that cannot drift from the payer's own codes.
 */
const bucket = (p: Posting, category: string) =>
  p.adjustments.filter((a) => a.category === category).reduce((t, a) => t + a.amount, 0);

/** Everything the charge was split into: paid, plus every withheld bucket. */
const accountedFor = (p: Posting) =>
  p.paidAmount +
  bucket(p, "contractual") +
  bucket(p, "patient") +
  bucket(p, "coordination") +
  bucket(p, "recoverable") +
  bucket(p, "informational");
type Rem = {
  remittance: { status: string; balanced: boolean; holdReason: string | null; postings: Posting[] };
};

/**
 * The payer's own arithmetic, read straight out of the file it sent.
 *
 * Deliberately parsed from the raw X12 rather than from anything Mermaid computed — if the two
 * disagree, that disagreement is the finding.
 */
function fromTheFile(raw: string) {
  const clp = raw.split("~").find((s) => s.startsWith("CLP"))!.split("*");
  /**
   * A CAS segment carries UP TO SIX reason/amount/quantity triplets after the group, not one. The
   * mock's pre-authorisation refusal packs CARC 45 and CARC 197 into a single segment —
   * `CAS*CO*45*100.00**197*900.00*` — and a parser that reads only the first triplet silently loses
   * $900 of the payer's own statement. Worth stating because the first version of this file did
   * exactly that and then accused the product of not producing a 197.
   */
  const cas = raw
    .split("~")
    .filter((s) => s.startsWith("CAS"))
    .flatMap((s) => {
      const p = s.split("*");
      const group = p[1]!;
      const out: { group: string; code: string; amount: number }[] = [];
      for (let i = 2; i + 1 < p.length; i += 3) {
        if (!p[i] || p[i + 1] === undefined || p[i + 1] === "") continue;
        out.push({ group, code: p[i]!, amount: Math.round(Number(p[i + 1]) * 100) });
      }
      return out;
    });
  return {
    charged: Math.round(Number(clp[3]) * 100),
    paid: Math.round(Number(clp[4]) * 100),
    patientResponsibility: Math.round(Number(clp[5]) * 100),
    status: clp[2]!,
    cas,
    byGroup: (g: string) => cas.filter((a) => a.group === g).reduce((t, a) => t + a.amount, 0),
  };
}

// ── 1. The payer pays exactly what was estimated ────────────────────────────────────────────────

test("as expected: the file balances and every bucket is the payer's own figure", async () => {
  const { raw, view } = await adjudicate("ABC00011");
  const f = fromTheFile(raw);
  const p = view.remittance.postings[0]!;

  assert.equal(f.paid + f.byGroup("CO") + f.byGroup("PR") + f.byGroup("OA"), f.charged, "the payer's own file balances");
  assert.equal(p.paidAmount, f.paid, `posted ${usd(p.paidAmount)} against CLP04 ${usd(f.paid)}`);
  assert.equal(p.patientResponsibility, f.patientResponsibility, "CLP05 is what reaches the patient");
  assert.equal(view.remittance.status, "posted", "nothing here needs a person");
});

// ── 2. Overpayment: the payer sent more than it was billed ──────────────────────────────────────

test("overpayment: paying more than the charge is HELD, never booked as revenue", async () => {
  /**
   * The dangerous direction. A payer that overpays reclaims it later — often months later, and by
   * deducting from an unrelated remittance — so a practice that books it as revenue spends money it
   * will have to give back.
   */
  const { view } = await adjudicate("ABC00011", "MRM-OVER", (raw) =>
    raw
      .replace(/(CLP\*MRM-OVER\*[^*]*\*[^*]*\*)600\.00/, "$1900.00")
      .replace(/CAS\*CO\*45\*100\.00/, "CAS*CO*45*100.00")
      .replace(/BPR\*I\*600\.00/, "BPR*I*900.00")
  );

  assert.equal(view.remittance.status, "held", "an overpayment must never post on its own");
  assert.match(
    view.remittance.holdReason ?? "",
    /\$900\.00/,
    `the hold must name the figure that does not fit: ${view.remittance.holdReason}`
  );
});

// ── 3. Corrected payment: a second advice for a claim already paid ──────────────────────────────

test("corrected payment: a second, DIFFERENT amount is allowed through — it is not a duplicate", async () => {
  /**
   * The distinction the duplicate gate rests on. A payer reissuing a corrected adjudication sends a
   * different figure; blocking it would refuse a correction the practice needs. Only an identical
   * amount on an already-posted claim is a duplicate.
   */
  const first = await adjudicate("ABC00011", "MRM-CORR");
  assert.equal(first.view.remittance.status, "posted");

  const second = await adjudicate(
    "ABC00011",
    "MRM-CORR",
    (raw) =>
      raw
        .replace(/TRN\*1\*[^*~]*/, "TRN*1*EFT-CORRECTED")
        .replace(/(CLP\*MRM-CORR\*[^*]*\*[^*]*\*)600\.00/, "$1550.00")
        .replace(/CAS\*CO\*45\*100\.00/, "CAS*CO*45*150.00")
        .replace(/BPR\*I\*600\.00/, "BPR*I*550.00"),
    first.services
  );

  assert.ok(
    !/already been posted/.test(second.view.remittance.holdReason ?? ""),
    `a corrected amount is not a duplicate: ${second.view.remittance.holdReason}`
  );
});

test("duplicate payment: the SAME amount on an already-posted claim is blocked", async () => {
  const first = await adjudicate("ABC00011", "MRM-DUP");
  assert.equal(first.view.remittance.status, "posted");

  const second = await adjudicate(
    "ABC00011",
    "MRM-DUP",
    (raw) => raw.replace(/TRN\*1\*[^*~]*/, "TRN*1*EFT-SECOND-COPY"),
    first.services
  );

  assert.equal(second.view.remittance.status, "held");
  // Recognised by the payer's own claim control number now, not only by amount — same verdict.
  assert.match(second.view.remittance.holdReason ?? "", /already (been )?posted/);
});

// ── 4. Coordination of benefits ─────────────────────────────────────────────────────────────────

test("COB: money assigned to another plan is neither a write-off nor the patient's", async () => {
  const { raw, view } = await adjudicate("ABC00023", "MRM-COB");
  const f = fromTheFile(raw);
  const p = view.remittance.postings[0]!;

  assert.ok(f.byGroup("OA") > 0 || f.status === "19", "the fixture must actually coordinate");
  assert.equal(view.remittance.status, "held", "nobody may be billed until the other plan rules");
  assert.match(view.remittance.holdReason ?? "", /another plan|forwarded/i);
  assert.equal(accountedFor(p), f.charged, "and the destinations still account for the whole charge");
  assert.ok(bucket(p, "coordination") > 0, "with money genuinely parked against the other plan");
});

// ── 5. Pre-authorisation refused: CO-197 ────────────────────────────────────────────────────────

test("CO-197: a refusal in the CO group is the practice's loss, never billable to the patient", async () => {
  /**
   * The rule that makes pre-authorisation worth enforcing at all. `CO` means contractual: the payer
   * is saying the practice may not charge the patient for it.
   */
  const { raw, view } = await adjudicate("ABC00077", "MRM-197");
  const f = fromTheFile(raw);
  const p = view.remittance.postings[0]!;

  const carc197 = f.cas.find((a) => a.code === "197");
  assert.ok(carc197, "the fixture must produce a CARC 197");
  assert.equal(carc197!.group, "CO", "and it must arrive in the CO group");

  const patientAdjustments = p.adjustments.filter((a) => a.group === "PR");
  assert.ok(!patientAdjustments.some((a) => a.code === "197"), "a pre-auth refusal must never reach the patient");

  const recoverable = p.adjustments.find((a) => a.code === "197")!;
  assert.equal(recoverable.category, "recoverable", "it is the practice's to pursue by appeal");
});

// ── 6. Annual maximum exhausted ─────────────────────────────────────────────────────────────────

test("annual maximum: the payer's cap lands on the patient, and says so", async () => {
  const { raw, view } = await adjudicate("ABC00099", "MRM-MAX");
  const f = fromTheFile(raw);
  const p = view.remittance.postings[0]!;

  assert.equal(accountedFor(p), f.charged, "the charge is still fully accounted for");
  assert.equal(p.patientResponsibility, f.patientResponsibility, "and the patient's share is CLP05, not a guess");
  assert.ok(
    f.cas.some((a) => a.code === "119"),
    "CARC 119 is the benefit-maximum code — the fixture must actually exhaust the maximum"
  );
  assert.equal(bucket(p, "patient"), f.byGroup("PR"), "the PR group is what lands on the patient");
});

// ── 7. Zero-dollar advice ───────────────────────────────────────────────────────────────────────

test("a claim refused outright pays nothing, and nothing is a real answer", async () => {
  /**
   * A zero-dollar 835 is a legitimate document, not a broken one. It must parse, post or hold on its
   * merits, and never be mistaken for cash.
   */
  const { view } = await adjudicate("ABC00011", "MRM-ZERO", (raw) =>
    raw
      .replace(/(CLP\*MRM-ZERO\*[^*]*\*[^*]*\*)600\.00/, "$10.00")
      .replace(/CAS\*CO\*45\*100\.00/, "CAS*CO*45*1000.00")
      .replace(/CAS\*PR\*2\*300\.00/, "CAS*PR*2*0.00")
      .replace(/(CLP\*MRM-ZERO\*[^*]*\*[^*]*\*[^*]*\*)300\.00/, "$10.00")
      .replace(/BPR\*I\*600\.00/, "BPR*I*0.00")
  );
  const p = view.remittance.postings[0];

  assert.ok(p, "a zero-dollar advice still produces a posting");
  assert.equal(p!.paidAmount, 0);
  assert.equal(p!.patientResponsibility, 0, "nothing was assigned to the patient");
});

// ── 8. Every scenario obeys the partition laws ──────────────────────────────────────────────────

test("across every scenario, the destinations never exceed the charge", async () => {
  /**
   * The one law that matters most, checked across the whole set rather than per case: a payer may
   * not account for more than it was billed. Over-attribution is not a rounding artefact — it means
   * a duplicated CAS, a payer file error, or a parse that counted a line twice, and every one of
   * those inflates a figure this system then bills someone for.
   */
  for (const member of ["ABC00011", "ABC00023", "ABC00077", "ABC00099"]) {
    const { raw, view } = await adjudicate(member, `MRM-${member.slice(-2)}`);
    const f = fromTheFile(raw);
    for (const p of view.remittance.postings) {
      assert.ok(
        accountedFor(p) <= f.charged,
        `${member}: destinations ${usd(accountedFor(p))} exceed the ${usd(f.charged)} charged`
      );
      for (const a of p.adjustments) {
        assert.ok(a.amount >= 0, `${member}: ${a.group}-${a.code} is negative (${a.amount})`);
      }
      assert.ok(Number.isInteger(p.paidAmount), "money is whole cents");
      assert.ok(p.paidAmount >= 0 && p.patientResponsibility >= 0, "and never negative");
    }
  }
});
