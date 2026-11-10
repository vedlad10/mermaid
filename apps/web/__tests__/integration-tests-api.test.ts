/**
 * The Test Lab reports what the harness actually found, and cannot drift into flattering itself.
 *
 * ── WHAT IS WORTH TESTING ON A PAGE THAT SHOWS A TRANSCRIPT ────────────────────────────────────
 * Not the prose — that is a judgement call and a test asserting on it would only pin today's
 * wording. What matters is the property the screen exists to hold: **it may not claim more than the
 * run proved.** A future edit that flips a scenario to `pass` because the account was upgraded, or
 * because someone confused "the mock passes" with "Stedi passed", turns an honest instrument into a
 * dashboard that says everything is fine. These tests are the thing standing in the way of that.
 *
 * So they check the arithmetic (the totals must equal the rows), the invariants (a pass may not be
 * blocked by a vendor; a bug cited by a scenario must exist), and the two claims a reader will act
 * on: the headline count, and the fact that every block is the vendor's and not ours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { INTEGRATION_REPORT } from "../integration-scenarios.ts";

const R = INTEGRATION_REPORT;

test("all ten scenarios are present, numbered 1..10, each with a distinct name", () => {
  assert.equal(R.scenarios.length, 10);
  assert.deepEqual(
    R.scenarios.map((s) => s.n),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "the page shows the ten scenarios from the report — no more, no fewer, in order"
  );
  assert.equal(new Set(R.scenarios.map((s) => s.name)).size, 10);
});

test("the headline totals are the rows counted, not a number someone typed", () => {
  const counted = {
    pass: R.scenarios.filter((s) => s.status === "pass").length,
    blocked: R.scenarios.filter((s) => s.status === "blocked").length,
    fail: R.scenarios.filter((s) => s.status === "fail").length,
  };
  assert.deepEqual(
    R.totals,
    counted,
    "the summary must be derivable from the scenarios — a total that disagrees with its own rows is the " +
      "exact failure this screen exists to prevent"
  );
});

test("the recorded result is 3 PASS · 0 FAIL · 7 BLOCKED", () => {
  /**
   * Pinned deliberately. If a later edit changes these, it must change this test too — which is the
   * moment somebody has to justify the new numbers against a harness run rather than a hope.
   */
  assert.deepEqual(R.totals, { pass: 3, blocked: 7, fail: 0 });
});

test("only scenarios the harness passed are marked pass", () => {
  assert.deepEqual(
    R.scenarios.filter((s) => s.status === "pass").map((s) => s.n),
    [4, 8, 9],
    "S4 (rejection), S8 (tenant isolation) and S9 (failure/retry) are the three the harness printed PASS"
  );
});

test("a passing scenario cannot also be blocked by something", () => {
  for (const s of R.scenarios.filter((x) => x.status === "pass")) {
    assert.equal(s.blockedBy, null, `S${s.n} is marked pass but claims to be blocked by ${s.blockedBy}`);
  }
});

test("every blocked scenario names what is blocking it, and none of them is Mermaid", () => {
  const blocked = R.scenarios.filter((s) => s.status === "blocked");
  assert.ok(blocked.length > 0);
  for (const s of blocked) {
    assert.ok(s.blockedBy, `S${s.n} is blocked but does not say by what — the reader is left to guess`);
    /**
     * THE LOAD-BEARING ASSERTION.
     *
     * "7 blocked" reads as "7 broken" unless the screen says otherwise, and the whole point of the
     * page is that all seven are one vendor account setting. The day one of these becomes a Mermaid
     * block, this test fails and somebody has to look at it — which is correct, because at that
     * point the headline is no longer true.
     */
    assert.notEqual(
      s.blockedBy,
      "mermaid",
      `S${s.n} is blocked by Mermaid — the page's central claim, that no block is ours, is no longer true`
    );
  }
});

test("every bug a scenario cites actually exists, and every bug is cited", () => {
  const ids = new Set(R.bugs.map((b) => b.id));
  for (const s of R.scenarios) {
    for (const id of s.bugs) {
      assert.ok(ids.has(id), `S${s.n} cites ${id}, which is in no bug list — the detail view would render nothing`);
    }
  }
  // The reverse: a bug nobody found is a bug with no evidence behind it.
  const cited = new Set(R.scenarios.flatMap((s) => s.bugs));
  for (const b of R.bugs) {
    assert.ok(
      cited.has(b.id) || b.id === "BUG-5",
      `${b.id} is listed but no scenario found it — BUG-5 is the documented exception (found while ` +
        `running the harness, not by a scenario assertion)`
    );
  }
});

test("every bug carries a root cause, a fix, a test and a commit", () => {
  for (const b of R.bugs) {
    for (const field of ["rootCause", "fix", "test", "commit"] as const) {
      assert.ok(b[field]?.trim(), `${b.id} has no ${field} — an unevidenced bug entry is a claim, not a finding`);
    }
  }
});

test("every scenario carries evidence from BOTH sides", () => {
  for (const s of R.scenarios) {
    assert.ok(s.mermaidEvidence.length > 0, `S${s.n} shows nothing about what Mermaid did`);
    assert.ok(s.stediEvidence.length > 0, `S${s.n} shows nothing about what Stedi said`);
    assert.ok(s.description.trim(), `S${s.n} never says what it set out to prove`);
    assert.ok(s.note.trim(), `S${s.n} has no recorded conclusion`);
  }
});

test("the report is dated and attributed, so it cannot read as a live status", () => {
  /**
   * Without these the page asserts "the integration works", present tense, forever. With them it is
   * a dated measurement — which is the only honest thing a transcript can be.
   */
  assert.match(R.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(R.commit.trim(), "the commit the harness ran against must be recorded");
  assert.match(R.harness, /stedi-scenarios/);
  assert.match(R.environment, /TEST mode/i);
  assert.match(
    R.environment,
    /MockEdiAdapter was not used/i,
    "the page must state that nothing here was mocked — that is the claim the whole exercise rests on"
  );
});

test("the verdict is one of the three, and carries its reasoning", () => {
  assert.ok(["GREEN", "YELLOW", "RED"].includes(R.verdict));
  assert.equal(R.verdict, "YELLOW", "the recorded verdict — GREEN would claim capabilities nobody has observed");
  assert.ok(R.verdictReason.trim());
});

test("the blocker is stated in the vendor's own words, with a remedy and a citation", () => {
  assert.match(R.blocker.vendorWords, /provisioned environment/);
  assert.ok(R.blocker.remedy.trim());
  assert.match(R.blocker.citation, /Stedi/);
});

test("coverage does not claim more than the scenarios proved", () => {
  const byCapability = new Map(R.coverage.map((c) => [c.capability, c]));

  /**
   * 835 retrieval and remittance posting were never reached — S6 and S7 are both blocked. A coverage
   * table that marked either "proven" while its scenario sits BLOCKED is the page contradicting
   * itself on the one subject a reader most needs to trust it about: whether money moves.
   */
  assert.equal(byCapability.get("835 / ERA retrieval")?.proven, "no");
  assert.equal(byCapability.get("Remittance posting")?.proven, "no");
  assert.equal(byCapability.get("270/271 eligibility")?.proven, "yes");
  assert.equal(byCapability.get("277CA acknowledgement")?.proven, "yes");

  for (const c of R.coverage) {
    assert.ok(["yes", "partial", "no"].includes(c.proven));
    assert.ok(c.detail.trim(), `${c.capability} claims a coverage level with no detail behind it`);
  }
});
