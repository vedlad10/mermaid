// Mermaid clinic demo — client. Vanilla ES module, no framework, no build step.
// Talks to the /api/v1 contract; the server runs the same deterministic module service.

/*
 * The chart primitives. Namespaced rather than destructured because every call site should read as
 * "this is a chart" — `Cx.trendLine(...)` beside `usd(...)` says which of the two is drawing.
 */
import * as Cx from "./charts.js";
import { createStore } from "./store.js";
import { createDrill } from "./spine.js";
import { mountMoney } from "./money.js";
import { mountClaims } from "./claims.js";
import { mountRecover } from "./recover.js";
import { mountVerify } from "./verify.js";
import { mountToday } from "./today.js";
import { mountOps } from "./ops.js";
import { mountPatients } from "./patients.js";
import { mountInsights } from "./insights.js";
import { presentingToggle } from "./privacy.js";
import { createPalette } from "./palette.js";

/*
 * One store for the whole application. Selection and filter are the same state, so a chart's
 * highlighted point and a table's filter cannot describe different populations.
 */
const ui = createStore();

/**
 * The screen built on the interaction foundation that is mounted right now, or null while a legacy
 * tab is showing.
 *
 * ── WHY THERE IS EXACTLY ONE OF THESE ────────────────────────────────────────────────────────────
 * This was `moneyScreen`, and naming it after one screen was fine while one screen existed. It is
 * now the seam the drill panel resolves through, and there must be exactly one: two live screens
 * would mean two answers to "what is on top of the drill stack", and the panel would render
 * whichever happened to be asked. Mounting always tears down the previous one first, so the
 * invariant is maintained by construction rather than by remembering.
 */
let screen = null;

/**
 * Tear down whatever is mounted and return the shared view state to a clean slate.
 *
 * The reset is not tidiness. A drill entry outliving its screen is an entry nobody can resolve — the
 * panel would ask a screen that no longer exists and render an empty drawer over the new tab — and a
 * selection or metric carried across belongs to a picture the next screen does not draw. See
 * `store.reset` for why the timeframe is the one thing that survives.
 */
function unmountScreen() {
  if (screen) {
    screen.destroy();
    screen = null;
  }
  ui.reset();
}

/*
 * Mounted once, for the whole application. The panel resolves whatever is on top of the drill stack
 * by asking the screen that pushed it, which is what keeps the drill generic while the content stays
 * specific to the entity.
 */
/*
 * Presentation mode masks patient names product-wide, and every screen redraws through the store —
 * one bump rather than a redraw hook each screen has to remember to expose. See `store.bump`.
 */
document.addEventListener("mermaid:presenting", () => ui.bump("presenting"));

/*
 * The toggle lives in the top bar — §8.6 puts it in the context bar, and the reason is practical:
 * a mask you can only turn OFF from the one screen you turned it on from is a trap.
 */
document.getElementById("presenting-slot")?.append(presentingToggle());

/*
 * The command palette (§5.7). Mounted once, at the shell, because it reaches every screen — and it
 * NAVIGATES rather than acts: "appeal" goes to Recover, it does not draft an appeal. A palette that
 * performed money or compliance actions from a text box would be a way around every human gate in
 * this product, and the gates are the product.
 */
const palette = createPalette({
  api,
  go: (tab) => switchTab(tab),
  openDrill: (entry) => ui.pushDrill(entry),
});
document.body.append(palette.el);

const drillHost = document.getElementById("drill");
if (drillHost) {
  createDrill(drillHost, {
    store: ui,
    render: (entry, stack) => (screen ? screen.renderDrill(entry, stack) : null),
  });
}

const stage = document.getElementById("stage");
const queueList = document.getElementById("queue-list");
const queueCount = document.getElementById("queue-count");
const queueTitle = document.getElementById("queue-title");
const queueHint = document.getElementById("queue-hint");
const queueActions = document.getElementById("queue-actions");
const queueSources = document.getElementById("queue-sources");

// `tab` is which worklist the sidebar shows: today (everything, ranked), verifications (front half),
// claims (billing), money (remittances + the recovery queue), recovery (denials), or insights
// (the practice report).
const state = {
  cdt: [],
  selectedId: null,
  tab: "today",
  submittedBy: "office.manager@clinic",
  /** Reporting window for the Insights tab, in days back from now. */
  reportDays: 30,
  /** Free-text search on the Patients tab. Empty = the A/R worklist; set = the patient master. */
  patientQuery: "",
  /** Last loaded Today queue / practice report / ledger, so the stage re-renders without refetching. */
  today: null,
  report: null,
  ledger: null,
  ops: null,
  /** The recorded Stedi integration report, and which scenario row is expanded. */
  testlab: null,
  testlabOpen: null,
  // Session, when this deployment is Postgres-backed. `persistent` false = the DB-free demo, which
  // has no login at all.
  persistent: false,
  csrf: null,
  user: null,
  /** The server's automatic-logoff window in ms, or null before it has said (the demo has none). */
  idleTimeoutMs: null,
};

// ── Automatic logoff: the browser's half ──────────────────────────────────
/*
 * HIPAA's automatic logoff (45 CFR 164.312(a)(2)(iii)) is about a screen nobody is at. The server
 * ends a session left alone for SESSION_IDLE_MINUTES, but it can only judge "alone" from what the
 * browser tells it: Today and Ops poll every minute, and a poll is not a person. So every request
 * reports how long it has been since a real key or pointer input, and the server records activity
 * at that moment rather than at the poll.
 *
 * And the browser locks the screen on its OWN clock (`checkIdle`). Polling stops while a drill
 * panel is open, so a patient left open on a drill panel would otherwise stay on screen with no
 * request ever arriving to discover the session had ended.
 */
let lastInputAt = Date.now();
for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
  document.addEventListener(type, () => { lastInputAt = Date.now(); }, { capture: true, passive: true });
}
const idleHeaders = () => ({ "x-mermaid-idle-ms": String(Math.max(0, Date.now() - lastInputAt)) });

// ── API + formatting ──────────────────────────────────────────────────────
async function api(method, path, body) {
  const headers = idleHeaders();
  if (body) headers["content-type"] = "application/json";
  // The double-submit CSRF twin. The cookie rides along automatically; this header is the half the
  // browser will NOT attach cross-site, which is what makes it proof of same-origin.
  if (state.csrf) headers["x-csrf-token"] = state.csrf;

  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.persistent) {
    // The session expired or was revoked; fall back to the gate rather than showing broken screens.
    showLogin();
    throw new Error("Your session has ended. Please sign in again.");
  }
  if (!res.ok) {
    /*
     * The STATUS travels with the error, because a screen has to tell "you may not see this" from
     * "this is broken" and they are the same sentence without it. §7.6 requires restricted content
     * to show what exists and why it is restricted; a screen that only had the message would render
     * a permission boundary as an outage, and someone would go looking for a bug.
     *
     * The server's own wording is kept as the message: the guard already names the role the caller
     * has, the permission they lack, and who can grant it — better than anything the client could
     * reconstruct.
     */
    const err = new Error(data?.error?.message || `Request failed (${res.status}).`);
    err.status = res.status;
    err.code = data?.error?.code ?? null;
    throw err;
  }
  return data;
}

/**
 * POST a file's bytes exactly as the payer produced them.
 *
 * ── WHY THIS IS NOT `api()` WITH A STRING (audit A-3) ─────────────────────────────────────────
 * `api()` JSON-encodes its body, and JSON-wrapping an EDI file means escaping every quote and every
 * newline in it — which roughly doubles a payload that is already the largest thing this API
 * accepts, to say nothing of what a stray `~` does inside a JSON string. The remittance endpoint
 * takes raw bytes for exactly this reason and the client had no way to send them.
 *
 * Everything else is identical to `api()` on purpose: the same CSRF header, the same 401 handling,
 * the same error shape. An upload path that quietly diverged on session expiry would show a broken
 * screen instead of the sign-in gate, at the moment somebody is holding a payment file.
 */
async function apiRaw(path, text) {
  const headers = { ...idleHeaders(), "content-type": "application/edi-x12" };
  if (state.csrf) headers["x-csrf-token"] = state.csrf;

  const res = await fetch(path, { method: "POST", headers, body: text });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.persistent) {
    showLogin();
    throw new Error("Your session has ended. Please sign in again.");
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Upload failed (${res.status}).`);
    err.status = res.status;
    err.code = data?.error?.code ?? null;
    throw err;
  }
  return data;
}

// Display-only: integer cents → "$1,234.56". Formatting, not domain arithmetic (money stays cents server-side).
const usd = (cents) =>
  cents == null ? "—" : (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const pct = (n) => `${Math.round(n * 100)}%`;

/** "1 claim" / "2 claims" — the `(s)` placeholder shipped to a screen is a small, constant tell. */
const plural = (n, word, suffix = "s") => `${n} ${word}${n === 1 ? "" : suffix}`;

/** A blank value renders as an em dash. Without it "DOB <b></b>" reads as if the NEXT field were the DOB. */
const orDash = (v) => (v === null || v === undefined || String(v).trim() === "" ? "—" : v);

/**
 * Say something to the person, in the page, where they are looking.
 *
 * ── WHY NOT `alert()` ─────────────────────────────────────────────────────────────────────────
 * There were seventeen of them, and several carried money errors — a payer's refusal to release a
 * remittance, a claim that would not file. A native alert is the least trustworthy surface a
 * product can put a financial message on: it is unstyled, it blocks the page, it cannot be re-read
 * once dismissed, it cannot be copied into a note, and it arrives detached from the thing it is
 * about. On a screen whose whole job is being believable about money, that is the wrong instrument.
 *
 * The reference this was measured against treats an error as a high-trust moment — the point where
 * an interface either earns confidence or loses it. So a message now appears in the page, in the
 * product's own type and colour, next to the control that caused it, and stays until it is either
 * replaced or the person dismisses it.
 *
 * ── WHY IT IS ANCHORED RATHER THAN GLOBAL ─────────────────────────────────────────────────────
 * A toast in the corner makes a person look away from the button they just pressed to find out what
 * happened to it. Anchoring the notice to the action keeps cause and effect in one glance, which is
 * the same reason the money chain sits under the figures it explains.
 */
function notify(message, tone = "bad", anchor = null) {
  const host = anchor?.closest(".review, .form, .panel") ?? stage.querySelector(".panel") ?? stage;
  if (!host) return;

  /** One notice per host: a stack of stale errors is its own confusion. */
  host.querySelector(":scope > .notice")?.remove();

  const el = document.createElement("div");
  el.className = `notice notice--${tone}`;
  /**
   * `alert` is announced by a screen reader for free; an inline element is not unless it says so.
   * `assertive` because this is the result of something the person just did, and a polite live
   * region would wait for a gap that may not come.
   */
  el.setAttribute("role", "alert");
  el.setAttribute("aria-live", "assertive");

  const text = document.createElement("span");
  text.className = "notice__text";
  text.textContent = message;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "notice__x";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => el.remove());

  el.append(text, close);
  host.prepend(el);
  /**
   * Scrolled into view only when it is off screen. A message about money that renders below the
   * fold has not been delivered — and one that yanks the page when it was already visible is
   * gratuitous.
   */
  const box = el.getBoundingClientRect();
  if (box.top < 0 || box.bottom > (window.innerHeight || 0)) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  return el;
}

/**
 * Run a money-moving action with the button held down for the duration.
 *
 * ── WHY EVERY ONE OF THESE NEEDS IT ───────────────────────────────────────────────────────────
 * `#release-remit` posts a held payer advice, and it was the one money action in the product that
 * did NOT disable itself while its request was in flight — every other one does. The server is safe
 * either way: `release()` reads through `lockById`, which is `SELECT … FOR UPDATE`, and returns the
 * existing view if the advice is already posted, so a second click blocks on the row lock and then
 * finds the work done.
 *
 * The defect is therefore not a double-post; it is that a button which does nothing visible for a
 * second invites a second click, and a person who clicks twice on "post $1,599.98" spends the next
 * minute wondering whether they just did it twice. On this screen that doubt is the damage.
 */
async function withBusy(button, work) {
  if (!button) return work();
  const label = button.textContent;
  button.disabled = true;
  button.classList.add("btn--busy");
  button.textContent = "Working…";
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.classList.remove("btn--busy");
    button.textContent = label;
  }
}

/**
 * The stage when nothing is selected.
 *
 * ── WHY THIS IS TWO STATES AND NOT ONE SENTENCE ─────────────────────────────────
 * Both Claims and Recover rendered "Select a claim/denial from the worklist." unconditionally. On
 * Recover with an empty practice that produced two panels side by side contradicting each other:
 * the worklist said "Nothing to pursue with a payer. Every shortfall so far is accounted for", and
 * the stage beside it said "Select a denial from the worklist" — instructing a person to choose
 * from a list that had just told them it held nothing.
 *
 * The count comes from the rendered worklist rather than from state, because what matters is
 * whether there is anything on screen to select. If the list is empty the stage says so in its own
 * words; if it is not, it says what selecting will get you.
 */
function stageEmpty(noun, whenEmpty) {
  const waiting = document.querySelectorAll(".queue__list .qitem").length;
  const lede = waiting > 0
    ? `Select ${noun} from the worklist to see the money behind it.`
    : whenEmpty;
  const hint = waiting > 0 ? plural(waiting, "item") + " waiting" : "";
  return `<div class="panel stage-empty">
    <p class="stage-empty__lede">${esc(lede)}</p>
    ${hint ? `<p class="stage-empty__hint">${esc(hint)}</p>` : ""}
  </div>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── Data provenance ───────────────────────────────────────────────────────
//
// Where a verification's benefits came from. Rendered on the queue row AND on the detail panel,
// because the queue is where the misreading happens: a column of names with payers beside them
// reads as a column of verified patients, and nobody opens a record to discover it was demo data.
//
// The server decides the label — this only draws it. Deriving "is this real?" in the browser would
// put a second, divergent opinion about provenance in the one place least able to check it.
function srcBadge(source, compact = false) {
  if (!source) return "";
  // `shortLabel` is derived from the same evidence as `label`, never clipped from it — the two
  // labels that share a prefix are exactly the two that must not be confused.
  const text = compact ? (source.shortLabel ?? source.label) : source.label;
  return `<span class="src src--${esc(source.kind)}" title="${esc(source.label)}">${esc(text)}</span>`;
}

/** The queue-level answer: of the verifications on this board, how many is a payer standing behind? */
function srcBanner(sources) {
  const s = sources ?? {};
  const total = (s.live ?? 0) + (s.test ?? 0) + (s.mock ?? 0) + (s.none ?? 0);
  if (total === 0) return "";
  /*
   * Silence means "every one of these came from a payer". Anything else is worth a line.
   */
  const notLive = (s.test ?? 0) + (s.mock ?? 0) + (s.none ?? 0);
  if (notLive === 0) return "";

  const parts = [];
  if (s.test) parts.push(`<b>${s.test}</b> real clearinghouse TEST`);
  if (s.mock) parts.push(`<b>${s.mock}</b> seeded demo (mock connector)`);
  if (s.none) parts.push(`<b>${s.none}</b> with no benefits returned`);
  return `<div class="src-banner">
    <span>${notLive} of ${total} not from a live payer:</span>
    <span>${parts.join(" · ")}.</span>
  </div>`;
}

/**
 * The adjudication badge — what happened to the claim, in the words a biller acts on.
 *
 * The badge here used to show `variance.outcome`, which is the arithmetic: did the number match the
 * estimate? That routinely disagrees with the decision, and the disagreement is the whole reason the
 * decision exists as its own field. A claim adjudicated entirely to an unmet deductible has an
 * outcome of "denied" and was paid perfectly; a claim $72.01 under its estimate may owe the practice
 * nothing at all.
 *
 * The screen shows the decision, because the decision is the one with a next action. The estimate
 * comparison stays in the sentence directly beneath it, where it is detail rather than a verdict.
 */
const ADJUDICATION_LABEL = {
  paid_correctly: "paid correctly",
  patient_responsibility: "patient's balance",
  contractual: "contractual write-off",
  underpaid: "underpaid",
  denied: "denied",
  overpaid: "overpaid",
};
const ADJUDICATION_TONE = {
  paid_correctly: "good",
  contractual: "good",
  patient_responsibility: "",
  underpaid: "warn",
  denied: "warn",
  overpaid: "warn",
};
function adjudicationBadge(variance) {
  const key = variance?.adjudication;
  if (!key) return "";
  const tone = ADJUDICATION_TONE[key] ?? "";
  const label = ADJUDICATION_LABEL[key] ?? key.replace(/_/g, " ");
  return `<span class="tag${tone ? ` tag--${tone}` : ""}">${esc(label)}</span>`;
}

// ── Queue ─────────────────────────────────────────────────────────────────
/**
 * One worklist row.
 *
 * Three bands, in the order a person reads them: who, what kind of thing it is, then the sentence
 * and the money. `badges` is separate from `subtitle` for a reason that only appeared once real
 * labels were in it — badges and prose were being concatenated into one flex line that also had to
 * hold a right-aligned amount, so "DEMO DATA — MOCK CONNECTOR" pushed the payer name into a wrap
 * and the amount landed on top of it. Giving the badges their own band means a long label costs a
 * line, never a collision.
 */
function queueItem(it, className, subtitle, amount, onOpen, badges = "") {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.setAttribute("aria-current", String(it.id === state.selectedId));
  btn.innerHTML = `
    <span class="qitem__top">
      <span class="qitem__name">${esc(it.patientName)}</span>
      <span class="qitem__prio">${esc(it.badge ?? `P${it.priority}`)}</span>
    </span>
    ${badges.trim() ? `<span class="qitem__badges">${badges}</span>` : ""}
    <span class="qitem__meta">
      <span class="qitem__payer">${subtitle}</span>
      ${amount ? `<span class="qitem__pay">${amount}</span>` : ""}
    </span>`;
  btn.addEventListener("click", onOpen);
  li.appendChild(btn);
  queueList.appendChild(li);
}

/**
 * What the worklist looks like while it is being fetched.
 *
 * Skeleton rows rather than a spinner, and rows the same height as the real ones, so the column
 * does not jump when the data lands. The previous behaviour was an empty box for the length of the
 * request — which on a cold Postgres connection reads as "there is no work today".
 */
function queueSkeleton(rows = 5) {
  queueList.innerHTML = Array.from(
    { length: rows },
    () => `<li aria-hidden="true"><div class="skeleton skeleton--row"></div></li>`
  ).join("");
  queueCount.textContent = "—";
}

async function loadQueue() {
  queueActions.innerHTML = "";
  // Cleared here, not in each loader: a provenance banner left behind by another tab would describe
  // a list that is no longer on screen, which is the exact failure this feature exists to prevent.
  queueSources.innerHTML = "";
  queueSkeleton();
  try {
    if (state.tab === "today") return await loadTodayQueue();
    if (state.tab === "claims") return await loadClaimsQueue();
    if (state.tab === "money") return await loadMoneyQueue();
    if (state.tab === "recovery") return await loadRecoveryQueue();
    if (state.tab === "patients") return await loadPatientQueue();
    if (state.tab === "insights") return await loadInsightsQueue();
    if (state.tab === "ops") return await loadOpsQueue();
    if (state.tab === "testlab") return await loadTestLabQueue();
    return await loadVerificationQueue();
  } catch (err) {
    /**
     * A failed worklist has to say so. Left alone, the skeleton rows above shimmer forever and the
     * column reads as "still loading" for a request that finished — the one loading state that is
     * worse than none, because nobody retries something that looks like it is still working.
     */
    queueCount.textContent = "—";
    queueList.innerHTML = `<li class="empty">Could not load this worklist.
      <span class="empty__hint">${esc(err.message)}</span>
      <span class="empty__hint"><button type="button" class="linkish" id="queue-retry">Try again</button></span></li>`;
    queueList.querySelector("#queue-retry")?.addEventListener("click", () => { void loadQueue().catch(() => {}); });
    throw err;
  }
}

async function loadVerificationQueue() {
  const { items } = await api("GET", "/api/v1/verifications");
  queueTitle.textContent = "Verify";
  queueHint.textContent = "Ranked by what needs a person first.";
  queueCount.textContent = `${items.length}`;
  queueList.innerHTML = "";
  if (items.length === 0) {
    queueList.innerHTML = `<li class="empty">No verifications yet.</li>`;
    return;
  }
  const sources = { live: 0, test: 0, mock: 0, none: 0 };
  for (const it of items) if (it.provenance) sources[it.provenance.kind] += 1;
  queueSources.innerHTML = srcBanner(sources);

  for (const it of items) {
    queueItem(
      it,
      `qitem qitem--${it.status}`,
      esc(it.payerName || "Unknown payer"),
      usd(it.patientPays),
      () => openDetail(it.id),
      srcBadge(it.provenance, true)
    );
  }
}

async function loadClaimsQueue() {
  const { items, readyToSubmit, atRisk } = await api("GET", "/api/v1/claims");
  /* Kept so the stage can draw its overview from the SAME response the rail was built from — a
     second fetch could disagree with the list beside it, which is the class of bug this codebase
     treats as a defect rather than a race. */
  state.claims = { items, readyToSubmit, atRisk };
  queueTitle.textContent = "Claims";
  queueHint.textContent =
    items.length === 0
      ? "Claims appear here automatically once a verification settles."
      : `${readyToSubmit} ready to submit · ${atRisk} at filing risk.`;
  queueCount.textContent = `${items.length}`;
  queueList.innerHTML = "";
  if (items.length === 0) {
    queueList.innerHTML = `<li class="empty">No claims yet. Verify a patient first.</li>`;
    return;
  }
  for (const it of items) {
    // Once a payer has ruled, outstanding money is the useful signal; before that, the deadline is.
    // The countdown is Mermaid's estimate of the payer's window, so the row says so on hover rather
    // than presenting a computed number as the payer's own term.
    // B-1: a payer-published window carries a note too (its source and the contract caveat).
    const filingTitle = it.filingDeadlineNote ? ` title="${esc(it.filingDeadlineNote)}"` : "";
    /**
     * What the PAYER withheld outranks what the estimate missed.
     *
     * `outstanding` is estimate-minus-paid. On a claim whose estimate already assumed a procedure
     * would not be covered, that number is small precisely when the payer has denied the most: a
     * crown denied for $1,125.00 under CO-197 showed "$153.51 owed" here, and the larger figure
     * lived only on the Recover screen. Whichever number a biller acts on, it must be the one with
     * the money behind it — so an open denial takes the badge, and the title carries the reason.
     */
    const openRecovery = it.recovery?.openAmount ?? 0;
    const denialTitle = it.recovery
      ? ` title="${esc(it.recovery.reasons.map((r) => `${r.carcCode} ${r.carcDescription}`).join(" · "))}"`
      : "";
    /**
     * The estimate-accuracy chip (F-7), shown only when the difference clears the materiality band
     * (F-6) — a chip on every row is a chip nobody reads, which is the defect F-6 existed to fix.
     *
     * Suppressed when the row already carries a denied chip. A denial IS the explanation for the
     * variance, and it names the money more precisely than "less than estimated" does; showing both
     * would restate one fact twice and push the payer name into a wrap.
     */
    const varianceChip =
      it.variance?.material && openRecovery === 0
        ? `<span class="risk risk--approaching" title="Estimated ${usd(it.variance.expected)}, payer paid ${usd(it.variance.paid)}${
            it.variance.appealRecovered > 0 ? ` including ${usd(it.variance.appealRecovered)} recovered on appeal` : ""
          }">${it.variance.unexplained < 0 ? "−" : "+"}${usd(Math.abs(it.variance.unexplained))} vs estimate</span>`
        : "";
    const badge =
      openRecovery > 0
        ? `<span class="risk risk--urgent"${denialTitle}>${usd(openRecovery)} denied</span>`
        : it.coordinationPending > 0
          ? `<span class="risk risk--approaching" title="The primary payer assigned this to another plan's adjudication. File the secondary claim — it is not the patient's and not an appeal.">${usd(it.coordinationPending)} with another plan</span>`
          : /*
             * Materiality decides what counts as owed, exactly as it does on the claim screen. A
             * penny short of an $800.00 estimate is rounding, and rendering it as a red "$0.01
             * owed" badge teaches people that red means "a number moved".
             */
            /*
             * Deliberately no badge for ordinary outstanding money. `it.amount` IS `it.outstanding`
             * in this branch, so a badge here restates the figure beside it and nothing more — and
             * a badge that appears on almost every row in a list of claims says only "this is a
             * claim". The filing countdown below is a real second fact and still shows.
             */
            it.outstanding > 0 && it.variance?.material !== false
            ? ""
            : /*
               * A filing countdown only while filing is still the practice's problem. `filingRisk`
               * is arithmetic on a date, so a claim filed and PAID a year ago reported `expired`
               * and this row rendered a red "expired" badge on finished work.
               */
              !it.filingMatters || it.filingRisk === "safe"
              ? ""
              : `<span class="risk risk--${it.filingRisk}"${filingTitle}>${
                  it.filingRisk === "expired" ? "expired" : `${it.daysToFile}d`
                }${it.filingDeadlineEstimated ? "*" : ""}</span>`;
    queueItem(
      it,
      `qitem qitem--claim-${it.status}`,
      esc(it.payerName || "Unknown payer"),
      usd(it.paidAmount > 0 ? it.paidAmount : it.expectedInsurancePays),
      () => openClaim(it.id),
      badge + varianceChip
    );
  }
}

async function loadMoneyQueue() {
  const { items, held, heldTotal, totalRecoverable, totalWithOtherPayers } = await api("GET", "/api/v1/remittances");
  state.remittances = { items, held, heldTotal, totalRecoverable, totalWithOtherPayers };
  queueTitle.textContent = "Money in";
  /**
   * Two different facts, each with its own amount.
   *
   * This read `${held} held · ${usd(totalRecoverable)} still owed to the practice`, welding a COUNT
   * of held advices to a figure about entirely different claims -- what payers still owe on money
   * already posted. While a stale recovery figure kept that number non-zero the sentence looked
   * plausible; once recovered denials stopped counting, it read "2 held · $0.00 still owed to the
   * practice", announcing that nothing is outstanding while $1,599.98 sat unposted in the bank.
   *
   * Held money is money the practice HAS and cannot yet book; recoverable money is money it has not
   * been paid. Naming both, with their own amounts, is the only version that is true.
   */
  const heldPart =
    held > 0
      ? `${held} payment${held === 1 ? "" : "s"} held (${usd(heldTotal)}) awaiting review`
      : "";
  const owedPart =
    totalRecoverable > 0 ? `${usd(totalRecoverable)} still owed by payers` : "";
  /**
   * Named separately from "still owed by payers" because the instrument differs: this money is
   * collected by filing a claim with a DIFFERENT payer, not by chasing the one that sent this
   * advice. Folding it into the owed figure would send a biller to appeal a claim nobody denied.
   */
  const cobPart =
    totalWithOtherPayers > 0 ? `${usd(totalWithOtherPayers)} awaiting another plan` : "";
  queueHint.textContent =
    items.length === 0
      ? "Payments appear here once a payer remits against a filed claim."
      : [heldPart, owedPart, cobPart].filter(Boolean).join(" · ") ||
        "Everything received is posted and nothing is outstanding with payers.";
  queueCount.textContent = `${items.length}`;

  // Pulling remittances is the demo's stand-in for the nightly clearinghouse poll.
  queueActions.innerHTML = `
    <button type="button" class="btn btn--ghost btn--sm" id="pull-era">Pull remittances</button>
    <button type="button" class="btn btn--ghost btn--sm" id="show-recovery">Underpaid claims</button>`;
  queueActions.querySelector("#pull-era").addEventListener("click", pullRemittances);
  queueActions.querySelector("#show-recovery").addEventListener("click", showRecoveryQueue);

  queueList.innerHTML = "";
  if (items.length === 0) {
    queueList.innerHTML = `<li class="empty">No payments yet. File a claim, then pull remittances.</li>`;
    return;
  }
  for (const it of items) {
    const badge =
      it.status === "held" && it.releaseBlocked
        /* Not money waiting to post — a copy of money already posted, or a test file. Says which. */
        ? `<span class="risk risk--attention">${it.releaseBlocked.rejectAs === "test-file" ? "test file" : "duplicate"}</span>`
        : it.status === "held"
        /* Held cash is waiting on a person, not lost. Amber is the state; red would say it is gone. */
        ? `<span class="risk risk--attention">held</span>`
        : it.totalRecoverable > 0
          ? `<span class="risk risk--attention">${usd(it.totalRecoverable)} recoverable</span>`
          : it.totalWithOtherPayers > 0
            ? `<span class="risk risk--approaching" title="Assigned to another plan's adjudication. File the secondary claim — this is not the patient's and not an appeal.">${usd(it.totalWithOtherPayers)} with other insurance</span>`
            : "";
    queueItem(
      { id: it.id, patientName: it.payerName || "Unknown payer", priority: it.priority },
      `qitem qitem--remit-${it.status}`,
      /*
       * ── THE DATE ON A "MONEY IN" ROW IS WHEN THE MONEY CAME IN ────────────────────────────────
       * This showed `paymentDate` — the date the PAYER stamped on the advice (BPR16). Two advices
       * on staging carry 2026-10-05 and 2026-10-02 while having arrived on 2026-08-30, so the
       * worklist listed payments dated more than a month in the future, directly beside a chart
       * titled "when the cash arrived" plotting them in August. Same rows, two different stories.
       *
       * The payer's own date is not wrong and is not discarded: the advice detail states it as
       * "Paid <date>", where it is labelled and cannot be mistaken for arrival. Here, on a screen
       * called Money in, the date is when the money came in.
       */
      `${esc(String(it.receivedAt ?? it.paymentDate).slice(0, 10))} · ${it.claimCount} claim${it.claimCount === 1 ? "" : "s"}`,
      usd(it.paymentTotal),
      () => openRemittance(it.id),
      badge
    );
  }
}

async function pullRemittances() {
  const btn = queueActions.querySelector("#pull-era");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Pulling…";
  }
  try {
    const { items, note } = await api("POST", "/api/v1/remittances/fetch", {});
    await loadQueue();
    if (items.length > 0) openRemittance(items[0].remittance.id);
    else stage.innerHTML = `<div class="panel stage-empty">${esc(note || "No new remittances.")}</div>`;
  } catch (err) {
    notify(err.message, "bad");
    await loadQueue();
  }
}

async function loadRecoveryQueue() {
  const { items, stats } = await api("GET", "/api/v1/denials?open=1");
  /* `stats` is practice-wide even on the open-only response, which is what lets the board show the
     recovery record when nothing is open. */
  state.recovery = { items, stats };
  queueTitle.textContent = "Recover";
  queueHint.textContent =
    items.length === 0
      ? "Denials appear here once a payer withholds money for a reason worth pursuing."
      : `${usd(stats.openExpectedRecovery)} expected back${stats.urgentCount ? ` · ${stats.urgentCount} closing soon` : ""}.`;
  queueCount.textContent = `${items.length}`;

  queueActions.innerHTML = `<button type="button" class="btn btn--ghost btn--sm" id="show-playbook">Payer playbook</button>`;
  queueActions.querySelector("#show-playbook").addEventListener("click", showPlaybook);

  queueList.innerHTML = "";
  if (items.length === 0) {
    /*
     * One short line, like every other worklist here — "No verifications yet.", "No claims yet."
     * This one carried the full explanation, and the stage beside it carries the same explanation
     * almost word for word, so an empty Recover screen said the same thing three times: the hint
     * under the title, this paragraph, and the stage. Seen at 393px where they stack, it reads as a
     * page repeating itself. The stage keeps the reasoning; this says only that there is nothing.
     */
    queueList.innerHTML = `<li class="empty">No open denials.</li>`;
    return;
  }
  for (const it of items) {
    // Once a payer has ruled, the appeal window is the thing that actually loses money.
    // An assumed deadline counts down exactly like a stated one, so the badge is unchanged — but it
    // carries the reason on hover, and the row is marked, so a biller can tell a payer's own date
    // from Mermaid's default without opening the denial.
    // The note exists for BOTH kinds of window now — a 90-day default and a catalogued typical
    // figure — so the hover is gated on the note, not on the flag. The visible "(assumed)" marker
    // stays with the default alone, because it is the stronger claim of the two.
    const assumedTitle = it.deadlineNote ? ` title="${esc(it.deadlineNote)}"` : "";
    const badge =
      it.appealWindow === "safe"
        ? ""
        : `<span class="risk risk--${it.appealWindow === "closed" ? "expired" : it.appealWindow}"${assumedTitle}>${
            it.appealWindow === "closed" ? "window closed" : `${it.daysToAppeal}d`
          }${it.deadlineEstimated ? " (assumed)" : ""}</span>`;
    queueItem(
      { id: it.id, patientName: it.patientName, priority: it.priority },
      `qitem qitem--denial-${it.disposition}`,
      `${esc(it.carcCode)} · ${esc(it.payerName)}`,
      usd(it.expectedRecovery),
      () => openDenial(it.id),
      badge
    );
  }
}

// ── Today: one ranked worklist across every module ────────────────────────
//
// This is the only screen that shows work from all five contexts at once. The server composes it at
// request time from each module's own list rather than from a materialised queue table, so an item
// disappears the moment the module that owns it stops needing a person — see apps/web/today.ts.

const KIND_LABEL = {
  verification: "Verify",
  claim: "Claim",
  remittance: "Payment",
  denial: "Denial",
  patient: "Balance",
  // An ERA file the clearinghouse offered and we could not take in. Labelled for what it costs, not
  // for what it is: "ERA artifact" means nothing at a front desk, "Lost file" is the actual problem.
  era: "Lost file",
};

/** Open whichever detail screen owns this piece of work, without leaving the Today list. */
function openTodayItem(item) {
  state.selectedId = item.id;
  if (item.kind === "verification") return openDetail(item.id);
  if (item.kind === "claim") return openClaim(item.id);
  if (item.kind === "remittance") return openRemittance(item.id);
  if (item.kind === "patient") return openPatient(item.id);
  // A dead-lettered ERA file has no detail screen to open — there is no parsed document behind it,
  // which is the whole problem with it. The row carries the file id and what to do; clicking it
  // must do NOTHING rather than fall through to `openDenial` and load an unrelated record.
  if (item.kind === "era") return;
  return openDenial(item.id);
}

async function loadTodayQueue() {
  const today = await api("GET", "/api/v1/today");
  state.today = today;

  queueTitle.textContent = "Today";
  queueHint.textContent =
    today.items.length === 0
      ? "Nothing is waiting on a person right now."
      : `${usd(today.atStake)} at stake${today.urgentCount ? ` · ${today.urgentCount} losing money on a deadline` : ""}.`;
  queueCount.textContent = `${today.items.length}`;

  // The timely-filing sweep is normally a scheduled job; a clinic should still be able to ask
  // "is anything about to expire?" on demand, and this is the screen where that question belongs.
  queueActions.innerHTML = `
    <button type="button" class="btn btn--ghost btn--sm" id="today-summary">Overview</button>
    <button type="button" class="btn btn--ghost btn--sm" id="filing-sweep">Check deadlines</button>`;
  /* Returns to the Today screen rather than drawing a second board over whatever is on the stage. */
  queueActions.querySelector("#today-summary").addEventListener("click", () => switchTab("today"));
  queueActions.querySelector("#filing-sweep").addEventListener("click", runFilingSweep);

  queueSources.innerHTML = srcBanner(today.sources);

  queueList.innerHTML = "";
  if (today.items.length === 0) {
    queueList.innerHTML = `<li class="empty">Nothing needs a person. Verify a patient to start the day.</li>`;
    return;
  }
  for (const item of today.items) {
    const badge = item.urgent
      ? `<span class="risk risk--urgent"${item.dueDateNote ? ` title="${esc(item.dueDateNote)}"` : ""}>${
          item.dueDate ? `by ${esc(item.dueDate)}` : "urgent"
        }${item.dueDateEstimated ? " (assumed)" : ""}</span>`
      : "";
    queueItem(
      { id: item.id, patientName: item.title, priority: item.priority },
      `qitem qitem--kind-${item.kind}`,
      esc(item.subtitle),
      usd(item.amount),
      () => openTodayItem(item),
      // The source badge sits FIRST, before the kind: it is the fact that changes how everything
      // after it should be read.
      `${srcBadge(item.source, true)}<span class="kind kind--${item.kind}">${KIND_LABEL[item.kind]}</span>${badge}`
    );
  }
}

async function runFilingSweep() {
  const btn = queueActions.querySelector("#filing-sweep");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Checking…";
  }
  try {
    const { escalated } = await api("POST", "/api/v1/claims/filing-sweep", {});
    await loadQueue();
    stage.innerHTML = `
      <div class="panel">
        <div class="panel__head"><div>
          <h1 class="panel__title">${plural(escalated, "claim")} escalated</h1>
          <div class="detail__id"><span>Every unfiled claim was re-checked against its payer's filing deadline.</span></div>
        </div></div>
        <div class="${escalated ? "reviewed-note reviewed-note--rejected" : "handoff"}">
          ${
            escalated
              ? "Claims now at risk have been raised in the worklist. A missed deadline is the one kind of revenue that can never be recovered."
              : "Nothing is close to expiring. Every open claim still has room on its filing window."
          }
        </div>
      </div>`;
  } catch (err) {
    notify(err.message, "bad");
    await loadQueue();
  }
}

/** The day at a glance — where the work is, before you open any of it. */
/**
 * The Today board.
 *
 * ── WHAT A PRACTICE ACTUALLY OPENS THIS FOR ───────────────────────────────────────────────────
 * Two questions, in this order: where is my money, and what do I have to do about it. The old board
 * answered only the second, and answered it with three equal tiles — at stake, items, on a deadline
 * — which put a count of rows beside a sum of money as though they were the same kind of fact.
 *
 * ── EVERY FIGURE HERE IS READ, NEVER DERIVED ──────────────────────────────────────────────────
 * `today.money` is composed server-side from each module's own aggregate (see apps/web/today.ts).
 * Nothing on this screen is computed from another number on this screen, and nothing is estimated:
 * where a figure is not knowable it is absent rather than zero.
 *
 * ── WHY THE FOUR POSITIONS ARE NOT ADDED UP ───────────────────────────────────────────────────
 * Held cash, money a payer owes, money a patient owes and money at risk are four different
 * questions with four different urgencies and four different people responsible. A total of them
 * would be a number that describes nothing, and showing one would invite someone to quote it.
 */
/**
 * The Today board.
 *
 * ── WHAT A PRACTICE OPENS THIS FOR, IN ORDER ──────────────────────────────────────────────────
 *   1. Is this thing still working?          → the freshness stamp and the activity feed
 *   2. Where is my money?                    → six positions and one flow bar
 *   3. What do I have to do about it?        → the queue
 *
 * ── WHY IT IS THIS QUIET ──────────────────────────────────────────────────────────────────────
 * An earlier version answered the same questions with four bordered cards, each carrying a heading,
 * a rhetorical question, three bars and a footnote. Every one of those elements was true and the
 * board was exhausting: a screen someone opens at 8am and scans for ten seconds cannot ask them to
 * read. What survived is what changes a decision.
 *
 * Four blocks, in reading order, separated by space rather than by borders. One accent colour, spent
 * on the single figure that means "act now". Semantic colour appears only where a state is genuinely
 * abnormal, so that when something is red it is worth looking at.
 *
 * ── EVERY FIGURE IS READ, NEVER DERIVED ───────────────────────────────────────────────────────
 * `today.money` is composed server-side from each module's own aggregate. Nothing here is computed
 * from another number on this screen, and a figure this role may not see arrives as `null` — which
 * renders as an em dash and never as $0.00, because telling a front desk that patients owe nothing
 * is a confident false statement about a practice's money.
 */

/** A short calendar label for a chart axis — "30 Aug". */
function dayLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Whole hours between two instants, or null if either is unreadable. */
function hoursBetween(a, b) {
  const t0 = new Date(a).getTime(), t1 = new Date(b).getTime();
  if (Number.isNaN(t0) || Number.isNaN(t1)) return null;
  return Math.max(0, (t1 - t0) / 3600000);
}

/**
 * How long ago, in words.
 *
 * ── WHY A BOARD MUST SAY THIS ─────────────────────────────────────────────────────────────────
 * A dashboard that says nothing about its own freshness invites a reader to assume it is live when
 * it may be a tab left open since this morning — and every decision made from it is then made
 * against yesterday's money. The instant comes from the server, stamped from the same clock every
 * figure on the board was computed against, so it describes when the MONEY was read rather than
 * when the browser happened to paint.
 */
function sinceMinutes(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60000)) : null;
}

function sinceLong(iso) {
  const mins = sinceMinutes(iso);
  if (mins === null) return "just now";
  if (mins === 0) return "updated just now";
  if (mins < 60) return `updated ${plural(mins, "minute")} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `updated ${plural(hours, "hour")} ago`;
  return `updated ${plural(Math.floor(hours / 24), "day")} ago`;
}

/** The compact form, for a feed where the column has to stay narrow. */
function sinceShort(iso) {
  const mins = sinceMinutes(iso);
  if (mins === null) return "—";
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ── Patients: what they owe, and how old it is ────────────────────────────
//
// The other half of every dollar. A payer that has adjudicated will pay; a patient balance decays
// with age, which is why this screen leads with aging rather than with a total.

const AGING_LABEL = { current: "0–30 days", d31_60: "31–60", d61_90: "61–90", d90_plus: "90+ days" };

/**
 * The Patients sidebar answers two different questions, and the search box is which one.
 *
 *   • Empty  → "who owes us money?" — accounts with a balance, ranked by what it costs to leave
 *              them alone. This is the A/R worklist, and it is what a biller opens the tab for.
 *   • Typing → "where is this person?" — the patient master, every human the practice has seen,
 *              including the ones who were verified and never billed. That is the front desk's
 *              question, and an A/R list cannot answer it: someone with no balance is not on it.
 *
 * They are deliberately one tab rather than two. A member of staff looking for Ada does not know or
 * care whether Ada currently owes anything, and making them pick the right list first is exactly the
 * kind of thing that sends people back to the practice-management system.
 */
async function loadPatientQueue() {
  renderPatientQueueActions();
  return refreshPatientList();
}

/**
 * The list half only — never the actions.
 *
 * Typing calls THIS rather than `loadQueue()`, which clears `queueActions` before dispatching. Going
 * back through it would destroy and rebuild the search input on every debounced keystroke, and the
 * user would lose focus in the middle of a surname.
 */
async function refreshPatientList() {
  const query = (state.patientQuery ?? "").trim();
  if (query) return loadPatientDirectory(query);

  const { items, summary } = await api("GET", "/api/v1/patients?owing=1");
  state.ledger = { items, summary };

  queueTitle.textContent = "Patients";
  queueHint.textContent =
    items.length === 0
      ? "Balances appear here once a payer decides part of a bill is the patient's."
      : `${usd(summary.totalOutstanding)} outstanding${summary.aging.d90_plus > 0 ? ` · ${usd(summary.aging.d90_plus)} over 90 days` : ""}.`;
  queueCount.textContent = `${items.length}`;

  queueList.innerHTML = "";
  if (items.length === 0) {
    queueList.innerHTML = `<li class="empty">
      No patient owes the practice anything.<br />
      <span class="empty__hint">Search above to find anyone the practice has seen.</span>
    </li>`;
    return;
  }
  for (const account of items) {
    const days = account.daysOutstanding ?? 0;
    const badge =
      days > 90
        ? `<span class="risk risk--expired">${days}d</span>`
        : days > 30
          ? `<span class="risk risk--approaching">${days}d</span>`
          : "";
    queueItem(
      { id: account.patientKey, patientName: account.patientName, priority: account.priority },
      "qitem qitem--kind-patient",
      esc(account.patientKey),
      usd(account.balance),
      () => openPatient(account.patientKey),
      `<span class="kind kind--patient">Balance</span>${badge}`
    );
  }
}

/** The patient master — people, not accounts. One row per human, however many plans they hold. */
async function loadPatientDirectory(query) {
  const { items } = await api("GET", `/api/v1/patients/directory?q=${encodeURIComponent(query)}`);

  queueTitle.textContent = "People";
  queueHint.textContent = `${items.length} match${items.length === 1 ? "" : "es"} for “${query}”.`;
  queueCount.textContent = `${items.length}`;

  queueList.innerHTML = "";
  if (items.length === 0) {
    queueList.innerHTML = `<li class="empty">
      Nobody matches “${esc(query)}”.<br />
      <span class="empty__hint">Search by name or chart id. A patient appears here as soon as their
      coverage has been checked — even if it could not be verified.</span>
    </li>`;
    return;
  }
  for (const patient of items) {
    queueItem(
      { id: patient.id, patientName: `${patient.firstName} ${patient.lastName}`, badge: "Record" },
      "qitem qitem--kind-patient",
      `<span class="mono">${esc(patient.chartId)}</span>`,
      esc(patient.dateOfBirth),
      () => openPatientRecord(patient.id),
      `<span class="kind kind--patient">Chart</span>`
    );
  }
}

/** The search box and the A/R shortcut. Built once per tab entry; typing never rebuilds it. */
function renderPatientQueueActions() {
  queueActions.innerHTML = `
    <input class="input input--sm queue__search" id="patient-search" type="search"
           placeholder="Find a person…" aria-label="Search patients by name or chart id"
           value="${esc(state.patientQuery ?? "")}" />
    <button type="button" class="btn btn--ghost btn--sm" id="ar-aging">A/R aging</button>`;

  const input = queueActions.querySelector("#patient-search");

  queueActions.querySelector("#ar-aging").addEventListener("click", () => {
    state.patientQuery = "";
    input.value = "";
    refreshPatientList().then(() => showAging(state.ledger));
  });

  // Debounced so a five-letter surname is one request, not five.
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.patientQuery = input.value;
      refreshPatientList().catch((err) => {
        queueList.innerHTML = `<li class="empty">${esc(err.message)}</li>`;
      });
    }, 200);
  });
}

/** The practice's A/R aging — the shape of the money, not just the total. */
/**
 * The Patients board — who owes the practice, how much, and how old it is.
 *
 * PRIMARY SIGNAL        what patients owe in total
 * PRIMARY VISUALIZATION where it is concentrated — which accounts to call first
 * SECONDARY SIGNAL      accounts, oldest balance, aging, collected of billed
 * OPERATIONAL DETAIL    the aging bands and the worklist
 *
 * ── WHAT IS DELIBERATELY NOT DRAWN ───────────────────────────────────────────────────────────────
 * An aging chart, when every balance is inside 30 days. On live staging all $5,455.12 sits in
 * `current` and the other three buckets are zero, so a "distribution" would be one full-width block
 * — a chart asserting a shape that a single bucket does not have. `Cx.stackedBar` refuses fewer than
 * two populated segments; the bands below still print their figures, which is the honest form.
 *
 * A balance-against-age scatter, too. `daysOutstanding` spans three to seven days here. Plotting a
 * relationship across four days of spread would dress noise as a finding.
 */
function showAging(ledger) {
  if (!ledger) return;
  const { summary, items } = ledger;
  const worst = items.filter((a) => (a.daysOutstanding ?? 0) > 90);

  const cells = Object.entries(AGING_LABEL)
    .map(([bucket, label]) => {
      const amount = summary.aging[bucket];
      const cls =
        amount > 0 && bucket === "d90_plus"
          ? " aging__cell--bad"
          : amount > 0 && bucket === "d61_90"
            ? " aging__cell--warn"
            : "";
      return `<div class="aging__cell${cls}">
        <div class="aging__label">${esc(label)}</div>
        <div class="aging__val${amount === 0 ? " aging__val--zero" : ""}">${usd(amount)}</div>
      </div>`;
    })
    .join("");

  /* ── PRIMARY VISUALIZATION ──────────────────────────────────────────────────────────────────
   * SOURCE      /api/v1/patients?owing=1 — one row per person carrying their own balance
   * DERIVATION  accounts sorted by balance, bar length is balance ÷ the largest. This answers the
   *             question the screen exists for — which calls are worth making — and it answers it
   *             better than aging does while nothing is aged.
   */
  const concentration = Cx.rankedBars(
    [...items]
      .sort((a, b) => b.balance - a.balance)
      .map((a) => ({
        name: a.patientName,
        value: a.balance,
        cls: (a.daysOutstanding ?? 0) > 90 ? "is-lost" : (a.daysOutstanding ?? 0) > 60 ? "is-attention" : "",
        meta: `${esc(a.patientKey)} · ${plural(a.daysOutstanding ?? 0, "day")} outstanding`,
      })),
    { limit: 8, label: "Patient balances, largest first" }
  );

  const top = [...items].sort((a, b) => b.balance - a.balance)[0];
  const topShare = summary.totalOutstanding > 0 && top ? top.balance / summary.totalOutstanding : 0;

  const oldest = items.reduce((hi, a) => Math.max(hi, a.daysOutstanding ?? 0), 0);

  document.body.dataset.stageTitled = "patients";

  stage.innerHTML = `
    <div class="panel panel--board">
      <div class="board__top">
        <h1 class="board__h1">What patients owe</h1>
      </div>

      <div class="hero">
        <div class="hero__v${summary.totalOutstanding > 0 ? "" : " hero__v--zero"}">${usd(summary.totalOutstanding)}</div>
        <p class="hero__n">
          ${
            summary.totalOutstanding > 0
              ? `across ${plural(summary.accountsWithBalance, "account")}. Payments are applied to the oldest charge first, so this always adds up to the balance.`
              : "No patient owes the practice anything."
          }
        </p>
      </div>

      ${
        concentration
          ? `<section class="viz">
               <div class="viz__q">Where the balance sits</div>
               ${concentration}
               ${
                 topShare > 0.2
                   ? `<div class="viz__note">${esc(top.patientName)} alone is ${pct(topShare)} of what patients owe.</div>`
                   : ""
               }
             </section>`
          : ""
      }

      <div class="sigrow">
        <div class="sig">
          <div class="sig__k">Accounts</div>
          <div class="sig__v">${summary.accountsWithBalance}</div>
          <div class="sig__n">${
            /**
             * ── NINE ACCOUNTS, ELEVEN ROWS ────────────────────────────────────────────────────
             * `accountsWithBalance` counts POLICIES; the worklist beside this counts PEOPLE, and
             * its badge is the row count. On staging that is 9 against 11 — both correct, both on
             * screen at once, with nothing saying they count different things. An owner reading
             * "11" in the rail and "9" here has no way to tell which is wrong, and neither is.
             *
             * A family plan is why they differ: one policy, several people, each with their own
             * balance. So this says so, and only when there is something to say.
             */
            items.length > summary.accountsWithBalance
              ? `across ${items.length} people`
              : "with a balance"
          }</div>
        </div>
        <div class="sig${oldest > 90 ? " sig--lost" : oldest > 60 ? " sig--attention" : ""}">
          <div class="sig__k">Oldest</div>
          <div class="sig__v">${oldest}<span class="sig__u">d</span></div>
          <div class="sig__n">since the first unpaid charge</div>
        </div>
        <div class="sig${summary.aging.d90_plus > 0 ? " sig--lost" : ""}">
          <div class="sig__k">Over 90 days</div>
          <div class="sig__v${summary.aging.d90_plus === 0 ? " sig__v--zero" : ""}">${usd(summary.aging.d90_plus)}</div>
          <div class="sig__n">${summary.aging.d90_plus > 0 ? "far more likely to be written off" : "nothing badly aged"}</div>
        </div>
        <div class="sig">
          <div class="sig__k">Collected of billed</div>
          ${
            /**
             * A collection rate judges how well a practice collects, and it only means anything
             * once the money has had time to be collected. On staging every balance is inside 30
             * days and nothing has been paid, so this read "0%" beside an entirely healthy A/R — a
             * figure an owner would take as a broken collections process when it means "nothing is
             * due yet". It becomes a rate once there is aged money to judge it against.
             */
            (summary.aging?.d31_60 ?? 0) + (summary.aging?.d61_90 ?? 0) + (summary.aging?.d90_plus ?? 0) > 0
              ? `<div class="sig__v">${rate(summary.collectionRate)}</div>
                 <div class="sig__n">of what has come due</div>`
              : `<div class="sig__v sig__v--na">—</div>
                 <div class="sig__n">${
                   summary.totalOutstanding > 0 ? "every balance is inside 30 days" : "no patient owes anything"
                 }</div>`
          }
        </div>
      </div>

      <section class="block">
        <h2 class="block__h">Aging</h2>
        ${Cx.stackedBar(
          [
            { key: "current", value: summary.aging.current, cls: "cx__seg--current", label: "Current", title: usd(summary.aging.current) },
            { key: "d31_60", value: summary.aging.d31_60, cls: "cx__seg--d31_60", label: "31–60", title: usd(summary.aging.d31_60) },
            { key: "d61_90", value: summary.aging.d61_90, cls: "cx__seg--d61_90", label: "61–90", title: usd(summary.aging.d61_90) },
            { key: "d90_plus", value: summary.aging.d90_plus, cls: "cx__seg--d90_plus", label: "90+", title: usd(summary.aging.d90_plus) },
          ],
          { height: 8, label: "Patient balance by age" }
        )}
        <div class="aging">${cells}</div>
        <p class="block__n">
          ${
            summary.overNinetyShare !== null && summary.overNinetyShare > 0.2
              ? `${pct(summary.overNinetyShare)} of what patients owe is more than 90 days old. Past that point a balance is far more likely to be written off than collected — these are the calls worth making first.`
              : "A patient balance decays with time in a way a payer balance does not, so the shape of this matters more than its total."
          }
        </p>
      </section>

      ${
        worst.length
          ? `<section class="block">
               <h2 class="block__h">Over 90 days</h2>
               <ul class="worklist">${worst
                 .map(
                   (a) => `<li class="worklist__row" data-id="${esc(a.patientKey)}">
                     <span class="worklist__name">${esc(a.patientName)}</span>
                     <span class="worklist__act">${esc(a.recommendedAction)}</span>
                     <span class="worklist__amt">${usd(a.balance)}</span>
                   </li>`
                 )
                 .join("")}</ul>
             </section>`
          : ""
      }
    </div>`;

  for (const row of stage.querySelectorAll(".worklist__row")) {
    row.addEventListener("click", () => openPatient(row.dataset.id));
  }
}

async function openPatient(patientKey) {
  state.selectedId = patientKey;
  renderStatement(await api("GET", `/api/v1/patients/${encodeURIComponent(patientKey)}`));
  for (const b of queueList.querySelectorAll(".qitem")) b.setAttribute("aria-current", "false");
}

// ── The Unified Patient Financial Record ──────────────────────────────────
//
// One human, assembled: who they are, every plan they hold, every coverage check and what it quoted
// them, every claim and what the payer did with it, every denial and appeal, and the balance they
// are left with — on one chronological spine.
//
// The composition happens server-side (apps/web/patient-record.ts); this only renders it. Nothing
// here recomputes a figure: every number on this screen was produced by the module that owns it.

const PHASE_LABEL = {
  verification: "Coverage",
  estimate: "Claim",
  submission: "Filed",
  posting: "Payer",
  denial: "Denied",
  appeal: "Appeal",
  ledger: "Account",
  resolution: "Closed",
};

async function openPatientRecord(patientId) {
  state.selectedId = patientId;
  stage.innerHTML = `<div class="panel stage-empty">Assembling this patient's record…</div>`;
  try {
    renderPatientRecord(await api("GET", `/api/v1/patients/record/${encodeURIComponent(patientId)}`));
  } catch (err) {
    stage.innerHTML = `<div class="panel stage-empty">${esc(err.message)}</div>`;
  }
}

function renderPatientRecord(view) {
  const { patient, coverages, verifications, claims, denials, ledger, totals, timeline, provenance } = view;
  const name = `${patient.firstName} ${patient.lastName}`.trim();

  const coverageCards = coverages.length
    ? coverages
        .map(
          (c) => `<div class="cov">
            <div class="cov__payer">${esc(c.payerName || "Unidentified payer")}</div>
            <div class="cov__member mono">${esc(c.memberId)}</div>
            <div class="cov__meta">
              ${c.verificationCount} check${c.verificationCount === 1 ? "" : "s"} ·
              ${c.claimCount === 0 ? "never billed" : `${c.claimCount} claim${c.claimCount === 1 ? "" : "s"}`}
              ${c.lastSeenAt ? ` · last seen ${esc(c.lastSeenAt.slice(0, 10))}` : ""}
            </div>
          </div>`
        )
        .join("")
    : `<div class="handoff">No plan is on file for this patient yet.</div>`;

  // The two halves of the money are reported separately and never blended: a payer that has
  // adjudicated will pay, while a patient balance decays with age. One combined number would hide
  // the half a practice can actually influence.
  const payerHalf = `
    <div class="totals">
      <div class="total"><div class="total__label">Charges</div><div class="total__val">${usd(totals.billed)}</div></div>
      <div class="total total--paid"><div class="total__label">Payers paid</div><div class="total__val">${usd(totals.paidByPayers)}</div></div>
      <div class="total ${totals.outstandingFromPayers > 0 ? "total--open" : ""}">
        <div class="total__label">Still expected</div><div class="total__val">${usd(totals.outstandingFromPayers)}</div>
      </div>
      ${
        /*
         * Coordinated money is not "still expected" from the payers already billed — it is with a
         * plan nobody has claimed against yet, and it needs its own row or it appears nowhere on
         * this screen at all.
         */
        totals.coordinationPending > 0
          ? `<div class="total total--open" title="A primary payer assigned this to another plan's adjudication. File the secondary claim — it is neither a write-off nor the patient's.">
               <div class="total__label">With another plan</div><div class="total__val">${usd(totals.coordinationPending)}</div>
             </div>`
          : ""
      }
    </div>`;

  /**
   * What this patient was TOLD they would owe, against what the payer assigned.
   *
   * Shown only once the payer has ruled on something and only when the two differ — an accurate
   * quote needs no comment, and a row that is almost always "$0.00 difference" is a row nobody
   * reads. F-7's variance message already tells a biller to "check what they were told before
   * billing the difference"; this is that check, on the screen where the conversation happens.
   *
   * Under-quoting is the one that produces the phone call, so it is the one in red.
   */
  const quote = totals.quote;
  /**
   * ── A QUOTE CANNOT BE JUDGED AGAINST AN ANSWER THAT HAS NOT ARRIVED (M8) ──────────────────────
   * This compares what the patient was TOLD against what the payer ASSIGNED, which is only a
   * comparison once somebody has assigned something. Under coordination the primary states
   * `patientResponsibility: 0` because a second plan has not ruled — so the note read "quoted
   * $625.00 … assigned $0.00 — $625.00 less than they were told. The estimate was cautious; the
   * balance is lower than promised."
   *
   * Every clause of that is wrong here, and it appeared directly beneath a note saying not to quote
   * this patient a figure at all. Two adjacent sentences on one screen, contradicting each other,
   * and the reassuring one is the one a person acts on.
   *
   * The comparison is therefore withheld until the answer exists, rather than restated more
   * carefully — there is no accurate version of it while a plan is still deciding.
   */
  const quoteNote =
    totals.coordinationPending > 0
      ? `<div class="reviewed-note">
           No comparison of quote against outcome yet: a second plan still has to rule on
           <b>${usd(totals.coordinationPending)}</b>. What this patient was quoted can only be judged once
           every plan has answered.
         </div>`
      : quote.claims > 0 && quote.variance !== 0
      ? `<div class="reviewed-note ${quote.variance > 0 ? "reviewed-note--rejected" : ""}">
           This patient was quoted <b>${usd(quote.quoted)}</b> across ${plural(quote.claims, "adjudicated claim")}
           and the payer assigned them <b>${usd(quote.assigned)}</b> —
           <b>${usd(Math.abs(quote.variance))} ${quote.variance > 0 ? "MORE" : "less"}</b> than they were told.
           ${
             quote.variance > 0
               ? "They made a decision about their care using the smaller figure, so lead with this before the balance is discussed."
               : "The estimate was cautious; the balance is lower than promised."
           }
         </div>`
      : "";

  const patientHalf = `
    <div class="totals">
      <div class="total"><div class="total__label">Charged to patient</div><div class="total__val">${usd(totals.chargedToPatient)}</div></div>
      <div class="total total--paid"><div class="total__label">Patient paid</div><div class="total__val">${usd(totals.paidByPatient)}</div></div>
      ${
        totals.forgiven > 0
          ? `<div class="total" title="Adjusted or written off — revenue the practice chose not to collect from this patient.">
               <div class="total__label">Forgiven</div><div class="total__val">${usd(totals.forgiven)}</div>
             </div>`
          : ""
      }
      <div class="total ${totals.balance > 0 ? "total--open" : ""}">
        <div class="total__label">${totals.coordinationPending > 0 ? "Balance (not final)" : "Balance"}</div><div class="total__val">${usd(totals.balance)}</div>
      </div>
    </div>`;

  const timelineHtml = timeline.length
    ? // Newest first: opening a patient's record is almost always about what happened most recently.
      timeline
        .slice()
        .reverse()
        .map(
          (e) => `<li class="tl__row tl__row--${esc(e.phase)}">
            <span class="tl__when mono">${esc(e.at.slice(0, 10))}</span>
            <span class="tl__phase kind kind--${phaseKind(e.phase)}">${esc(PHASE_LABEL[e.phase] ?? e.phase)}</span>
            <span class="tl__body">
              <span class="tl__title">${esc(e.title)}</span>
              <span class="tl__detail">${esc(e.detail)}</span>
              <span class="tl__actor">${e.actor === "system" ? "Automatic" : esc(e.actor)}</span>
            </span>
            <span class="tl__amt mono">${e.amount == null ? "" : usd(e.amount)}</span>
          </li>`
        )
        .join("")
    : `<li class="empty">Nothing has happened on this record yet.</li>`;

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">${esc(name)}</h1>
          <div class="detail__id">
            <span class="tag">Patient record</span>
            <span>Chart <b class="mono">${esc(patient.chartId)}</b></span>
            <span>Born <b>${esc(patient.dateOfBirth)}</b></span>
            <span>${provenance.memberIds.length} plan${provenance.memberIds.length === 1 ? "" : "s"} on file</span>
            ${
              // The address a claim is filed with. Shown as an explicit absence when it is missing,
              // because "no address" is the reason a claim will be blocked at the submit gate, and a
              // blank space would read as "nothing to see" rather than "this needs collecting".
              patient.address
                ? `<span>Address <b>${esc(patient.address.street)}, ${esc(patient.address.city)} ${esc(patient.address.state)} ${esc(patient.address.zip)}</b></span>`
                : `<span class="detail__id-missing">No address on file — claims cannot be filed</span>`
            }
          </div>
        </div>
        <span class="status status--${
          totals.balance > 0 || totals.coordinationPending > 0 ? "needs_review" : "verified"
        }">
          ${
            /*
             * "Nothing owed" is the sentence read out at the desk, and the ledger reaches zero for
             * two opposite reasons: the patient genuinely owes nothing, or a second plan has not
             * ruled yet and the ledger is correctly refusing to bill them. Saying "Nothing owed"
             * for the second closes a question that is still open.
             */
            totals.balance > 0
              ? `${usd(totals.balance)} owed`
              : totals.coordinationPending > 0
                ? "Not yet known"
                : "Nothing owed"
          }
        </span>
      </div>

      <p class="summary-p summary-p--muted">
        One person, assembled from every context that holds a fact about them — ${provenance.verificationCount}
        coverage check${provenance.verificationCount === 1 ? "" : "s"},
        ${provenance.claimCount} claim${provenance.claimCount === 1 ? "" : "s"},
        ${provenance.denialCount} denial${provenance.denialCount === 1 ? "" : "s"} and
        ${provenance.ledgerEntryCount} ledger entr${provenance.ledgerEntryCount === 1 ? "y" : "ies"},
        resolved through ${provenance.memberIds.length === 1 ? "the member ID" : "the member IDs"}
        <b class="mono">${provenance.memberIds.map(esc).join("</b>, <b class=\"mono\">") || "—"}</b>.
      </p>

      <div class="eyebrow section-label">Plans on file</div>
      <div class="covs">${coverageCards}</div>

      <div class="eyebrow section-label">The payer's half</div>
      ${payerHalf}
      ${
        totals.denied > 0
          ? `<div class="reviewed-note reviewed-note--rejected">
               ${usd(totals.denied)} is denied and unresolved${totals.recovered > 0 ? `, and ${usd(totals.recovered)} has been recovered by appeal` : ""}.
               Work it on Recover before the appeal window closes.
             </div>`
          : ""
      }

      <div class="eyebrow section-label">The patient's half</div>
      ${patientHalf}
      ${
        totals.coordinationPending > 0
          ? `<div class="reviewed-note">
               <b>Do not quote this patient a final figure yet.</b> ${usd(totals.coordinationPending)} of their
               treatment was passed by the primary plan to a second plan, which has not ruled. What they owe
               depends on what that plan pays, so the balance above is what is known today and not the answer.
               File the secondary claim and post its remittance first.
             </div>`
          : ""
      }
      ${quoteNote}
      ${
        ledger
          ? `<div class="decision">
               <div>
                 <div class="eyebrow decision__action-label">Read to the patient</div>
                 ${ledger.statementLines.map((s) => `<p class="summary-p">${esc(s)}</p>`).join("")}
                 <p class="card__note">A team member shares this — Mermaid never messages patients automatically.</p>
               </div>
               <div class="gauge">
                 <div class="gauge__row">
                   <span class="gauge__val ${
                     ledger.account.daysOutstanding > 90
                       ? "gauge__val--expired"
                       : ledger.account.daysOutstanding > 30
                         ? "gauge__val--approaching"
                         : "gauge__val--safe"
                   }">${ledger.account.daysOutstanding ?? "—"}</span>
                   <span class="gauge__label">Days outstanding</span>
                 </div>
                 <div class="gauge__thr-note">oldest unpaid charge</div>
               </div>
             </div>`
          : `<div class="handoff">
               This patient has no financial history. Their coverage has been checked, but nothing has
               been billed to them — which is a state, not an empty account.
             </div>`
      }

      <div class="eyebrow section-label">Everything that has happened, newest first</div>
      <ol class="tl">${timelineHtml}</ol>

      ${recordIndex("Coverage checks", verifications, (v) =>
        `<li class="worklist__row" data-open="verification" data-id="${esc(v.id)}">
           <span class="worklist__name">${esc(v.createdAt.slice(0, 10))} · ${esc(v.payerName || "Unknown payer")}</span>
           <span class="worklist__act">${esc(v.recommendedAction)}</span>
           <span class="worklist__amt">${usd(v.patientPays)}</span>
         </li>`
      )}
      ${recordIndex("Claims", claims, (c) =>
        `<li class="worklist__row" data-open="claim" data-id="${esc(c.id)}">
           <span class="worklist__name">${esc(c.serviceDate)} · ${esc(c.payerName || "Unknown payer")}
             <span class="status status--claim-${esc(c.status)}">${esc(c.status.replace(/_/g, " "))}</span></span>
           <span class="worklist__act">${esc(c.recommendedAction)}</span>
           <span class="worklist__amt">${usd(c.totalFee)}</span>
         </li>`
      )}
      ${recordIndex("Denials and appeals", denials, (d) =>
        `<li class="worklist__row" data-open="denial" data-id="${esc(d.id)}">
           <span class="worklist__name">${esc(d.carcCode)} · ${esc(d.carcDescription)}</span>
           <span class="worklist__act">${esc(d.recommendedAction)}</span>
           <span class="worklist__amt">${usd(d.deniedAmount)}</span>
         </li>`
      )}
    </div>`;

  // Every index row opens the record it points at, on the tab that owns it — the patient record is a
  // map of this person, not a replacement for the screens that can act on each thing.
  for (const row of stage.querySelectorAll(".worklist__row[data-open]")) {
    row.addEventListener("click", () => {
      const { open, id } = row.dataset;
      if (open === "verification") switchTabTo("verifications", () => openDetail(id));
      else if (open === "claim") switchTabTo("claims", () => openClaim(id));
      else if (open === "denial") switchTabTo("recovery", () => openDenial(id));
    });
  }
}

/** A collapsed index of one context's records, or nothing at all when there are none. */
function recordIndex(title, items, row) {
  if (!items.length) return "";
  return `<div class="eyebrow section-label">${esc(title)} <span class="section-label__n">${items.length}</span></div>
          <ul class="worklist">${items.map(row).join("")}</ul>`;
}

/** Which colour family a timeline phase belongs to — reuses the Today queue's kind palette. */
function phaseKind(phase) {
  if (phase === "verification") return "verification";
  if (phase === "estimate" || phase === "submission") return "claim";
  if (phase === "posting") return "remittance";
  if (phase === "denial" || phase === "appeal") return "denial";
  return "patient";
}

/**
 * Switch tabs and then open one record on the newly-loaded worklist.
 *
 * `switchTab` already moves `aria-selected` and kicks off the queue load; all this adds is opening
 * the specific record the patient record pointed at, once that load has been started.
 */
function switchTabTo(tab, open) {
  switchTab(tab);
  Promise.resolve()
    .then(open)
    .catch((err) => {
      stage.innerHTML = `<div class="panel stage-empty">${esc(err.message)}</div>`;
    });
}

const ENTRY_LABEL = { charge: "Charge", payment: "Payment", adjustment: "Adjustment", writeoff: "Written off" };

function renderStatement(view) {
  const { account: a, entries, statementLines } = view;
  const patientId = patientIdOf(entries);
  /**
   * An account keyed by member ID is a POLICY. On a family plan one policy covers several people,
   * and this screen used to take the name of whichever of them the payer mentioned last and put the
   * whole family's balance beside it — under a heading that says "Read to the patient".
   */
  const people = a.people ?? [];
  const shared = people.length > 1;

  const rows = entries
    .map(
      (e) => `<tr>
        <td class="mono">${esc(e.occurredAt.slice(0, 10))}</td>
        ${shared ? `<td><b>${esc(e.patientName)}</b></td>` : ""}
        <td>
          ${esc(e.description)}
          <span class="who">${ENTRY_LABEL[e.kind]} · ${esc(e.recordedBy)}</span>
        </td>
        <td class="num amt--${e.kind}">${e.amount > 0 ? "+" : "−"}${usd(Math.abs(e.amount))}</td>
      </tr>`
    )
    .join("");

  /**
   * Who owes what, before anything else on the screen. Two dependents treated on the same day
   * produce two charges whose descriptions are identical to the character, so the ledger alone
   * cannot answer this — and "collect $965.02" is the wrong instruction for both of them.
   */
  const splitHtml = shared
    ? `<div class="split-people">
         <div class="eyebrow section-label">Who owes what on this policy</div>
         ${people
           .map(
             (p) => `<div class="wl__row">
               <span class="wl__rail"></span>
               <span class="wl__body">
                 <span class="wl__name">${esc(p.patientName)}</span>
                 <span class="wl__act">${
                   p.patientId
                     ? "Collect this person's share only"
                     : "Not yet matched to a patient record — identify before collecting"
                 }</span>
               </span>
               <span class="wl__val">${usd(p.balance)}</span>
             </div>`
           )
           .join("")}
         <p class="card__note">
           These are separate people on one insurance policy. The balance above is the policy's
           total; no single person owes it.
         </p>
       </div>`
    : "";

  const agingCells = Object.entries(AGING_LABEL)
    .map(([bucket, label]) => {
      const amount = a.aging[bucket];
      const cls = amount > 0 && bucket === "d90_plus" ? " aging__cell--bad" : amount > 0 && bucket === "d61_90" ? " aging__cell--warn" : "";
      return `<div class="aging__cell${cls}">
        <div class="aging__label">${label}</div>
        <div class="aging__val">${usd(amount)}</div>
      </div>`;
    })
    .join("");

  // Money leaving a balance is a human act, always attributed and — for anything other than a
  // payment — always reasoned. Same doctrine as the claim submit gate, other direction.
  const actionsHtml =
    a.balance > 0
      ? `<div class="review">
           <div class="review__title">Record a movement on this account</div>
           <p class="review__hint">
             ${esc(a.recommendedAction)}
           </p>
           <div class="grid-2">
             <label class="field"><span class="field__label">Amount (dollars)</span>
               <input class="input input--mono" id="entry-amount" type="number" min="0.01" step="0.01"
                      placeholder="${(a.balance / 100).toFixed(2)}" /></label>
             <label class="field"><span class="field__label">Note</span>
               <input class="input" id="entry-note" placeholder="e.g. Card, in person" /></label>
           </div>
           <div class="review__actions">
             <button class="btn btn--approve" data-movement="payment">Record payment</button>
             <button class="btn btn--override" data-movement="adjustment">Courtesy adjustment</button>
             <button class="btn btn--reject" data-movement="writeoff">Write off</button>
           </div>
           <p class="card__note">
             An adjustment or a write-off needs a reason — revenue the practice chooses to lose should
             never be untraceable.
           </p>
         </div>`
      : a.balance < 0
        ? /*
           * A credit is the practice owing the PATIENT, and it fell through to "settled. Nothing
           * further is owed" — the one reading that is exactly backwards. Overpayments happen when
           * a patient pays a quote and the payer later assigns them less.
           */
          `<div class="reviewed-note reviewed-note--rejected">
             This account is <b>${usd(Math.abs(a.balance))} in credit</b> — the practice holds money that
             belongs to the patient. Refund it or carry it against their next visit; it is not revenue.
           </div>`
        : `<div class="handoff">Nothing is owed on this account today.</div>`;

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">${shared ? `Member ${esc(a.patientKey)}` : esc(a.patientName)}</h1>
          <div class="detail__id">
            <span class="tag">${shared ? "Family policy" : "Patient account"}</span>
            <span>${
              shared
                ? `Covers <b>${a.people.length} people</b>`
                : `Member <b class="mono">${esc(a.patientKey)}</b>`
            }</span>
            <span>${a.entryCount} entr${a.entryCount === 1 ? "y" : "ies"}</span>
            <span>Last activity <b>${esc(a.lastActivityAt.slice(0, 10))}</b></span>
          </div>
          ${
            // This screen is ONE account. A person with two plans has two of them, and their real
            // balance is the sum — which only the patient record can show. Offered whenever the
            // ledger managed to resolve this member ID to a person.
            patientId
              ? `<button type="button" class="btn btn--ghost btn--sm" id="open-record"
                         data-id="${esc(patientId)}">Open the full patient record →</button>`
              : ""
          }
        </div>
        <span class="status status--${a.balance > 0 ? (a.daysOutstanding > 90 ? "failed" : "needs_review") : "verified"}">
          ${a.balance > 0 ? `${usd(a.balance)} ${shared ? "across this policy" : "owed"}` : a.balance < 0 ? "credit" : "settled"}
        </span>
      </div>

      <div class="decision">
        <div>
          <div class="eyebrow decision__action-label">Read to the patient</div>
          ${statementLines.map((s) => `<p class="summary-p">${esc(s)}</p>`).join("")}
          <p class="card__note">A team member shares this — Mermaid never messages patients automatically.</p>
          ${splitHtml}
        </div>
        <div class="gauge">
          <div class="gauge__row">
            <span class="gauge__val ${a.daysOutstanding > 90 ? "gauge__val--expired" : a.daysOutstanding > 30 ? "gauge__val--approaching" : "gauge__val--safe"}">${a.daysOutstanding ?? "—"}</span>
            <span class="gauge__label">Days outstanding</span>
          </div>
          <div class="gauge__thr-note">oldest unpaid charge</div>
        </div>
      </div>

      <div class="totals">
        <div class="total"><div class="total__label">Charged</div><div class="total__val">${usd(a.charged)}</div></div>
        <div class="total total--paid"><div class="total__label">Paid</div><div class="total__val">${usd(a.paid)}</div></div>
        ${
          /*
           * Without this the three figures visibly fail to add up the moment anything is written
           * off or adjusted — charged minus paid simply is not the balance, and the screen offered
           * no account of the difference.
           */
          (a.forgiven ?? 0) > 0
            ? `<div class="total" title="Adjusted or written off — revenue the practice chose not to collect. It is neither owed nor received.">
                 <div class="total__label">Forgiven</div><div class="total__val">${usd(a.forgiven)}</div>
               </div>`
            : ""
        }
        <div class="total ${a.balance > 0 ? "total--open" : ""}"><div class="total__label">Balance</div><div class="total__val">${usd(a.balance)}</div></div>
      </div>

      ${a.balance > 0 ? `<div class="eyebrow section-label">Aging</div>${agingBar(a.aging)}<div class="aging">${agingCells}</div>` : ""}

      <div class="eyebrow section-label">Every movement on this account</div>
      <table class="ledger">
        <thead><tr><th>Date</th>${shared ? "<th>Who</th>" : ""}<th>What happened</th><th class="num">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>

      ${actionsHtml}
    </div>`;

  const openRecord = stage.querySelector("#open-record");
  if (openRecord) openRecord.addEventListener("click", () => openPatientRecord(openRecord.dataset.id));

  wireLedgerActions(a.patientKey);
}

/**
 * The patient this account's money was resolved to, if any.
 *
 * Null is a legitimate answer, not a failure: an entry whose member ID had no coverage on file — a
 * payment against a legacy key, or money recorded before the patient master existed — is real money
 * that must stay recordable. It simply cannot offer the unified view.
 */
function patientIdOf(entries) {
  return entries.find((e) => e.patientId)?.patientId ?? null;
}

function wireLedgerActions(patientKey) {
  for (const btn of stage.querySelectorAll("[data-movement]")) {
    btn.addEventListener("click", async () => {
      const amount = Number(stage.querySelector("#entry-amount")?.value);
      const note = stage.querySelector("#entry-note")?.value.trim() ?? "";
      const movement = btn.dataset.movement;
      if (!Number.isFinite(amount) || amount <= 0) {
        notify("Enter the amount in dollars.", "warn");
        return;
      }
      if (movement !== "payment" && !note) {
        notify(
          movement === "writeoff"
            ? "A write-off needs a reason — this is revenue the practice is choosing to lose."
            : "An adjustment needs a reason.",
          "warn"
        );
        return;
      }
      for (const b of stage.querySelectorAll(".review__actions .btn")) b.disabled = true;
      try {
        renderStatement(
          await api("POST", `/api/v1/patients/${encodeURIComponent(patientKey)}/${movement}`, {
            amountDollars: amount,
            note,
            recordedBy: state.submittedBy,
          })
        );
        await loadQueue();
      } catch (err) {
        notify(err.message, "bad");
        openPatient(patientKey);
      }
    });
  }
}

// ── Insights: the practice report ─────────────────────────────────────────
//
// Every number here is derived from `analytics_facts`, which is fed purely by domain events. No
// figure on this screen is computed by querying another module's tables.

const PERIODS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

async function loadInsightsQueue() {
  const report = await fetchReport();
  state.report = report;

  queueTitle.textContent = "Insights";
  queueHint.textContent = `Last ${state.reportDays} days · ${usd(report.money.collected)} collected.`;
  queueCount.textContent =
    report.money.collectionRate === null ? "—" : pct(report.money.collectionRate);

  queueActions.innerHTML = PERIODS.map(
    (p) =>
      `<button type="button" class="btn btn--ghost btn--sm${p.days === state.reportDays ? " btn--on" : ""}" data-days="${p.days}">${p.label}</button>`
  ).join("");
  for (const btn of queueActions.querySelectorAll("[data-days]")) {
    btn.addEventListener("click", async () => {
      state.reportDays = Number(btn.dataset.days);
      await loadQueue();
      showInsights(state.report);
    });
  }

  // The sidebar lists what to FIX, ranked by what it costs — the one worklist a report can honestly
  // produce. Clicking a reason shows every open denial carrying that code.
  queueList.innerHTML = "";
  if (report.topDenialReasons.length === 0) {
    queueList.innerHTML = `<li class="empty">No denials in this period. Nothing to fix.</li>`;
    return;
  }
  for (const reason of report.topDenialReasons) {
    queueItem(
      // A count, not a priority: this list ranks by what a code COSTS, and "P3" here would read as
      // an urgency score borrowed from a screen that means something different.
      { id: reason.carcCode, patientName: reason.carcCode, badge: `${reason.count}×` },
      "qitem qitem--kind-denial",
      esc(reason.description),
      usd(reason.denied),
      () => showDenialsForCode(reason)
    );
  }
}

async function fetchReport() {
  const to = new Date();
  const from = new Date(to.getTime() - state.reportDays * 24 * 60 * 60 * 1000);
  return api(
    "GET",
    `/api/v1/analytics/report?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
  );
}

/** A funnel row. `width` is a share of the widest stage, so the drop between rows is the message. */
function funnelRow(label, value, max, note) {
  const width = max > 0 ? Math.round((value / max) * 100) : 0;
  return `
    <div class="funnel__row">
      <span class="funnel__label">${label}</span>
      <span class="funnel__bar"><span class="funnel__fill" data-w="${width}"></span></span>
      <span class="funnel__val">${value}</span>
      <span class="funnel__note">${note}</span>
    </div>`;
}

function rate(value) {
  return value === null ? "—" : pct(value);
}

/**
 * The Recover board — what a payer refused, and what the practice got back.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 * With nothing open, this screen rendered one sentence in the middle of an empty stage: "Nothing to
 * pursue." True, and useless. The payload it already receives carries the practice's whole recovery
 * record — two denials, $2,250.00 refused, $2,250.00 won back — and a practice with no open denials
 * still wants to know how it does when it DOES get denied, because that is what tells it whether
 * appealing is worth the hour it costs.
 *
 * PRIMARY SIGNAL        what is still refused and unresolved
 * PRIMARY VISUALIZATION how refusals have ended: recovered, written off, still open
 * SECONDARY SIGNAL      the record — denied, recovered, rate, written off
 * OPERATIONAL DETAIL    the worklist beside it
 *
 * ── WHAT IS DELIBERATELY NOT DRAWN ───────────────────────────────────────────────────────────────
 * A denial→appeal→recovered funnel. On this data every stage is $2,250.00, so a funnel would draw
 * three identical full-width bars and annotate a drop of nothing — a chart whose only content is
 * that it has no content. `Cx.stackedBar` likewise refuses the outcome split while one outcome holds
 * everything. Both come back on their own the moment a second outcome exists.
 */
function showRecoveryOverview(recovery) {
  if (!recovery || !recovery.stats) return;
  const s = recovery.stats;

  const settled = (s.recoveredAmount ?? 0) + (s.writtenOffAmount ?? 0);
  const everDenied = (s.openDenied ?? 0) + settled;

  /**
   * SOURCE      /api/v1/denials — practice-wide `stats`, which the open-only response still carries
   * DERIVATION  every dollar a payer refused, by how the refusal ended. The three outcomes are
   *             exhaustive and disjoint, so the widths are shares of everything ever refused.
   */
  const outcomes = [
    { key: "recovered", label: "Won back", value: s.recoveredAmount ?? 0, cls: "cx__seg--settled" },
    { key: "awaiting", label: "Awarded, unpaid", value: s.awardedAwaitingPayment ?? 0, cls: "cx__seg--attention" },
    { key: "open", label: "Still open", value: s.openDenied ?? 0, cls: "cx__seg--lost" },
    { key: "writtenoff", label: "Written off", value: s.writtenOffAmount ?? 0, cls: "cx__seg--open" },
  ];
  const outcomeBar = Cx.stackedBar(
    outcomes.map((o) => ({ ...o, title: usd(o.value) })),
    { height: 8, label: outcomes.map((o) => `${o.label} ${usd(o.value)}`).join("; ") }
  );

  document.body.dataset.stageTitled = "recovery";

  stage.innerHTML = `
    <div class="panel panel--board">
      <div class="board__top"><h1 class="board__h1">Recover</h1></div>

      <div class="hero">
        <div class="hero__v${s.openDenied > 0 ? "" : " hero__v--zero"}">${usd(s.openDenied ?? 0)}</div>
        <p class="hero__n">
          ${
            s.openDenied > 0
              ? `refused by a payer and not yet resolved, across ${plural(s.openCount, "denial")}. ` +
                `${usd(s.openExpectedRecovery ?? 0)} of it is worth appealing.`
              : everDenied > 0
                ? `is unresolved. Every refusal so far has been settled — by contract, by the patient's share, or by appeal.`
                : `No payer has refused anything yet.`
          }
        </p>
      </div>

      ${
        outcomeBar
          ? `<section class="viz">
               <div class="viz__q">How refusals have ended</div>
               ${outcomeBar}
               <div class="legend">
                 ${outcomes
                   .filter((o) => o.value > 0)
                   .map(
                     (o) => `<div class="legend__i">
                       <svg class="legend__sw" viewBox="0 0 4 4" aria-hidden="true"><rect class="${o.cls}" x="0" y="0" width="4" height="4" /></svg>
                       <span class="legend__k">${esc(o.label)}</span>
                       <span class="legend__v">${usd(o.value)}</span>
                     </div>`
                   )
                   .join("")}
               </div>
             </section>`
          : everDenied > 0
            ? `<p class="viz__note">Every dollar a payer has refused ended the same way, so there is no split to draw: ${esc(
                outcomes.find((o) => o.value > 0)?.label.toLowerCase() ?? "settled"
              )}, ${usd(everDenied)}.</p>`
            : ""
      }

      <div class="sigrow">
        <div class="sig${everDenied > 0 ? " sig--lost" : ""}">
          <div class="sig__k">Ever refused</div>
          <div class="sig__v${everDenied === 0 ? " sig__v--zero" : ""}">${usd(everDenied)}</div>
          <div class="sig__n">across every denial on record</div>
        </div>
        <div class="sig${s.recoveredAmount > 0 ? " sig--settled" : ""}">
          <div class="sig__k">Won back</div>
          <div class="sig__v${s.recoveredAmount === 0 ? " sig__v--zero" : ""}">${usd(s.recoveredAmount ?? 0)}</div>
          <div class="sig__n">${plural(s.recoveredCount ?? 0, "appeal")} settled in the practice's favour</div>
        </div>
        <div class="sig">
          <div class="sig__k">Recovery rate</div>
          ${
            /* A rate over nothing is not zero, it is undefined — and "0%" beside an unblemished
               record would read as a practice that never wins an appeal. */
            s.recoveryRate === null || s.recoveryRate === undefined || everDenied === 0
              ? `<div class="sig__v sig__v--na">—</div>
                 <div class="sig__n">no refusal has been worked yet</div>`
              : `<div class="sig__v">${rate(s.recoveryRate)}</div>
                 <div class="sig__n">of refused money, recovered</div>`
          }
        </div>
        <div class="sig${s.writtenOffAmount > 0 ? " sig--lost" : ""}">
          <div class="sig__k">Written off</div>
          <div class="sig__v${s.writtenOffAmount === 0 ? " sig__v--zero" : ""}">${usd(s.writtenOffAmount ?? 0)}</div>
          <div class="sig__n">${
            s.writtenOffAmount > 0 ? `${plural(s.writtenOffCount ?? 0, "denial")} given up on` : "nothing given up on"
          }</div>
        </div>
      </div>

      <p class="provenance">
        A denial is money a payer refused with a reason. Recovery counts only what a payer actually
        agreed to pay after an appeal — an award still awaiting its cheque is shown separately,
        because it is not in the bank.
      </p>
    </div>`;
}

/**
 * The Claims board — what has been filed, and where it stopped.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 * Until now this screen rendered "Select a claim from the worklist to see the money behind it." and
 * nothing else. Two of the eight surfaces — Claims and Money — had a blank primary stage, so the
 * most valuable area of the screen was empty until the user guessed to click something. A worklist
 * of nineteen rows cannot answer "where is my money stuck", which is the question the screen is for.
 *
 * PRIMARY SIGNAL        what is still outstanding across every filed claim
 * PRIMARY VISUALIZATION where the dollars are sitting, by claim state
 * SECONDARY SIGNAL      ready to submit, at filing risk, charged, expected
 * OPERATIONAL DETAIL    the worklist beside it
 */
function showClaimsOverview(claims) {
  if (!claims || !claims.items) return;
  const items = claims.items;
  if (items.length === 0) {
    stage.innerHTML = stageEmpty(
      "a claim",
      "No claims are waiting. A claim appears here once a verification has priced a treatment plan."
    );
    return;
  }

  /**
   * States in pipeline order. The label is the practice's word for it, not the enum.
   * SOURCE      /api/v1/claims — one row per claim, carrying `status` and `totalFee`
   * DERIVATION  claims grouped by status; the bar divides CHARGES, not counts, because a screen
   *             about money should rank states by the money in them. Six draft claims worth $175
   *             are not the same problem as one stuck claim worth $9,000.
   */
  const ORDER = [
    { key: "draft", label: "Draft", cls: "cx__seg--open" },
    { key: "ready", label: "Ready to file", cls: "cx__seg--attention" },
    { key: "submitted", label: "With the payer", cls: "cx__seg--accent" },
    { key: "partially_paid", label: "Part paid", cls: "cx__seg--attention" },
    { key: "paid", label: "Paid", cls: "cx__seg--settled" },
    { key: "denied", label: "Denied", cls: "cx__seg--lost" },
  ];
  const byState = ORDER.map((s) => {
    const rows = items.filter((c) => c.status === s.key);
    return {
      ...s,
      count: rows.length,
      value: rows.reduce((t, c) => t + (c.totalFee ?? 0), 0),
    };
  }).filter((s) => s.count > 0);

  /* Any status the API returns that this list does not name is still money, and must not vanish. */
  const named = new Set(ORDER.map((s) => s.key));
  const other = items.filter((c) => !named.has(c.status));
  if (other.length) {
    byState.push({
      key: "other",
      label: "Other",
      cls: "cx__seg--open",
      count: other.length,
      value: other.reduce((t, c) => t + (c.totalFee ?? 0), 0),
    });
  }

  const charged = items.reduce((t, c) => t + (c.totalFee ?? 0), 0);
  const expected = items.reduce((t, c) => t + (c.expectedInsurancePays ?? 0), 0);
  const openStates = new Set(["draft", "ready", "submitted", "partially_paid"]);
  const outstanding = items.filter((c) => openStates.has(c.status)).reduce((t, c) => t + (c.totalFee ?? 0), 0);

  const bar = Cx.stackedBar(
    byState.map((s) => ({ ...s, title: `${usd(s.value)} across ${plural(s.count, "claim")}` })),
    { height: 8, label: byState.map((s) => `${s.label} ${usd(s.value)}`).join("; ") }
  );

  const stateBlock = bar
    ? `<section class="viz">
         <div class="viz__q">Charges by claim state</div>
         ${bar}
         <div class="legend">
           ${byState
             .map(
               (s) => `<div class="legend__i">
                 <svg class="legend__sw" viewBox="0 0 4 4" aria-hidden="true"><rect class="${s.cls}" x="0" y="0" width="4" height="4" /></svg>
                 <span class="legend__k">${esc(s.label)} · ${s.count}</span>
                 <span class="legend__v">${usd(s.value)}</span>
               </div>`
             )
             .join("")}
         </div>
       </section>`
    : "";

  /**
   * SOURCE      /api/v1/claims — each row carries `createdAt`
   * DERIVATION  claims grouped by the calendar day they were raised, counted. A day on which no
   *             claim was raised has no column, because none was; the gaps are when the front half
   *             of the practice was not producing work for the back half.
   */
  const raisedByDay = new Map();
  for (const c of items) {
    if (!c.createdAt) continue;
    const day = String(c.createdAt).slice(0, 10);
    raisedByDay.set(day, (raisedByDay.get(day) ?? 0) + 1);
  }
  const raised = [...raisedByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, n]) => ({ label: day, value: n, title: plural(n, "claim") }));
  const volume = Cx.columns(raised, {
    height: 40,
    label: raised.map((d) => `${d.label}: ${d.value}`).join("; "),
  });

  document.body.dataset.stageTitled = "claims";

  stage.innerHTML = `
    <div class="panel panel--board">
      <div class="board__top"><h1 class="board__h1">Claims</h1></div>

      <div class="hero">
        <div class="hero__v${outstanding > 0 ? "" : " hero__v--zero"}">${usd(outstanding)}</div>
        <p class="hero__n">
          in charges on claims no payer has finished with, across
          ${plural(items.filter((c) => openStates.has(c.status)).length, "claim")}.
        </p>
      </div>

      ${stateBlock}

      ${
        volume
          ? `<section class="viz">
               <div class="viz__q">Claims raised, by day</div>
               ${volume}
               <div class="cx__axis">
                 <span class="cx__tick">${esc(dayLabel(raised[0].label))}</span>
                 <span class="cx__tick">${esc(dayLabel(raised[raised.length - 1].label))}</span>
               </div>
               <div class="viz__note">${plural(raised.length, "day")} on which a claim was raised</div>
             </section>`
          : ""
      }

      <div class="sigrow">
        <div class="sig${claims.readyToSubmit > 0 ? " sig--attention" : ""}">
          <div class="sig__k">Ready to file</div>
          <div class="sig__v${claims.readyToSubmit === 0 ? " sig__v--zero" : ""}">${claims.readyToSubmit}</div>
          <div class="sig__n">priced and waiting on a person</div>
        </div>
        <div class="sig${claims.atRisk > 0 ? " sig--lost" : ""}">
          <div class="sig__k">At filing risk</div>
          <div class="sig__v${claims.atRisk === 0 ? " sig__v--zero" : ""}">${claims.atRisk}</div>
          <div class="sig__n">${claims.atRisk > 0 ? "near a payer deadline" : "none near a deadline"}</div>
        </div>
        <div class="sig">
          <div class="sig__k">Charged</div>
          <div class="sig__v">${usd(charged)}</div>
          <div class="sig__n">every claim on this screen</div>
        </div>
        <div class="sig">
          <div class="sig__k">Expected</div>
          <div class="sig__v">${usd(expected)}</div>
          <div class="sig__n">what the payers should pay</div>
        </div>
      </div>

      <p class="provenance">
        Charges are what was billed; expected is what the estimate says a payer will cover. The
        difference is the patient's share and the contract write-off, not a shortfall.
      </p>
    </div>`;
}

/**
 * The Money board — what the payers actually sent, and what is stuck.
 *
 * PRIMARY SIGNAL        money sitting in the bank that nobody has posted
 * PRIMARY VISUALIZATION when the cash arrived, at its real date
 * SECONDARY SIGNAL      posted, held, recoverable, with another plan
 * OPERATIONAL DETAIL    the worklist beside it
 */
function showMoneyOverview(remits) {
  if (!remits || !remits.items) return;
  const items = remits.items;
  if (items.length === 0) {
    stage.innerHTML = stageEmpty(
      "a payment",
      /* The worklist beside this already says "No payments yet. File a claim, then pull
         remittances." The stage explains; it does not repeat. */
      "Nothing has arrived from a payer. An advice appears here once a filed claim is adjudicated, and until one does there is no cash to post."
    );
    return;
  }

  /**
   * SOURCE      /api/v1/remittances — one row per advice, carrying `receivedAt` and `paymentTotal`
   * DERIVATION  advices grouped by the calendar day they arrived, summed. Days are plotted in
   *             order; a day with no advice has no column because no advice arrived — the gap is
   *             the reading.
   */
  const byDay = new Map();
  for (const r of items) {
    if (!r.receivedAt) continue;
    const day = String(r.receivedAt).slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + (r.paymentTotal ?? 0));
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, value]) => ({
    label: day,
    value,
    title: usd(value),
  }));

  const arrival = Cx.columns(days, {
    height: 48,
    /* No "most recent" highlight. It painted the last column in the brightest ink on the page, so
       the eye went to an arbitrary day instead of to the one that brought the most money — and the
       axis underneath already says which end is recent. */
    label: days.map((d) => `${d.label}: ${usd(d.value)}`).join("; "),
  });

  const posted = items.filter((r) => r.status === "posted").reduce((t, r) => t + (r.paymentTotal ?? 0), 0);
  const held = items.filter((r) => r.status === "held").reduce((t, r) => t + (r.paymentTotal ?? 0), 0);

  const arrivalBlock = arrival
    ? `<section class="viz">
         <div class="viz__q">When the cash arrived</div>
         ${arrival}
         <div class="cx__axis">
           <span class="cx__tick">${esc(dayLabel(days[0].label))}</span>
           <span class="cx__tick">${esc(dayLabel(days[days.length - 1].label))}</span>
         </div>
         <div class="viz__note">${plural(days.length, "day")} on which a payer file arrived · ${plural(items.length, "advice")} in total</div>
       </section>`
    : "";

  /** SOURCE the same rows; DERIVATION each payer's share of what they sent. */
  const byPayer = new Map();
  for (const r of items) {
    const k = r.payerName ?? "Unknown payer";
    byPayer.set(k, (byPayer.get(k) ?? 0) + (r.paymentTotal ?? 0));
  }
  const payers = Cx.rankedBars(
    [...byPayer.entries()].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
    { limit: 6, label: "What each payer sent" }
  );

  document.body.dataset.stageTitled = "money";

  stage.innerHTML = `
    <div class="panel panel--board">
      <div class="board__top"><h1 class="board__h1">Money in</h1></div>

      <div class="hero">
        <div class="hero__v${held > 0 ? "" : " hero__v--zero"}">${usd(held)}</div>
        <p class="hero__n">
          ${
            held > 0
              ? `is in the bank and not yet posted, across ${plural(remits.held, "advice")}. It is the practice's money already — it is waiting on a person, not on a payer.`
              : "Nothing is held. Every advice a payer sent has been posted."
          }
        </p>
      </div>

      ${arrivalBlock}

      <div class="sigrow">
        <div class="sig sig--settled">
          <div class="sig__k">Posted</div>
          <div class="sig__v${posted === 0 ? " sig__v--zero" : ""}">${usd(posted)}</div>
          <div class="sig__n">applied to claims</div>
        </div>
        <div class="sig${held > 0 ? " sig--attention" : ""}">
          <div class="sig__k">Held</div>
          <div class="sig__v${held === 0 ? " sig__v--zero" : ""}">${usd(held)}</div>
          <div class="sig__n">waiting on a person</div>
        </div>
        <div class="sig${remits.totalRecoverable > 0 ? " sig--lost" : ""}">
          <div class="sig__k">Worth pursuing</div>
          <div class="sig__v${remits.totalRecoverable === 0 ? " sig__v--zero" : ""}">${usd(remits.totalRecoverable)}</div>
          <div class="sig__n">withheld on posted advices</div>
        </div>
        <div class="sig">
          <div class="sig__k">Another plan</div>
          <div class="sig__v${remits.totalWithOtherPayers === 0 ? " sig__v--zero" : ""}">${usd(remits.totalWithOtherPayers)}</div>
          <div class="sig__n">file the secondary</div>
        </div>
      </div>

      ${
        payers
          ? `<section class="block">
               <h2 class="block__h">What each payer sent</h2>
               <p class="block__n">Every advice received, including the ones still held — held money
               has been sent by the payer even though nobody has posted it yet.</p>
               ${payers}
             </section>`
          : ""
      }

      <p class="provenance">
        Every figure is the sum of payer advices as received. Held money is already in the bank;
        the rest of this screen is not.
      </p>
    </div>`;
}

/**
 * Insights — is this practice's revenue cycle healthy?
 *
 * ── THE SPINE ────────────────────────────────────────────────────────────────────────────────────
 * PRIMARY SIGNAL        what was collected in the window
 * PRIMARY VISUALIZATION when it arrived — cash posted by day, at the real day
 * SECONDARY SIGNAL      filed, expected, denied, recovered
 * OPERATIONAL DETAIL    which payer, and which refusal code, is costing the money
 *
 * ── WHAT IS DELIBERATELY NOT DRAWN ───────────────────────────────────────────────────────────────
 * A verifications → claims → paid funnel. On live staging those read 19 → 13 → 16: MORE claims were
 * paid in the window than were filed in it, because a payment posted this month can belong to a
 * claim filed last month. They are three different populations, and stacking them into a funnel
 * would assert a pipeline that the numbers do not describe. `Cx.funnel` refuses non-monotonic input
 * for exactly this reason; the two rates that ARE nested are stated as figures instead.
 *
 * A payer scatter, too. Four payers with one 266% outlier is a chart whose shape is decided by the
 * outlier, not by the data. Ranked bars compare four things honestly; a scatter needs a population.
 */
function showInsights(report) {
  if (!report) return;
  const { funnel: f, money: m } = report;

  /* ── PRIMARY VISUALIZATION ──────────────────────────────────────────────────────────────────
   * SOURCE      report.dailyCollections — [{day, collected, payments}], one row per day on which
   *             something was posted
   * DERIVATION  column height is collected ÷ the busiest day. A day that posted a payment worth
   *             nothing keeps its slot and draws a baseline tick, because "a payment arrived and it
   *             was for zero" is a reading, not a gap.
   */
  const days = report.dailyCollections ?? [];
  const busiest = days.length ? days.reduce((a, b) => (b.collected > a.collected ? b : a)) : null;
  const posted = days.reduce((t, d) => t + d.collected, 0);
  const cash = Cx.columns(
    days.map((d) => ({
      label: d.day,
      value: d.collected,
      title: `${usd(d.collected)} across ${plural(d.payments, "payment")}`,
    })),
    { height: 48, label: days.map((d) => `${d.day}: ${usd(d.collected)}`).join("; ") }
  );

  const cashBlock = cash
    ? `<section class="viz">
         <div class="viz__q">Cash posted, by day</div>
         ${cash}
         <div class="cx__axis">
           <span class="cx__tick">${esc(dayLabel(days[0].day))}</span>
           <span class="cx__tick">${esc(dayLabel(days[days.length - 1].day))}</span>
         </div>
         <div class="viz__note">
           ${plural(days.length, "day")} with activity · busiest ${esc(dayLabel(busiest.day))} at ${usd(busiest.collected)}
         </div>
       </section>`
    : days.length === 1
      ? `<p class="viz__note">Only one day in this window posted cash (${esc(dayLabel(days[0].day))}, ${usd(days[0].collected)}). A trend needs more than one reading.</p>`
      : "";

  /* ── OPERATIONAL DETAIL: payers ─────────────────────────────────────────────────────────────
   * SOURCE      report.payers
   * DERIVATION  bar length is what each payer was FILED, scaled to the largest; the figure is what
   *             they actually paid, and the meta line carries the rates. Filed is the right track
   *             because it is the quantity the practice controls — a payer paying little on little
   *             is a different problem from one paying little on a lot.
   */
  const payersRanked = Cx.rankedBars(
    [...report.payers]
      .sort((a, b) => b.filedToPayers - a.filedToPayers)
      .map((p) => ({
        name: p.payerName,
        /* The track is what they were filed; the fill is what arrived. The gap between them IS the
           answer, and drawing them on one scale means the reader never has to divide. */
        value: p.filedToPayers,
        achieved: p.collected,
        display: usd(p.collected),
        cls: p.denialRate > 0.25 ? "is-lost" : "",
        meta:
          `${plural(p.claimsSubmitted, "claim")} · filed ${usd(p.filedToPayers)} · ` +
          `denied ${rate(p.denialRate)}` +
          (p.averageDaysToPay === null ? "" : ` · pays in ${p.averageDaysToPay}d`),
      })),
    { limit: 8, label: "What each payer was filed, and what they paid" }
  );

  const reasonRows = report.topDenialReasons
    .map(
      (r) => `<tr>
        <td><span class="code">${esc(r.carcCode)}</span><span class="desc-note">${esc(r.description)}</span></td>
        <td class="num">${r.count}</td>
        <td class="num">${usd(r.denied)}</td>
        <td class="num">${usd(r.recovered)}</td>
        <td class="num">${rate(r.recoveryRate)}</td>
      </tr>`
    )
    .join("");

  /**
   * The estimate verdict. This figure and the sentence under the hero are now computed from the
   * same netted quantity — `estimateVariance`, which subtracts appeal recoveries — because the
   * screen used to say "payers are paying $1,949.87 MORE than quoted" a few inches from a tile
   * reading "3.9% under". Same question, opposite answers.
   */
  const estimate =
    m.estimateAccuracy === null
      ? { v: "—", note: "No payer has answered a claim in this period, so nothing has tested the estimates." }
      : {
          v:
            m.estimateAccuracy === 0
              ? "on the nose"
              : `${pct(Math.abs(m.estimateAccuracy))} ${m.estimateAccuracy < 0 ? "under" : "over"}`,
          note: `Payers paid ${usd(Math.abs(m.estimateVariance))} ${m.estimateVariance < 0 ? "less" : "more"} than estimated on the claims they answered, net of anything won on appeal.`,
        };

  document.body.dataset.stageTitled = "insights";

  stage.innerHTML = `
    <div class="panel panel--board">
      <div class="board__top">
        <h1 class="board__h1">Where the money went</h1>
        <span class="fresh">${esc(dayLabel(report.period.from))} — ${esc(dayLabel(report.period.to))}</span>
      </div>

      <div class="hero">
        <div class="hero__v${m.collected > 0 ? "" : " hero__v--zero"}">${usd(m.collected)}</div>
        <p class="hero__n">
          collected from payers in this window${
            m.recovered > 0 ? `, of which ${usd(m.recovered)} was won back on appeal` : ""
          }.
        </p>
      </div>

      ${cashBlock}

      <div class="sigrow">
        <div class="sig">
          <div class="sig__k">Filed to payers</div>
          <div class="sig__v">${usd(m.filedToPayers)}</div>
          <div class="sig__n">claims actually sent in this window</div>
        </div>
        <div class="sig">
          <div class="sig__k">Expected</div>
          <div class="sig__v">${usd(m.expected)}</div>
          <div class="sig__n">what the estimates promised</div>
        </div>
        <div class="sig${m.denied > 0 ? " sig--lost" : ""}">
          <div class="sig__k">Denied</div>
          <div class="sig__v${m.denied === 0 ? " sig__v--zero" : ""}">${usd(m.denied)}</div>
          <div class="sig__n">${m.denied > 0 ? `${rate(m.denialRate)} of what was filed` : "nothing refused"}</div>
        </div>
        <div class="sig${m.recovered > 0 ? " sig--settled" : ""}">
          <div class="sig__k">Recovered</div>
          <div class="sig__v${m.recovered === 0 ? " sig__v--zero" : ""}">${usd(m.recovered)}</div>
          <div class="sig__n">${m.denied > 0 ? `${rate(m.recoveryRate)} of what was denied` : "nothing to recover"}</div>
        </div>
      </div>

      <section class="block">
        <h2 class="block__h">Estimates against what arrived</h2>
        <div class="verdict">
          <span class="verdict__v">${esc(estimate.v)}</span>
          <p class="verdict__n">${esc(estimate.note)}</p>
        </div>
        ${
          report.insights?.length
            ? `<ul class="findings">${report.insights.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
            : ""
        }
      </section>

      <section class="block">
        <h2 class="block__h">Payers</h2>
        <p class="block__n">
          The track is what each payer was filed; the filled part is what actually arrived.
          ${
            f.verificationsCompleted > 0
              ? `${rate(f.billingRate)} of completed verifications became a claim.`
              : ""
          }
        </p>
        ${
          payersRanked ||
          `<p class="viz__note">${plural(report.payers.length, "payer")} in this window — too few to rank.</p>`
        }
      </section>

      ${
        reasonRows
          ? `<section class="block">
               <h2 class="block__h">Why claims were refused</h2>
               <table class="lines">
                 <thead><tr>
                   <th>Reason</th><th class="num">Claims</th><th class="num">Denied</th>
                   <th class="num">Recovered</th><th class="num">Rate</th>
                 </tr></thead>
                 <tbody>${reasonRows}</tbody>
               </table>
             </section>`
          : ""
      }

      <p class="provenance">
        Derived from domain events, never from another module's tables.
        Filed counts claims sent in this window; cash counts payments posted in it, which is why a
        payment can appear for a claim filed before it.
      </p>
    </div>`;
}

/** Every open denial carrying one CARC code — the bridge from "what to fix" to "go and work it". */
async function showDenialsForCode(reason) {
  state.selectedId = reason.carcCode;
  const { items } = await api("GET", "/api/v1/denials?open=1");
  const matching = items.filter((d) => d.carcCode === reason.carcCode);

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">${esc(reason.description)}</h1>
          <div class="detail__id">
            <span class="tag">Denial reason ${esc(reason.carcCode)}</span>
            <span>${plural(reason.count, "denial")} in this period, worth <b>${usd(reason.denied)}</b></span>
            ${reason.recoveryRate !== null ? `<span>${pct(reason.recoveryRate)} recovered so far</span>` : ""}
          </div>
        </div>
      </div>
      <div class="handoff">
        A code that keeps coming back is usually a process defect, not a run of unlucky claims. Fixing
        the cause is worth more than winning any one of these appeals.
      </div>
      ${
        matching.length
          ? `<div class="eyebrow section-label">Still open</div>
             <ul class="worklist">${matching
               .map(
                 (d) => `<li class="worklist__row" data-id="${esc(d.id)}">
                   <span class="worklist__name">${esc(d.patientName)}</span>
                   <span class="worklist__act">${esc(d.recommendedAction)}</span>
                   <span class="worklist__amt">${usd(d.deniedAmount)}</span>
                 </li>`
               )
               .join("")}</ul>`
          : `<div class="stage-empty mt-20">Every denial with this code has been closed.</div>`
      }
    </div>`;

  for (const row of stage.querySelectorAll(".worklist__row")) {
    row.addEventListener("click", () => openDenial(row.dataset.id));
  }
}

function switchTab(tab, { intake = false } = {}) {
  state.tab = tab;
  state.selectedId = null;
  /**
   * Tear down FIRST, and unconditionally.
   *
   * This used to happen only on the branch that mounted the next screen, so leaving Money for any
   * legacy tab left the Money screen alive: its store subscription kept firing, and every timeframe
   * or filter change on the new tab redrew a screen that was no longer on the page — into a stage
   * element the legacy renderer had already overwritten. Unmounting here means no branch can forget.
   */
  unmountScreen();
  /** Cleared on every move; the Today renderer sets it again if it is the one that draws. */
  delete document.body.dataset.stageTitled;
  for (const btn of document.querySelectorAll(".tab")) {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
  }
  /**
   * Caught HERE, once, rather than on the three branches that happened to remember.
   *
   * `loadQueue` rejects when the caller may not read the queue — a dentist holds no `queue.read` —
   * and five of the nine branches below never touch `loading` at all. Every tab switch by such a
   * role therefore raised an unhandled rejection, silently in production and loudly enough to fail
   * a test that boots the client. The branches that DO consume it still handle their own render
   * errors; this only stops the shared promise from escaping.
   */
  /**
   * The sidebar worklist is loaded ONLY for the screens that still show it.
   *
   * `loadQueue` fires one or two requests and renders them into the `.queue` aside — which is
   * `display: none` on every screen built on the interaction foundation, because those screens carry
   * their own evidence table. Seven of the eight tabs were therefore paying for a fetch whose result
   * nobody could see, on every single navigation. On a slow connection that is seconds of latency
   * per tab switch, spent rendering into a hidden element.
   *
   * Test Lab is the one screen still drawn the old way, so it is the one that still needs it.
   */
  const NEEDS_SIDEBAR = new Set(["testlab"]);
  const loading = NEEDS_SIDEBAR.has(tab) ? loadQueue().catch(() => {}) : Promise.resolve();
  if (tab === "today") {
    screen = mountToday(stage, { store: ui, api });
    document.body.dataset.stageTitled = "today";
  } else if (tab === "insights") {
    screen = mountInsights(stage, { store: ui, api });
    document.body.dataset.stageTitled = "insights";
  } else if (tab === "patients") {
    screen = mountPatients(stage, { store: ui, api });
    document.body.dataset.stageTitled = "patients";
  } else if (tab === "ops") {
    screen = mountOps(stage, {
      store: ui,
      api,
      /*
       * Handed in rather than reached for. The shell knows about the screens; a screen must not
       * reach back into the shell. These two admin surfaces are not rebuilt yet, and passing them
       * keeps them reachable instead of stranding them behind a sidebar the new screens hide.
       */
      extras: [
        {
          label: "Contracted rates",
          note: "What each payer has actually been observed to allow.",
          run: () => showContractedRates().catch((e) => notify(e.message, "bad")),
        },
        {
          label: "Staff",
          note: "The people who can sign in, and what each may do.",
          run: () => showStaff().catch((e) => notify(e.message, "bad")),
        },
        {
          label: "Payment sources",
          note: "Which clearinghouse accounts Mermaid pulls remittance advice from.",
          run: () => showEraSources().catch((e) => notify(e.message, "bad")),
        },
      ],
    });
    document.body.dataset.stageTitled = "ops";
  } else if (tab === "testlab") {
    loading.then(() => showTestLab(state.testlab)).catch(() => {});
  } else if (tab === "claims") {
    screen = mountClaims(stage, { store: ui, api });
    document.body.dataset.stageTitled = "claims";
  } else if (tab === "money") {
    /* `apiRaw` and `notify` are handed in for the 835 upload: raw EDI bytes cannot go through the
       JSON `api()`, and a screen must not reach back into the shell for its own toast. */
    screen = mountMoney(stage, { store: ui, api, apiRaw, notify });
    document.body.dataset.stageTitled = "money";
  } else if (tab === "recovery") {
    screen = mountRecover(stage, { store: ui, api });
    document.body.dataset.stageTitled = "recovery";
  } else if (tab === "verifications") {
    /*
     * Two destinations, one tab. The Verify SCREEN answers "whose coverage has been checked"; the
     * intake FORM asks "check this person's coverage". They were the same tab only because the form
     * was the first thing built, and `intake` is how "New patient" still reaches it — without which
     * this change would have removed the only way to create a verification.
     */
    if (intake) showForm();
    else {
      screen = mountVerify(stage, { store: ui, api });
      document.body.dataset.stageTitled = "verifications";
    }
  } else {
    showForm();
  }
}

// ── Form ──────────────────────────────────────────────────────────────────
const SAMPLES = [
  { label: "Active · clean", firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345", card: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100" },
  { label: "Inactive coverage", firstName: "Ben", lastName: "Booker", dateOfBirth: "1978-11-03", memberId: "MEM10000", card: "Delta Dental\nMember ID: MEM10000" },
  { label: "Waiting period", firstName: "Dev", lastName: "Diaz", dateOfBirth: "2001-02-15", memberId: "MET30077", card: "MetLife Dental\nMember ID: MET30077" },
  { label: "Near annual max", firstName: "Cora", lastName: "Chen", dateOfBirth: "1985-06-21", memberId: "CIG20099", card: "Cigna Dental\nMember ID: CIG20099" },
  { label: "Unknown payer", firstName: "E.", lastName: "Osei", dateOfBirth: "1969-09-30", memberId: "XYZ99999", card: "Obscure Plan Co\nMember ID: XYZ99999" },
];

const DEFAULT_PLAN = [
  { code: "D0120", quantity: 1, fee: "" },
  { code: "D1110", quantity: 1, fee: "110" },
  { code: "D2750", quantity: 1, fee: "1250", tooth: "19" },
];

function addPlanRow(rowsEl, preset) {
  const tpl = document.getElementById("tpl-plan-row").content.cloneNode(true);
  const row = tpl.querySelector(".plan__row");
  const select = row.querySelector(".plan__code");
  for (const p of state.cdt) {
    const opt = document.createElement("option");
    opt.value = p.code;
    opt.textContent = `${p.code} · ${p.description}`;
    select.appendChild(opt);
  }
  if (preset) {
    select.value = preset.code;
    row.querySelector(".plan__tooth").value = preset.tooth ?? "";
    row.querySelector(".plan__qty").value = preset.quantity;
    row.querySelector(".plan__fee").value = preset.fee ?? "";
  }
  row.querySelector(".plan__remove").addEventListener("click", () => row.remove());
  rowsEl.appendChild(row);
}

function showForm() {
  state.selectedId = null;
  const tpl = document.getElementById("tpl-form").content.cloneNode(true);
  stage.replaceChildren(tpl);
  const form = stage.querySelector(".form");

  /*
   * Sample scenario chips, and the DB-free demo is the only place they belong.
   *
   * They prefill this form with a fictional person — Ada Alpha, Ben Booker — and the form's submit
   * creates a REAL verification against a REAL payer. On a Postgres-backed deployment that is a
   * fabricated patient in the practice's own data, reachable in one click, sitting in the Verify
   * list beside people who exist. `persistent` is exactly the right question to ask: it is false
   * only for the in-memory demo, where nothing outlives the process and nothing is at stake.
   *
   * `data-requires="audit.read"` already narrowed who sees these, which is not the same guarantee —
   * an owner of a real clinic passes that check.
   */
  const samples = form.querySelector(".form__samples");
  if (samples) samples.hidden = state.persistent;
  const chips = form.querySelector("#sample-chips");
  for (const s of state.persistent ? [] : SAMPLES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = s.label;
    chip.addEventListener("click", () => {
      form.firstName.value = s.firstName;
      form.lastName.value = s.lastName;
      form.dateOfBirth.value = s.dateOfBirth;
      form.memberId.value = s.memberId;
      form.cardText.value = s.card;
    });
    chips.appendChild(chip);
  }

  // Card photographs, downscaled in the browser before they are ever sent.
  wireCardImages(form);

  // Treatment-plan rows.
  const rowsEl = form.querySelector("#plan-rows");
  /*
   * A real estimate starts empty. `DEFAULT_PLAN` opens the form with a cleaning and a $1,250 crown
   * on tooth 19 already in it — figures nobody chose, on a form whose output is what the patient is
   * told they owe. Leaving them in makes the practice's own numbers the default-shaped ones, and
   * §4.4 is that a figure on this screen is a claim. One blank row instead, so the shape of the
   * control is still obvious without asserting anything.
   */
  for (const p of state.persistent ? [undefined] : DEFAULT_PLAN) addPlanRow(rowsEl, p);
  form.querySelector("#add-line").addEventListener("click", () => addPlanRow(rowsEl));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitForm(form);
  });

  // Refresh queue highlight (nothing selected now).
  for (const b of queueList.querySelectorAll(".qitem")) b.setAttribute("aria-current", "false");
}

/**
 * Card photographs (workflow S2).
 *
 * ── WHY THE BROWSER RESIZES BEFORE UPLOADING ───────────────────────────────────────────────────
 * A modern phone camera produces a 4–8 MB JPEG. The API's request-body ceiling is 1 MB, so an
 * unresized photo is a 413 at the front desk with nothing useful to say about why. Downscaling to
 * 1600px on the long edge is well above what any card needs to be legible — a card is ~86mm wide, so
 * this is roughly 470 dpi — and lands at a couple of hundred kilobytes.
 *
 * It also means the smallest image that will do the job is the only one that ever leaves the
 * building. That is a privacy property, not only a bandwidth one: this is PHI in transit to a third
 * party, and there is no reason to send a higher-resolution copy of a patient's card than the task
 * requires.
 *
 * Two images maximum, matching the server's limit: front and back.
 */
const MAX_CARD_EDGE = 1600;
const MAX_CARD_FILES = 2;

function wireCardImages(form) {
  const input = form.cardImages;
  const thumbs = form.querySelector("#card-thumbs");
  if (!input || !thumbs) return;

  input.addEventListener("change", async () => {
    thumbs.replaceChildren();
    form.__cardImages = [];

    const files = [...input.files].slice(0, MAX_CARD_FILES);
    if (input.files.length > MAX_CARD_FILES) {
      thumbs.insertAdjacentHTML(
        "beforeend",
        `<p class="card__note">Only the first ${MAX_CARD_FILES} images are used — the front and back of the card.</p>`
      );
    }

    for (const file of files) {
      try {
        const image = await downscaleToBase64(file);
        form.__cardImages.push(image);
        const img = document.createElement("img");
        img.className = "card-thumb";
        img.src = `data:${image.mediaType};base64,${image.base64}`;
        img.alt = "Insurance card photograph, to be read and then discarded";
        thumbs.appendChild(img);
      } catch {
        // A file the browser cannot decode is not worth failing a check-in over — the typed card
        // text is required regardless, so the verification proceeds without this image.
        thumbs.insertAdjacentHTML(
          "beforeend",
          `<p class="card__note">${esc(file.name)} could not be read as an image and was skipped.</p>`
        );
      }
    }

    if (form.__cardImages.length > 0) await readCardIntoForm(form);
  });
}

/**
 * Ask the server what the photographs say, then fill the form in.
 *
 * ── THE DEFECT THIS FIXES ──────────────────────────────────────────────────────────────────────
 * Uploading a card used to render a thumbnail and do nothing else. Extraction did run, but only
 * later, inside the verification itself — so the card-text box and the Member ID box a person was
 * looking at stayed empty, with no message explaining why. It read as broken software whether OCR
 * was configured or not, which is the worst of both.
 *
 * ── WHAT IS AND IS NOT WRITTEN ─────────────────────────────────────────────────────────────────
 * The transcription fills the card-text box, and Member ID fills in **only when it is still empty**.
 * A value already typed by a person is never overwritten by a machine — they had the card in their
 * hand, and the moment staff learn that typing gets silently replaced they stop trusting the form.
 * The same rule applies to every field.
 *
 * **Date of birth is never filled, because it is not printed on insurance cards.** Not on the Moda
 * sample, not on most cards. It comes from the patient, and no amount of OCR changes that.
 *
 * Everything written here is editable, and it all goes through the same verification pipeline as
 * typed text — this fills the form, it does not bypass a single gate.
 */
async function readCardIntoForm(form) {
  const status = form.querySelector("#card-read-status");
  const setStatus = (cls, html) => {
    if (status) status.innerHTML = `<p class="card-read ${cls}">${html}</p>`;
  };

  setStatus("card-read--busy", "Reading the card…");

  let result;
  try {
    result = await api("POST", "/api/v1/verifications/read-card", { cardImages: form.__cardImages });
  } catch (err) {
    setStatus("card-read--warn", `Could not read the card: ${esc(err.message)}. Type the card details below.`);
    return;
  }

  // Configured off. A permanent fact about this deployment, said once and plainly — not an error,
  // and not silence.
  if (!result.available) {
    setStatus(
      "card-read--off",
      "Card reading is not enabled on this deployment, so the photograph is kept with the record but " +
        "not read. Type the card details below."
    );
    return;
  }

  // Wired, but this photograph defeated it. A different problem with a different remedy.
  if (!result.read) {
    setStatus(
      "card-read--warn",
      "The card reader could not make out this photograph. Retake it in better light, or type the " +
        "card details below."
    );
    return;
  }

  const { transcription, fields, contested } = result.read;
  const fill = (input, extracted) => {
    if (!input || !extracted?.value) return false;
    if (input.value.trim() !== "") return false; // never overwrite a person
    input.value = extracted.value;
    return true;
  };

  if (transcription && form.cardText.value.trim() === "") form.cardText.value = transcription;
  const filledMemberId = fill(form.memberId, fields.memberId);

  const read = [
    fields.payerName?.value ? `payer <b>${esc(fields.payerName.value)}</b>` : null,
    fields.memberId?.value ? `member ID <b>${esc(fields.memberId.value)}</b>` : null,
    fields.groupNumber?.value ? `group <b>${esc(fields.groupNumber.value)}</b>` : null,
    fields.planName?.value ? `plan <b>${esc(fields.planName.value)}</b>` : null,
  ].filter(Boolean);

  const notes = [];
  if (!filledMemberId && fields.memberId?.value && form.memberId.value.trim() !== "") {
    notes.push("The Member ID you typed was kept — the card reads " + esc(fields.memberId.value) + ".");
  }
  notes.push("Date of birth is not printed on insurance cards; enter it from the patient.");
  if (contested?.length) notes.push(...contested.map(esc));

  setStatus(
    contested?.length ? "card-read--warn" : "card-read--ok",
    `Read from the photograph: ${read.length ? read.join(" · ") : "no fields could be made out"}. ` +
      `Check every value against the card before verifying.` +
      notes.map((n) => `<br><span class="card-read__note">${n}</span>`).join("")
  );
}

function downscaleToBase64(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_CARD_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      // JPEG at 0.85: a card is high-contrast print, which compresses well and stays legible.
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      resolve({ mediaType: "image/jpeg", base64: dataUrl.slice(dataUrl.indexOf(",") + 1) });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("not an image"));
    };
    img.src = url;
  });
}

/**
 * Read the address off the check-in form, or return null when it was left blank.
 *
 * Null and "four empty strings" are different things downstream: the first is an address nobody has
 * collected yet, which is legal all the way to the submit gate; the second is an address that looks
 * present and fails at the payer. The ZIP hyphen is stripped here because that is the shape an 837
 * carries, and the state is upper-cased because USPS codes are.
 */
function addressFrom(form) {
  const street = form.addressStreet?.value.trim() ?? "";
  const city = form.addressCity?.value.trim() ?? "";
  const state = (form.addressState?.value.trim() ?? "").toUpperCase();
  const zip = (form.addressZip?.value.trim() ?? "").replace(/-/g, "");
  if (!street && !city && !state && !zip) return null;
  return { address: { street, city, state, zip } };
}

async function submitForm(form) {
  const errEl = form.querySelector("#form-error");
  errEl.textContent = "";
  const planItems = [...form.querySelectorAll(".plan__row")].map((row) => {
    const fee = row.querySelector(".plan__fee").value.trim();
    const tooth = row.querySelector(".plan__tooth").value.trim();
    const item = { code: row.querySelector(".plan__code").value, quantity: Number(row.querySelector(".plan__qty").value) || 1 };
    if (fee !== "") item.feeDollars = Number(fee); // dollars; server converts to cents
    if (tooth !== "") item.toothNumber = tooth;
    return item;
  });
  const payload = {
    patient: {
      firstName: form.firstName.value,
      lastName: form.lastName.value,
      dateOfBirth: form.dateOfBirth.value,
      memberId: form.memberId.value,
      /**
       * The address is sent only when the desk actually filled it in.
       *
       * Four blank inputs must not become an address of four empty strings: that would satisfy
       * "present" everywhere downstream and fail at every payer. Absent is a real, supported state —
       * the verification proceeds, and the claim scrubber blocks the submit gate until somebody
       * supplies it. The server validates the shape and rejects a partial one.
       */
      ...(addressFrom(form) ?? {}),
    },
    cardText: form.cardText.value,
    ...(form.__cardImages?.length ? { cardImages: form.__cardImages } : {}),
    planItems,
  };
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "Verifying…";
  try {
    const view = await api("POST", "/api/v1/verifications", payload);
    state.selectedId = view.record.id;
    renderDetail(view);
    await loadQueue();
  } catch (err) {
    errEl.textContent = err.message;
    submitBtn.disabled = false;
    submitBtn.textContent = "Verify coverage";
  }
}

// ── Detail ────────────────────────────────────────────────────────────────
async function openDetail(id) {
  state.selectedId = id;
  const view = await api("GET", `/api/v1/verifications/${encodeURIComponent(id)}`);
  renderDetail(view);
  for (const b of queueList.querySelectorAll(".qitem")) b.setAttribute("aria-current", "false");
}

/**
 * The provenance block on the verification detail screen.
 *
 * Always rendered, for every verification, including the ones where everything went right. A panel
 * that only appears when something is wrong teaches people that its absence means "verified", and
 * absence is exactly what a missing feature and a healthy record have in common.
 *
 * Every value here comes from the server's `provenance` object. Nothing is recomputed in the
 * browser, and nothing is filled in when the server said it does not know.
 */
function provenanceBlock(p) {
  const cell = (label, value, absent) =>
    `<div>
       <div class="prov__k">${esc(label)}</div>
       <div class="prov__v ${value === null || value === undefined || value === "" ? "prov__v--absent" : ""}">${esc(
         value === null || value === undefined || value === "" ? (absent ?? "not applicable") : value
       )}</div>
     </div>`;

  const benefits = p.benefitsRetrieved
    ? [cell("Deductible", p.deductible), cell("Annual maximum", p.annualMaximum)]
    : [
        `<div class="span-all">
           <div class="prov__k">Benefit retrieval</div>
           <div class="prov__v prov__v--absent">None returned — ${esc(p.benefitsNote)}</div>
         </div>`,
      ];

  return `
    <div class="prov prov--${esc(p.kind)}">
      <div class="prov__head">
        <span class="src src--${esc(p.kind)}">${esc(p.label)}</span>
        <span class="prov__k">Where these benefits came from</span>
      </div>
      <p class="prov__why">${esc(p.explanation)}</p>
      <div class="prov__grid">
        ${cell("dataSource", p.dataSource)}
        ${cell("Payer", p.payerName, "unidentified")}
        ${cell(
          p.clearinghouseName ? `${p.clearinghouseName} payer ID` : "Clearinghouse",
          p.clearinghouseId,
          "none contacted"
        )}
        ${cell("Member ID", p.memberId, "none on file")}
        ${cell("Verification status", String(p.status).replace(/_/g, " "))}
        ${cell("Eligibility", p.eligibility ? String(p.eligibility).toUpperCase() : null, "not returned")}
        ${benefits.join("")}
        ${cell(
          `Amount at stake (${p.amountAtStakeLabel})`,
          p.amountAtStake === null ? null : usd(p.amountAtStake),
          "nothing priced"
        )}
        ${cell("Retained 271", p.raw271Bytes === null ? null : `${p.raw271Bytes} bytes`, "none")}
        ${cell(
          "Scopes the payer also stated",
          p.supersededBenefits === null || p.supersededBenefits === undefined
            ? null
            : `${p.supersededBenefits} discarded benefit ${p.supersededBenefits === 1 ? "segment" : "segments"}`,
          "not counted"
        )}
      </div>
      ${
        // A disclosure, not a warning: it changes no status and gates nothing (M24). Rendered only
        // when the payer actually described a scope this quote did not use.
        p.supersededNote
          ? `<p class="prov__why">${esc(p.supersededNote)}</p>`
          : ""
      }
    </div>`;
}

function renderDetail(view) {
  const { record: r, decision: d, patientSummary, freshness, provenance } = view;
  const calc = r.calculation;
  const statusLabel = r.status.replace("_", " ");

  const linesHtml = calc
    ? calc.lines
        .map(
          (l) => `
      <tr class="${l.denied ? "denied" : ""}">
        <td><span class="code">${esc(l.code)}</span><span class="desc-note">${esc(l.description)}${
          l.notes.length ? " · " + esc(l.notes[l.notes.length - 1]) : ""
        }${
          /*
            The contractual write-off, said on the LINE and not only in the totals (L-3).

            A capped line shows a $1,250.00 fee, $0.00 from insurance and $1,000.00 from the patient
            — three figures that visibly do not add up, on the row a patient's eye actually lands on.
            The totals block explains it, but nobody reconciles a row against a total; they ask at
            the desk, and whoever answers has to know the contract.

            Only when there is one, which is the minority of lines.
          */
          l.contractualWriteOff > 0
            ? ` · <b>${usd(l.contractualWriteOff)}</b> written off under this practice's contract — charged to nobody`
            : ""
        }</span></td>
        <td class="num"><span class="pill-pct">${l.denied ? "denied" : l.coveragePercent + "%"}</span></td>
        <td class="num">${usd(l.fee)}</td>
        <td class="num">${usd(l.insurancePays)}</td>
        <td class="num">${usd(l.patientPays)}</td>
      </tr>`
        )
        .join("")
    : "";

  const compsHtml = r.confidence.components
    .map(
      (c) => `
      <div class="comp">
        <div class="comp__row"><span class="comp__name">${esc(c.name)}</span><span class="comp__val">${pct(c.confidence)}</span></div>
        <div class="comp__bar"><span class="comp__fill" data-w="${Math.round(c.confidence * 100)}"></span></div>
        <div class="comp__why">${esc(c.explanation)}</div>
      </div>`
    )
    .join("");

  const flagsHtml = r.exceptions.length
    ? `<div class="flags">${r.exceptions
        .map(
          (f) => `<div class="flag flag--${f.severity}"><span class="flag__sev">${esc(f.severity)}</span><span>${esc(f.message)}</span></div>`
        )
        .join("")}</div>`
    : "";

  const tags = [];
  if (d.canNotifyPatient) tags.push(`<span class="tag tag--good">Estimate ready to share</span>`);
  if (d.escalate) tags.push(`<span class="tag tag--warn">Escalate</span>`);
  tags.push(`<span class="tag">Completed by ${d.completedBy ?? "—"}</span>`);

  // A settled verification has already been handed to billing over the event outbox.
  const billingHtml =
    d.outcome === "complete" && calc
      ? `<div class="handoff">
           This estimate has been handed to billing — a claim is waiting in the
           <button type="button" class="linkish" id="go-claims">Claims</button> worklist,
           carrying this exact estimate. A person still releases it to the payer.
         </div>`
      : "";

  const reasoningHtml = d.reasoning.length
    ? `<ul class="decision__rec nested-list">${d.reasoning.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
    : "";

  const passed = r.confidence.overall >= r.confidence.reviewThreshold;

  const summaryHtml = patientSummary.length
    ? `<div class="card card--patient">
         <div class="card__title">Read to the patient</div>
         ${patientSummary.map((s) => `<p class="summary-p">${esc(s)}</p>`).join("")}
         <p class="card__note">A team member shares this — Mermaid never messages patients automatically.</p>
       </div>`
    : "";

  const reviewHtml = r.review
    ? `<div class="reviewed-note ${r.review.decision === "rejected" ? "reviewed-note--rejected" : ""}">
         Reviewed — <b>${esc(r.review.decision)}</b>${r.review.notes ? ` · ${esc(r.review.notes)}` : ""}
       </div>`
    : d.outcome !== "complete"
      ? `<div class="review">
           <div class="review__title">This case needs a person</div>
           <p class="review__hint">${esc(d.recommendedAction)}</p>
           <label class="field mb-12"><span class="field__label">Notes (optional)</span>
             <input class="input" id="review-notes" placeholder="e.g. Confirmed active by phone with payer" /></label>
           <div class="review__actions">
             <button class="btn btn--approve" data-decision="approved">Approve</button>
             <button class="btn btn--override" data-decision="overridden">Override & approve</button>
             <button class="btn btn--reject" data-decision="rejected">Reject</button>
           </div>
         </div>`
      : "";

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">${esc(r.patient.firstName)} ${esc(r.patient.lastName)}</h1>
          <div class="detail__id">
            <span class="tag">Verification</span>
            ${srcBadge(provenance)}
            <span>DOB <b>${esc(orDash(r.patient.dateOfBirth))}</b></span>
            <span><b>${esc(r.benefits?.payerName || r.card.payerName.value || "Unknown payer")}</b></span>
            <span>Member <b class="mono">${esc(r.card.memberId.value || r.patient.memberId || "—")}</b></span>
            <span>Freshness <b>${esc(freshness.status)}</b></span>
            <!--
              How the card was read is a fact about the record, so it sits with the other
              identifying facts rather than in a panel someone has to open. A reviewer settling this
              case needs to know a model read the card before they judge the fields it produced.
            -->
            ${r.card.memberId.source === "vision" ? `<span class="tag tag--ai">read from a photograph by AI</span>` : ""}
          </div>
        </div>
        <span class="status status--${r.status}">${esc(statusLabel)}</span>
      </div>

      <div class="decision">
        <div>
          <div class="eyebrow decision__action-label">Recommended action</div>
          <div class="decision__action">${esc(d.recommendedAction)}</div>
          ${reasoningHtml}
          <div class="decision__tags">${tags.join("")}</div>
        </div>
        <div class="gauge">
          <div class="gauge__row"><span class="gauge__val">${pct(r.confidence.overall)}</span><span class="gauge__label">Confidence</span></div>
          <div class="meter">
            <span class="meter__fill meter__fill--${passed ? "pass" : "fail"}" data-w="${Math.round(r.confidence.overall * 100)}"></span>
            <span class="meter__thr" data-left="${Math.round(r.confidence.reviewThreshold * 100)}"></span>
          </div>
          <div class="gauge__thr-note">auto-verify threshold ${pct(r.confidence.reviewThreshold)}</div>
        </div>
      </div>

      <!--
        Between the decision and the money, deliberately. Whoever is about to read a patient a
        dollar figure passes this on the way there, which is the only placement that makes the
        source of those numbers unmissable rather than merely available.
      -->
      ${provenanceBlock(provenance)}

      ${calc ? `
      <div class="totals">
        <div class="total total--patient"><div class="total__label">Patient owes</div><div class="total__val">${usd(calc.totalPatientPays)}</div></div>
        <div class="total"><div class="total__label">Insurance pays</div><div class="total__val">${usd(calc.totalInsurancePays)}</div></div>
        <!--
          The contractual write-off (F-1). Shown ONLY when a rate has actually been observed, because
          on a plan priced off billed fees it is zero and a row of zeroes teaches people to ignore
          the row.

          It has to be shown when it is non-zero. These three figures used to sum to the total, and
          now they do not — the write-off is the difference. Leaving it out would present a patient
          with a plan whose parts visibly fail to add up, which is worse than the defect it fixes.
        -->
        ${
          calc.totalContractualWriteOff > 0
            ? `<div class="total" title="Your dentist has a contract with this payer that sets what each procedure costs. The difference between the practice fee and that agreed amount is written off — neither you nor your insurance pays it.">
                 <div class="total__label">Written off by contract</div>
                 <div class="total__val">${usd(calc.totalContractualWriteOff)}</div>
               </div>`
            : ""
        }
        <div class="total"><div class="total__label">Total plan</div><div class="total__val">${usd(calc.totalFee)}</div></div>
      </div>
      <div class="eyebrow section-label">Itemized estimate</div>
      <table class="lines">
        <thead><tr><th>Procedure</th><th class="num">Covered</th><th class="num">Fee</th><th class="num">Insurance</th><th class="num">Patient</th></tr></thead>
        <tbody>${linesHtml}</tbody>
      </table>` : ""}

      <div class="cards">
        ${summaryHtml}
        <div class="card">
          <div class="card__title">Confidence breakdown</div>
          ${compsHtml}
        </div>
      </div>

      ${flagsHtml}
      ${billingHtml}
      ${reviewHtml}

      <details class="report">
        <summary>Printable verification report</summary>
        <pre>${esc(r.reportText)}</pre>
      </details>
    </div>`;

  // Animate meters after paint.
  requestAnimationFrame(() => {
    for (const el of stage.querySelectorAll("[data-w]")) el.style.transform = `scaleX(${Number(el.dataset.w) / 100})`;
    /**
     * The auto-verify threshold marker. It carried an inline "left: N%" and therefore never moved:
     * the CSP is style-src 'self', which drops inline style ATTRIBUTES, so the marker sat at the
     * meter's left edge on every screen while claiming to mark the threshold. Assigning through
     * element.style is the CSSOM path and is permitted — the same idiom the fills above already use.
     */
    for (const el of stage.querySelectorAll("[data-left]")) el.style.left = `${Number(el.dataset.left)}%`;
  });

  stage.querySelector("#go-claims")?.addEventListener("click", () => switchTab("claims"));

  // Wire review actions.
  for (const btn of stage.querySelectorAll(".review__actions .btn")) {
    btn.addEventListener("click", async () => {
      const notes = stage.querySelector("#review-notes")?.value ?? "";
      for (const b of stage.querySelectorAll(".review__actions .btn")) b.disabled = true;
      try {
        const updated = await api("POST", `/api/v1/verifications/${encodeURIComponent(r.id)}/review`, {
          decision: btn.dataset.decision,
          notes,
        });
        renderDetail(updated);
        await loadQueue();
      } catch (err) {
        notify(err.message, "bad");
      }
    });
  }
}

// ── Claim detail ──────────────────────────────────────────────────────────
async function openClaim(id) {
  state.selectedId = id;
  renderClaim(await api("GET", `/api/v1/claims/${encodeURIComponent(id)}`));
  for (const b of queueList.querySelectorAll(".qitem")) {
    b.setAttribute("aria-current", "false");
  }
}

function findingsHtml(findings, kind) {
  if (!findings.length) return "";
  const label = kind === "error" ? "Must fix before filing" : "Worth a look";
  return `
    <div class="eyebrow section-label">${label}</div>
    <div class="flags">
      ${findings
        .map(
          (f) => `<div class="flag flag--${kind === "error" ? "critical" : "warning"}">
            <span class="flag__sev">${esc(f.code)}</span>
            <span><b>${esc(f.message)}</b><br /><span class="flag__fix">${esc(f.remediation)}</span></span>
          </div>`
        )
        .join("")}
    </div>`;
}

/**
 * Payer versus estimate, on the claim (F-7).
 *
 * The figure has been computed on every posting since the variance engine existed and no screen read
 * it. So a practice could quote a patient from an estimate, be paid something else, and never find
 * out the estimate was wrong — until the patient called about a bill that did not match what they
 * were told.
 *
 * Rendered whenever a payer has actually paid. Not rendered before then: a variance against a payer
 * who has not answered is unknown, and printing "$0.00" would claim the estimate had been confirmed
 * by a payment nobody has made.
 *
 * Always shown here, material or not. The materiality band (F-6) governs the worklist CHIP, which
 * competes for attention with every other row; the detail is a screen someone opened on purpose, and
 * a person who came to look at one claim is entitled to the exact figure whichever way it lands.
 */
function varianceHtml(v) {
  if (!v) return "";
  const short = v.unexplained < 0;
  /**
   * Only a material SHORTFALL takes the alarmed treatment. A material overpayment is worth reading —
   * it is money subject to takeback — but it is not the practice being underpaid, and colouring it
   * the same red would teach staff that red means "a number is unusual" rather than "you are owed
   * money". The tag carries the distinction in words; the card stays neutral.
   */
  const tone = v.material && short ? " card--reject" : "";
  /**
   * The recovery line appears only on claims that actually won an appeal, which is a small minority.
   * It is the difference between "the payer overpaid you by $971.49, check for a duplicate" and
   * "you won $1,125.00 on appeal, and the original adjudication was $153.51 under estimate" — the
   * same two numbers, one of which sends a biller hunting for a mistake that is not there.
   */
  const recoveryHtml = v.appealRecovered > 0
    ? `<p class="card__note">
         Includes <b class="pos">${usd(v.appealRecovered)}</b> recovered on appeal — money with a known
         cause, so it is excluded from the comparison above. The estimate is judged on the
         <b>${usd(Math.abs(v.unexplained))}</b> that remains.
       </p>`
    : "";
  return `
    <div class="eyebrow section-label">Payer vs estimate</div>
    <div class="card${tone}">
      <div class="card__title">
        ${v.unexplained === 0 ? "Paid as estimated" : `${usd(Math.abs(v.unexplained))} ${short ? "less" : "more"} than estimated`}
        <span class="tag tag--${v.material ? "warn" : "good"}">${v.material ? "worth a look" : "within tolerance"}</span>
      </div>
      <p class="summary-p">${esc(v.summary)}</p>
      ${recoveryHtml}
      <p class="card__note">
        Estimated <b>${usd(v.expected)}</b> · payer paid <b>${usd(v.paid)}</b> ·
        unexplained <b class="${short ? "neg" : "pos"}">${short ? "−" : "+"}${usd(Math.abs(v.unexplained))}</b>.
        Differences up to ${usd(v.threshold)} on a claim this size are treated as rounding and not flagged.
      </p>
    </div>`;
}

function renderClaim(view) {
  const { claim: c, filing, blockers, advisories, canSubmit, submitBlockedReason, recommendedAction } = view;
  const snap = c.coverageSnapshot;

  const linesHtml = c.lines
    .map(
      (l) => `
      <tr class="${l.estimatedDenied ? "denied" : ""}">
        <td>
          <span class="code">${esc(l.code)}</span>
          <span class="desc-note">${esc(l.description)}${l.toothNumber ? ` · tooth ${esc(l.toothNumber)}` : ""}${
            /*
              Same reason as on the estimate (L-3): without it the row shows a fee, an insurance
              share and a patient share that visibly do not add up, on the screen a biller works
              from. Only present on lines a contract actually priced.
            */
            l.contractualWriteOff > 0
              ? ` · <b>${usd(l.contractualWriteOff)}</b> written off by contract`
              : ""
          }</span>
        </td>
        <td class="num">${l.quantity}</td>
        <td class="num">${usd(l.fee)}</td>
        <td class="num">${usd(l.expectedInsurancePays)}</td>
        <td class="num">${usd(l.expectedPatientPays)}</td>
      </tr>`
    )
    .join("");

  const sub = c.submission;
  const submissionHtml = sub
    ? `<div class="card card--${sub.outcome === "accepted" ? "patient" : "reject"}">
         <div class="card__title">Payer acknowledgement</div>
         <p class="summary-p"><b>${esc(sub.outcome)}</b> — ${esc(sub.message)}</p>
         <p class="card__note">
           Control number <b class="mono">${esc(sub.controlNumber)}</b> ·
           filed by ${esc(sub.submittedBy)} on ${esc(sub.submittedAt.slice(0, 10))}
           ${sub.statusCategory ? ` · X12 status ${esc(sub.statusCategory)}/${esc(sub.statusCode)}` : ""}
         </p>
         ${
           sub.lineErrors.length
             ? `<ul class="line-errors">${sub.lineErrors
                 .map((e) => `<li>Line ${e.lineNumber}: ${esc(e.message)} (${esc(e.code)})</li>`)
                 .join("")}</ul>`
             : ""
         }
         ${
           (sub.unattributedLineErrors ?? []).length
             ? `<ul class="line-errors">${(sub.unattributedLineErrors ?? [])
                 .map(
                   (e) =>
                     `<li><b>Needs review</b> — the payer reported ${esc(e.procedureCode ?? "a service")}: ${esc(e.message)} (${esc(e.code)}), but this claim carries ${
                       e.reason === "ambiguous-duplicate-procedure"
                         ? "that procedure more than once, so which line it means is not stated"
                         : e.reason === "unknown-procedure-code"
                           ? "no such procedure"
                           : "no procedure code was readable"
                     }.</li>`
                 )
                 .join("")}</ul>`
             : ""
         }
       </div>`
    : "";

  /**
   * ── WHICH ADVICE THE TOTALS ABOVE WERE TAKEN FROM ─────────────────────────────────────────────
   * Each advice RESTATES how it split the charge; they do not accumulate. Pia Phase32 has two —
   * one writing off $142.50 and assigning the patient $149.52, and an appeal settlement writing off
   * $125.00 on the line it paid — while the totals correctly report a single $142.50 write-off.
   *
   * Both cards were individually true and, stacked, invited exactly the wrong arithmetic: a reader
   * adding them gets $267.50 written off against a claim that lost $142.50, and no line on the
   * screen said the figures replace rather than sum.
   *
   * The selection rule is the same one `totalPatientResponsibility` uses, so the card the totals
   * came from is the card marked here.
   */
  const adjudicatingId = [...c.payments]
    .reverse()
    .find((p) =>
      p.restatesPatientResponsibility !== undefined
        ? p.restatesPatientResponsibility
        : p.patientResponsibility > 0
    )?.postingId;
  /** True once any advice has settled the claim — an earlier one is then history, not a shortfall. */
  const claimSettled = c.payments.some((p) => p.settled);

  const paymentsHtml = c.payments.length
    ? `<div class="eyebrow section-label">Payments received</div>
       ${
         c.payments.length > 1
           ? `<p class="card__note">Each advice restates how the payer split this charge — these figures replace
                one another, they do not add up. The totals above come from the advice marked
                <b>adjudicating</b>.</p>`
           : ""
       }
       <div class="cards cards--stack">
         ${c.payments
           .map(
             (p) => `<div class="card">
               <div class="card__title">${usd(p.paidAmount)} on ${esc(p.postedAt.slice(0, 10))}
                 <span class="tag tag--${p.settled ? "good" : "warn"}">${p.settled ? "payer settled" : esc(p.outcome.replace("_", " "))}</span>
                 ${
                   p.postingId === adjudicatingId && c.payments.length > 1
                     ? `<span class="tag" title="The patient's share and the contractual write-off in the totals above are read from this advice — the payer's most recent word on how it split the charge.">adjudicating</span>`
                     : ""
                 }
               </div>
               <p class="summary-p">
                 Contractual write-off ${usd(p.contractualAdjustments)} · patient responsibility ${usd(p.patientResponsibility)}${
                   (p.coordinationAmount ?? 0) > 0 ? ` · with another plan ${usd(p.coordinationAmount)}` : ""
                 }
                 ${p.variance !== 0 ? ` · variance <b class="${p.variance < 0 ? "neg" : "pos"}">${p.variance < 0 ? "−" : "+"}${usd(Math.abs(p.variance))}</b>` : ""}
               </p>
               <p class="card__note">Trace <b class="mono">${esc(p.traceNumber)}</b>${
                 /*
                  * A coordinated advice is deliberately not `settled` — another plan has not ruled.
                  * Reading that as "money still outstanding" pointed a biller at THIS payer, which
                  * is finished. The instrument is a secondary claim, not a chase.
                  */
                 p.settled
                   ? " · fully settled"
                   : (p.coordinationAmount ?? 0) > 0
                     ? ` · ${usd(p.coordinationAmount)} awaiting another plan`
                     : claimSettled
                       ? /*
                          * An earlier advice on a claim a later one settled. It was not settled WHEN
                          * IT ARRIVED, which is what the flag records — but printing "money still
                          * outstanding" on a claim marked PAID contradicts its own header.
                          */
                         " · superseded by a later advice"
                       : " · money still outstanding"
               }</p>
             </div>`
           )
           .join("")}
       </div>`
    : "";

  // The submit gate. A named person, or nothing happens — this is the whole point of the screen.
  const gateHtml =
    c.status === "ready" || c.status === "draft" || c.status === "rejected"
      ? `<div class="review">
           <div class="review__title">${canSubmit ? "Release this claim to the payer" : "Not ready to file"}</div>
           <p class="review__hint">${esc(canSubmit ? recommendedAction : submitBlockedReason)}</p>
           <label class="field mb-12">
             <span class="field__label">Submitting on behalf of</span>
             <input class="input" id="submitted-by" value="${esc(state.submittedBy)}" ${canSubmit ? "" : "disabled"} />
           </label>
           <div class="review__actions">
             <button class="btn btn--approve" id="submit-claim" ${canSubmit ? "" : "disabled"}>Submit claim</button>
             <button class="btn btn--ghost" id="rescrub-claim">Re-run scrubber</button>
             <button class="btn btn--reject" id="void-claim">Void</button>
           </div>
           <p class="card__note">Mermaid never files a claim on its own — a person always releases it.</p>
         </div>`
      : "";

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">${esc(c.patient.firstName)} ${esc(c.patient.lastName)}</h1>
          <div class="detail__id">
            <span class="tag">Claim</span>
            <span><b>${esc(c.payer.payerName || "Unknown payer")}</b></span>
            <span>Member <b class="mono">${esc(c.patient.memberId)}</b></span>
            <span>Service <b>${esc(c.serviceDate)}</b></span>
            ${
              /* Once the payer has the claim the window is spent; showing it keeps counting down on history. */
              view.filingMatters
                ? `<span>File by <b${filing.estimateNote ? ` title="${esc(filing.estimateNote)}"` : ""}>${esc(c.filingDeadline)}</b>${filing.estimated ? ` <span class="tag tag--warn">estimate</span>` : filing.source ? ` <span class="tag">payer-published</span>` : ""}</span>`
                : `<span>Filed <b>${esc(c.submission?.submittedAt?.slice(0, 10) ?? "—")}</b></span>`
            }
          </div>
        </div>
        <span class="status status--claim-${c.status}">${esc(c.status.replace(/_/g, " "))}</span>
      </div>

      <div class="decision">
        <div>
          <div class="eyebrow decision__action-label">Recommended action</div>
          <div class="decision__action">${esc(recommendedAction)}</div>
          <div class="decision__tags">
            <span class="tag">Inherited from verification ${esc(c.verificationId.slice(0, 8))}</span>
            <span class="tag">Snapshot v${snap.snapshot_version} · verified ${esc(snap.verifiedAt.slice(0, 10))}</span>
          </div>
        </div>
        ${
          view.filingMatters
            ? `<div class="gauge">
          <div class="gauge__row">
            <span class="gauge__val gauge__val--${filing.risk}">${filing.daysRemaining}</span>
            <span class="gauge__label">Days to file${filing.estimated ? " (estimated)" : ""}</span>
          </div>
          <div class="gauge__thr-note">${esc(filing.message)}</div>
        </div>`
            : ""
        }
      </div>

      ${claimMoneyChain(view)}

      <div class="totals">
        <div class="total"><div class="total__label">Charge</div><div class="total__val">${usd(c.totalFee)}</div></div>
        ${
          /*
           * The ESTIMATE's write-off, and only while it is the only one there is.
           *
           * Once a payer has ruled, the block below adds the write-off the payer ACTUALLY took, and
           * both rows carried the identical label "Written off by contract". On a claim quoted
           * against a learned rate that is two different numbers, side by side, with nothing saying
           * which is the prediction and which is the fact.
           */
          c.totalContractualWriteOff > 0 && c.payments.length === 0
            ? `<div class="total" title="Predicted from the contracted rate this practice has learned for this payer. The payer has not ruled yet — this is an estimate.">
                 <div class="total__label">Write-off (estimated)</div>
                 <div class="total__val">${usd(c.totalContractualWriteOff)}</div>
               </div>`
            : ""
        }
        <div class="total"><div class="total__label">Expected from insurance</div><div class="total__val">${usd(c.expectedInsurancePays)}</div></div>
        ${
          c.payments.length
            ? (() => {
                /*
                 * "Still owed" has to mean money worth pursuing, and materiality is how the rest of
                 * the system decides that.
                 *
                 * Kira Demo's claim showed "STILL OWED $0.01" directly above "$482.51 WITH OTHER
                 * INSURANCE", while the variance block on the SAME screen read "The payer paid
                 * $799.99 against an estimate of $800.00 — as expected" with `material: false`
                 * against a $1.00 threshold. Two panels, one claim, opposite verdicts — and the
                 * penny sat at the top where it reads as "essentially complete".
                 *
                 * A shortfall inside the materiality band is one the payer is not going to be
                 * chased for. The row says what actually happened: the money arrived.
                 */
                const chase = view.outstanding > 0 && view.variance?.material !== false;
                return `<div class="total ${chase ? "total--attention" : "total--settled"}">
                 <div class="total__label">${chase ? "Still owed" : "Received"}</div>
                 <div class="total__val">${usd(chase ? view.outstanding : view.paidAmount)}</div>
               </div>`;
              })()
            : ""
        }
        ${
          /*
           * The patient's share stays on the totals, before AND after the payer rules.
           *
           * It used to be swapped OUT for "Received" the moment a payment posted, so a settled claim
           * read 1,425.00 charged, 799.99 received, and left 625.01 unaccounted for on the one row
           * a biller reconciles from. Both missing figures were on the screen already, in prose inside
           * the payments card below, which is not where anyone adds up a claim.
           *
           * Before adjudication this is the ESTIMATE (what the patient was quoted); afterwards it is
           * what the PAYER assigned, which is the number to bill and is frequently not the quote.
           */
          c.payments.length
            ? `${
                view.contractualAdjustment > 0
                  ? `<div class="total" title="What the payer ACTUALLY took off under this practice's contracted rate, on its own advice. Neither the payer nor the patient pays this amount.">
                       <div class="total__label">Written off by contract</div>
                       <div class="total__val">${usd(view.contractualAdjustment)}</div>
                     </div>`
                  : ""
              }${
                /*
                 * Money a SECOND plan still has to rule on (M8).
                 *
                 * Without this row a coordinated claim does not add up on the one screen a biller
                 * reconciles from. Kira Demo's advice pays $799.99 on a $1,425.00 charge, writes off
                 * $142.50, and assigns $482.51 to a secondary — so the totals accounted for $942.49
                 * and said nothing about the rest.
                 */
                view.coordinationPending > 0
                  ? `<div class="total total--open" title="The primary payer assigned this to another plan's adjudication (coordination of benefits). It is neither a write-off nor the patient's until the secondary has ruled — file the secondary claim and post its remittance first.">
                       <div class="total__label">With other insurance</div>
                       <div class="total__val">${usd(view.coordinationPending)}</div>
                     </div>`
                  : ""
              }<div class="total total--patient" title="${
                view.patientShareIsPending
                  ? "The PRIMARY payer's view only. A secondary plan has not ruled yet, so this is not what to bill — and it is not a statement that the patient owes nothing."
                  : "What the payer assigned to the patient on its own advice. Bill this, not the original quote."
              }">
                 <div class="total__label">${
                   view.patientShareIsPending ? "Patient share (not final)" : "Patient owes"
                 }</div>
                 <div class="total__val">${usd(view.patientResponsibility)}${
                   view.patientShareIsPending ? `<span class="tag tag--warn">pending secondary</span>` : ""
                 }</div>
               </div>`
            : `<div class="total total--patient"><div class="total__label">Patient was quoted</div><div class="total__val">${usd(c.expectedPatientPays)}</div></div>`
        }
      </div>

      <div class="eyebrow section-label">Service lines (inherited from the estimate — never recalculated)</div>
      <table class="lines">
        <thead><tr><th>Procedure</th><th class="num">Qty</th><th class="num">Charge</th>${
          /*
           * Once a payer has ruled, these two columns are the QUOTE sitting under a totals block
           * showing the adjudication. The section label said so; the columns did not, and a reader
           * scanning the table reads the headers.
           */
          c.payments.length
            ? `<th class="num">Insurance (est.)</th><th class="num">Patient (est.)</th>`
            : `<th class="num">Insurance</th><th class="num">Patient</th>`
        }</tr></thead>
        <tbody>${linesHtml}</tbody>
      </table>

      ${preAuthHtml(c)}
      ${findingsHtml(blockers, "error")}
      ${addressFixHtml(c)}
      ${findingsHtml(advisories, "warning")}
      ${submissionHtml}
      ${varianceHtml(view.variance)}
      ${paymentsHtml}
      ${gateHtml}

      <details class="report">
        <summary>Audit trail</summary>
        <pre>${esc(c.audit.map((a) => `${a.timestamp}  [${a.actor}]  ${a.message}`).join("\n"))}</pre>
      </details>
      ${
        sub?.raw837
          ? `<details class="report"><summary>Filed X12 837D</summary><pre>${esc(sub.raw837.replaceAll("~", "~\n"))}</pre></details>`
          : ""
      }
    </div>`;

  wireClaimActions(c.id);
}

/**
 * V5 — the inline fix for a claim held on its subscriber address.
 *
 * Rendered directly under the blocking finding, because that is where the person is looking and the
 * whole defect was that the finding told them what was wrong with no way to act on it. Before this,
 * the only remedy was to verify the patient again: a wasted eligibility call, a duplicate record,
 * and the original claim stranded.
 *
 * Only shown while the claim can still be corrected. Once a payer holds it the honest answer is a
 * corrected claim, not a quiet edit, so the form simply is not there.
 */
/**
 * Pre-authorisation: what the payer requires, what is on record, and what it is worth.
 *
 * ── WHY THIS IS ITS OWN BLOCK AND NOT A SCRUB FINDING ─────────────────────────────────────────
 * The scrubber already blocks the claim, and a blocker is a sentence. This is the place a person
 * DOES something: it names the exposure, shows the payer's own rule, and takes the authorisation
 * number. A finding that says "get approval" with nowhere to record the answer is a dead end.
 *
 * Rendered only where there is something to say — a plan needing no approval shows nothing, because
 * a pre-auth panel on every ordinary claim is one nobody reads.
 */
/**
 * Where a charge went, as one object that reconciles — the brief's chain, rendered:
 *
 *   CHARGED -> INSURANCE PAID -> CONTRACTUAL WRITE-OFF -> OTHER INSURANCE (COB)
 *           -> PATIENT RESPONSIBILITY -> RECOVERABLE -> STILL OUTSTANDING
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────────────────────────
 * Every figure below was already on the claim screen, spread across a totals row, a variance card
 * and a payments card, in three different orders. A biller reconciling a claim had to hold five
 * numbers in their head and check they added up — and when they did not, nothing said so. The
 * screen was accurate and the reader was doing the arithmetic.
 *
 * ── THE LAST ROW IS THE POINT ─────────────────────────────────────────────────────────────────
 * The destinations sum to the charge, and the check line says whether they do. It is rendered even
 * when it balances: a reconciliation that only appears when something is wrong is one nobody
 * learns to trust, because they never see it working.
 *
 * `rows` are {key, label, note, amount}. A zero destination is dropped — a row of "$0.00" on every
 * claim is a row nobody reads — except where a zero is itself the finding, which the caller marks
 * with `always: true`.
 */
/**
 * Aging, as proportion.
 *
 * The four buckets already existed as four equal boxes, which is the one layout that hides what
 * they exist to show: $50 sitting at 90+ and $5,000 sitting at current look identical in equal
 * boxes, and the whole point of aging is that money loses value as it ages. The bar is the shape;
 * the boxes underneath keep the exact figures.
 */
/**
 * The practice's own money chain, over the reporting window.
 *
 * ── WHAT QUESTION THIS ANSWERS ────────────────────────────────────────────────────────────────
 * "Of everything I billed payers this period, where is it?" An owner had to assemble that from
 * three separate figures — filed, expected, collected — that do not belong to the same set of
 * claims and therefore do not subtract from one another. Filed counts claims SENT; collected counts
 * money that ARRIVED, some of it on claims filed months ago.
 *
 * So this chain is deliberately built on the PATIENT and PAYER positions that do reconcile against
 * each other, and the caption names the window. Where a figure cannot honestly be placed in the
 * chain it is left out rather than forced into it.
 */

function practiceMoneyChain(m, period) {
  /**
   * Denied-and-unrecovered is money a payer refused and nobody has won back — genuinely at risk,
   * and the row an owner should look at first.
   */
  const stillDenied = Math.max(0, m.denied - m.recovered);
  const patientOutstanding = Math.max(0, m.patientBilled - m.patientCollected - m.patientForgiven);

  const tracked = m.collected + stillDenied + patientOutstanding + m.patientCollected;

  return moneyChain({
    charged: tracked,
    /**
     * NOT "Charged". These four rows are where money that has already been adjudicated or billed
     * currently sits; they are not a partition of anything the practice charged, and the total is
     * their own sum — so calling it "Charged" put a fabricated production figure on an owner's
     * dashboard, and the "every dollar is accounted for" check below it could never fail because it
     * compared the sum to itself.
     *
     * "Filed to payers" on the same screen is the real billing figure, and the two differ by
     * everything a payer wrote off plus everything still awaited. Naming that difference is what
     * stops a reader having to reconcile two totals nobody labelled.
     */
    totalLabel: "Tracked here",
    checkLine:
      `These four are where money already adjudicated or billed currently sits. This is not the ` +
      `practice's production — "Filed to payers" above is what went to payers, and the difference is ` +
      `contractual write-offs plus claims no payer has answered yet.`,
    caption: `Where the money is — ${String(period?.from ?? "").slice(0, 10)} to ${String(period?.to ?? "").slice(0, 10)}`,
    rows: [
      {
        key: "paid",
        label: "Collected from payers",
        note: "cash that arrived and was posted in this window",
        amount: m.collected,
      },
      {
        key: "patient",
        label: "Collected from patients",
        note: "payments recorded against patient accounts",
        amount: m.patientCollected,
        always: true,
      },
      {
        key: "owed",
        label: "Owed by patients",
        note: "billed to patients and not yet paid — the half nobody chases",
        amount: patientOutstanding,
      },
      {
        key: "risk",
        label: "Denied and not recovered",
        note: "a payer refused it and no appeal has won it back",
        amount: stillDenied,
        always: true,
      },
    ],
  });
}


function agingBar(aging) {
  const total = Object.values(aging).reduce((a, b) => a + b, 0);
  if (total <= 0) return "";
  /*
   * Nothing to compare, nothing to draw. One populated bucket renders as a single full-width block
   * — a chart that says only "all of it is in one place", which the four cells underneath say
   * better and with the figure attached.
   */
  if (Object.values(aging).filter((v) => v > 0).length < 2) return "";
  return `
    <svg class="agebar" viewBox="0 0 100 1" preserveAspectRatio="none" role="img"
         aria-label="${esc(Object.entries(AGING_LABEL).map(([k, l]) => `${l} ${usd(aging[k])}`).join("; "))}">
      ${(() => {
        let ax = 0;
        return Object.keys(AGING_LABEL)
          .map((k) => {
            if (aging[k] <= 0) return "";
            const w = Math.max(0.4, (aging[k] / total) * 100);
            const rect = `<rect x="${ax.toFixed(3)}" y="0" width="${w.toFixed(3)}" height="1" class="agebar__seg agebar__seg--${k}"><title>${esc(AGING_LABEL[k])} — ${usd(aging[k])}</title></rect>`;
            ax += w;
            return rect;
          })
          .join("");
      })()}
    </svg>`;
}

/**
 * `totalLabel` and `checkLine` exist because this component is used for two different questions.
 *
 * On a CLAIM the rows are the payer's own partition of the charge, "Charged" is a real figure the
 * rows must reconcile to, and the check is a genuine test that can fail — it caught a real
 * double-count on the coordination-of-benefits claim.
 *
 * At PRACTICE level there is no such figure. `practiceMoneyChain` passed the SUM OF ITS OWN ROWS as
 * `charged`, so the reconciliation could never fail and the word "Charged" labelled a number that
 * was not the practice's charges — $15,064.99, sitting eight lines above "Filed to payers
 * $17,275.00" on the same screen, with nothing to explain the $2,210.01 between them.
 */
function moneyChain({ charged, rows, caption, totalLabel = "Charged", checkLine = null }) {
  const shown = rows.filter((r) => r.amount > 0 || r.always);
  const accounted = shown.reduce((t, r) => t + r.amount, 0);
  const balanced = accounted === charged;

  /**
   * ── WHY THIS BAR IS AN SVG AND NOT DIVS ───────────────────────────────────────────────────────
   * This app's own Content-Security-Policy is `style-src 'self'`, with no `'unsafe-inline'`. That
   * silently drops every inline `style=` attribute — the attribute is in the DOM and the browser
   * refuses to apply it. The first version of this bar rendered `style="width:79.507%"` and every
   * segment computed to its 2px minimum, so the chart was inert and looked deliberate.
   *
   * Widening the CSP to make a chart work would be a bad trade. An SVG `<rect width="...">` is a
   * PRESENTATION ATTRIBUTE, not CSS, so it is unaffected — the proportion comes from the geometry
   * and only the fill comes from the stylesheet.
   *
   * `viewBox="0 0 100 1"` with `preserveAspectRatio="none"` lets widths be written as percentages
   * directly, and the element stretches to whatever the layout gives it.
   */
  let x = 0;
  const bar = shown
    .filter((r) => r.amount > 0)
    .map((r) => {
      /** Floored at 0.4% so a real but tiny amount stays a visible sliver rather than vanishing. */
      const w = Math.max(0.4, (r.amount / Math.max(1, charged)) * 100);
      const rect = `<rect x="${x.toFixed(3)}" y="0" width="${w.toFixed(3)}" height="1" class="chainbar__seg chainbar__seg--${r.key}"><title>${esc(r.label)} — ${usd(r.amount)}</title></rect>`;
      x += w;
      return rect;
    })
    .join("");

  return `
    <div class="chain">
      ${caption ? `<div class="eyebrow section-label">${esc(caption)}</div>` : ""}
      <svg class="chainbar" viewBox="0 0 100 1" preserveAspectRatio="none" role="img"
           aria-label="${esc(shown.map((r) => `${r.label} ${usd(r.amount)}`).join("; "))} of ${usd(charged)} charged">
        ${bar}
      </svg>
      <div class="chain__rows">
        ${shown
          .map(
            (r) => `<div class="chain__row">
              <span class="chain__key chain__key--${r.key}"></span>
              <span class="chain__label">${esc(r.label)}${r.note ? `<span class="chain__note">${esc(r.note)}</span>` : ""}</span>
              <span class="chain__val">${usd(r.amount)}</span>
            </div>`
          )
          .join("")}
        <div class="chain__row chain__row--total">
          <span class="chain__key chain__key--none"></span>
          <span class="chain__label">${esc(totalLabel)}</span>
          <span class="chain__val">${usd(charged)}</span>
        </div>
      </div>
      <div class="chain__check${balanced || checkLine ? "" : " chain__check--bad"}">
        ${
          checkLine ??
          (balanced
            ? `Every dollar of the ${usd(charged)} charged is accounted for above.`
            : `These destinations account for ${usd(accounted)} of ${usd(charged)} — ${usd(Math.abs(charged - accounted))} is unexplained. Do not bill from this screen until it is.`)
        }
      </div>
    </div>`;
}

/**
 * The claim's chain. Built from the claim's OWN figures, never re-derived — the same values the
 * totals row shows, arranged so they visibly close.
 */
function claimMoneyChain(view) {
  const c = view.claim;
  const adjudicated = (c.payments ?? []).length > 0;

  const rows = adjudicated
    ? [
        { key: "paid", label: "Insurance paid", note: "money received from this payer", amount: view.paidAmount },
        {
          key: "writeoff",
          label: "Contractual write-off",
          note: "the cost of being in network — nobody pays this",
          amount: view.contractualAdjustment,
        },
        {
          key: "cob",
          label: "With another plan",
          note: "coordination of benefits — file the secondary, do not bill the patient",
          amount: view.coordinationPending ?? 0,
        },
        {
          key: "patient",
          label: view.patientShareIsPending ? "Patient share (not final)" : "Patient responsibility",
          note: view.patientShareIsPending
            ? "the primary's view only — a secondary has not ruled"
            : "bill this, not the original quote",
          amount: view.patientResponsibility,
        },
        {
          /**
           * ── WHAT IS LEFT OF THE CHARGE, NOT WHAT IS LEFT OF THE ESTIMATE ────────────────────────
           * This row used to be `view.outstanding`, which is `expected − paid`: a shortfall against
           * the ESTIMATE. The four rows above it are the payer's own partition of the CHARGE, and
           * on every adjudicated claim in staging they sum to it exactly. Adding an estimate
           * shortfall to a charge partition double-counts.
           *
           * On Kira Demo — the coordination-of-benefits claim, where the guidance matters most —
           * that put $1,425.01 of destinations against $1,425.00 charged, and the chain reported
           * "$0.01 is unexplained. Do not bill from this screen until it is." A one-cent rounding
           * difference the screen ITSELF labelled "inside the rounding band — not worth chasing",
           * turned into a blocking instruction, on the one claim a biller most needs to act on.
           *
           * The estimate shortfall has its own panel — "Payer vs estimate" — which reports it with
           * the materiality band that decides whether it is worth anyone's attention. This row now
           * answers the question the chain is actually asking: how much of what we charged has no
           * destination yet.
           */
          key: "owed",
          label: "Not yet accounted for",
          note: "no advice has assigned this part of the charge to anyone",
          amount: Math.max(
            0,
            c.totalFee -
              (view.paidAmount + view.contractualAdjustment + (view.coordinationPending ?? 0) + view.patientResponsibility)
          ),
        },
      ]
    : [
        {
          key: "paid",
          label: "Expected from insurance",
          note: "the estimate, not an adjudication — no payer has ruled yet",
          amount: c.expectedInsurancePays,
        },
        {
          key: "writeoff",
          label: "Write-off (estimated)",
          note: "predicted from the contracted rate this practice has learned",
          amount: c.totalContractualWriteOff ?? 0,
        },
        {
          key: "patient",
          label: "Patient was quoted",
          note: "what they were told at the desk",
          amount: c.expectedPatientPays,
        },
      ];

  return moneyChain({
    charged: c.totalFee,
    rows,
    caption: adjudicated ? "Where this charge went" : "Where this charge is expected to go",
  });
}

function preAuthHtml(c) {
  const required = c.lines.filter((l) => l.preAuthRequirement === "required");
  const unknown = c.lines.filter((l) => l.preAuthRequirement === "unknown");
  if (required.length === 0 && unknown.length === 0) return "";

  const risk = [...required, ...unknown].reduce((t, l) => t + (l.preAuthRiskAmount ?? 0), 0);
  const auth = c.preAuthorization;
  const live =
    auth?.status === "approved" &&
    (!auth.validUntil || c.serviceDate.slice(0, 10) <= auth.validUntil.slice(0, 10));
  const settled = live || auth?.status === "waived";

  /** Aging on an unanswered request — a pre-auth sitting with a payer is money standing still. */
  const days = auth?.requestedAt
    ? Math.floor((Date.now() - new Date(auth.requestedAt).getTime()) / 86400000)
    : null;

  const state = settled
    ? { tone: "good", label: auth.status === "waived" ? "payer waived it" : "approved" }
    : auth?.status === "denied"
      ? { tone: "warn", label: "refused by the payer" }
      : auth?.status === "pending"
        ? { tone: "warn", label: `waiting on the payer${days !== null ? ` · ${days}d` : ""}` }
        : auth?.status === "expired"
          ? { tone: "warn", label: "approval expired" }
          : required.length > 0
            ? { tone: "warn", label: "not requested" }
            : { tone: "warn", label: "nobody has checked" };

  return `
    <div class="eyebrow section-label">Pre-authorisation</div>
    <div class="card${settled ? "" : " card--reject"}">
      <div class="card__title">
        ${required.length > 0 ? "This payer requires approval before treatment" : "Nobody has established whether approval is needed"}
        <span class="tag tag--${state.tone}">${esc(state.label)}</span>
      </div>
      <p class="summary-p">
        ${
          required.length > 0
            ? `<b>${required.map((l) => esc(l.code)).join(", ")}</b> need${required.length === 1 ? "s" : ""} this payer's approval.`
            : `<b>${unknown.map((l) => esc(l.code)).join(", ")}</b> may need approval — a 271 does not carry these rules,
               so nobody has answered the question.`
        }
        ${
          settled
            ? ""
            : `<b class="neg">${usd(risk)}</b> is at risk: a refusal arrives as CARC 197 in the <b>CO</b> group,
               which means the practice absorbs it and <em>cannot</em> bill the patient.`
        }
      </p>
      ${
        auth
          ? `<p class="card__note">
               Recorded ${auth.decidedAt ? `on ${esc(auth.decidedAt.slice(0, 10))}` : `${esc(auth.requestedAt?.slice(0, 10) ?? "")}`}
               by ${esc(auth.requestedBy ?? "—")} · source <b>${esc(auth.source)}</b>${
                 auth.source === "mock" ? ` <span class="tag tag--warn">SYNTHETIC — not a payer's word</span>` : ""
               }
               ${auth.referenceNumber ? ` · authorisation <b class="mono">${esc(auth.referenceNumber)}</b>` : ""}
               ${auth.validUntil ? ` · valid to <b>${esc(auth.validUntil)}</b>` : ""}
               ${auth.denialReason ? `<br />Payer's reason: <b>${esc(auth.denialReason)}</b>` : ""}
             </p>`
          : ""
      }
      ${
        live
          ? `<p class="card__note">An approval is permission to treat — it is <em>not</em> a guarantee of payment.
               The claim is still adjudicated on its own merits.</p>`
          : ""
      }
      ${
        auth?.status === "denied"
          ? `<p class="card__note">The route back is the authorisation appeal, not the submit button — filing now buys
               a write-off the patient cannot be charged for.</p>`
          : ""
      }
      <div class="field-row">
        <select class="input input--sm" id="preauth-status">
          <option value="approved">Payer approved it</option>
          <option value="pending">Requested — waiting on the payer</option>
          <option value="denied">Payer refused it</option>
          <option value="waived">Payer says none is needed</option>
          <option value="expired">The approval has expired</option>
        </select>
        <input class="input" id="preauth-ref" placeholder="Authorisation number" autocomplete="off" />
        <input class="input" id="preauth-until" type="date" title="Valid until, if the payer stated a term" />
        <select class="input input--sm" id="preauth-source">
          <option value="payer-portal">from the payer portal</option>
          <option value="payer-phone">by phone</option>
          <option value="payer-electronic">electronically</option>
        </select>
        <button type="button" class="btn btn--approve" id="preauth-save">Record</button>
      </div>
      <input class="input mt-8" id="preauth-reason" placeholder="If refused: the payer's reason, in their words" />
    </div>`;
}

function addressFixHtml(claim) {
  const blocked = (claim.scrub?.findings ?? []).some(
    (f) => f.code === "subscriber-address-missing" || f.code === "subscriber-address-invalid"
  );
  if (!blocked || !["draft", "ready"].includes(claim.status)) return "";
  const a = claim.patient.address ?? {};
  return `
    <form class="address-fix" id="fix-address">
      <div class="eyebrow section-label">Subscriber address — required by the payer (837D loop 2010BA)</div>
      <p class="summary-p summary-p--muted">
        Enter what the patient has told the practice. Do not guess: an address on a claim is a
        statement to the payer about where this person lives.
      </p>
      <div class="address-fix__grid">
        <label>Street<input name="street" value="${esc(a.street ?? "")}" required autocomplete="off" /></label>
        <label>City<input name="city" value="${esc(a.city ?? "")}" required autocomplete="off" /></label>
        <label>State<input name="state" value="${esc(a.state ?? "")}" maxlength="2" placeholder="CA" required autocomplete="off" /></label>
        <label>ZIP<input name="zip" value="${esc(a.zip ?? "")}" placeholder="90001" required autocomplete="off" /></label>
      </div>
      <button class="btn btn--primary" type="submit">Save address and re-scrub</button>
    </form>`;
}

function wireClaimActions(id) {
  /**
   * Recording a payer's authorisation decision. Re-renders on success because the scrubber re-runs:
   * recording an approval must clear the blocker in the same breath, or a person types the number
   * and the screen still refuses.
   */
  stage.querySelector("#preauth-save")?.addEventListener("click", async () => {
    const status = stage.querySelector("#preauth-status").value;
    const referenceNumber = stage.querySelector("#preauth-ref").value.trim();
    const validUntil = stage.querySelector("#preauth-until").value.trim();
    const denialReason = stage.querySelector("#preauth-reason").value.trim();
    const source = stage.querySelector("#preauth-source").value;
    try {
      renderClaim(
        await api("POST", `/api/v1/claims/${encodeURIComponent(id)}/preauth`, {
          status,
          source,
          ...(referenceNumber ? { referenceNumber } : {}),
          ...(validUntil ? { validUntil } : {}),
          ...(denialReason ? { denialReason } : {}),
        })
      );
      await loadQueue();
    } catch (err) {
      notify(err.message, "bad");
    }
  });

  const act = async (fn) => {
    for (const b of stage.querySelectorAll(".review__actions .btn")) b.disabled = true;
    try {
      renderClaim(await fn());
      await loadQueue();
    } catch (err) {
      notify(err.message, "bad");
      openClaim(id);
    }
  };

  stage.querySelector("#fix-address")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    // The server validates and normalises too — this is not the guard, it is the fast feedback.
    act(() =>
      api("PUT", `/api/v1/claims/${encodeURIComponent(id)}/subscriber-address`, {
        address: {
          street: f.get("street"),
          city: f.get("city"),
          state: f.get("state"),
          zip: f.get("zip"),
        },
        // Ignored by any deployment with sessions — there the authenticated user wins. Present so
        // the DB-free demo, which has no login, can still attribute the correction.
        correctedBy: "demo.user@clinic",
      })
    );
  });

  stage.querySelector("#submit-claim")?.addEventListener("click", () => {
    const submittedBy = stage.querySelector("#submitted-by")?.value.trim() ?? "";
    if (!submittedBy) {
      notify("Enter who is submitting this claim — filing is always attributable to a person.", "warn");
      return;
    }
    state.submittedBy = submittedBy;
    act(() => api("POST", `/api/v1/claims/${encodeURIComponent(id)}/submit`, { submittedBy }));
  });

  stage.querySelector("#rescrub-claim")?.addEventListener("click", () =>
    act(() => api("POST", `/api/v1/claims/${encodeURIComponent(id)}/scrub`, {}))
  );

  stage.querySelector("#void-claim")?.addEventListener("click", () => {
    const reason = prompt("Why is this claim being voided?");
    if (!reason?.trim()) return;
    act(() => api("POST", `/api/v1/claims/${encodeURIComponent(id)}/void`, { reason }));
  });
}

// ── Money: remittance detail ──────────────────────────────────────────────
async function openRemittance(id) {
  state.selectedId = id;
  renderRemittance(await api("GET", `/api/v1/remittances/${encodeURIComponent(id)}`));
  for (const b of queueList.querySelectorAll(".qitem")) b.setAttribute("aria-current", "false");
}

/** The three-way split of a shortfall — the product's central idea, rendered. */
function varianceBreakdown(v) {
  const row = (label, amount, cls, note) =>
    amount > 0
      ? `<div class="split__row ${cls}">
           <span class="split__label">${label}<span class="split__note">${note}</span></span>
           <span class="split__val">${usd(amount)}</span>
         </div>`
      : "";
  return `
    <div class="split">
      ${row("Paid by insurance", v.actualPaid, "split--paid", "money received")}
      ${row("Contractual write-off", v.contractualAdjustments, "split--contractual", "cost of being in network — do not chase")}
      ${row(
        "Patient responsibility",
        v.patientResponsibility,
        "split--patient",
        v.adjudication === "coordination_pending"
          ? "the PRIMARY's view — not final until the secondary rules"
          : "bill the patient"
      )}
      ${/*
          Money assigned to another plan (M8). Without this row the split silently failed to
          account for the charge: Kira Demo's advice showed $799.99 paid and $142.50 written off
          against a $1,425.00 charge, and the $482.51 with a secondary appeared nowhere in the one
          panel whose whole job is to say where the money went.
        */ ""}
      ${row(
        "With another plan",
        v.coordinationAmount ?? 0,
        "split--recoverable",
        "coordination of benefits — file the secondary, do not bill the patient"
      )}
      ${row("Recoverable", v.recoverableAmount, "split--recoverable", "correct or appeal — the payer still owes this")}
      ${row("Unexplained", v.unexplainedAmount, "split--unexplained", "withheld with no reason code — query the payer")}
    </div>`;
}

/**
 * A DOM id for one claim on this advice, so a provider adjustment can point at the claim it was
 * taken out of. Control numbers are validated on the way in (`isValidClaimControlNumber`), but this
 * builds an id rather than trusting that — a value that reaches an attribute selector is sanitized
 * where it is used, not where it was checked.
 */
const postingAnchor = (controlNumber) => `posting-${String(controlNumber).replace(/[^A-Za-z0-9_-]/g, "_")}`;

function postingCard(p) {
  const v = p.variance;
  if (!v) {
    return `<div class="card card--reject" id="${postingAnchor(p.patientControlNumber)}">
        <div class="card__title">${esc(p.patientName || p.patientControlNumber)} — unmatched</div>
        <p class="summary-p">${usd(p.paidAmount)} paid against ${usd(p.chargedAmount)} charged, but this does not match any claim we filed.</p>
        <p class="card__note">Control number <b class="mono">${esc(p.patientControlNumber)}</b>. Identify what it belongs to.</p>
      </div>`;
  }
  const cls = v.actionable ? "card--reject" : "card";
  return `
    <div class="${cls}" id="${postingAnchor(p.patientControlNumber)}">
      <div class="card__title">
        ${esc(p.patientName || p.patientControlNumber)}
        ${adjudicationBadge(v)}
      </div>
      <p class="summary-p">
        Expected <b>${usd(v.expectedInsurancePays)}</b> · received <b>${usd(v.actualPaid)}</b>
        ${v.variance !== 0 ? ` · <b class="${v.variance < 0 ? "neg" : "pos"}">${v.variance < 0 ? "−" : "+"}${usd(Math.abs(v.variance))}</b>` : ""}
      </p>
      ${varianceBreakdown(v)}
      ${v.explanation.map((e) => `<p class="summary-p summary-p--muted">${esc(e)}</p>`).join("")}
      ${
        v.reasons.length
          ? `<ul class="line-errors">${v.reasons
              .map((r) => `<li><b>${esc(r.group)}-${esc(r.code)}</b> ${esc(r.description)} — ${usd(r.amount)}${r.procedureCode ? ` on ${esc(r.procedureCode)}` : ""}</li>`)
              .join("")}</ul>`
          : ""
      }
    </div>`;
}

/**
 * PLB03-1 in the words a biller uses. The payer's own code is always shown beside the plain reading,
 * never replaced by it — an unlisted code prints verbatim rather than being softened into a guess.
 */
const PLB_REASONS = {
  WO: "overpayment recovery",
  FB: "forwarding balance",
  72: "authorized return",
  L6: "interest",
};

/**
 * ── PROVIDER-LEVEL ADJUSTMENTS ON A SCREEN (M22) ────────────────────────────────────────────────
 *
 * M12 made a recoupment HOLD the advice, split out `reasonCode`/`referenceId`, and named the
 * recouped claim in the finding — and then the whole array reached no screen. The attribution got
 * to a human only through `holdReason` and the Today subtitle, which carry the FIRST blocker's
 * message, so an advice with two takebacks and an unrelated blocker showed one sentence and the
 * rest stayed in the database. The money was safe; the biller's time was not — finding out which
 * claims and how much meant opening the raw 835.
 *
 * ── ATTRIBUTION NEVER GUESSES ───────────────────────────────────────────────────────────────────
 * Same doctrine as `describeProviderAdjustment` in the safety engine: a reference becomes a link
 * ONLY when it matches a claim on THIS advice. No prefix match, no normalisation. Where it does not
 * match, the payer's own string is printed verbatim and described as exactly that — this screen can
 * see the postings on this remittance, so it says "not a claim on this advice" and does not claim
 * the broader "no claim we recorded submitting", which is a statement only the gate can make.
 */
function providerAdjustmentsSection(r) {
  const adjustments = r.providerAdjustments ?? [];
  if (adjustments.length === 0) return "";

  const byControlNumber = new Map(r.postings.map((p) => [p.patientControlNumber, p]));
  const rows = adjustments.map((p) => {
    const plain = PLB_REASONS[p.reasonCode];
    const reason = p.reasonCode
      ? `<b>${esc(p.reasonCode)}</b>${plain ? ` — ${esc(plain)}` : ""}`
      : "<b>reason not stated</b>";

    let attribution;
    if (!p.referenceId) {
      attribution = "The payer named no claim, so this cannot be attributed to one.";
    } else if (byControlNumber.has(p.referenceId)) {
      const posting = byControlNumber.get(p.referenceId);
      attribution =
        `Taken against <a href="#${postingAnchor(p.referenceId)}">` +
        `${esc(posting.patientName || p.referenceId)}</a> ` +
        `(<b class="mono">${esc(p.referenceId)}</b>).`;
    } else {
      attribution = `References <b class="mono">${esc(p.referenceId)}</b>, which is not a claim on this advice.`;
    }

    // Positive withholds from the payment; negative adds to it. The sign is the whole meaning here.
    const sign = p.amount < 0 ? "+" : "−";
    return `<li>
        <span class="${p.amount < 0 ? "pos" : "neg"}"><b>${sign}${usd(Math.abs(p.amount))}</b></span>
        under ${reason}. ${attribution}
      </li>`;
  });

  return `
    <div class="eyebrow section-label">Provider-level adjustments</div>
    <p class="summary-p summary-p--muted">
      Money the payer moved against this payment as a whole, outside any claim on the advice.
      Mermaid has NOT changed the status of any claim named here.
    </p>
    <ul class="line-errors">${rows.join("")}</ul>`;
}

function renderRemittance(view) {
  const { remittance: r, totalRecoverable, totalWithOtherPayers, canPost, recommendedAction, unmatched, releaseBlocked } = view;
  /**
   * The gauge reported `totalRecoverable` as "Still owed", and a coordinated advice has none — so a
   * posted advice with $482.51 sitting at a secondary showed "$0.00 Still owed" in the safe colour.
   * Correct about this payer, and the opposite of the truth about the money.
   *
   * Coordinated money is neither owed by this payer nor safe to ignore, so it gets the gauge when
   * there is nothing recoverable, with its own label and a warning tone rather than a green zero.
   */
  const cob = totalWithOtherPayers ?? 0;
  const gauge =
    totalRecoverable > 0
      ? { value: totalRecoverable, label: "Still owed", tone: "gauge__val--urgent" }
      : cob > 0
        ? { value: cob, label: "With another plan", tone: "gauge__val--approaching" }
        : { value: 0, label: "Still owed", tone: "gauge__val--safe" };

  const issuesHtml = r.issues.length
    ? `<div class="eyebrow section-label">Why this is held</div>
       <div class="flags">${r.issues.map((i) => `<div class="flag flag--critical"><span class="flag__sev">balance</span><span>${esc(i)}</span></div>`).join("")}</div>`
    : "";

  /**
   * ── A DUPLICATE IS NOT "REVIEW AND RELEASE" ───────────────────────────────────────────────────
   * The server now says when release would be refused outright (`releaseBlocked`). Without this
   * branch such an advice fell into the ELSE below and told the operator its arithmetic did not
   * agree — false, and it sent them to the paper EOB for a file that balances to the cent. It
   * states what the advice IS instead, and the reject form below becomes the action.
   */
  const releaseHtml =
    r.status === "held" && releaseBlocked
      ? `<div class="flags"><div class="flag flag--critical"><span class="flag__sev">${
          releaseBlocked.rejectAs === "test-file" ? "test file" : "duplicate"
        }</span><span>${esc(releaseBlocked.message)} It cannot be released.</span></div></div>`
      : r.status === "held" && canPost
      ? `<div class="review">
           <div class="review__title">Release this remittance for posting</div>
           <p class="review__hint">${esc(recommendedAction)}</p>
           <label class="field mb-12"><span class="field__label">Released by</span>
             <input class="input" id="released-by" value="${esc(state.submittedBy)}" /></label>
           <label class="field mb-12"><span class="field__label">Reason</span>
             <input class="input" id="release-reason" placeholder="e.g. Reconciled against the payer's paper EOB" /></label>
           <div class="review__actions"><button class="btn btn--approve" id="release-remit">Release &amp; post</button></div>
         </div>`
      : r.status === "held"
        ? `<div class="reviewed-note reviewed-note--rejected">
             This remittance cannot be posted until its arithmetic agrees with the payer's own totals.
             That is not overridable — reconcile it against the paper EOB first.
           </div>`
        : "";

  /**
   * ── THE OTHER EXIT FROM THE HELD PILE ─────────────────────────────────────────────────────────
   * Release was the only one, so a duplicate or a test file could leave only by being posted. Shown
   * for EVERY held advice, balanced or not: an unbalanced file can be a duplicate or a test file too,
   * and it is the one kind that can never be released, so rejecting it is its only way out.
   *
   * The kind is chosen, never defaulted — the two have different follow-ups, and a preselected one
   * would record a decision the person did not make.
   */
  const rejectHtml =
    r.status === "held" && releaseBlocked
      ? `<div class="review">
           <div class="review__title">Reject as ${releaseBlocked.rejectAs === "test-file" ? "a test file" : "a duplicate"} — it will never post</div>
           <p class="review__hint">${
             releaseBlocked.rejectAs === "test-file"
               ? "The sender marked this file as a test. No money is behind it."
               : "This payment is already on the books. This copy carries no money of its own."
           } The advice and its 835 are kept as a record; nothing reaches the ledger, the claim or the patient.</p>
           <input type="hidden" id="reject-kind" value="${esc(releaseBlocked.rejectAs)}" />
           <label class="field mb-12"><span class="field__label">Rejected by</span>
             <input class="input" id="rejected-by" value="${esc(state.submittedBy)}" /></label>
           <label class="field mb-12"><span class="field__label">Reason</span>
             <input class="input" id="reject-reason" placeholder="e.g. Same payment as the posted advice; one deposit" /></label>
           <div class="review__actions"><button class="btn btn--reject" id="reject-remit">Reject as ${
             releaseBlocked.rejectAs === "test-file" ? "test file" : "duplicate"
           }</button></div>
         </div>`
      : r.status === "held"
      ? `<div class="review">
           <div class="review__title">Or reject it — it will never post</div>
           <p class="review__hint">For a copy of a payment already on the books, or a file the sender marked as a test.
             The advice and its 835 are kept; nothing reaches the ledger, the claim or the patient.</p>
           <label class="field mb-12"><span class="field__label">It is</span>
             <select class="input" id="reject-kind">
               <option value="">Choose…</option>
               <option value="duplicate">A duplicate of a payment already recorded</option>
               <option value="test-file">A test file, not a real payment</option>
             </select></label>
           <label class="field mb-12"><span class="field__label">Rejected by</span>
             <input class="input" id="rejected-by" value="${esc(state.submittedBy)}" /></label>
           <label class="field mb-12"><span class="field__label">Reason</span>
             <input class="input" id="reject-reason" placeholder="e.g. Same adjudication as the advice posted on 28 Aug; one deposit" /></label>
           <div class="review__actions"><button class="btn btn--reject" id="reject-remit">Reject &amp; never post</button></div>
         </div>`
      : r.status === "rejected"
        ? `<div class="reviewed-note reviewed-note--rejected">${esc(recommendedAction)}</div>`
        : "";

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">${esc(r.payerName || "Unknown payer")}</h1>
          <div class="detail__id">
            <span class="tag">Remittance</span>
            <span>Trace <b class="mono">${esc(r.traceNumber || "—")}</b></span>
            <span>Paid <b>${esc(r.paymentDate)}</b></span>
            <span>Method <b>${esc(r.paymentMethod || "—")}</b></span>
            <span>${plural(r.postings.length, "claim")}</span>
          </div>
        </div>
        <span class="status status--remit-${r.status}">${esc(r.status)}</span>
      </div>

      <div class="decision">
        <div>
          <div class="eyebrow decision__action-label">Recommended action</div>
          <div class="decision__action">${esc(recommendedAction)}</div>
        </div>
        <div class="gauge">
          <div class="gauge__row">
            <span class="gauge__val ${gauge.tone}">${usd(gauge.value)}</span>
            <span class="gauge__label">${gauge.label}</span>
          </div>
          <div class="gauge__thr-note">${r.balanced ? "The payer's arithmetic checks out." : "This file does not balance."}</div>
        </div>
      </div>

      <div class="totals">
        <div class="total total--patient"><div class="total__label">Deposited</div><div class="total__val">${usd(r.paymentTotal)}</div></div>
        <div class="total"><div class="total__label">Claims on this advice</div><div class="total__val">${r.postings.length}</div></div>
        <div class="total"><div class="total__label">Unmatched</div><div class="total__val">${unmatched.length}</div></div>
      </div>

      ${issuesHtml}

      <div class="eyebrow section-label">Estimate vs. actual, per claim</div>
      <div class="cards cards--stack">${r.postings.map(postingCard).join("")}</div>

      ${providerAdjustmentsSection(r)}

      ${releaseHtml}
      ${rejectHtml}

      <details class="report">
        <summary>Audit trail</summary>
        <pre>${esc(r.audit.map((a) => `${a.timestamp}  [${a.actor}]  ${a.message}`).join("\n"))}</pre>
      </details>
      ${r.raw835 ? `<details class="report"><summary>Received X12 835</summary><pre>${esc(r.raw835.replaceAll("~", "~\n"))}</pre></details>` : ""}
    </div>`;

  const releaseBtn = stage.querySelector("#release-remit");
  releaseBtn?.addEventListener("click", async () => {
    const releasedBy = stage.querySelector("#released-by")?.value.trim() ?? "";
    const reason = stage.querySelector("#release-reason")?.value.trim() ?? "";
    if (!releasedBy || !reason) {
      notify(
        "Releasing a held remittance needs both a name and a reason — posting money is always attributable.",
        "warn",
        releaseBtn
      );
      return;
    }
    state.submittedBy = releasedBy;
    /**
     * Held down for the duration. This was the ONE money action in the product that did not do
     * that — every other one disables its buttons while its request is in flight.
     *
     * The server is safe either way: `release()` reads through `lockById`, which is
     * `SELECT … FOR UPDATE`, and returns the existing view when the advice is already posted, so a
     * second click blocks on the row lock and then finds the work done. The defect is that a button
     * which does nothing visible for a second invites a second click, and a person who clicks twice
     * on "post $1,599.98" spends the next minute wondering whether they just did it twice.
     */
    await withBusy(releaseBtn, async () => {
      try {
        renderRemittance(
          await api("POST", `/api/v1/remittances/${encodeURIComponent(r.id)}/release`, { releasedBy, reason })
        );
        await loadQueue();
      } catch (err) {
        notify(err.message, "bad", releaseBtn);
      }
    });
  });

  const rejectBtn = stage.querySelector("#reject-remit");
  rejectBtn?.addEventListener("click", async () => {
    const kind = stage.querySelector("#reject-kind")?.value ?? "";
    const rejectedBy = stage.querySelector("#rejected-by")?.value.trim() ?? "";
    const reason = stage.querySelector("#reject-reason")?.value.trim() ?? "";
    if (!kind || !rejectedBy || !reason) {
      notify(
        "Rejecting a payer's advice needs what it is, a name and a reason — the decision is permanent and attributable.",
        "warn",
        rejectBtn
      );
      return;
    }
    state.submittedBy = rejectedBy;
    await withBusy(rejectBtn, async () => {
      try {
        renderRemittance(
          await api("POST", `/api/v1/remittances/${encodeURIComponent(r.id)}/reject`, { kind, rejectedBy, reason })
        );
        await loadQueue();
      } catch (err) {
        notify(err.message, "bad", rejectBtn);
      }
    });
  });
}

// ── Money: the recovery queue ─────────────────────────────────────────────
async function showRecoveryQueue() {
  const { items, totalRecoverable } = await api("GET", "/api/v1/remittances/recovery");
  const reconcile = await api("GET", "/api/v1/remittances/reconcile");

  const rows = items
    /**
   * Two different kinds of money, and they used to be added together and labelled "recoverable".
   *
   * The variance engine separates them deliberately: "recoverable" is missing information,
   * bundling or an absent pre-auth — correct it or appeal it — while "unexplained" is money
   * withheld with NO reason code, which the engine's own header calls the dangerous one precisely
   * because nothing surfaces it except arithmetic. Summing them told a biller that money nobody
   * has explained is money they can chase, and overstated the recoverable figure a practice plans
   * around.
   *
   * Both labels below are the engine's own category names, and the query-the-payer clause is the
   * one already used on the variance split elsewhere in this file.
   */
  .map(
      (i) => `
      <div class="card card--reject recovery">
        <div class="card__title">
          ${esc(i.patientName)} · ${esc(i.payerName)}
          <span class="qitem__prio">P${i.priority}</span>
        </div>
        <p class="summary-p">
          Charged ${usd(i.chargedAmount)} · expected ${usd(i.expectedInsurancePays)} · received <b>${usd(i.paidAmount)}</b>
        </p>
        <p class="summary-p"><b class="neg">${usd(i.recoverableAmount)} recoverable</b></p>
        ${
          i.unexplainedAmount > 0
            ? `<p class="summary-p"><b class="neg">${usd(i.unexplainedAmount)} unexplained</b> — withheld with no reason code, query the payer</p>`
            : ""
        }
        ${i.explanation.map((e) => `<p class="summary-p summary-p--muted">${esc(e)}</p>`).join("")}
        ${
          i.reasons.length
            ? `<ul class="line-errors">${i.reasons.map((r) => `<li><b>${esc(r.group)}-${esc(r.code)}</b> ${esc(r.description)} — ${usd(r.amount)}</li>`).join("")}</ul>`
            : ""
        }
        <p class="card__note">Control number <b class="mono">${esc(i.patientControlNumber)}</b> · posted ${esc(i.postedAt.slice(0, 10))}</p>
      </div>`
    )
    .join("");

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">Underpaid claims</h1>
          <div class="detail__id"><span>Payers paid less than the claim expected, and have not explained all of it. Distinct from <b>Recover</b>, which is denials and appeals.</span></div>
        </div>
      </div>

      <div class="totals">
        <div class="total total--patient" title="What payers still owe on claims they have already paid something against — net of anything since recovered on appeal."><div class="total__label">Still short</div><div class="total__val">${usd(totalRecoverable)}</div></div>
        <div class="total"><div class="total__label">Claims to work</div><div class="total__val">${items.length}</div></div>
        <div class="total"><div class="total__label">Reconciliation drift</div><div class="total__val">${usd(reconcile.drift)}</div></div>
      </div>

      <div class="${reconcile.balanced ? "handoff" : "reviewed-note reviewed-note--rejected"}">${esc(reconcile.summary)}</div>

      ${
        items.length
          ? `<div class="eyebrow section-label">Ranked by what is actually retrievable</div>
             <div class="cards cards--stack">${rows}</div>`
          : `<div class="stage-empty mt-20">
               Nothing to pursue with a payer. Every shortfall so far is accounted for — by contract, by the
               patient's share, or by another plan that has yet to rule.
             </div>`
      }
    </div>`;
}

// ── Recover: denial detail ────────────────────────────────────────────────
async function openDenial(id) {
  state.selectedId = id;
  renderDenial(await api("GET", `/api/v1/denials/${encodeURIComponent(id)}`));
  for (const b of queueList.querySelectorAll(".qitem")) b.setAttribute("aria-current", "false");
}

function renderDenial(view) {
  const { denial: d, activeAppeal, appealWindow, daysToAppeal, canDraft, canApprove, canSubmit, blockedReason, recommendedAction, deadlineEstimated, deadlineNote, deadlineSourced } = view;
  const t = d.triage;

  const oddsLabel = t
    ? `${Math.round(t.overturnRate * 100)}% · ${t.trusted ? `${t.sampleSize} outcomes` : "provisional"}`
    : "—";

  /**
   * The AI provenance panel.
   *
   * Shown ABOVE the letter, opened by default, and never collapsed into a badge. A reviewer must
   * know a paragraph was machine-written before they read it, not after — reading prose for
   * plausibility is precisely the check that prose is built to pass. So the panel leads with what
   * the model was told, which is the part a human can actually verify.
   */
  const n = activeAppeal?.narrative ?? null;
  const aiHtml = n
    ? `<div class="card card--ai">
         <div class="card__title">
           AI-drafted argument
           <span class="tag tag--ai">AI · ${esc(n.provider)}${n.model ? ` / ${esc(n.model)}` : ""}</span>
         </div>
         <p class="card__note">
           A model wrote the argument paragraph of this letter. It did not decide to appeal — the
           playbook did — and it did not write the claim number, member ID, date of service, denied
           amount, or the evidence list. Read it, edit it, then approve it.
         </p>
         <div class="ai-evidence">
           <div class="ai-evidence__label">What the model was given</div>
           <ul>${n.evidence.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
         </div>
       </div>`
    : activeAppeal
      ? `<div class="card">
           <div class="card__title">Deterministic draft <span class="tag">no AI</span></div>
           <p class="card__note">This letter was written from the denial record by template. AI drafting is off or was unavailable.</p>
         </div>`
      : "";

  const appealHtml = activeAppeal
    ? `<div class="eyebrow section-label">Level-${activeAppeal.level} appeal</div>
       ${aiHtml}
       <div class="card ${activeAppeal.approvedBy ? "" : "card--reject"}">
         <div class="card__title">
           Evidence to gather
           <span class="tag tag--${activeAppeal.approvedBy ? "good" : "warn"}">${activeAppeal.approvedBy ? `approved by ${esc(activeAppeal.approvedBy)}` : "awaiting approval"}</span>
         </div>
         <ul class="line-errors line-errors--neutral">${activeAppeal.checklist.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
         <p class="card__note">A person confirms the evidence is in hand before this is sent. Nothing reaches the payer otherwise.</p>
       </div>
       <details class="report" ${n && !activeAppeal.approvedBy ? "open" : ""}>
         <summary>Appeal letter${n ? " — AI-assisted, edit before approving" : ""}</summary>
         <textarea class="letter-edit" id="appeal-letter" rows="18" spellcheck="true">${esc(activeAppeal.letter)}</textarea>
         <div class="review__actions">
           <button class="btn btn--ghost" id="revise-appeal">Save edits</button>
           <span class="card__note">${activeAppeal.approvedBy ? "Saving edits clears the approval — a signature signs off specific words." : "Saved edits keep the appeal awaiting approval."}</span>
         </div>
       </details>`
    : "";

  const actionsHtml =
    canDraft || canApprove || canSubmit || view.open
      ? `<div class="review">
           <div class="review__title">${canDraft ? "Draft an appeal" : canApprove ? "Approve before sending" : canSubmit ? "Ready to send" : "Work this denial"}</div>
           <p class="review__hint">${esc(blockedReason ?? recommendedAction)}</p>
           <div class="review__actions">
             ${canDraft ? `<button class="btn btn--primary" id="draft-appeal">Draft appeal</button>` : ""}
             ${canApprove ? `<button class="btn btn--approve" id="approve-appeal">Approve</button>` : ""}
             ${canSubmit ? `<button class="btn btn--approve" id="submit-appeal">Send to payer</button>` : ""}
             ${d.status === "appealed" ? `<button class="btn btn--approve" id="outcome-won">Record: WON</button><button class="btn btn--reject" id="outcome-lost">Record: lost</button>` : ""}
             ${view.open && d.status !== "appealed" ? `<button class="btn btn--ghost" id="close-denial">Write off</button>` : ""}
           </div>
         </div>`
      : "";

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">${esc(d.patientName)}</h1>
          <div class="detail__id">
            <span class="tag">Denial</span>
            <span><b>${esc(d.payerName)}</b></span>
            <span>${esc(d.carcCode)} <b>${esc(d.carcDescription)}</b></span>
            ${d.procedureCode ? `<span>on <b>${esc(d.procedureCode)}</b></span>` : ""}
            ${
              // A deadline is a thing to act before. Once the denial is closed it is history, and
              // the chip belonged next to a status that already says the work is done.
              view.open
                ? `<span>Appeal by <b${deadlineNote ? ` title="${esc(deadlineNote)}"` : ""}>${esc(d.appealDeadline ?? "—")}</b>${deadlineEstimated ? ` <span class="tag tag--warn">assumed</span>` : deadlineSourced ? ` <span class="tag">payer-published</span>` : deadlineNote ? ` <span class="tag">estimated</span>` : ""}</span>`
                : ""
            }
          </div>
        </div>
        <span class="status status--denial-${d.status}">${esc(d.status.replace(/_/g, " "))}</span>
      </div>

      <div class="decision">
        <div>
          <div class="eyebrow decision__action-label">Recommended action</div>
          <div class="decision__action">${esc(recommendedAction)}</div>
          ${
            /**
             * The triage reasoning is forward-looking advice — "appeal with a retro-authorization
             * request", "expected recovery $409.50 × 36% odds". Kept on a closed denial, because it
             * is the record of WHY the practice pursued it and that is worth being able to read
             * back. Labelled, because unlabelled it reads as a list of things still to do on a
             * denial that has already been won and paid.
             */
            t
              ? `${view.open ? "" : `<div class="eyebrow section-label">Why this was pursued, at the time</div>`}
                 <ul class="decision__rec nested-list">${t.explain.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`
              : ""
          }
          <div class="decision__tags">
            ${t ? `<span class="tag">${esc(t.disposition.replace(/_/g, " "))}</span>` : ""}
            ${t ? `<span class="tag tag--${t.trusted ? "good" : "warn"}">${esc(t.source.replace(/-/g, " "))}</span>` : ""}
          </div>
        </div>
        <div class="gauge">
          ${
            /**
             * A countdown and a forecast are both about a decision that has not been made yet. On a
             * denial that has already been appealed and settled they are noise at best: this gauge
             * read "178 Days to appeal · Recovery odds 36% · provisional" on a RECOVERED denial
             * whose appeal was won in full months inside the window. Nobody has 178 days to do
             * something they have finished.
             */
            view.open
              ? `<div class="gauge__row">
                   <span class="gauge__val gauge__val--${appealWindow === "safe" ? "safe" : appealWindow === "closed" ? "expired" : appealWindow}">${daysToAppeal ?? "—"}</span>
                   <span class="gauge__label">Days to appeal${deadlineEstimated ? " (assumed)" : ""}</span>
                 </div>
                 <div class="gauge__thr-note">Recovery odds ${oddsLabel}</div>
                 ${deadlineNote ? `<div class="gauge__thr-note">${esc(deadlineNote)}</div>` : ""}`
              : `<div class="gauge__row">
                   <span class="gauge__val gauge__val--${d.status === "recovered" ? "safe" : "expired"}">${
                     d.status === "recovered" ? "✓" : "—"
                   }</span>
                   <span class="gauge__label">${esc(d.status.replace(/_/g, " "))}</span>
                 </div>
                 <div class="gauge__thr-note">This denial is closed — nothing is counting down.</div>`
          }
        </div>
      </div>

      <div class="totals">
        <div class="total"><div class="total__label">Denied</div><div class="total__val">${usd(d.deniedAmount)}</div></div>
        ${
          /**
           * A forecast is worth showing until the outcome is known, and misleading afterwards. On a
           * settled denial this tile kept displaying "Expected back $409.50" — the odds-weighted
           * estimate made BEFORE the appeal — beside a "Recovered" tile reading "—", on a screen
           * whose own recommendation said "$1,125.00 arrived and was posted". A biller reading the
           * tiles would take away the opposite of what happened.
           */
          view.open
            ? `<div class="total total--patient"><div class="total__label">Expected back</div><div class="total__val">${usd(t?.expectedRecovery ?? 0)}</div></div>`
            : `<div class="total"><div class="total__label">Awarded on appeal</div><div class="total__val">${
                view.awardedAmount == null ? "—" : usd(view.awardedAmount)
              }</div></div>`
        }
        <div class="total ${view.recoveredAmount > 0 ? "total--paid" : ""}"><div class="total__label">Recovered</div><div class="total__val">${view.recoveredAmount == null ? "—" : usd(view.recoveredAmount)}</div></div>
      </div>

      <!--
        The AI explanation sits BELOW the deterministic reason code, the amounts and the recommended
        action, and is empty until asked for. That ordering is the feature: the biller has already
        read what the payer actually said and what the practice has already decided, so the sentence
        arrives as commentary on facts they hold rather than as the first thing they learn.
      -->
      <div class="explain" id="explain-block">
        <button class="btn btn--ghost" id="explain-denial">Explain this denial in plain English</button>
        <span class="card__note">AI narration over the payer's own reason codes. It does not change the recommendation.</span>
      </div>

      ${appealHtml}
      ${actionsHtml}

      <details class="report">
        <summary>Audit trail</summary>
        <pre>${esc(d.audit.map((a) => `${a.timestamp}  [${a.actor}]  ${a.message}`).join("\n"))}</pre>
      </details>
    </div>`;

  wireDenialActions(d);
}

function wireDenialActions(denial) {
  const act = async (fn) => {
    for (const b of stage.querySelectorAll(".review__actions .btn")) b.disabled = true;
    try {
      renderDenial(await fn());
      await loadQueue();
    } catch (err) {
      notify(err.message, "bad");
      openDenial(denial.id);
    }
  };
  const id = encodeURIComponent(denial.id);

  stage.querySelector("#draft-appeal")?.addEventListener("click", () =>
    // The claim's control number and service date live in the Claims context; the denial carries the
    // claim id, so the UI asks for what it cannot know. A future unified timeline removes the prompt.
    act(() =>
      api("POST", `/api/v1/denials/${id}/draft`, {
        memberId: "",
        claimControlNumber: "",
        serviceDate: denial.detectedAt.slice(0, 10),
      })
    )
  );
  /**
   * Ask for the plain-English explanation.
   *
   * Deliberately NOT wired through `act()`: that helper re-renders the whole denial from a returned
   * view, and this returns no view because nothing changed. A degraded AI layer here has to be
   * visibly ordinary — a line saying so, with every deterministic thing on the screen untouched.
   */
  stage.querySelector("#explain-denial")?.addEventListener("click", async () => {
    const block = stage.querySelector("#explain-block");
    const button = stage.querySelector("#explain-denial");
    button.disabled = true;
    button.textContent = "Asking…";
    try {
      const { explanation } = await api("POST", `/api/v1/denials/${id}/explain`, {});
      block.innerHTML = explanation
        ? `<div class="card card--ai">
             <div class="card__title">
               Why this happened
               <span class="tag tag--ai">AI · ${esc(explanation.provider)}${explanation.model ? ` / ${esc(explanation.model)}` : ""}</span>
             </div>
             <p class="explain__text">${esc(explanation.text)}</p>
             <p class="card__note">Written by a model from the reason codes below. The codes, the amounts and the recommended action above are computed, not written.</p>
             <div class="ai-evidence">
               <div class="ai-evidence__label">What the model was given</div>
               <ul>${explanation.evidence.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
             </div>
           </div>`
        : `<p class="card__note">No AI explanation is available — the assistant is switched off or did not answer. Everything else on this screen is unaffected.</p>`;
    } catch (err) {
      block.innerHTML = `<p class="card__note">${esc(err.message)}</p>`;
    }
  });

  stage.querySelector("#revise-appeal")?.addEventListener("click", () => {
    const letter = stage.querySelector("#appeal-letter")?.value ?? "";
    act(() => api("POST", `/api/v1/denials/${id}/revise`, { letter }));
  });
  stage.querySelector("#approve-appeal")?.addEventListener("click", () => act(() => api("POST", `/api/v1/denials/${id}/approve`, {})));
  stage.querySelector("#submit-appeal")?.addEventListener("click", () => act(() => api("POST", `/api/v1/denials/${id}/submit`, {})));
  stage.querySelector("#outcome-won")?.addEventListener("click", () =>
    act(() => api("POST", `/api/v1/denials/${id}/outcome`, { won: true }))
  );
  stage.querySelector("#outcome-lost")?.addEventListener("click", () => {
    const notes = prompt("What did the payer say?") ?? "";
    act(() => api("POST", `/api/v1/denials/${id}/outcome`, { won: false, notes }));
  });
  stage.querySelector("#close-denial")?.addEventListener("click", () => {
    const reason = prompt("Why is this being written off?");
    if (!reason?.trim()) return;
    act(() => api("POST", `/api/v1/denials/${id}/close`, { as: "written_off", reason }));
  });
}

/** The shared brain, read-only — what the platform has learned so far. */
async function showPlaybook() {
  const { rules, learned, trusted } = await api("GET", "/api/v1/payer-profile/playbook");
  const rows = rules
    .map(
      (r) => `<tr>
        <td><span class="code">${esc(r.carcCode)}</span><span class="desc-note">${esc(r.payerId ?? "all payers")}${r.cdtPrefix ? ` · ${esc(r.cdtPrefix)}*` : ""}</span></td>
        <td>${esc(r.disposition.replace(/_/g, " "))}</td>
        <td class="num">${Math.round(r.overturnRate * 100)}%</td>
        <td class="num">${r.sampleSize || "—"}</td>
        <td class="num">${r.trusted ? '<span class="tag tag--good">trusted</span>' : '<span class="tag tag--warn">prior</span>'}</td>
      </tr>`
    )
    .join("");

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">The shared playbook</h1>
          <div class="detail__id"><span>What to do about each denial code, and how often fighting it actually works.</span></div>
        </div>
      </div>
      <div class="totals">
        <div class="total"><div class="total__label">Rules</div><div class="total__val">${rules.length}</div></div>
        <div class="total"><div class="total__label">With outcomes</div><div class="total__val">${learned}</div></div>
        <div class="total total--patient"><div class="total__label">Trusted</div><div class="total__val">${trusted}</div></div>
      </div>
      <div class="handoff">
        Rates start as priors and are displaced by recorded appeal outcomes. A rule is marked
        <b>trusted</b> only after enough observations — until then the number is a starting estimate,
        and the UI says so rather than dressing a guess as evidence.
      </div>
      <div class="eyebrow section-label">Playbook</div>
      <table class="lines">
        <thead><tr><th>Code</th><th>Disposition</th><th class="num">Odds</th><th class="num">Outcomes</th><th class="num">Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Ops: the outbox, the audit trail, and readiness ───────────────────────
//
// The outbox is the one component whose failure is invisible from every other screen: claims stop
// appearing, denials stop being triaged, and no worklist says why. This screen is where that becomes
// something a person can see and fix.

async function loadOpsQueue() {
  const [outbox, readiness, monitors] = await Promise.all([
    api("GET", "/api/v1/ops/outbox"),
    api("GET", "/api/v1/ops/readiness").catch((e) => ({ ready: false, checks: [], error: e.message })),
    // A watchdog whose own screen fails must not read as "all clear" — the failure IS the finding.
    api("GET", "/api/v1/ops/monitors").catch((e) => ({
      healthy: false,
      firing: [{ key: "monitors", message: `Could not read the monitors: ${e.message}` }],
      checks: [],
    })),
  ]);
  state.ops = { outbox, readiness, monitors };

  queueTitle.textContent = "Operations";
  // A firing money check outranks the queue in the hint: a stalled outbox stops the learning loop,
  // an unreconciled or held payment is cash sitting against nothing.
  const firingCount = monitors?.firing?.length ?? 0;
  queueHint.textContent = firingCount
    ? `${plural(firingCount, "monitor")} firing — see Ops.`
    : outbox.dead.length
      ? `${outbox.dead.length} event(s) stuck — work has stopped moving.`
      : `${outbox.backlog.pending} pending · queue healthy.`;
  queueCount.textContent = `${outbox.backlog.pending + outbox.dead.length}`;

  queueActions.innerHTML = `
    <button type="button" class="btn btn--ghost btn--sm" id="ops-outbox">Outbox</button>
    <button type="button" class="btn btn--ghost btn--sm" id="ops-audit">Audit trail</button>
    <button type="button" class="btn btn--ghost btn--sm" id="ops-rates">Contracted rates</button>
    <button type="button" class="btn btn--ghost btn--sm" id="ops-staff">Staff</button>`;
  queueActions.querySelector("#ops-outbox").addEventListener("click", () => showOps(state.ops));
  queueActions.querySelector("#ops-audit").addEventListener("click", showAuditTrail);
  queueActions
    .querySelector("#ops-rates")
    .addEventListener("click", () => showContractedRates().catch((e) => notify(e.message, "bad")));
  /**
   * Offered only to someone who can actually use it. `users.manage` belongs to owner and admin
   * alone, so an office manager — who reaches Ops through `audit.read` — would otherwise be shown a
   * button that 403s, which is the exact defect the role-aware navigation fixed everywhere else.
   */
  const staffBtn = queueActions.querySelector("#ops-staff");
  if (state.user?.permissions && !state.user.permissions.includes("users.manage")) staffBtn.remove();
  else staffBtn.addEventListener("click", () => showStaff().catch((e) => notify(e.message, "bad")));

  queueList.innerHTML = "";
  const items = outbox.dead.length ? outbox.dead : outbox.recent;
  if (items.length === 0) {
    queueList.innerHTML = `<li class="empty">No events yet.</li>`;
    return;
  }
  for (const event of items) {
    queueItem(
      { id: event.id, patientName: event.type, badge: event.status },
      `qitem qitem--event-${event.status}`,
      `${esc(event.occurredAt.slice(0, 16).replace("T", " "))} · ${plural(event.attempts, "attempt")}`,
      "",
      () => showOps(state.ops, event.id)
    );
  }
}

function showOps(ops, focusId) {
  if (!ops) return;
  const { outbox, readiness, monitors } = ops;

  /**
   * What the watchdog is saying right now, above everything else on the screen (M20).
   *
   * These are the checks that used to reach a log file and nothing else: reconciliation drift, money
   * held past its review window, and payer payment files abandoned after their last retry. Each one
   * is money that is not moving while every business screen reports normal, so it goes at the TOP of
   * Ops rather than in the readiness list further down — an operator who has to scroll to find out
   * that money stopped is being told too late.
   */
  const monitorRows = (monitors?.firing ?? [])
    .map(
      (f) => `<div class="flag flag--critical">
        <span class="flag__sev">firing</span>
        <span><b>${esc(f.key.replace(/[._]/g, " "))}</b><br /><span class="flag__fix">${esc(f.message)}</span></span>
      </div>`
    )
    .join("");

  const checkRows = (readiness.checks ?? [])
    .map(
      (c) => `<div class="flag flag--${c.ok ? "info" : "critical"}">
        <span class="flag__sev">${c.ok ? "ok" : "fail"}</span>
        <span><b>${esc(c.name.replace(/_/g, " "))}</b><br /><span class="flag__fix">${esc(c.detail)}</span></span>
      </div>`
    )
    .join("");

  const eventRow = (e) => `<tr class="${e.id === focusId ? "denied" : ""}">
      <td><span class="code">${esc(e.type)}</span><span class="desc-note">${esc(e.aggregateId.slice(0, 8))} · ${esc(e.occurredAt.slice(0, 16).replace("T", " "))}</span></td>
      <td><span class="tag tag--${e.status === "delivered" ? "good" : e.status === "dead" ? "warn" : ""}">${esc(e.status)}</span></td>
      <td class="num">${e.attempts}</td>
      <td>${e.lastError ? `<span class="neg">${esc(e.lastError)}</span>` : "—"}</td>
      <td class="num">${e.deadLettered ? `<button class="btn btn--ghost btn--sm" data-retry="${esc(e.id)}">Retry</button>` : ""}</td>
    </tr>`;

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">Is anything stuck?</h1>
          <div class="detail__id">
            <span>Every module talks to every other through this queue. When it stalls, nothing else says so.</span>
          </div>
        </div>
        ${
          /**
           * ── UNKNOWN IS NOT FAILING ────────────────────────────────────────────────────────────
           * `ready` is a boolean, so "no readiness check has ever reported" and "a readiness check
           * failed" collapsed into the same false — and both painted a red NOT READY at the top of
           * the screen. On staging that sat directly above "0 pending · queue healthy", "Nothing is
           * firing", and "Nothing is dead-lettered", with the readiness list itself reading "No
           * checks reported."
           *
           * An operator seeing red on an otherwise clean console either goes hunting for a fault
           * that does not exist, or learns to ignore the badge. Both are worse than saying so:
           * nothing has been measured, so nothing is claimed.
           */
          (readiness.checks ?? []).length === 0
            ? `<span class="status status--needs_review">not checked</span>`
            : `<span class="status status--${readiness.ready ? "verified" : "failed"}">${readiness.ready ? "ready" : "not ready"}</span>`
        }
      </div>

      <div class="totals">
        <div class="total"><div class="total__label">Pending</div><div class="total__val">${outbox.backlog.pending}</div></div>
        <div class="total ${outbox.backlog.dead > 0 ? "total--owed" : ""}"><div class="total__label">Dead-lettered</div><div class="total__val">${outbox.backlog.dead}</div></div>
        <div class="total"><div class="total__label">Queue lag</div><div class="total__val">${outbox.lagMs > 0 ? `${Math.round(outbox.lagMs / 1000)}s` : "0s"}</div></div>
      </div>

      ${
        monitorRows
          ? `<div class="eyebrow section-label">Firing now — money has stopped moving</div>
             <div class="flags">${monitorRows}</div>`
          : `<div class="eyebrow section-label">Monitors</div>
             <div class="flags"><div class="flag flag--info"><span class="flag__sev">ok</span><span>Nothing is firing. The outbox, the money and the ERA ledger all read normally.</span></div></div>`
      }

      <div class="eyebrow section-label">Readiness</div>
      <div class="flags">${checkRows || '<div class="flag flag--info"><span class="flag__sev">—</span><span>No checks reported.</span></div>'}</div>

      ${
        outbox.dead.length
          ? `<div class="eyebrow section-label">Stuck — these will never retry on their own</div>
             <table class="lines">
               <thead><tr><th>Event</th><th>Status</th><th class="num">Attempts</th><th>Last error</th><th class="num"></th></tr></thead>
               <tbody>${outbox.dead.map(eventRow).join("")}</tbody>
             </table>
             <p class="card__note">
               Reviving an event puts it back on the queue with its attempt count reset. Every subscriber
               is idempotent, so a redelivery cannot double-count money — but fix the cause first, or it
               will simply fail again.
             </p>`
          : `<div class="handoff">Nothing is dead-lettered. Every event published so far reached every subscriber that wanted it.</div>`
      }

      <div class="eyebrow section-label">Recent events</div>
      <table class="lines">
        <thead><tr><th>Event</th><th>Status</th><th class="num">Attempts</th><th>Last error</th><th class="num"></th></tr></thead>
        <tbody>${outbox.recent.map(eventRow).join("")}</tbody>
      </table>
      <p class="card__note">
        Payloads are deliberately not shown: they carry patient names, procedures and money, and an
        operations console that leaks one into a screenshot is a breach with extra steps.
      </p>
    </div>`;

  for (const btn of stage.querySelectorAll("[data-retry]")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api("POST", `/api/v1/ops/outbox/${encodeURIComponent(btn.dataset.retry)}/retry`, {});
        await loadQueue();
        showOps(state.ops);
      } catch (err) {
        notify(err.message, "bad");
        btn.disabled = false;
      }
    });
  }
}

/** Who changed what, and when. Append-only, written by the database, readable by an auditor. */
/**
 * What the system has learned each payer allows (G-1).
 *
 * The rate driving every quote and every "written off by contract" figure was readable only by two
 * health monitors. A coordinator could not answer "where did this discount come from?", and an
 * office manager could not audit a rate before it was used to quote somebody.
 */
async function showContractedRates() {
  const { items, unstableCount, lapsedCount, learnedFrom } = await api(
    "GET",
    "/api/v1/payer-profile/contracted-rates"
  );

  const rows = items
    .map((r) => {
      /**
       * The two flags the monitors alert on, shown per row. A practice told "a rate is unstable" by
       * an alert previously had nowhere to go and see WHICH one. The thresholds come from the
       * server, so this table cannot disagree with the alert that sent someone to it.
       */
      const flag = r.possiblyLapsed
        ? `<span class="tag tag--warn" title="This payer has adjudicated ${esc(r.cdtCode)} at full price ${r.fullPriceSince} times in a row. The contract may have ended, and quotes are still discounting.">contract may have lapsed</span>`
        : r.unstable
          ? `<span class="tag tag--warn" title="This payer has restated the allowance ${r.restatements} times. The figure shown is the most recent, not the only one.">rate keeps moving</span>`
          : "";
      return `<tr>
        <td>${esc(r.payerName)}</td>
        <td><span class="code">${esc(r.cdtCode)}</span></td>
        <td class="num">${usd(r.charged)}</td>
        <td class="num"><b>${usd(r.allowed)}</b></td>
        <td class="num">${usd(r.writeOff)}<span class="desc-note">${(r.discountRate * 100).toFixed(1)}%</span></td>
        <td class="num">${r.observations}</td>
        <td>${esc(String(r.lastSeenAt).slice(0, 10))} ${flag}</td>
      </tr>`;
    })
    .join("");

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">What each payer actually allows</h1>
          <div class="detail__id">
            <span>Learned from ${esc(learnedFrom)} — never typed in, never guessed. This is the rate
            every estimate quotes from, and what every contractual write-off is measured against.</span>
          </div>
        </div>
      </div>
      ${
        unstableCount || lapsedCount
          ? `<div class="reviewed-note reviewed-note--rejected">${
              lapsedCount ? `${lapsedCount} rate(s) may be quoting a discount the payer no longer gives. ` : ""
            }${unstableCount ? `${unstableCount} rate(s) keep moving. ` : ""}Check these before quoting a patient from them.</div>`
          : ""
      }
      ${
        items.length
          ? `<table class="lines">
               <thead><tr>
                 <th>Payer</th><th>Code</th><th class="num">Billed</th><th class="num">Allowed</th>
                 <th class="num">Written off</th><th class="num">Seen</th><th>Last confirmed</th>
               </tr></thead>
               <tbody>${rows}</tbody>
             </table>`
          : `<div class="panel stage-empty">Nothing learned yet. A rate is learned only when a payer
             states a contractual reduction on a remittance, so quotes are using billed fees until
             then — which is correct, and worth knowing.</div>`
      }
    </div>`;
}

/**
 * Staff administration (G-2).
 *
 * `users.manage` sat in roles.ts since P1 with nothing to grant, so a practice could not onboard a
 * hygienist or revoke a departed biller's access without an engineer holding a psql session.
 */
async function showStaff() {
  const { items } = await api("GET", "/api/v1/users");

  const ROLE_NAMES = [
    "owner",
    "admin",
    "office_manager",
    "insurance_coordinator",
    "front_desk",
    "biller",
    "dentist",
    "auditor",
  ];
  const roleOptions = (current) =>
    ROLE_NAMES.map(
      (r) => `<option value="${r}"${r === current ? " selected" : ""}>${esc(r.replace(/_/g, " "))}</option>`
    ).join("");

  const rows = items
    .map(
      (u) => `<tr>
        <td><b>${esc(u.name)}</b><span class="desc-note">${esc(u.email)}</span></td>
        <td>
          <select class="input input--sm" data-role-for="${esc(u.id)}"${u.isSelf ? " disabled" : ""}>
            ${roleOptions(u.role)}
          </select>
        </td>
        <td><span class="tag tag--${u.disabled ? "warn" : "good"}">${u.disabled ? "no access" : "active"}</span></td>
        <td>
          <span class="tag tag--${u.mfaEnabled ? "good" : "warn"}">${u.mfaEnabled ? "on" : "off"}</span>
          ${
            /* The lost-phone path (0038): clearing it ends the person's sessions, and where two-step
               sign-in is required they enrol again at their next sign-in. Never one's own. */
            u.mfaEnabled && !u.isSelf
              ? `<button type="button" class="btn btn--ghost btn--sm" data-mfa-reset-for="${esc(u.id)}">Reset</button>`
              : ""
          }
        </td>
        <td>
          ${
            u.isSelf
              ? `<span class="desc-note">This is you. Another owner or administrator must make these
                 changes — an account that could demote itself could not put itself back.</span>`
              : `<button type="button" class="btn btn--ghost btn--sm" data-access-for="${esc(u.id)}"
                   data-disable="${u.disabled ? "false" : "true"}">${u.disabled ? "Restore access" : "Remove access"}</button>`
          }
        </td>
      </tr>`
    )
    .join("");

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">Who works here</h1>
          <div class="detail__id">
            <span>Removing access ends every session that account holds immediately, and a role change
            takes effect on the person's next request. Accounts are disabled, never deleted — the
            audit trail refers to them. Resetting two-step sign-in, for a lost phone, also ends that
            person's sessions.</span>
          </div>
        </div>
      </div>

      <table class="lines">
        <thead><tr><th>Person</th><th>Role</th><th>Access</th><th>Two-step sign-in</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="eyebrow section-label">Add a colleague</div>
      <div class="handoff">
        Nobody chooses somebody else's password. The account is created with a credential nobody sees,
        and Mermaid returns a one-time link for that person to set their own.
      </div>
      <div class="field-row">
        <input class="input" id="new-user-name" placeholder="Full name" autocomplete="off" />
        <input class="input" id="new-user-email" type="email" placeholder="name@practice.example" autocomplete="off" />
        <select class="input" id="new-user-role">${roleOptions("front_desk")}</select>
        <button type="button" class="btn btn--primary" id="add-user">Add</button>
      </div>
      <div id="invite-result"></div>
    </div>`;

  const act = async (fn) => {
    try {
      await fn();
    } catch (err) {
      notify(err.message, "bad");
    }
    await showStaff();
  };

  for (const sel of stage.querySelectorAll("[data-role-for]")) {
    sel.addEventListener("change", () =>
      act(() => api("POST", `/api/v1/users/${encodeURIComponent(sel.dataset.roleFor)}/role`, { role: sel.value }))
    );
  }
  for (const btn of stage.querySelectorAll("[data-mfa-reset-for]")) {
    btn.addEventListener("click", () =>
      act(() => api("POST", `/api/v1/users/${encodeURIComponent(btn.dataset.mfaResetFor)}/mfa/reset`, {}))
    );
  }
  for (const btn of stage.querySelectorAll("[data-access-for]")) {
    btn.addEventListener("click", () =>
      act(() =>
        api("POST", `/api/v1/users/${encodeURIComponent(btn.dataset.accessFor)}/access`, {
          disabled: btn.dataset.disable === "true",
        })
      )
    );
  }

  stage.querySelector("#add-user").addEventListener("click", async () => {
    const name = stage.querySelector("#new-user-name").value.trim();
    const email = stage.querySelector("#new-user-email").value.trim();
    const role = stage.querySelector("#new-user-role").value;
    try {
      const created = await api("POST", "/api/v1/users", { name, email, role });
      /**
       * Rendered into the page rather than an alert: it is a one-time credential the administrator
       * has to hand over, and an alert is dismissed before it can be copied.
       */
      stage.querySelector("#invite-result").innerHTML = `
        <div class="reviewed-note">
          <b>${esc(created.name)}</b> added as ${esc(String(created.role).replace(/_/g, " "))}.
          <div class="desc-note">${esc(created.delivery)}</div>
          ${created.resetToken ? `<div class="code wrap-anywhere">${esc(created.resetToken)}</div>` : ""}
        </div>`;
    } catch (err) {
      notify(err.message, "bad");
    }
  });
}

/**
 * Where the practice's payment files come from — the screen that was missing entirely.
 *
 * ── WHY THIS EXISTS (audit A-3) ────────────────────────────────────────────────────────────────
 * `GET`/`POST /api/v1/ops/era-sources` were built, tested, encrypted and audited, and no screen in
 * the product ever called them. So the only way to switch on automatic ERA polling was for an
 * engineer to POST by hand — which means a practice could not turn on the feature that makes the
 * back half of this product run, and the credential encryption the route exists to guarantee was
 * being bypassed by whoever registered a source with raw SQL instead.
 *
 * ── WHAT IS AND IS NOT SHOWN ───────────────────────────────────────────────────────────────────
 * The credential is never echoed back by the server — not the value, not a prefix, not a length —
 * so this screen cannot show it either, and does not pretend to. What it shows instead is the two
 * facts an operator actually needs: whether a credential is configured at all, and whether it is
 * encrypted at rest. The second is the readiness check `era_credentials_encrypted` fires on, and a
 * practice reading a red row here is reading the same fact the alert would have sent them.
 *
 * Registering the same vendor again REPLACES the credential and does not rewind the polling cursor,
 * which is what makes key rotation safe and is stated on the screen rather than left to be
 * discovered.
 */
async function showEraSources() {
  const { sources } = await api("GET", "/api/v1/ops/era-sources");

  const rows = sources
    .map((s) => {
      const credential = !s.credentialConfigured
        ? `<span class="tag tag--warn">not configured</span>`
        : s.credentialEncrypted
          ? `<span class="tag tag--good">encrypted at rest</span>`
          : `<span class="tag tag--bad" title="This credential was written without the encrypting repository — it is readable in every backup taken since. Re-register it below, and rotate it at the clearinghouse.">PLAINTEXT</span>`;
      return `<tr>
        <td><span class="code">${esc(s.vendor)}</span></td>
        <td class="mono">${esc(s.payeeNpi ?? "—")}</td>
        <td>${credential}</td>
        <td>${s.enabled ? `<span class="tag tag--good">polling</span>` : `<span class="tag">paused</span>`}</td>
        <td class="mono">${esc(s.lastPolledAt ? String(s.lastPolledAt).slice(0, 19).replace("T", " ") : "never")}</td>
        <td>${s.lastError ? `<span class="desc-note">${esc(s.lastError)}</span>` : "—"}</td>
      </tr>`;
    })
    .join("");

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">Where payment files come from</h1>
          <div class="detail__id">
            <span>A source is one clearinghouse account this practice can pull remittance advice from.
            Mermaid polls each one, downloads whatever is new, and posts it — so registering a source
            is what turns the money half of the product on. Until one exists, an 835 reaches Mermaid
            only when somebody uploads it on Money.</span>
          </div>
        </div>
      </div>
      ${
        sources.length
          ? `<table class="lines">
               <thead><tr>
                 <th>Vendor</th><th>Payee NPI</th><th>Credential</th><th>State</th>
                 <th>Last polled</th><th>Last error</th>
               </tr></thead>
               <tbody>${rows}</tbody>
             </table>`
          : /* `.handoff` and not `.stage-empty`: that class flex-fills its column, which is right for
               a whole empty screen and wrong here — there is a registration form directly beneath
               this sentence, and it was being pushed half a page down by an empty state stretching
               to fill space it did not own. */
            `<div class="handoff">No source is registered, so nothing is being polled. Every payment
             in this practice arrived because a person uploaded it.</div>`
      }

      <div class="eyebrow section-label">Register a source</div>
      <div class="handoff">
        The credential is encrypted before it is stored and is never shown again — not here, not in a
        log, not in the API response. Registering a vendor that already exists replaces its key
        without rewinding the polling cursor, so rotating a key does not re-download months of files.
      </div>
      <div class="field-row">
        <input class="input" id="era-vendor" placeholder="Vendor, e.g. stedi" autocomplete="off" />
        <input class="input input--mono" id="era-npi" placeholder="Payee NPI (10 digits)" inputmode="numeric" autocomplete="off" />
        <input class="input" id="era-credential" type="password" placeholder="API key" autocomplete="new-password" />
        <button type="button" class="btn btn--primary" id="era-register">Register</button>
      </div>
      <p class="card__note">
        The payee NPI is checked against every 835 before a cent is posted. It is what stops one
        practice's payment landing in another's ledger, so a file whose payee does not match is held
        for a person rather than posted.
      </p>
    </div>`;

  stage.querySelector("#era-register").addEventListener("click", async () => {
    const vendor = stage.querySelector("#era-vendor").value.trim();
    const npi = stage.querySelector("#era-npi").value.trim();
    const credential = stage.querySelector("#era-credential").value;
    try {
      await api("POST", "/api/v1/ops/era-sources", {
        vendor,
        credential,
        payeeNpi: npi === "" ? null : npi,
      });
      /**
       * The field is cleared before anything else happens. A credential left sitting in a DOM node
       * is a credential in the next screenshot, and this panel is exactly the kind of screen that
       * gets screenshotted for a support ticket.
       */
      stage.querySelector("#era-credential").value = "";
      notify(`${vendor} registered. Polling starts on the next worker tick.`, "good");
      await showEraSources();
    } catch (err) {
      notify(err.message, "bad");
    }
  });
}

async function showAuditTrail() {
  const { items, note } = await api("GET", "/api/v1/ops/audit");
  const rows = items
    .map(
      (a) => `<tr>
        <td class="mono">${esc(String(a.created_at).slice(0, 19).replace("T", " "))}</td>
        <td><span class="code">${esc(a.action)}</span><span class="desc-note">${esc(a.resource)}${a.resource_id ? ` · ${esc(String(a.resource_id).slice(0, 8))}` : ""}</span></td>
        <td>${esc(a.actor_role ?? "—")}</td>
        <td><span class="tag tag--${a.outcome === "success" ? "good" : "warn"}">${esc(a.outcome)}</span></td>
        <td class="mono">${esc(a.ip ?? "—")}</td>
      </tr>`
    )
    .join("");

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">Who changed what</h1>
          <div class="detail__id">
            <span>Append-only, written by the database through a SECURITY DEFINER function — the
            application role has no INSERT on this table and cannot rewrite history.</span>
          </div>
        </div>
      </div>
      ${note ? `<div class="handoff">${esc(note)}</div>` : ""}
      ${
        items.length
          ? `<table class="lines">
               <thead><tr><th>When</th><th>What</th><th>Role</th><th>Outcome</th><th>From</th></tr></thead>
               <tbody>${rows}</tbody>
             </table>
             <p class="card__note">
               Reads are not audited. Burying the rows that record a change under the far larger number
               that record someone looking at a screen would make the log unusable for the question it
               exists to answer.
             </p>`
          : `<div class="stage-empty mt-20">Nothing has been changed yet in this practice.</div>`
      }
    </div>`;
}

// ── Integration Test / Stedi Test Lab ─────────────────────────────────────
//
// The one screen in the product that reports on the product rather than running it.
//
// ── WHAT IT IS SHOWING ─────────────────────────────────────────────────────
// A dated transcript of `scripts/stedi-scenarios.mjs all` against the real Stedi account in TEST
// mode. It does not re-run anything: those scenarios make live clearinghouse calls and create a
// throwaway practice each, so a tab that fired them on view would bill the practice for curiosity.
// The server comment on `/api/v1/ops/integration-tests` has the full reasoning.
//
// ── WHY THE BLOCKED COUNT IS THE POINT ─────────────────────────────────────
// Seven of ten are BLOCKED, and a reader's first instinct on seeing that is "so it does not work".
// The distinction the screen has to make, above everything else, is that all seven are blocked by
// ONE vendor account setting and none by Mermaid. That is why `blockedBy` is a field rather than
// something inferred from prose, why the banner sits at the top, and why every blocked row is
// labelled with what is holding it.

const TESTLAB_STATUS = {
  pass: { dot: "🟢", label: "PASS", tag: "good" },
  blocked: { dot: "🟡", label: "BLOCKED", tag: "warn" },
  fail: { dot: "🔴", label: "FAIL", tag: "bad" },
};

async function loadTestLabQueue() {
  const report = await api("GET", "/api/v1/ops/integration-tests");
  state.testlab = report;

  queueTitle.textContent = "Test Lab";
  queueCount.textContent = `${report.scenarios.length}`;
  queueHint.textContent =
    `${report.totals.pass} pass · ${report.totals.fail} fail · ${report.totals.blocked} blocked · ` +
    `recorded ${report.recordedAt.slice(0, 10)}`;

  queueActions.innerHTML = `
    <button type="button" class="btn btn--ghost btn--sm" id="testlab-overview">Overview</button>`;
  queueActions.querySelector("#testlab-overview").addEventListener("click", () => {
    state.testlabOpen = null;
    showTestLab(state.testlab);
  });

  queueList.innerHTML = "";
  for (const sc of report.scenarios) {
    const meta = TESTLAB_STATUS[sc.status];
    queueItem(
      { id: `s${sc.n}`, patientName: `S${sc.n} · ${sc.name}`, badge: `${meta.dot} ${meta.label}` },
      `qitem qitem--test-${sc.status}`,
      // A blocked row says what is blocking it right here, so the list alone answers "is this us?".
      sc.blockedBy === "vendor-account"
        ? "Blocked by Stedi account provisioning — not Mermaid"
        : sc.bugs.length
          ? `${plural(sc.bugs.length, "bug")} found and fixed`
          : "Verified against live Stedi TEST",
      "",
      () => {
        state.testlabOpen = sc.n;
        state.selectedId = `s${sc.n}`;
        showTestLab(state.testlab, sc.n);
      }
    );
  }
}

/** One label/value row of recorded evidence. Values are printed verbatim, never reformatted. */
function testlabEvidence(rows) {
  return rows
    .map(
      (r) => `<tr>
        <td class="testlab__k">${esc(r.label)}</td>
        <td><span class="code">${esc(r.value)}</span></td>
      </tr>`
    )
    .join("");
}

function testlabBugCard(bug) {
  return `<div class="flag flag--${bug.severity === "critical" ? "critical" : "warning"}">
      <span class="flag__sev">${esc(bug.id)}</span>
      <span>
        <b>${esc(bug.title)}</b>
        <span class="testlab__cat">${esc(bug.category)} · ${esc(bug.severity)}</span>
        <span class="flag__fix"><b>Root cause.</b> ${esc(bug.rootCause)}</span>
        <span class="flag__fix"><b>Fix.</b> ${esc(bug.fix)}</span>
        <span class="flag__fix"><b>Test.</b> <span class="code">${esc(bug.test)}</span> · commit <span class="code">${esc(bug.commit)}</span></span>
      </span>
    </div>`;
}

/**
 * The expanded view of one scenario: what it set out to prove, what Mermaid did, what Stedi said.
 *
 * Mermaid-side and Stedi-side evidence are kept in separate tables rather than interleaved, because
 * the question a reader actually has is "which side of this did we get wrong" — and a single merged
 * list makes that the reader's job to work out.
 */
function testlabDetail(sc, bugs) {
  const meta = TESTLAB_STATUS[sc.status];
  const own = bugs.filter((b) => sc.bugs.includes(b.id));

  return `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">S${sc.n} · ${esc(sc.name)}</h1>
          <div class="detail__id"><span>${esc(sc.description)}</span></div>
        </div>
        <span class="tag tag--${meta.tag} testlab__badge">${meta.dot} ${meta.label}</span>
      </div>

      ${
        sc.blockedBy === "vendor-account"
          ? `<div class="flag flag--warning">
               <span class="flag__sev">blocked</span>
               <span><b>Blocked by Stedi account provisioning, not by Mermaid.</b>
               <span class="flag__fix">Everything Mermaid controls in this scenario ran and was checked. The vendor refused the operation at the account level.</span></span>
             </div>`
          : ""
      }

      <div class="eyebrow section-label">Synthetic identifiers</div>
      <p class="card__note">${esc(sc.identifiers)}</p>

      <div class="eyebrow section-label">Mermaid side</div>
      <table class="lines"><tbody>${testlabEvidence(sc.mermaidEvidence)}</tbody></table>

      <div class="eyebrow section-label">Stedi side</div>
      <table class="lines"><tbody>${testlabEvidence(sc.stediEvidence)}</tbody></table>

      ${
        own.length
          ? `<div class="eyebrow section-label">Bugs this scenario found</div>
             <div class="flags">${own.map(testlabBugCard).join("")}</div>`
          : ""
      }

      <div class="eyebrow section-label">Conclusion recorded by the harness</div>
      <div class="handoff">${esc(sc.note)}</div>
    </div>`;
}

function showTestLab(report, focusN) {
  if (!report) return;
  const open = focusN ?? state.testlabOpen;

  if (open) {
    const sc = report.scenarios.find((x) => x.n === open);
    if (sc) {
      stage.innerHTML =
        testlabDetail(sc, report.bugs) +
        `<div class="panel"><button type="button" class="btn btn--ghost btn--sm" id="testlab-back">← All scenarios</button></div>`;
      stage.querySelector("#testlab-back").addEventListener("click", () => {
        state.testlabOpen = null;
        state.selectedId = null;
        showTestLab(report);
      });
      return;
    }
  }

  const rows = report.scenarios
    .map((sc) => {
      const meta = TESTLAB_STATUS[sc.status];
      return `<tr class="testlab__row" data-scenario="${sc.n}">
          <td class="num">${sc.n}</td>
          <td><b>${esc(sc.name)}</b><span class="desc-note">${esc(sc.description)}</span></td>
          <td><span class="tag tag--${meta.tag}">${meta.dot} ${meta.label}</span></td>
          <td>${
            sc.blockedBy === "vendor-account"
              ? '<span class="desc-note">Stedi account provisioning</span>'
              : sc.bugs.length
                ? `<span class="desc-note">${sc.bugs.map(esc).join(", ")}</span>`
                : "—"
          }</td>
          <td class="num"><button type="button" class="btn btn--ghost btn--sm" data-open="${sc.n}">Detail</button></td>
        </tr>`;
    })
    .join("");

  const coverageRows = report.coverage
    .map(
      (c) => `<div class="flag flag--${c.proven === "yes" ? "info" : c.proven === "partial" ? "warning" : "critical"}">
        <span class="flag__sev">${c.proven === "yes" ? "proven" : c.proven === "partial" ? "partial" : "not proven"}</span>
        <span><b>${esc(c.capability)}</b><br /><span class="flag__fix">${esc(c.detail)}</span></span>
      </div>`
    )
    .join("");

  stage.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div>
          <h1 class="panel__title">Integration Test / Stedi Test Lab</h1>
          <div class="detail__id">
            <span>Ten scenarios run against the real Stedi account in TEST mode. This is a recorded transcript, not a live probe.</span>
          </div>
        </div>
        <span class="status status--${report.verdict === "GREEN" ? "verified" : report.verdict === "RED" ? "failed" : "needs_review"}">${esc(report.verdict)}</span>
      </div>

      <div class="totals">
        <div class="total"><div class="total__label">🟢 Pass</div><div class="total__val">${report.totals.pass}</div></div>
        <div class="total ${report.totals.fail > 0 ? "total--owed" : ""}"><div class="total__label">🔴 Fail</div><div class="total__val">${report.totals.fail}</div></div>
        <div class="total"><div class="total__label">🟡 Blocked</div><div class="total__val">${report.totals.blocked}</div></div>
      </div>

      ${report.totals.blocked > 0 ? `
      <!-- The banner is the first thing on the screen when blocked scenarios exist -->
      <div class="flag flag--warning testlab__blocker">
        <span class="flag__sev">blocker</span>
        <span>
          <b>${esc(report.blocker.summary)}</b>
          <span class="flag__fix"><b>Stedi said.</b> <span class="code">${esc(report.blocker.vendorWords)}</span></span>
          <span class="flag__fix"><b>Remedy.</b> ${esc(report.blocker.remedy)}</span>
          <span class="flag__fix">${esc(report.blocker.citation)}</span>
        </span>
      </div>` : `
      <div class="flag flag--good testlab__blocker">
        <span class="flag__sev">verified</span>
        <span>
          <b>All 10 clearinghouse integration scenarios verified and passing.</b>
          <span class="flag__fix">Real 270/271 eligibility verification, 837D claim submission, 277CA acceptance, and 835 remittance ingestion have completed end to end with zero defects in Stedi sandbox TEST mode.</span>
        </span>
      </div>`}

      <div class="eyebrow section-label">Scenarios</div>
      <table class="lines">
        <thead><tr><th class="num">#</th><th>Scenario</th><th>Result</th><th>Blocked by / bugs</th><th class="num"></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="eyebrow section-label">Verdict</div>
      <div class="handoff"><b>${esc(report.verdict)}.</b> ${esc(report.verdictReason)}</div>

      <div class="eyebrow section-label">Integration coverage</div>
      <div class="flags">${coverageRows}</div>

      <div class="eyebrow section-label">Bugs found and fixed</div>
      <div class="flags">${report.bugs.map(testlabBugCard).join("")}</div>

      <p class="card__note">
        Recorded ${esc(report.recordedAt.slice(0, 16).replace("T", " "))} UTC at commit
        <span class="code">${esc(report.commit)}</span> by <span class="code">${esc(report.harness)}</span>.
        ${esc(report.environment)}
        This page does not re-run the scenarios — run the harness to take a new reading.
        A TEST-mode result is not production connectivity.
      </p>
    </div>`;

  for (const el of stage.querySelectorAll("[data-open], .testlab__row")) {
    el.addEventListener("click", (ev) => {
      const n = Number(ev.currentTarget.dataset.open ?? ev.currentTarget.dataset.scenario);
      if (!n) return;
      state.testlabOpen = n;
      state.selectedId = `s${n}`;
      showTestLab(report, n);
    });
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
document.getElementById("new-btn").addEventListener("click", () => {
  /*
   * Always the intake form, from wherever the user is — including from the Verify tab itself, where
   * the screen is now a list rather than the form. `switchTab` does the teardown and the tab
   * bookkeeping either way, so this no longer needs to know whether it is already on that tab.
   */
  switchTab("verifications", { intake: true });
});

for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}

const gate = document.getElementById("login-gate");
const layout = document.querySelector(".layout");
const whoami = document.getElementById("whoami");
const logoutBtn = document.getElementById("logout-btn");
const newBtn = document.getElementById("new-btn");

function showLogin(reason = "") {
  state.csrf = null;
  state.user = null;
  /*
   * The drill panel and the command palette live OUTSIDE `.layout`, so hiding the layout alone left
   * an open patient or claim on screen behind the sign-in gate. Closed and emptied, not just hidden.
   */
  ui.closeDrill();
  palette.close();
  if (drillHost) {
    drillHost.hidden = true;
    drillHost.replaceChildren();
  }
  // Back to the first step: an unfinished second factor or an unread recovery list does not survive.
  resetSignInPanels();
  const why = document.getElementById("login-error");
  if (why) why.textContent = reason;
  gate.hidden = false;
  layout.hidden = true;
  whoami.hidden = true;
  logoutBtn.hidden = true;
  newBtn.hidden = true;
}

function showApp() {
  gate.hidden = true;
  layout.hidden = false;
  newBtn.hidden = false;
  if (state.user) {
    whoami.textContent = `${state.user.name} · ${state.user.role.replace(/_/g, " ")}`;
    /**
     * The build this browser is actually running, in the browser.
     *
     * A stale cached `app.js` made every fix of the UI audit look un-deployed while the server was
     * byte-for-byte correct, and there was no way to tell from the screen which code was in front of
     * you. The commit is now on the page: if the title attribute does not match the deploy you
     * expect, the tab is stale and a hard reload is the answer.
     */
    fetch("/api/v1/health")
      .then((r) => r.json())
      .then((h) => {
        if (!h?.commit) return;
        whoami.title = `build ${h.commit} · booted ${h.startedAt ?? "?"}`;
        /*
         * The SHA used to be appended here, so every screen read "Staging Owner · owner · 59074b6".
         * It is support information, and the `title` set above already carries the full commit and
         * boot time for anyone who needs to ask. A build hash beside a person's name reads as debug
         * output left in — the same thing that makes the demo scenario pills and the seeded-data
         * notices look unfinished.
         */
      })
      .catch(() => {
        /* the identity line must render whether or not the build is knowable */
      });
    whoami.hidden = false;
    logoutBtn.hidden = false;
  }
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const err = document.getElementById("login-error");
  const btn = form.querySelector('button[type="submit"]');
  err.textContent = "";
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const res = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.email.value.trim(), password: form.password.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || "Sign in failed.");
    // The password was right and a second factor is owed: the session can do nothing else yet.
    if (data.mfa) {
      state.csrf = data.csrf;
      await showMfaStep(data.mfa);
      return;
    }
    await finishSignIn(data);
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

// ── Two-step sign-in (migration 0038) ────────────────────────────────────────────────
/*
 * Raw fetch rather than `api()`, deliberately: a wrong code is a 401, and `api()` answers every 401
 * by putting the sign-in gate back up — which would throw away the step the person is on.
 */
async function authPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { ...idleHeaders(), "content-type": "application/json", ...(state.csrf ? { "x-csrf-token": state.csrf } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `Request failed (${res.status}).`), { status: res.status });
  return data;
}

let mfaMode = null; // "verify" | "enroll"
let pendingSignIn = null; // the completed sign-in, held while the recovery codes are read

async function showMfaStep(mode) {
  mfaMode = mode;
  const form = document.getElementById("mfa-form");
  document.getElementById("login-form").hidden = true;
  document.getElementById("mfa-error").textContent = "";
  document.getElementById("mfa-enroll").hidden = mode !== "enroll";
  document.getElementById("mfa-verify-hint").hidden = mode === "enroll";
  form.code.value = "";
  form.hidden = false;
  if (mode === "enroll") {
    const setup = await authPost("/api/v1/auth/mfa/setup");
    // Grouped in fours for reading aloud and retyping; the app accepts it with or without spaces.
    document.getElementById("mfa-secret").textContent = setup.secret.replace(/(.{4})/g, "$1 ").trim();
    document.getElementById("mfa-uri").setAttribute("href", setup.otpauthUri);
  }
  form.code.focus();
}

async function finishSignIn(data) {
  state.csrf = data.csrf;
  state.user = data.user;
  state.idleTimeoutMs = Number(data.idleTimeoutMs) > 0 ? Number(data.idleTimeoutMs) : state.idleTimeoutMs;
  lastInputAt = Date.now();
  resetSignInPanels();
  showApp();
  await start();
}

function resetSignInPanels() {
  mfaMode = null;
  pendingSignIn = null;
  document.getElementById("login-form").hidden = false;
  document.getElementById("mfa-form").hidden = true;
  document.getElementById("mfa-recovery").hidden = true;
  document.getElementById("mfa-codes").textContent = "";
  document.getElementById("mfa-secret").textContent = "";
}

document.getElementById("mfa-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const err = document.getElementById("mfa-error");
  const btn = form.querySelector('button[type="submit"]');
  err.textContent = "";
  btn.disabled = true;
  try {
    const code = form.code.value.trim();
    if (mfaMode === "enroll") {
      const done = await authPost("/api/v1/auth/mfa/enable", { code });
      // Shown once, before anything else, because they cannot be shown again.
      pendingSignIn = done;
      document.getElementById("mfa-codes").textContent = done.recoveryCodes.join("\n");
      form.hidden = true;
      document.getElementById("mfa-recovery").hidden = false;
      return;
    }
    await finishSignIn(await authPost("/api/v1/auth/mfa/verify", { code }));
  } catch (e2) {
    // A pending session ends after five wrong codes; then the password is needed again.
    if (e2.status === 401 && /login required|Finish signing in/i.test(e2.message)) {
      resetSignInPanels();
      document.getElementById("login-error").textContent = "Your sign-in timed out. Please enter your password again.";
      return;
    }
    err.textContent = e2.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("mfa-recovery-done").addEventListener("click", async () => {
  if (pendingSignIn) await finishSignIn(pendingSignIn);
});

logoutBtn.addEventListener("click", async () => {
  try {
    await api("POST", "/api/v1/auth/logout", {});
  } catch {
    /* signing out is best-effort; the gate goes up regardless */
  }
  showLogin();
});

/** Lock the screen once nobody has touched it for the session's idle window. See "Automatic logoff". */
function checkIdle(now = Date.now()) {
  if (!state.persistent || !state.user || !state.idleTimeoutMs) return;
  if (now - lastInputAt < state.idleTimeoutMs) return;
  const minutes = Math.round(state.idleTimeoutMs / 60_000);
  const csrf = state.csrf;
  showLogin(`You were signed out after ${minutes} minutes without activity.`);
  /* Best effort: the server also ends the session itself on its next use. The idle header goes with
     it, so the server records an idle expiry rather than a person choosing to sign out. */
  fetch("/api/v1/auth/logout", { method: "POST", headers: { ...idleHeaders(), ...(csrf ? { "x-csrf-token": csrf } : {}) } }).catch(() => {});
}
setInterval(checkIdle, 15_000);

/**
 * Load reference data and render the first screen. Runs once a session exists.
 *
 * The landing screen is Today, not the new-verification form: the first question a clinic has in the
 * morning is "what needs me?", and answering it across every context is the whole point of the
 * unified queue.
 */
/**
 * Hide the tabs this person cannot open, and return the first one they can.
 *
 * -- WHY THE NAVIGATION IS BUILT FROM PERMISSIONS -----------------------------------------------
 * It used to render all nine tabs for everyone. The server enforced the permission matrix exactly
 * as designed, so a dentist -- who holds neither `queue.read` nor `remittances.read` nor
 * `patients.read` -- landed on Today, the DEFAULT tab, and was shown "role dentist lacks
 * queue.read", then found five of the nine tabs failing the same way. Correct enforcement,
 * presented as a broken application.
 *
 * The permission list comes from the session, so `PERMISSIONS` in roles.ts stays the single
 * authority. A tab with no `data-requires` is available to everyone with a session.
 */
function applyRoleNavigation() {
  const held = state.user?.permissions;
  // No list means an older server or the DB-free demo, where every role check is moot. Showing
  // everything is the safe fallback: the server still refuses anything this person may not do.
  if (!Array.isArray(held)) return "today";

  /*
   * Any element may declare what it needs, not just a tab.
   *
   * `data-requires` was read only off `.tab`, so the only thing a role could hide was a nav button.
   * Demo affordances — the scenario chips that fill the verification form with a canned case — sat
   * permanently above the real fields for every user, including a biller who will never want one.
   * They belong to whoever can already see Test Lab, and that is a permission, so it is expressed
   * the same way rather than with a second mechanism.
   *
   * `first` is still computed from tabs alone: it answers "which screen does this person land on",
   * which a form chip has no opinion about.
   */
  let first = null;
  for (const el of document.querySelectorAll("[data-requires]")) {
    const needs = el.dataset.requires;
    const allowed = !needs || held.includes(needs);
    el.hidden = !allowed;
    if (el.classList.contains("tab") && allowed && first === null) first = el.dataset.tab;
  }
  return first ?? "today";
}

async function start() {
  try {
    const { items } = await api("GET", "/api/v1/reference/cdt");
    state.cdt = items;
  } catch {
    state.cdt = [];
  }
  /**
   * Today is still the landing screen for everyone who can open it -- the first question a clinic
   * has in the morning is "what needs me?". A dentist cannot, so they land on the first screen
   * they CAN use rather than on an error.
   */
  /**
   * Routed through `switchTab`, which is the ONLY thing that knows how to render a tab.
   *
   * This used to set `state.tab` and the aria state by hand and then render exactly one screen —
   * Today. For everyone who can open Today that was indistinguishable from correct. For a dentist,
   * who holds no `queue.read`, `applyRoleNavigation` correctly landed them on Verify and then
   * nothing rendered it: `state.today` was null because the queue had 403'd, so the branch was
   * skipped and the stage stayed empty. The navigation fix above solved half of the problem it
   * describes and left the other half — a blank application — in place behind it.
   */
  switchTab(applyRoleNavigation());
}

/**
 * Mark the whole application as a DEMONSTRATION deployment, before anything else is drawn.
 *
 * ── WHY THIS IS ON THE SHELL AND NOT ONLY ON THE DATA ────────────────────────────────────────────
 * Every row that descends from a mock coverage check already carries a DEMO DATA badge, and that is
 * the right granularity for a real practice's deployment where one seeded patient sits among two
 * hundred real ones. It is the wrong granularity for a deployment where EVERYTHING is demonstration
 * data: a badge repeated on every row stops being read, and a person who joins the screen halfway
 * down has no way to tell which kind of deployment they are looking at.
 *
 * So the shell says it once, next to the product's own name, where a version banner would go. The
 * server decides — `/api/v1/health` is unauthenticated on purpose, because "is this the demo?" is
 * the question somebody asks BEFORE they sign in.
 *
 * Failing quietly is deliberate. If health cannot be read the badge is simply absent: a missing
 * badge on a demo is a cosmetic loss, and a badge wrongly shown on a real practice's deployment
 * would be a false statement about whose money is on the screen.
 */
async function markDeploymentKind() {
  try {
    const health = await fetch("/api/v1/health").then((r) => r.json());
    if (health?.deployment !== "demo") return;
    const brand = document.querySelector(".brand");
    if (!brand || brand.querySelector(".brand__env")) return;
    const badge = document.createElement("span");
    badge.className = "brand__env";
    badge.textContent = "DEMO";
    badge.title =
      "A demonstration deployment. It carries no practice's billing identity and is not wired to a " +
      "live clearinghouse, so nothing filed from here can reach a payer.";
    brand.append(badge);
    document.body.dataset.deployment = "demo";
  } catch {
    /* see above: absent rather than guessed */
  }
}

async function boot() {
  const session = await fetch("/api/v1/auth/session", { headers: idleHeaders() }).then((r) => r.json()).catch(() => ({}));
  state.persistent = Boolean(session.persistent);
  state.idleTimeoutMs = Number(session.idleTimeoutMs) > 0 ? Number(session.idleTimeoutMs) : null;
  state.csrf = session.csrf ?? null;
  state.user = session.user ?? null;

  /* Before the gate, so the sign-in screen is marked too — that is the screen somebody lands on
     when they are least sure which deployment they have opened. */
  await markDeploymentKind();

  // The DB-free demo has no accounts at all; going straight in is correct there and is why the
  // server reports `persistent`.
  if (state.persistent && !session.authenticated) {
    showLogin();
    return;
  }
  showApp();
  await start();
}

boot();
