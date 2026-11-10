/**
 * The allowed-amount variance engine (F2).
 *
 * The first section is the one this feature exists for. `foldObservation` — the learner beside this
 * engine — assigns `allowed: next.allowed` on every advice, so the moment a payer cuts a rate the
 * old figure is gone and every later payment matches what the system now believes. The evidence
 * destroys itself exactly when it becomes valuable. Everything below is written to make that
 * specific failure impossible to reintroduce without a red test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, type Cents } from "@mermaid/shared";
import {
  confirmedEpoch,
  foldRateObservation,
  type FoldOptions,
  type RateEpoch,
} from "../allowed-variance.ts";

const CROWN = cents(1125);
const CUT = cents(980);

const obs = (over: Partial<Parameters<typeof foldRateObservation>[1]> = {}) => ({
  payerId: "delta-dental",
  cdtCode: "D2750",
  allowed: CROWN,
  charged: cents(1250),
  observedAt: "2026-03-04T00:00:00.000Z",
  observedPayerName: "Delta Dental",
  ...over,
});

/** Replay a sequence of observations, returning the final history and every finding raised. */
function replay(inputs: Parameters<typeof foldRateObservation>[1][], options: FoldOptions = {}) {
  let epochs: RateEpoch[] = [];
  const findings = [];
  for (const input of inputs) {
    const result = foldRateObservation(epochs, input, options);
    epochs = result.epochs;
    if (result.finding) findings.push(result.finding);
  }
  return { epochs, findings };
}

// ── The baseline ────────────────────────────────────────────────────────────────────────────────

test("the first rate ever seen becomes the baseline, and says nothing", () => {
  const { epochs, finding } = foldRateObservation([], obs());
  assert.equal(finding, null, "there is nothing to contradict, so there is nothing to report");
  assert.equal(epochs.length, 1);
  assert.equal(epochs[0]!.status, "confirmed");
  assert.equal(epochs[0]!.allowed, CROWN);
  assert.equal(epochs[0]!.seq, 1);
  assert.equal(epochs[0]!.closedAt, null);
});

test("the payer paying what it said it would is not a finding", () => {
  const { epochs, findings } = replay([obs(), obs({ observedAt: "2026-04-04T00:00:00.000Z" })]);
  assert.deepEqual(findings, []);
  assert.equal(epochs.length, 1, "no candidate opens against a figure that agrees");
  assert.equal(epochs[0]!.observations, 2);
  assert.equal(epochs[0]!.lastSeenAt, "2026-04-04T00:00:00.000Z");
});

// ── THE REGRESSION THIS FEATURE EXISTS FOR ──────────────────────────────────────────────────────

test("a lower rate does NOT overwrite the rate it disagrees with", () => {
  const { epochs, finding } = foldRateObservation(
    foldRateObservation([], obs()).epochs,
    obs({ allowed: CUT, observedAt: "2026-08-19T00:00:00.000Z" })
  );

  const baseline = confirmedEpoch(epochs)!;
  assert.equal(baseline.allowed, CROWN, "the confirmed rate is still the one the payer agreed to");
  assert.equal(epochs.length, 2, "the new figure opened a candidate beside it");
  assert.equal(epochs[1]!.status, "candidate");
  assert.equal(epochs[1]!.allowed, CUT);

  assert.equal(finding!.classification, "line-underpayment");
  assert.equal(finding!.expected, CROWN);
  assert.equal(finding!.observed, CUT);
  assert.equal(finding!.delta, cents(-145));
  assert.equal(finding!.recoverable, true);
  assert.equal(finding!.againstEpoch, 1, "and the finding names the epoch it was measured against");
});

test("a sustained cut keeps reporting its FULL size, instead of converging to zero", () => {
  /**
   * The exact shape of the defect. Under the learner beside this engine, the second short advice is
   * compared against the first short advice — which it matches — and the variance reads as zero from
   * then on. The payer is now underpaying by $145.00 a crown forever and the system reports that
   * nothing is wrong.
   *
   * Here the baseline does not move until it has been corroborated, so every advice up to that point
   * is measured against what the payer actually agreed to.
   */
  const { findings } = replay(
    [
      obs(),
      obs({ allowed: CUT, observedAt: "2026-08-19T00:00:00.000Z" }),
      obs({ allowed: CUT, observedAt: "2026-08-20T00:00:00.000Z" }),
    ],
    { confirmAfter: 99 }
  );

  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.delta),
    [cents(-145), cents(-145)],
    "the second short payment is still short by the same $145.00, not by nothing"
  );
});

test("the superseded rate stays readable, with the dates it was in force", () => {
  const { epochs, findings } = replay([
    obs({ observedAt: "2026-03-04T00:00:00.000Z" }),
    obs({ observedAt: "2026-06-04T00:00:00.000Z" }),
    obs({ allowed: CUT, observedAt: "2026-08-19T00:00:00.000Z" }),
    obs({ allowed: CUT, observedAt: "2026-09-02T00:00:00.000Z" }),
    obs({ allowed: CUT, observedAt: "2026-09-14T00:00:00.000Z" }),
  ]);

  const old = epochs.find((e) => e.seq === 1)!;
  assert.equal(old.status, "superseded");
  assert.equal(old.allowed, CROWN, "the figure itself is untouched — this is the evidence");
  assert.equal(old.openedAt, "2026-03-04T00:00:00.000Z");
  assert.equal(old.closedAt, "2026-09-14T00:00:00.000Z");
  assert.equal(old.observations, 2, "and how many advices stood behind it");

  assert.equal(confirmedEpoch(epochs)!.allowed, CUT, "the baseline has moved, because it was corroborated");
  assert.equal(findings.at(-1)!.classification, "schedule-drift");
  assert.equal(findings.at(-1)!.recoverable, false, "a schedule that moved is a contract conversation");
});

test("a fold never shortens the history and never rewrites a figure", () => {
  const sequence = [CROWN, CUT, cents(1000), CUT, CUT, CROWN, cents(900)];
  let epochs: RateEpoch[] = [];
  let seen: { seq: number; allowed: Cents }[] = [];

  for (const [i, allowed] of sequence.entries()) {
    epochs = foldRateObservation(epochs, obs({ allowed, observedAt: `2026-0${i + 1}-01T00:00:00.000Z` })).epochs;
    for (const before of seen) {
      const after = epochs.find((e) => e.seq === before.seq);
      assert.ok(after, `epoch ${before.seq} disappeared`);
      assert.equal(after.allowed, before.allowed, `epoch ${before.seq} was rewritten`);
    }
    seen = epochs.map((e) => ({ seq: e.seq, allowed: e.allowed }));
  }
});

// ── Corroboration ───────────────────────────────────────────────────────────────────────────────

test("one differing advice is not enough to move the baseline", () => {
  const { epochs } = replay([obs(), obs({ allowed: CUT, observedAt: "2026-08-19T00:00:00.000Z" })]);
  assert.equal(confirmedEpoch(epochs)!.allowed, CROWN);
});

test("going back to the old rate abandons the candidate instead of leaving it waiting", () => {
  /**
   * A one-off short payment that the payer then corrects is an underpayment, not a schedule change.
   * Left open, the candidate would sit there collecting a sighting a year later and eventually
   * supersede a rate the payer never stopped honouring.
   */
  const { epochs } = replay([
    obs(),
    obs({ allowed: CUT, observedAt: "2026-08-19T00:00:00.000Z" }),
    obs({ observedAt: "2026-08-26T00:00:00.000Z" }),
  ]);

  assert.equal(confirmedEpoch(epochs)!.allowed, CROWN);
  const abandoned = epochs.find((e) => e.seq === 2)!;
  assert.equal(abandoned.status, "superseded");
  assert.equal(abandoned.allowed, CUT, "closed, not deleted — the short payment still happened");
  assert.equal(abandoned.closedAt, "2026-08-26T00:00:00.000Z");
});

test("a third figure contradicts the candidate and opens its own", () => {
  const { epochs } = replay([
    obs(),
    obs({ allowed: CUT, observedAt: "2026-08-19T00:00:00.000Z" }),
    obs({ allowed: cents(900), observedAt: "2026-08-26T00:00:00.000Z" }),
  ]);

  assert.equal(confirmedEpoch(epochs)!.allowed, CROWN, "an unstable payer does not get to move the baseline");
  assert.equal(epochs.filter((e) => e.status === "candidate").length, 1, "only one live candidate at a time");
  assert.equal(epochs.find((e) => e.status === "candidate")!.allowed, cents(900));
});

test("pennies apart is rounding, not a rate change", () => {
  const { epochs, finding } = foldRateObservation(
    foldRateObservation([], obs()).epochs,
    obs({ allowed: cents(1124.5), observedAt: "2026-04-04T00:00:00.000Z" })
  );
  assert.equal(finding, null);
  assert.equal(epochs.length, 1, "no candidate, or a payer that rounds oddly holds one open forever");
  assert.equal(epochs[0]!.observations, 2);
});

// ── Classification ──────────────────────────────────────────────────────────────────────────────

test("a different entity repricing the claim is a leased network, not a mystery shortfall", () => {
  const { finding } = foldRateObservation(
    foldRateObservation([], obs()).epochs,
    obs({ allowed: CUT, observedAt: "2026-08-19T00:00:00.000Z", observedPayerName: "Connection Dental Network" })
  );
  assert.equal(finding!.classification, "leased-network");
  assert.equal(finding!.recoverable, true);
  assert.equal(finding!.observedPayerName, "Connection Dental Network");
});

test("the same payer spelled differently is still the same payer", () => {
  const { finding } = foldRateObservation(
    foldRateObservation([], obs()).epochs,
    obs({ allowed: CUT, observedAt: "2026-08-19T00:00:00.000Z", observedPayerName: "  DELTA DENTAL " })
  );
  assert.equal(finding!.classification, "line-underpayment", "casing is not a third party");
});

test("an advice that printed no payer name is silence, not a third party", () => {
  const { finding } = foldRateObservation(
    foldRateObservation([], obs()).epochs,
    obs({ allowed: CUT, observedAt: "2026-08-19T00:00:00.000Z", observedPayerName: null })
  );
  assert.equal(finding!.classification, "line-underpayment");
});

test("a composite paid at the amalgam rate, to the cent, is an alternate benefit", () => {
  const peerRates = new Map<string, Cents>([["D2150", cents(145)]]);
  const composite = obs({ cdtCode: "D2392", allowed: cents(185), charged: cents(240) });

  const { finding } = foldRateObservation(
    foldRateObservation([], composite).epochs,
    { ...composite, allowed: cents(145), observedAt: "2026-08-19T00:00:00.000Z" },
    { peerRates }
  );

  assert.equal(finding!.classification, "abp-downgrade");
  assert.equal(finding!.downgradedTo, "D2150");
  assert.equal(
    finding!.recoverable,
    false,
    "appealing a contractual downgrade loses — the difference is the PATIENT's, and calling it an underpayment is how it gets written off"
  );
});

test("near the amalgam rate is an underpayment, not a downgrade", () => {
  // A downgrade IS the other code's allowance, because the payer computed it from that fee
  // schedule. Something merely close to it is a shortfall wearing a coincidence.
  const peerRates = new Map<string, Cents>([["D2150", cents(145)]]);
  const composite = obs({ cdtCode: "D2392", allowed: cents(185), charged: cents(240) });

  const { finding } = foldRateObservation(
    foldRateObservation([], composite).epochs,
    { ...composite, allowed: cents(147.5), observedAt: "2026-08-19T00:00:00.000Z" },
    { peerRates }
  );
  assert.equal(finding!.classification, "line-underpayment");
  assert.equal(finding!.downgradedTo, undefined);
});

test("with no substitution table, a downgrade reports as what it can be proven to be", () => {
  const peerRates = new Map<string, Cents>([["D2150", cents(145)]]);
  const composite = obs({ cdtCode: "D2392", allowed: cents(185), charged: cents(240) });

  const { finding } = foldRateObservation(
    foldRateObservation([], composite).epochs,
    { ...composite, allowed: cents(145), observedAt: "2026-08-19T00:00:00.000Z" },
    { peerRates, downgradePairs: new Map() }
  );
  assert.equal(finding!.classification, "line-underpayment", "unexplained beats an explanation nobody can source");
});

test("naming the third party outranks naming the substitution", () => {
  /**
   * When a rental network repriced the claim AND the figure happens to match a lesser code, the
   * leased-network reading is the one to act on: it names a party the practice may have a 30-day
   * notice right against, where the downgrade reading would send the balance to the patient.
   */
  const peerRates = new Map<string, Cents>([["D2150", cents(145)]]);
  const composite = obs({ cdtCode: "D2392", allowed: cents(185), charged: cents(240) });

  const { finding } = foldRateObservation(
    foldRateObservation([], composite).epochs,
    {
      ...composite,
      allowed: cents(145),
      observedAt: "2026-08-19T00:00:00.000Z",
      observedPayerName: "Connection Dental Network",
    },
    { peerRates }
  );
  assert.equal(finding!.classification, "leased-network");
});

test("a payer paying MORE is drift, and is never filed as money to chase", () => {
  const { finding } = foldRateObservation(
    foldRateObservation([], obs()).epochs,
    obs({ allowed: cents(1200), observedAt: "2026-08-19T00:00:00.000Z" })
  );
  assert.equal(finding!.classification, "schedule-drift");
  assert.equal(finding!.delta, cents(75));
  assert.equal(finding!.recoverable, false, "a biller must never be sent to chase a raise");
});
