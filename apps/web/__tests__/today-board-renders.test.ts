/**
 * The Today board must actually render.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────────────────
 * 2,056 tests passed while `showTodaySummary` threw `ReferenceError: Cannot access 'exposure'
 * before initialization` on every single render, for every role. A total was declared beside the
 * card that used it and read by the lead band above it, putting it in its temporal dead zone at the
 * moment the lead was built. The board was a blank page. Nothing in the suite noticed, because
 * nothing in the suite had ever executed the client.
 *
 * That is the shape of the hole: `apps/web/public/app.js` is four thousand lines of the product a
 * user actually touches, and it was verified only by reading it. Type-checking does not cover it
 * (it is JavaScript by necessity — it ships to a browser unbuilt), and the API tests stop at the
 * JSON boundary.
 *
 * So this runs the real client, in `node:vm`, against payloads built by the real `buildTodayQueue`,
 * and checks the markup that comes out. It says nothing about how the board LOOKS — that needs
 * eyes, or a browser. It answers the question underneath: does it run, and is what it prints true.
 *
 * ── WHY A STUB DOM AND NOT A HEADLESS BROWSER ──────────────────────────────────────────────────
 * A browser would test more and cost minutes per run in a suite that currently completes in one.
 * The defect class this exists for — a throw during render, a fabricated figure, `$NaN`, a
 * permission leak — is entirely visible in the markup string. When a defect needs layout to see, it
 * needs a browser, and this file does not pretend otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { MockEdiAdapter, type RemittanceRequestClaim } from "@mermaid/edi";
import type { ClaimSubmittedBody } from "@mermaid/events";
import { cents, type Role } from "@mermaid/shared";
import { buildTodayQueue, type TodayQueue } from "../today.ts";
import { positionRows } from "../public/today.js";
import { buildServices, type Services } from "../wiring.ts";

/**
 * The client is an ES module and this harness runs it as a script in a `vm` context, so the one
 * `import` it carries has to be resolved here rather than stubbed.
 *
 * Inlined, not mocked. These tests exist to check what the board actually RENDERS, and a fake chart
 * module would let a real charting bug — a segment drawn from a figure the payload never carried —
 * pass every assertion below. The module's source is wrapped in an IIFE so its private helpers (it
 * declares its own `esc`) cannot collide with the client's.
 */
const read = (name: string) => readFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), "utf8");

/**
 * Every module the client imports, inlined as an IIFE that returns its exports.
 *
 * Inlined rather than stubbed: these tests exist to check what the board actually RENDERS, and a
 * fake module would let a real bug pass every assertion. Each is wrapped so its private helpers —
 * several declare their own `esc`, `node` or `usd` — cannot collide with the client's or with each
 * other's.
 */
const ns = (file: string, binding: string) => {
  const src = read(file);
  const exports = [...src.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]!);
  return `const ${binding} = (() => {
${src.replace(/^import .*$/gm, "").replace(/\bexport /g, "")}
return { ${exports.join(", ")} };
})();
`;
};

/* Ordered so a module is defined before the one that destructures from it. */
const MODULES =
  ns("charts.js", "Cx") +
  ns("store.js", "__store") +
  ns("chart.js", "__chart") +
  ns("table.js", "__table") +
  ns("spine.js", "__spine") +
  /* Inlined, not stubbed: it is pure string logic over one body attribute, and the shell calls it
     at boot to put the presentation-mode toggle in the top bar. */
  ns("privacy.js", "__privacy") +
  /* Inlined for the same reason: the shell constructs it at boot, and its query ROUTING is real
     logic worth executing rather than stubbing away. */
  ns("palette.js", "__palette") +
  `const { createStore } = __store;
const { createDrill } = __spine;
const { presentingToggle } = __privacy;
const { createPalette } = __palette;
${/*
   * The screens built on the interaction foundation are STUBBED, unlike the primitives above.
   *
   * They cannot be inlined: each mounts a live chart, a virtualised table and a metric spine, which
   * between them need layout geometry, pointer events and a real SVG namespace. The stub DOM in this
   * file deliberately has none of that — it exists to answer "what text does the board produce",
   * which is a different question from "does a chart lay out".
   *
   * The stub is not `() => null`, though, and the difference matters. Every real mount begins by
   * handing the stage over with `replaceChildren`, and this test's whole assertion is that the
   * landing path does not leave the stage blank. A stub that drew nothing would report a blank page
   * for the roles that land on these tabs — failing for a correct app — while one that silently
   * returned would make the assertion vacuous. So it does exactly what a real mount's first line
   * does, and no more.
   *
   * What this therefore proves: the landing path reached this branch and gave it the stage. What it
   * does not prove: that the screen renders correctly. That is the browser's job, not this file's.
   */ ""}
const stubScreen = () => {
  stage.replaceChildren();
  return { destroy() {}, reload() {}, renderDrill: async () => null };
};
const mountMoney = stubScreen;
const mountClaims = stubScreen;
const mountRecover = stubScreen;
const mountVerify = stubScreen;
const mountToday = stubScreen;
const mountOps = stubScreen;
const mountPatients = stubScreen;
const mountInsights = stubScreen;
`;

const CLIENT = MODULES + read("app.js")
  .replace(/^import .*$/gm, "")
  /** `boot()` fetches a session. Everything above it is declarations, which is what is under test. */
  .replace(/\nboot\(\);\s*$/, "\n");

/** The smallest DOM the board needs. Nothing here can influence the text it produces. */
type Stub = Record<string, unknown>;
const el = (): Stub => ({
  innerHTML: "",
  /**
   * Counted, not ignored. A screen can be drawn by assigning `innerHTML` OR by handing over a
   * cloned template through `replaceChildren` — the verification form does the latter — so a test
   * that only reads `innerHTML` would call a rendered form a blank page.
   */
  replacedCount: 0,
  replaceChildren(this: Stub) {
    this.replacedCount = (this.replacedCount as number) + 1;
  },
  textContent: "",
  dataset: {},
  style: {},
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {},
  removeEventListener() {},
  append() {},
  appendChild() {},
  remove() {},
  /*
   * A real attribute bag, not a no-op. Presentation mode (§8.6) stores its state as an attribute on
   * `document.body` and reads it back on every render, so a stub that swallowed writes and answered
   * `false` forever would let a masking bug through — and would have crashed the boot path here,
   * which is what it did.
   */
  attrs: new Set<string>(),
  setAttribute(this: Stub, name: string) {
    (this.attrs as Set<string>).add(name);
  },
  removeAttribute(this: Stub, name: string) {
    (this.attrs as Set<string>).delete(name);
  },
  hasAttribute(this: Stub, name: string) {
    return (this.attrs as Set<string>).has(name);
  },
  getAttribute: () => null,
  querySelector: () => el(),
  querySelectorAll: () => [],
  closest: () => null,
  focus() {},
  scrollIntoView() {},
});


// ── A clinic with money in every category the board reports ─────────────────────────────────────

const RECEIVED = new Date("2026-08-10T09:00:00Z");
const NOW = new Date(RECEIVED.getTime() + 2 * 86_400_000);

const submitted = (memberId: string, id: string): ClaimSubmittedBody => ({
  claimId: `claim-${id}`,
  verificationId: `ver-${id}`,
  submittedAt: "2026-07-28T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Board", lastName: "Patient", dateOfBirth: "1990-04-12", memberId },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber: `MRM-${id}`,
  payerControlNumber: "556677889",
  totalFee: cents(1000),
  expectedInsurancePays: cents(600),
  serviceDate: "2026-07-27",
});

const remitClaim = (memberId: string, id: string): RemittanceRequestClaim => ({
  patientControlNumber: `MRM-${id}`,
  payerControlNumber: "556677889",
  patientFirstName: "Board",
  patientLastName: "Patient",
  memberId,
  lines: [{ procedureCode: "D2750", charged: cents(1000), quantity: 1 }],
  expectedInsurancePays: cents(600),
});

/**
 * Two held advices (…23 forwards to a second plan) AND an open claim.
 *
 * The open claim matters: without one `expectedFromPayers` is zero, and a zero cannot distinguish
 * "this role may not see it" from "there is none of it" — which is the exact distinction half the
 * assertions below exist to prove.
 */
async function clinic(): Promise<Services> {
  const services = buildServices({ inMemory: true });
  /** A verification produces a claim, which is what puts money in `expectedFromPayers`. */
  await services.via(new MockEdiAdapter()).verification.create({
    patient: {
      firstName: "Open",
      lastName: "Claim",
      dateOfBirth: "1990-01-01",
      memberId: "MET90011",
      address: { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" },
    },
    cardText: "MetLife Dental\nMember ID: MET90011",
    planItems: [{ code: "D0120", quantity: 1, fee: cents(65) }],
  });
  for (const id of ["B1", "B2"]) {
    await services.remittance.recordExpectation(submitted("ABC00023", id));
    const fetched = await new MockEdiAdapter().fetchRemittance({
      payerId: "delta-dental",
      payerName: "Delta Dental",
      payeeName: "MERMAID DEMO DENTAL",
      paymentDate: "2026-08-10",
      claims: [remitClaim("ABC00023", id)],
    });
    await services.remittance.ingestArtifact(
      fetched.raw!,
      { resolution: "source-credential", vendor: "mock", artifactId: `f-${id}`, expectedPayeeId: null },
      RECEIVED
    );
  }
  return services;
}



// ── The money position, which is now a pure function ────────────────────────────────────────────

/**
 * These assertions used to run the whole client in a `vm` and read the markup it produced, because
 * the money position was written directly into an HTML string by the Today renderer. That renderer
 * is gone: §8.1's Today is a three-column triage screen built on the shared primitives, and the
 * position it still carries is computed by `positionRows` and handed to the DOM as data.
 *
 * The guarantees are unchanged and are asserted closer to where they can break. What was being
 * tested was never really the markup — it was the null-versus-zero decision, and that decision now
 * lives in one exported function with no DOM anywhere near it.
 */

const ROLES: Role[] = [
  "owner",
  "admin",
  "office_manager",
  "insurance_coordinator",
  "front_desk",
  "biller",
  "dentist",
  "auditor",
];

const usd = (c: number): string =>
  `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const positionFor = async (role: Role | null = null) => {
  const today = await buildTodayQueue(await clinic(), 50, NOW, role ? { role } : null);
  return { today, rows: positionRows(today.money) };
};

for (const role of ROLES) {
  test(`the money position is computable for a ${role}`, async () => {
    const { rows } = await positionFor(role);
    assert.ok(rows.length >= 4, "every role gets the same rows; only their contents differ");
    for (const r of rows) {
      assert.ok(typeof r.label === "string" && r.label.length > 0, "every row is named");
      assert.ok(typeof r.display === "string" && r.display.length > 0, "and every row says something");
    }
  });
}

test("the position is computable for an empty practice", async () => {
  /**
   * The first screen a new practice ever sees. A crash here is the worst possible first impression,
   * and the empty path is the one no fixture exercises by accident.
   */
  const today = await buildTodayQueue(buildServices({ inMemory: true }), 50, NOW, { role: "owner" });
  const rows = positionRows(today.money);
  assert.ok(rows.length >= 4);
  for (const r of rows) {
    assert.equal(r.visible, true, "an owner of an empty practice may see everything");
    assert.equal(r.amount, 0, "and everything is genuinely zero, not withheld");
    assert.equal(r.display, "$0.00", "which is a real answer and is printed as one");
  }
});

test("nothing renders as a broken value", async () => {
  for (const role of ROLES) {
    const { rows } = await positionFor(role);
    for (const r of rows) {
      for (const bad of ["NaN", "undefined", "null", "Infinity", "[object Object]"]) {
        assert.ok(!r.display.includes(bad), `${role}: ${r.label} printed ${bad}`);
      }
    }
  }
});

test("every figure traces to the payload it was given", async () => {
  /**
   * The screen may not compute money. Each visible figure must be a value the SERVER sent, because
   * the server is the only thing that has applied the viewer's permissions to it.
   */
  const { today, rows } = await positionFor("owner");
  const m = today.money;
  const expected: Record<string, number | null | undefined> = {
    held: m.heldInBank,
    payers: m.owedByPayers,
    patients: m.owedByPatients,
    denied: m.deniedUnrecovered,
    preauth: m.preAuthAtRisk,
  };
  for (const r of rows) {
    if (!r.visible) continue;
    assert.equal(r.amount, expected[r.key], `${r.key} must be the server's figure, not a derived one`);
    assert.equal(r.display, usd(r.amount!), "and must be formatted, never recomputed");
  }
});

test("held money appears as a position, and its figure is the server's", async () => {
  const { today, rows } = await positionFor("owner");
  assert.ok(today.money.heldInBank! > 0, "the fixture really does hold money, so this is not vacuous");
  const held = rows.find((r) => r.key === "held")!;
  assert.equal(held.amount, today.money.heldInBank);
  assert.equal(held.tone, "warning", "money sitting in the bank unposted is waiting on a person");
});

test("a withheld figure is an em dash and carries no amount at all, never $0.00", async () => {
  /**
   * THE ASSERTION THIS FILE EXISTS FOR. Telling a front-desk user that payers owe the practice
   * $0.00 is a confident false statement about money. Telling them the figure is not theirs to see
   * is a true one.
   *
   * The trap, which caught this renderer's predecessor: writing the figure as `usd(v ?? 0)` prints
   * "$0.00" under a caption reading "not visible to your role", and an assertion that only checks
   * the caption passes. So this asserts on the ROW — a withheld row has no `amount` property to
   * coerce, which is a stronger guarantee than a formatting rule anyone can forget to apply.
   */
  const owner = await positionFor("owner");
  const desk = await positionFor("front_desk");

  assert.ok(owner.today.money.heldInBank! > 0, "there IS held money, so the comparison is not vacuous");
  assert.equal(desk.today.money.heldInBank, null, "and the front desk may not see it");

  const withheld = desk.rows.filter((r) => !r.visible);
  assert.ok(withheld.length >= 3, `front desk should have three withheld positions; found ${withheld.length}`);
  for (const r of withheld) {
    assert.equal(r.display, "—", `a withheld position must be an em dash, not ${JSON.stringify(r.display)}`);
    assert.ok(!("amount" in r), "and must carry no value a renderer could print");
    assert.match(r.note, /not visible to your role/, "and must say why the space is empty");
  }
});

test("a visible zero is a real answer and is not confused with a withheld one", () => {
  /* The distinction the whole guard exists for, asserted in the direction nobody thinks to check. */
  const rows = positionRows({ heldInBank: 0, owedByPayers: 0, owedByPatients: 0, deniedUnrecovered: 0 });
  for (const r of rows) {
    assert.equal(r.visible, true);
    assert.equal(r.display, "$0.00");
    assert.equal(r.tone, null, "zero is never an alarm");
  }
});

test("no row is derived from another, so a partial view is never presented as a whole", () => {
  /**
   * Summing what a role CAN see into a total would present a partial figure as the practice's
   * position — which reads as a smaller problem than there is. Every row is its own server figure.
   */
  const rows = positionRows({ heldInBank: 100, owedByPayers: 200, owedByPatients: 300, deniedUnrecovered: null });
  const visible = rows.filter((r) => r.visible);
  const total = visible.reduce((t, r) => t + (r.amount ?? 0), 0);
  assert.ok(
    !visible.some((r) => r.amount === total),
    "no row equals the sum of the others"
  );
});

test("pre-authorisation exposure is shown only when there is some, or when it is withheld", () => {
  /* A permanent "$0.00 at risk" line is one more thing to read past on a screen whose job is to be
     read in five seconds — but a WITHHELD one must still appear, or its absence reads as zero. */
  assert.ok(!positionRows({ preAuthAtRisk: 0 }).some((r) => r.key === "preauth"));
  assert.ok(positionRows({ preAuthAtRisk: 500 }).some((r) => r.key === "preauth"));
  assert.ok(positionRows({ preAuthAtRisk: null }).some((r) => r.key === "preauth"));
});


// ── The landing screen ──────────────────────────────────────────────────────────────────────────

/**
 * Boot the client the way a browser does, with a session and a stubbed API, and see what the user
 * is actually looking at when `start()` returns.
 *
 * This exists because the navigation was fixed and the RENDER was not. `applyRoleNavigation` hides
 * the tabs a role cannot open and returns the first one it can — a dentist holds no `queue.read`,
 * so they land on Verify. But `start()` then rendered exactly one screen, Today, guarded on
 * `state.today` being populated. For a dentist the queue had 403'd, so that guard was false and
 * nothing rendered at all: correct permissions, correct navigation, blank page.
 */
async function bootAs(role: Role, permissions: string[]): Promise<{ html: string; landing: string }> {
  const tabs = [
    { tab: "today", requires: "queue.read" },
    { tab: "verifications", requires: "verifications.read" },
    { tab: "claims", requires: "claims.read" },
    { tab: "money", requires: "remittances.read" },
    { tab: "recovery", requires: "denials.read" },
    { tab: "patients", requires: "patients.read" },
  ].map((t) => {
    /*
     * These stand in for real rail buttons, so they carry what a real one carries: the dataset, and
     * a class list that says it is a tab. `applyRoleNavigation` reads both — it hides anything
     * declaring `data-requires` and picks the landing screen from the tabs among them — and a stub
     * without `classList` would let a form chip decide where a dentist lands.
     */
    const node: Stub = {
      ...el(),
      dataset: { tab: t.tab, requires: t.requires },
      hidden: false,
      classList: { contains: (c: string) => c === "tab", add() {}, remove() {} },
    };
    node.setAttribute = () => {};
    return node;
  });

  const stage = el();
  const template = { ...el(), content: { cloneNode: () => el() } };
  const document = {
    getElementById: (id: string) => (id === "stage" ? stage : template),
    querySelector: () => el(),
    /*
     * Both selectors resolve to the same nodes, because in the real document they do: every rail
     * button is a `.tab` AND carries `data-requires`. Answering only `.tab` meant that when role
     * gating was generalised to hide any element declaring a permission, this stub returned nothing,
     * every tab stayed visible, and the landing-screen assertions failed for a reason that had
     * nothing to do with navigation.
     */
    querySelectorAll: (sel: string) => (sel === ".tab" || sel === "[data-requires]" ? tabs : []),
    createElement: () => el(),
    addEventListener() {},
    body: el(),
    documentElement: el(),
    title: "",
  };

  /** The API a restricted role actually meets: 403 on what it may not read. */
  const api = async (input: string) => {
    const url = String(input);
    const allowed =
      url.includes("/reference/") ||
      url.includes("/auth/") ||
      (url.includes("/today") && permissions.includes("queue.read"));
    return {
      ok: allowed,
      status: allowed ? 200 : 403,
      headers: { get: () => "application/json" },
      json: async () =>
        allowed
          ? { items: [], counts: {}, atStake: 0, urgentCount: 0, money: {}, sources: {} }
          : { error: { code: "forbidden", message: `role ${role} lacks it` } },
    };
  };

  const ctx = vm.createContext({
    document,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { pathname: "/" } },
    location: { pathname: "/" },
    navigator: { userAgent: "test" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: api,
    console: { ...console, error() {}, warn() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval,
    requestAnimationFrame: (f: () => void) => f(),
    Intl,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    Promise,
    URL,
    URLSearchParams,
  });
  vm.runInContext(CLIENT, ctx, { filename: "app.js" });
  vm.runInContext(`state.user = { role: ${JSON.stringify(role)}, permissions: ${JSON.stringify(permissions)} };`, ctx);
  const landing = vm.runInContext("applyRoleNavigation()", ctx) as string;
  /**
   * `start()`, not `switchTab()`. Calling the renderer directly proved only that the renderer works
   * — the defect was in the LANDING PATH, which decided which screen to draw and then drew a
   * different one. Reverting the fix left this file entirely green until the boot sequence itself
   * was the thing under test.
   */
  await vm.runInContext("start()", ctx);
  /**
   * `switchTab` renders the queue-backed tabs from a promise. Drain the microtask queue before
   * reading the stage, or the assertion measures a screen that has not been drawn yet — which would
   * make this test fail for the RIGHT roles and pass for the broken one.
   */
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return {
    html: ((stage.innerHTML as string) || (stage.replacedCount ? "[template]" : "")) as string,
    landing,
  };
}

test("a dentist lands on a screen that renders, not a blank page", async () => {
  const { html, landing } = await bootAs("dentist", [
    "verifications.read",
    "claims.read",
    "denials.read",
    "appeals.read",
    "appeals.write",
  ]);
  assert.notEqual(landing, "today", "a dentist holds no queue.read, so Today is not their landing tab");
  assert.ok(html.length > 0, `the dentist landed on "${landing}" and the stage was left empty`);
});

test("every role lands on a screen that renders something", async () => {
  /**
   * Generalised deliberately. The dentist was the role that exposed this, but the defect was in the
   * landing path, not in the dentist — any future role without `queue.read` would have met the same
   * blank page.
   */
  const sets: [Role, string[]][] = [
    ["owner", ["queue.read", "verifications.read", "claims.read", "remittances.read", "denials.read", "patients.read"]],
    ["front_desk", ["queue.read", "verifications.read", "patients.read"]],
    ["dentist", ["verifications.read", "claims.read", "denials.read"]],
    ["biller", ["queue.read", "claims.read", "remittances.read", "denials.read", "patients.read"]],
  ];
  for (const [role, perms] of sets) {
    const { html, landing } = await bootAs(role, perms);
    assert.ok(html.length > 0, `${role} landed on "${landing}" with an empty stage`);
  }
});

// ── The claim money chain ───────────────────────────────────────────────────────────────────────

/**
 * A claim's money chain partitions the CHARGE. Every row must be a destination of that charge, and
 * the row that used to close it was not one.
 *
 * `outstanding` is `expected − paid`: a shortfall against the ESTIMATE, which is a different
 * question and has its own panel. Adding it to the partition double-counted. On the coordination-of-
 * benefits claim — where a biller most needs the guidance — that produced $1,425.01 of destinations
 * against $1,425.00 charged and the chain said "$0.01 is unexplained. Do not bill from this screen
 * until it is", about a penny the same screen labelled "inside the rounding band — not worth
 * chasing".
 */
function chainOf(view: unknown): string {
  const stage2 = el();
  const doc = {
    getElementById: (id: string) => (id === "stage" ? stage2 : el()),
    querySelector: () => el(),
    querySelectorAll: () => [],
    createElement: () => el(),
    addEventListener() {},
    body: el(),
    documentElement: el(),
    title: "",
  };
  const c = vm.createContext({
    document: doc,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { pathname: "/" } },
    location: { pathname: "/" },
    navigator: { userAgent: "test" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    requestAnimationFrame: (f: () => void) => f(),
    Intl, Date, Math, JSON, Number, String, Object, Array, Promise, URL, URLSearchParams,
    __view: view,
  });
  vm.runInContext(CLIENT, c, { filename: "app.js" });
  return vm.runInContext("claimMoneyChain(__view)", c) as string;
}

/** Kira Demo's figures exactly: primary paid, contractual taken, the rest with a second plan. */
const COB_CLAIM = {
  claim: { totalFee: 142500, expectedInsurancePays: 80000, payments: [{ paidAmount: 79999 }] },
  paidAmount: 79999,
  contractualAdjustment: 14250,
  coordinationPending: 48251,
  patientResponsibility: 0,
  patientShareIsPending: true,
  outstanding: 1,
  variance: { material: false },
};

test("a coordination-of-benefits claim's chain balances, and does not tell a biller to stop", () => {
  const html = chainOf(COB_CLAIM);
  assert.match(html, /Every dollar of the \$1,425\.00 charged is accounted for/);
  assert.ok(!/unexplained/.test(html), "a penny of estimate shortfall is not an unaccounted charge");
  assert.ok(!/Do not bill from this screen/.test(html), "and must not produce a blocking instruction");
});

test("the estimate shortfall is not a row in a partition of the charge", () => {
  const html = chainOf(COB_CLAIM);
  assert.ok(!/Still owed by this payer/.test(html), "that row answered a different question");
});

test("a charge a payer has genuinely left unassigned IS reported", () => {
  /**
   * The row still earns its place: when an advice accounts for less than the charge, the remainder
   * has no destination and a biller must not bill from the screen until it does.
   */
  const partial = {
    claim: { totalFee: 100000, expectedInsurancePays: 60000, payments: [{ paidAmount: 30000 }] },
    paidAmount: 30000,
    contractualAdjustment: 0,
    coordinationPending: 0,
    patientResponsibility: 0,
    patientShareIsPending: false,
    outstanding: 30000,
    variance: { material: true },
  };
  const html = chainOf(partial);
  assert.match(html, /Not yet accounted for/);
  assert.match(html, /\$700\.00/, "the unassigned remainder of the charge, not the estimate shortfall");
});
