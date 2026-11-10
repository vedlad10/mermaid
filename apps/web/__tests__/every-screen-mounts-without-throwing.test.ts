/**
 * Every screen must mount, load and render without throwing.
 *
 * ── THE DEFECT THIS EXISTS FOR, WHICH WAS MINE ─────────────────────────────────────────────────
 * Eight screens were converted from a hand-rolled `let loading` flag to a shared load handle. The
 * conversion replaced each declaration — `let loading = false` became `const state = {…}` — and on
 * one screen failed to match the body that used it. Money was left with:
 *
 *     async function load() {
 *       if (loading) return;      // `loading` no longer exists
 *
 * A `ReferenceError` on the first line of the first load. The screen drew its header and its empty
 * layout and nothing else — no spine, no chart, no rows, and no ERROR STATE either, because the
 * throw happened before anything could record that it had.
 *
 * ── WHY NOTHING ELSE CAUGHT IT ─────────────────────────────────────────────────────────────────
 * `typecheck` does not cover these files: they ship to a browser unbuilt and are JavaScript by
 * necessity. Importing a module does not execute a function body, so the import checks passed. And
 * the `today-board-renders` harness deliberately STUBS the screens, so its boot test proves the
 * branch was reached and nothing whatever about what the branch did.
 *
 * ── WHY A STUB DOM RATHER THAN A STATIC CHECK ──────────────────────────────────────────────────
 * The first attempt at this was a regex hunting for identifiers a file never declares. It could not
 * be made to stop reporting destructured parameters and words inside template literals, and a test
 * with false positives is a test somebody deletes — after which the real defect ships. Executing the
 * code is the only exact answer to "does this throw", so this executes it.
 *
 * The stub is honest about its limits: it has no layout, so every geometry read is zero and this
 * says nothing about whether a chart is drawn correctly. It answers the question underneath, which
 * is the one that was silently false: does the screen run at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/* ── The smallest DOM eight screens can actually mount into ─────────────────────────────────── */

type El = Record<string, unknown>;

const NS_TAGS = new Set(["svg", "rect", "line", "path", "circle", "g", "title", "text"]);

function makeEl(tag = "div"): El {
  const children: El[] = [];
  const attrs = new Map<string, string>();
  const classes = new Set<string>();
  const el: El = {
    tagName: String(tag).toUpperCase(),
    children,
    style: {},
    dataset: {},
    hidden: false,
    tabIndex: -1,
    textContent: "",
    innerHTML: "",
    value: "",
    disabled: false,
    scrollTop: 0,
    /* Zero, and deliberately so: there is no layout here, and pretending otherwise would let a
       geometry bug pass while claiming this test had checked it. */
    offsetWidth: 0,
    clientWidth: 0,
    offsetHeight: 0,
    clientHeight: 0,
    scrollHeight: 0,
    classList: {
      add: (...c: string[]) => c.forEach((x) => classes.add(x)),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
      toggle: (c: string, on?: boolean) => (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    get className() { return [...classes].join(" "); },
    set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    get firstChild() { return children[0] ?? null; },
    get lastChild() { return children[children.length - 1] ?? null; },
    get childElementCount() { return children.length; },
    append: (...kids: unknown[]) => { for (const k of kids) if (k && typeof k === "object") children.push(k as El); },
    appendChild: (k: El) => { children.push(k); return k; },
    prepend: (...kids: unknown[]) => { for (const k of kids) if (k && typeof k === "object") children.unshift(k as El); },
    replaceChildren: (...kids: unknown[]) => { children.length = 0; for (const k of kids) if (k && typeof k === "object") children.push(k as El); },
    remove: () => {},
    insertBefore: (k: El) => { children.unshift(k); return k; },
    setAttribute: (n: string, v: string) => attrs.set(n, String(v)),
    getAttribute: (n: string) => attrs.get(n) ?? null,
    removeAttribute: (n: string) => attrs.delete(n),
    hasAttribute: (n: string) => attrs.has(n),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    focus: () => {},
    blur: () => {},
    contains: () => false,
    closest: () => null,
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    querySelector: () => makeEl(),
    /* Empty, so a screen that iterates its own controls simply does nothing rather than crashing. */
    querySelectorAll: () => [] as El[],
  };
  return el;
}

function installDom(): { body: El } {
  const body = makeEl("body");
  const doc: Record<string, unknown> = {
    body,
    documentElement: makeEl("html"),
    createElement: (t: string) => makeEl(t),
    createElementNS: (_ns: string, t: string) => makeEl(NS_TAGS.has(t) ? t : "div"),
    createDocumentFragment: () => makeEl("fragment"),
    getElementById: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [] as El[],
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    activeElement: null,
  };
  const g = globalThis as Record<string, unknown>;
  g.document = doc;
  g.window = { addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  g.CustomEvent = class { type: string; detail: unknown; constructor(t: string, i?: { detail?: unknown }) { this.type = t; this.detail = i?.detail; } };
  g.KeyboardEvent = class { key = ""; };
  /* `table.js` asks `v instanceof Node` to tell a cell that is an element from one that is text.
     A stub element is not a real Node, so the class exists and nothing is an instance of it —
     which is the correct answer here: every stub cell value is text. */
  g.Node = class {};
  g.PointerEvent = class {};
  return { body };
}

installDom();

const { createStore } = await import("../public/store.js");

/* ── Payloads shaped like the real endpoints, with enough in them to exercise a render ─────── */

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

const FIXTURES: Record<string, unknown> = {
  "/api/v1/claims": {
    items: [
      {
        id: "c1", verificationId: "v1", createdAt: iso(20), updatedAt: iso(3), status: "paid",
        patientName: "Ada Alpha", payerName: "Delta Dental", memberId: "ABC12345", serviceDate: iso(21).slice(0, 10),
        totalFee: 142500, expectedInsurancePays: 80000, expectedPatientPays: 62500, patientResponsibility: 14250,
        coordinationPending: 0, preAuthRiskAmount: 0, filingMatters: false, filingDeadline: iso(-300),
        filingRisk: "safe", daysToFile: 300, filingDeadlineEstimated: false, filingDeadlineNote: null,
        scrubErrors: 0, scrubWarnings: 1, canSubmit: false, paidAmount: 79999, outstanding: 0,
        submittedAt: iso(18), submissionOutcome: "accepted", firstPaidAt: iso(10),
        variance: null, recommendedAction: "Nothing to do.", priority: 5,
      },
      {
        id: "c2", verificationId: "v2", createdAt: iso(5), updatedAt: iso(1), status: "ready",
        patientName: "Ben Booker", payerName: null, memberId: "MEM10000", serviceDate: iso(6).slice(0, 10),
        totalFee: 62500, expectedInsurancePays: 30000, expectedPatientPays: 32500, patientResponsibility: 0,
        coordinationPending: 0, preAuthRiskAmount: 0, filingMatters: true, filingDeadline: iso(-2),
        filingRisk: "urgent", daysToFile: 2, filingDeadlineEstimated: true, filingDeadlineNote: "An estimate.",
        scrubErrors: 2, scrubWarnings: 0, canSubmit: false, paidAmount: 0, outstanding: 30000,
        submittedAt: null, submissionOutcome: null, firstPaidAt: null,
        variance: null, recommendedAction: "Fix the scrub errors.", priority: 80,
      },
    ],
    readyToSubmit: 0, atRisk: 1,
  },
  "/api/v1/denials": {
    items: [{
      id: "d1", claimId: "c1", detectedAt: iso(9), status: "open", patientName: "Ada Alpha",
      payerName: "Delta Dental", carcCode: "197", carcDescription: "Pre-authorization absent",
      procedureCode: "D2750", deniedAmount: 112500, expectedRecovery: 33750, overturnRate: 0.3,
      trusted: false, sampleSize: 2, triageSource: "carc-category", disposition: "appeal",
      appealDeadline: iso(-30), daysToAppeal: 30, appealWindow: "safe", deadlineEstimated: true,
      deadlineNote: "Estimated.", appealStatus: null, recoveredAmount: null, awardedAmount: null,
      awardSettledAmount: null, awardOutstanding: 0, awardAgeDays: null, awardedAt: null,
      recommendedAction: "Appeal it.", priority: 60,
    }, {
      /*
       * A second denial whose sample CLEARS the quotable threshold (`MIN_SAMPLE` is 5).
       *
       * The first one does not, so every branch gated on `quotable(...)` was unreached: the reason
       * and payer lists both draw an extra bar segment for the money an overturn rate implies, and
       * the whole of that arithmetic was running in no test. One fixture below the threshold proves
       * only that the suppressed path renders.
       */
      id: "d2", claimId: "c1", detectedAt: iso(6), status: "open", patientName: "Cora Chen",
      payerName: "Cigna Dental", carcCode: "29", carcDescription: "Time limit for filing expired",
      procedureCode: "D2740", deniedAmount: 60000, expectedRecovery: 24000, overturnRate: 0.4,
      trusted: true, sampleSize: 12, triageSource: "practice-history", disposition: "appeal",
      appealDeadline: iso(-20), daysToAppeal: 20, appealWindow: "safe", deadlineEstimated: false,
      deadlineNote: null, appealStatus: null, recoveredAmount: null, awardedAmount: null,
      awardSettledAmount: null, awardOutstanding: 0, awardAgeDays: null, awardedAt: null,
      recommendedAction: "Appeal it.", priority: 40,
    }],
    stats: {
      openCount: 1, openDenied: 112500, openExpectedRecovery: 33750, recoveredCount: 0,
      recoveredAmount: 0, awaitingPaymentCount: 0, awardedAwaitingPayment: 0,
      writtenOffCount: 0, writtenOffAmount: 0, recoveryRate: null, urgentCount: 0,
    },
  },
  "/api/v1/verifications": {
    items: [{
      id: "v1", createdAt: iso(12), status: "verified", patientName: "Ada Alpha", payerName: "Delta Dental",
      memberId: "ABC12345", patientPays: 62500, totalFee: 142500, outcome: "complete",
      recommendedAction: "Ready to share.", priority: 10, criticalFlags: 0, reviewed: false,
      provenance: { kind: "mock", label: "DEMO DATA", shortLabel: "DEMO", benefitsRetrieved: true, amountAtStake: 142500 },
    }],
    doneToday: 1,
  },
  "/api/v1/remittances": {
    items: [{
      id: "r1", payerName: "Delta Dental", status: "posted", receivedAt: iso(4),
      paymentTotal: 79999, claimCount: 1, totalRecoverable: 0, totalWithOtherPayers: 0,
    }],
  },
  "/api/v1/patients": {
    items: [{
      patientKey: "ABC12345", patientName: "Ada Alpha", patientId: "p1", balance: 62500,
      charged: 62500, paid: 0, forgiven: 0, people: [{ patientId: "p1", patientName: "Ada Alpha", balance: 62500 }],
      aging: { current: 62500, d31_60: 0, d61_90: 0, d90_plus: 0 },
      oldestChargeAt: iso(9), daysOutstanding: 9, entryCount: 1, lastActivityAt: iso(9),
      priority: 20, recommendedAction: "Nothing yet.",
    }],
    summary: {
      accountsWithBalance: 1, totalOutstanding: 62500, aging: { current: 62500, d31_60: 0, d61_90: 0, d90_plus: 0 },
      overNinetyShare: 0, totalCharged: 62500, totalPaid: 0, totalForgiven: 0, collectionRate: 0,
    },
  },
  "/api/v1/today": {
    items: [{
      kind: "verification", id: "v1", title: "Ada Alpha", subtitle: "Delta Dental · needs a person",
      action: "Call the payer.", amount: 142500, priority: 90, dueDate: iso(-3), urgent: true,
      source: { kind: "mock", label: "DEMO DATA", shortLabel: "DEMO", benefitsRetrieved: true },
    }],
    counts: { verification: 1, claim: 0, remittance: 0, denial: 0, patient: 0, era: 0 },
    atStake: 142500, urgentCount: 1,
    money: {
      heldInBank: 0, heldCount: 0, oldestHeldAt: null, owedByPayers: 30000, withOtherPlans: 0,
      expectedFromPayers: 0, owedByPatients: 62500,
      aging: { current: 62500, d31_60: 0, d61_90: 0, d90_plus: 0 },
      overNinetyShare: 0, deniedUnrecovered: 112500, recoveredByAppeal: 0, preAuthAtRisk: 0, heldAdvices: [],
    },
    sources: { live: 0, test: 0, mock: 1, none: 0 },
    generatedAt: new Date().toISOString(),
    recentActivity: [{ kind: "remittance", at: iso(4), text: "Delta Dental paid $799.99", amount: 79999, id: "r1" }],
  },
  /* The schedule (0035) — read by Today's strip and Verify's readiness timeline. One ready visit
     today, one not ready in three days, so both widgets take their drawing path, not their empty one. */
  "/api/v1/appointments": {
    today: iso(0).slice(0, 10),
    timeZone: "UTC",
    items: [
      {
        id: "a1", source: "mock", externalId: "A-1", day: iso(0).slice(0, 10), scheduledFor: iso(0),
        status: "scheduled", patientId: "p1", patientName: "Ada Alpha", chartId: "MRM-1", provider: "Dr. Reyes",
        durationMinutes: 60, plannedProcedures: [{ code: "D1110", feeCents: 12000 }], plannedProductionCents: 12000,
        readiness: { state: "verified", group: "verified", verificationId: "v1", verifiedAt: iso(2), expiresAt: iso(-28), reason: "" },
      },
      {
        id: "a2", source: "mock", externalId: "A-2", day: iso(-3).slice(0, 10), scheduledFor: iso(-3),
        status: "scheduled", patientId: "p2", patientName: "Ben Booker", chartId: "MRM-2", provider: null,
        durationMinutes: null, plannedProcedures: [{ code: "D2750", feeCents: 125000 }], plannedProductionCents: 125000,
        readiness: { state: "unverified", group: "pending", verificationId: null, verifiedAt: null, expiresAt: null, reason: "" },
      },
    ],
  },
  /* "Verify all due": one visit that will be checked and one that will not, so the panel draws its
     list and its button rather than its empty sentence. */
  "/api/v1/appointments/due": {
    horizonDays: 3,
    maxPatients: 20,
    checks: 1,
    visits: [
      { appointmentId: "a2", patientId: "p2", patientName: "Ben Booker", scheduledFor: iso(-1), day: iso(-1).slice(0, 10),
        state: "stale", will: "check", reason: "The last check will be out of date by the visit." },
      { appointmentId: "a3", patientId: "p3", patientName: "Grace Green", scheduledFor: iso(-2), day: iso(-2).slice(0, 10),
        state: "no-coverage", will: "skip", reason: "No insurance on file. Verify from the patient's card first." },
    ],
  },
  "/api/v1/ops/outbox": {
    backlog: { pending: 0, dead: 0, oldestPending: null }, lagMs: 0, dead: [],
    recent: [
      { id: "e1", type: "claim.submitted", aggregateId: "c1", occurredAt: iso(18), attempts: 1, publishedAt: iso(18), lastError: null, deadLettered: false, status: "delivered" },
      { id: "e2", type: "remittance.posted", aggregateId: "r1", occurredAt: iso(4), attempts: 1, publishedAt: iso(4), lastError: null, deadLettered: false, status: "delivered" },
    ],
  },
  "/api/v1/ops/monitors": {
    healthy: true, firing: [],
    checks: [{ key: "outbox.lag", ok: true, message: "Draining normally.", detail: { lagMs: 0, pending: 0 } }],
  },
  "/api/v1/ops/audit": {
    items: [{ id: 1, trace_id: "t1", actor_role: "owner", action: "login", resource: "session", resource_id: "a@b.c", outcome: "success", ip: "::1", created_at: iso(0) }],
  },
};

/** The analytics report answers on a query string, so it is matched by prefix. */
const REPORT = {
  period: { from: iso(30), to: iso(0) },
  funnel: { verificationsCompleted: 1, verificationsFlagged: 0, claimsSubmitted: 2, claimsPaid: 1, billingRate: 1, reviewRate: 0 },
  money: {
    filedToPayers: 205000, expected: 110000, collected: 79999, denied: 112500, recovered: 0,
    collectionRate: 0.72, denialRate: 0.54, recoveryRate: 0, patientBilled: 62500, patientCollected: 0,
    patientForgiven: 0, patientCollectionRate: 0, estimateVariance: -30001, estimateAccuracy: -0.27, totalCollected: 79999,
  },
  payers: [{ payerId: "delta", payerName: "Delta Dental", claimsSubmitted: 1, filedToPayers: 142500, expected: 80000, collected: 79999, denied: 0, recovered: 0, collectionRate: 1, denialRate: 0, averageDaysToPay: 8 }],
  topDenialReasons: [{ carcCode: "197", description: "Pre-authorization absent", count: 1, denied: 112500, recovered: 0, recoveryRate: 0 }],
  dailyCollections: [
    { day: iso(5).slice(0, 10), collected: 40000, payments: 1 },
    { day: iso(4).slice(0, 10), collected: 39999, payments: 1 },
  ],
  insights: ["Collecting 72% of what the estimates promised."],
};

const api = async (_method: string, path: string): Promise<unknown> => {
  if (path.startsWith("/api/v1/analytics/report")) return REPORT;
  const hit = FIXTURES[path.split("?")[0]!];
  if (hit) return hit;
  throw new Error(`no fixture for ${path}`);
};

/* ── The screens ──────────────────────────────────────────────────────────────────────────────── */

const SCREENS: Array<[string, string]> = [
  ["Today", "mountToday"],
  ["Verify", "mountVerify"],
  ["Claims", "mountClaims"],
  ["Money", "mountMoney"],
  ["Recover", "mountRecover"],
  ["Patients", "mountPatients"],
  ["Insights", "mountInsights"],
  ["Ops", "mountOps"],
];
const FILES: Record<string, string> = {
  mountToday: "today.js", mountVerify: "verify.js", mountClaims: "claims.js", mountMoney: "money.js",
  mountRecover: "recover.js", mountPatients: "patients.js", mountInsights: "insights.js", mountOps: "ops.js",
};

for (const [label, mountName] of SCREENS) {
  test(`${label} mounts, loads and renders without throwing`, async () => {
    const mod = (await import(`../public/${FILES[mountName]}`)) as Record<string, unknown>;
    const mount = mod[mountName] as (stage: unknown, deps: unknown) => { destroy(): void };
    assert.equal(typeof mount, "function", `${mountName} is not exported`);

    const stage = makeEl("div");
    const store = createStore();

    /*
     * The mount is synchronous; the load it kicks off is not. Draining the microtask queue is what
     * makes this test cover the RENDER-AFTER-DATA path — which is where the Money defect lived, and
     * where a screen that mounts fine can still throw on its first real draw.
     */
    let screen: { destroy(): void; reload(): Promise<void> } | null = null;
    assert.doesNotThrow(() => {
      screen = mount(stage, { store, api, extras: [] }) as typeof screen;
    }, `${label} threw while mounting`);

    /*
     * ── THE LOAD IS AWAITED, AND THAT IS THE WHOLE POINT ──────────────────────────────────────
     * The Money defect did not throw synchronously. `mount` kicks off `load()` and ignores the
     * promise, so a `ReferenceError` inside it became a rejection nobody was listening for — which
     * is exactly why the browser showed a header, an empty layout, and no error state at all.
     *
     * A test that only wrapped the MOUNT would therefore pass on the broken code. Verified by
     * reintroducing the bug: it did, twice — an `unhandledRejection` listener did not catch it
     * either, because Node only reports one once the promise is collected. Every screen exposes
     * `reload`, which runs the same path and can be awaited, so the failure has nowhere to hide.
     */
    await assert.doesNotReject(
      () => screen!.reload(),
      `${label}'s load path rejected — in a browser this is a blank screen with no error state`
    );
    for (let i = 0; i < 20; i++) await Promise.resolve();

    assert.ok((stage.children as unknown[]).length > 0, `${label} left the stage empty`);
    assert.doesNotThrow(() => screen!.destroy(), `${label} threw while unmounting`);
  });
}

test("a screen whose data fails still renders, rather than throwing", async () => {
  /**
   * The other half of the same defect. A load that rejects must become the §7.3 error state; if it
   * escapes instead, the screen is left blank AND the console gets an unhandled rejection.
   */
  const mod = (await import("../public/claims.js")) as Record<string, unknown>;
  const mount = mod.mountClaims as (stage: unknown, deps: unknown) => { destroy(): void };
  const stage = makeEl("div");
  const failing = async () => { throw new Error("payer portal returned no response"); };

  let screen: { destroy(): void } | null = null;
  await assert.doesNotReject(async () => {
    screen = mount(stage, { store: createStore(), api: failing });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
  assert.ok((stage.children as unknown[]).length > 0, "the error state must still put something on the stage");
  screen!.destroy();
});

test("Verify's readiness timeline draws §8.2's today rule, once, through the centre of today's column", async () => {
  // Through FILES, like the screens above: verify.js has no .d.ts, and a literal path would need one.
  const mod = (await import(`../public/${FILES.mountVerify}`)) as Record<string, unknown>;
  const mount = mod.mountVerify as (stage: unknown, deps: unknown) => { destroy(): void; reload(): Promise<void> };
  const stage = makeEl("div");
  const screen = mount(stage, { store: createStore(), api, extras: [] });
  await screen.reload();
  for (let i = 0; i < 20; i++) await Promise.resolve();

  const rules: El[] = [];
  const walk = (n: El) => {
    const cls = (n.getAttribute as (k: string) => string | null)?.("class");
    if (cls === "ch__rule") rules.push(n);
    for (const c of (n.children as El[]) ?? []) walk(c);
  };
  walk(stage);
  assert.equal(rules.length, 1, "one rule, on the readiness timeline only — the look-back chart marks nothing");
  const x = Number((rules[0]!.getAttribute as (k: string) => string)("x1"));
  // Fourteen columns across a 1000-unit plot; today is the first, so its centre is half a column in.
  assert.ok(Math.abs(x - 1000 / 14 / 2) < 1e-9, `rule at x=${x}`);
  assert.equal((rules[0]!.getAttribute as (k: string) => string)("x2"), String(x), "vertical");
  screen.destroy();
});
