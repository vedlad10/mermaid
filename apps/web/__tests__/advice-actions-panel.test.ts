/**
 * The advice drill's action panel (`public/coordination.js`): what a person is OFFERED.
 *
 * The server decides whether release is possible; this proves the screen never contradicts it. In
 * particular: no "Release & post" is ever drawn for a duplicate, a test file, or an advice whose
 * coverage question is unanswered — the exact place free text used to clear a coordination hold —
 * and the coverage form sends a structured answer, not a sentence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

type El = {
  tagName: string;
  id: string;
  type: string;
  value: string;
  hidden: boolean;
  disabled: boolean;
  placeholder: string;
  className: string;
  textContent: string;
  children: El[];
  handlers: Record<string, () => unknown>;
  append: (...k: unknown[]) => void;
  prepend: (...k: unknown[]) => void;
  replaceChildren: (...k: unknown[]) => void;
  addEventListener: (t: string, fn: () => unknown) => void;
};

function makeEl(tag: string): El {
  const el: El = {
    tagName: tag.toUpperCase(),
    id: "",
    type: "",
    value: "",
    hidden: false,
    disabled: false,
    placeholder: "",
    className: "",
    textContent: "",
    children: [],
    handlers: {},
    append: (...k) => { for (const c of k) if (c && typeof c === "object") el.children.push(c as El); },
    prepend: (...k) => { for (const c of k) if (c && typeof c === "object") el.children.unshift(c as El); },
    replaceChildren: (...k) => { el.children = []; el.append(...k); },
    addEventListener: (t, fn) => { el.handlers[t] = fn; },
  };
  return el;
}
(globalThis as Record<string, unknown>).document = { createElement: makeEl };

const { renderAdviceActions } = await import("../public/coordination.js");

const all = (el: El | null): El[] => (el ? [el, ...el.children.flatMap(all)] : []);
const text = (el: El | null) => all(el).map((e) => e.textContent).join(" | ");
const button = (el: El | null, label: RegExp) => all(el).find((e) => e.tagName === "BUTTON" && label.test(e.textContent));
const byId = (el: El | null, id: string) => all(el).find((e) => e.id === id)!;

const advice = (over: Record<string, unknown> = {}) => ({
  id: "rem-1",
  status: "held",
  payerName: "Cigna Dental",
  postings: [{ patientControlNumber: "MRM-1", chargedAmount: 142500, paidAmount: 79999, patientResponsibility: 0 }],
  ...over,
});

const caseItem = (over: Record<string, unknown> = {}) => ({
  caseId: "case-1",
  patientControlNumber: "MRM-1",
  primaryPayerName: "Cigna Dental",
  coverageStatus: "unconfirmed",
  workStatus: "awaiting-coverage",
  assignedCents: 48251,
  forwarded: true,
  crossoverCarrier: null,
  eligibilityOtherPayers: [],
  blockedReason: "Nobody has confirmed whether the patient has another plan.",
  deadline: { deadline: "2027-08-19", daysRemaining: 330, estimateNote: "That window is an estimate, not this payer's stated terms." },
  case: { request: null, confirmation: null },
  ...over,
});

function apiStub(item = caseItem()) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const api = async (method: string, path: string, body?: Record<string, unknown>) => {
    calls.push({ method, path, body });
    if (path === "/api/v1/auth/session") return { user: { email: "biller@clinic" } };
    if (path.startsWith("/api/v1/coordination-cases/") && method === "GET") return item;
    return {};
  };
  return { api, calls };
}

const RELEASE = /Release & post/;

test("a duplicate offers only its reject — never release", async () => {
  const { api } = apiStub();
  const panel = await renderAdviceActions(
    { remittance: advice(), releaseBlocked: { code: "duplicate-adjudication", message: "Already posted from EFT227219236.", rejectAs: "duplicate" }, canPost: false, coordination: [] },
    { api, reload: async () => {} }
  );
  assert.match(text(panel), /Duplicate — cannot be released/);
  assert.ok(button(panel, /Reject as duplicate/));
  assert.equal(button(panel, RELEASE), undefined);
});

test("an unanswered coverage question shows the evidence and the form — and no release", async () => {
  const { api } = apiStub();
  const panel = await renderAdviceActions(
    { remittance: advice(), releaseBlocked: null, canPost: false, coordination: [{ caseId: "case-1", coverageStatus: "unconfirmed" }] },
    { api, reload: async () => {} }
  );
  const t = text(panel);
  assert.match(t, /Coverage needs confirming/);
  assert.match(t, /Cigna Dental said it forwarded claim MRM-1 to another plan/);
  assert.match(t, /No other plan \(the 835 names nobody\)/, "what the payer did NOT say is stated, not left blank");
  assert.match(t, /Missing before this can be released: whether the patient has another plan, where you learned it, and the date/);
  assert.match(t, /Assigned to another plan \| \$482\.51 — not collected/);
  assert.ok(button(panel, /Record the answer/));
  assert.ok(button(panel, /Record the request/));
  assert.equal(button(panel, RELEASE), undefined, "a reason is not an answer");
});

test("the coverage form sends a structured answer, attributed", async () => {
  const { api, calls } = apiStub();
  let reloaded = 0;
  const panel = await renderAdviceActions(
    { remittance: advice(), releaseBlocked: null, canPost: false, coordination: [{ caseId: "case-1", coverageStatus: "unconfirmed" }] },
    { api, reload: async () => { reloaded++; } }
  );
  byId(panel, "cob-outcome-case-1").value = "other-coverage";
  byId(panel, "cob-source-case-1").value = "patient";
  byId(panel, "cob-date-case-1").value = "2026-09-24";
  byId(panel, "cob-payer-case-1").value = "Delta Dental";
  byId(panel, "cob-member-case-1").value = "DD-778";
  await button(panel, /Record the answer/)!.handlers.click!();

  const sent = calls.find((c) => c.path.endsWith("/confirm-coverage"))!;
  assert.equal(sent.method, "POST");
  assert.deepEqual(
    { ...sent.body, actor: undefined, releasedBy: undefined, rejectedBy: undefined },
    {
      actor: undefined,
      releasedBy: undefined,
      rejectedBy: undefined,
      outcome: "other-coverage",
      source: "patient",
      sourceNote: "",
      confirmedOn: "2026-09-24",
      secondary: { payerName: "Delta Dental", memberId: "DD-778" },
    }
  );
  assert.equal(sent.body!.actor, "biller@clinic");
  assert.equal(reloaded, 1, "the drill is redrawn from the server's answer");
});

test("an ordinary hold offers release and reject", async () => {
  const { api } = apiStub();
  const panel = await renderAdviceActions(
    { remittance: advice(), releaseBlocked: null, canPost: true, coordination: [] },
    { api, reload: async () => {} }
  );
  assert.ok(button(panel, RELEASE));
  assert.ok(button(panel, /Reject & never post/));
});

test("posted money for another plan shows the secondary claim and its next step", async () => {
  const { api } = apiStub(
    caseItem({
      coverageStatus: "other-coverage",
      workStatus: "ready-to-file",
      blockedReason: null,
      case: { request: null, confirmation: { outcome: "other-coverage", source: "patient", confirmedOn: "2026-09-24", confirmedBy: "biller@clinic", secondary: { payerName: "Delta Dental" } } },
    })
  );
  const panel = await renderAdviceActions(
    { remittance: advice({ status: "posted" }), releaseBlocked: null, canPost: false, coordination: [{ caseId: "case-1", coverageStatus: "other-coverage" }] },
    { api, reload: async () => {} }
  );
  const t = text(panel);
  assert.match(t, /Other coverage confirmed — Delta Dental/);
  assert.match(t, /Secondary claim — Ready to file with the other plan/);
  assert.match(t, /File by 2027-08-19 \(330 days\)\. That window is an estimate/);
  assert.ok(button(panel, /Record the secondary filing/));
  assert.equal(button(panel, RELEASE), undefined, "a posted advice has nothing to release");
});

test("a posted advice with nothing to decide draws nothing", async () => {
  const { api } = apiStub();
  const panel = await renderAdviceActions(
    { remittance: advice({ status: "posted" }), releaseBlocked: null, canPost: false, coordination: [] },
    { api, reload: async () => {} }
  );
  assert.equal(panel, null);
});
