/**
 * The command palette (spec §5.7).
 *
 * ── WHAT IT IS, AND WHAT IT IS NOT ───────────────────────────────────────────────────────────────
 * §5.7 opens by saying it: "Not a search box — the fastest path to any entity or action." The
 * difference is real. A search box takes a query and returns matches; this takes what a person
 * typed and works out what they meant, because in a revenue cycle the SHAPE of what you type
 * already says which thing you are after:
 *
 *     84210             five or more digits → a claim or a member ID
 *     D2750             a D and four digits → a procedure code
 *     $1,125            a dollar prefix     → an amount, matched within a tolerance
 *     delta             free text           → payers, patients, screens and actions at once
 *
 * ── WHY ROUTING BEATS RANKING ────────────────────────────────────────────────────────────────────
 * A single ranked list would put a patient called "Delta" above the payer Delta Dental on a good
 * day and below it on a bad one, and the person typing already knew which they wanted. Routing by
 * shape is not a shortcut around relevance scoring — it is the information the query itself carries,
 * and throwing it away to re-derive it statistically is the worse design.
 *
 * ── WHY IT SEARCHES WHAT THE SCREENS ALREADY HOLD ────────────────────────────────────────────────
 * There is no search endpoint, and this does not invent one: it queries the same four list APIs the
 * screens use, once, when the palette first opens. That has a real consequence and it is stated in
 * the footer rather than hidden — the palette searches the working set those endpoints return, not
 * the whole database. A palette that silently searched a subset while looking like it searched
 * everything would be worse than one that says so.
 */

import { maskId, maskName } from "./privacy.js";

const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const usdExact = (cents) => {
  const v = Number(cents ?? 0) / 100;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? "−" : ""}$${s}`;
};

/** Which kind of thing a query is asking for, decided by its shape (§5.7). */
export function routeQuery(raw) {
  const q = String(raw ?? "").trim();
  if (!q) return { kind: "recent", term: "" };
  /*
   * An amount, with the separators a person actually types stripped before parsing.
   *
   * The digit check is not redundant: `Number("")` is 0, not NaN, so a bare `$` — which someone has
   * typed the instant they reach for this — would otherwise route to an amount of ZERO and match
   * every record with a zero balance. `Number.isFinite` alone lets that straight through.
   */
  if (/^\$/.test(q)) {
    const bare = q.replace(/[$,\s]/g, "");
    const n = Number(bare);
    return /\d/.test(bare) && Number.isFinite(n)
      ? { kind: "amount", term: q, cents: Math.round(n * 100) }
      : { kind: "text", term: q };
  }
  /* A CDT code: a D and four digits. Case-insensitive because nobody holds shift for this. */
  if (/^d\d{1,4}$/i.test(q)) return { kind: "code", term: q.toUpperCase() };
  /* Five or more digits, or an alphanumeric run with no spaces, is an identifier. */
  if (/^\d{5,}$/.test(q)) return { kind: "id", term: q };
  return { kind: "text", term: q };
}

/**
 * How close an amount has to be to count as a match.
 *
 * A dollar, not a percentage. Someone typing `$1,125` from a remittance is quoting an exact figure
 * and wants that claim; a percentage tolerance would widen with the amount and return four claims
 * for a large one. The cents are the point of typing it.
 */
const AMOUNT_TOLERANCE_CENTS = 100;

/**
 * Everything the palette can reach that is not a record: the screens, and the actions §5.7 names.
 *
 * Actions NAVIGATE — `appeal` goes to Recover, it does not draft an appeal. A palette that performed
 * money or compliance actions from a text box would be a way around every human gate in this
 * product, and the gates are the product.
 */
const DESTINATIONS = [
  { tab: "today", label: "Today", hint: "what needs a person right now", words: "today triage queue needs" },
  { tab: "verifications", label: "Verify", hint: "whose coverage has been checked", words: "verify verification coverage eligibility check" },
  { tab: "claims", label: "Claims", hint: "where every claim is, and what is stuck", words: "claims claim billing submit resubmit release 837" },
  { tab: "money", label: "Money", hint: "what the payer actually sent", words: "money cash collected remittance post payment era 835" },
  { tab: "recovery", label: "Recover", hint: "what was denied, and what is worth chasing", words: "recover denial denied appeal appeals carc" },
  { tab: "patients", label: "Patients", hint: "who owes us, and how old it is", words: "patients patient balance statement ledger ar aging" },
  { tab: "insights", label: "Insights", hint: "what is systematically changing", words: "insights report analytics compare payers cohort scorecard" },
  { tab: "ops", label: "Ops", hint: "is the machine keeping up", words: "ops operations outbox audit monitors queue health" },
];

/**
 * @param {object} deps
 * @param {(method: string, path: string) => Promise<any>} deps.api
 * @param {(tab: string) => void} deps.go            switch to a screen
 * @param {(entry: object) => void} deps.openDrill   push a drill entry for a record
 */
export function createPalette({ api, go, openDrill }) {
  const root = node("div", "pal");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Command palette");

  const sheet = node("div", "pal__sheet");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "pal__in";
  input.setAttribute("aria-label", "Search or jump to");
  input.placeholder = "Search a patient, payer, claim, amount or code — or jump to a screen";
  input.autocomplete = "off";
  input.spellcheck = false;

  const list = node("div", "pal__list");
  list.setAttribute("role", "listbox");
  const foot = node("div", "pal__foot");

  sheet.append(input, list, foot);
  root.append(sheet);

  /* ── State ────────────────────────────────────────────────────────────────────────────────── */
  let records = null;      /* the working set, fetched once on first open */
  let loading = false;
  let results = [];
  let active = 0;
  /** The last few things opened from here, so an empty palette is still useful (§5.7). */
  const recent = [];

  /* ── The working set ──────────────────────────────────────────────────────────────────────── */
  async function ensureRecords() {
    if (records || loading) return;
    loading = true;
    draw();
    /*
     * Each list is optional. A palette that returned nothing because ONE endpoint was down would be
     * useless exactly when a person is trying to find something in a hurry.
     */
    const [p, c, d, v] = await Promise.all([
      api("GET", "/api/v1/patients").catch(() => null),
      api("GET", "/api/v1/claims").catch(() => null),
      api("GET", "/api/v1/denials").catch(() => null),
      api("GET", "/api/v1/verifications").catch(() => null),
    ]);
    records = {
      patients: p?.items ?? [],
      claims: c?.items ?? [],
      denials: d?.items ?? [],
      verifications: v?.items ?? [],
      partial: [p, c, d, v].some((x) => x === null),
    };
    loading = false;
    draw();
  }

  /* ── Matching ─────────────────────────────────────────────────────────────────────────────── */
  const contains = (haystack, needle) => String(haystack ?? "").toLowerCase().includes(needle);

  function search(route) {
    const r = records ?? { patients: [], claims: [], denials: [], verifications: [] };
    const term = route.term.toLowerCase();
    const groups = [];

    /* Destinations and actions first when the query is text: they are the fastest thing to want. */
    if (route.kind === "text" || route.kind === "recent") {
      const dests = DESTINATIONS.filter((dd) => route.kind === "recent" || contains(dd.words, term) || contains(dd.label, term));
      if (dests.length) {
        groups.push({
          title: "Go to",
          items: dests.slice(0, route.kind === "recent" ? 8 : 5).map((dd) => ({
            label: dd.label, meta: dd.hint, run: () => go(dd.tab),
          })),
        });
      }
    }

    if (route.kind === "code") {
      /*
       * A procedure code is not on any list row — the claims list carries totals, not lines. Rather
       * than return nothing, the palette says where the code CAN be seen. Answering "I do not index
       * that, here is what does" is more useful than an empty list.
       */
      groups.push({
        title: "Procedure code",
        items: [{
          label: route.term,
          meta: "Procedure codes are on the claim itself — open a claim to see its lines",
          run: () => go("claims"),
        }],
      });
    }

    const match = {
      patient: (x) =>
        route.kind === "id" ? contains(x.patientKey, term)
        : route.kind === "amount" ? Math.abs((x.balance ?? 0) - route.cents) <= AMOUNT_TOLERANCE_CENTS
        : contains(x.patientName, term) || contains(x.patientKey, term),
      claim: (x) =>
        route.kind === "id" ? contains(x.memberId, term) || contains(x.id, term)
        : route.kind === "amount" ? Math.abs((x.totalFee ?? 0) - route.cents) <= AMOUNT_TOLERANCE_CENTS
        : contains(x.patientName, term) || contains(x.payerName, term) || contains(x.memberId, term),
      denial: (x) =>
        route.kind === "id" ? contains(x.claimId, term)
        : route.kind === "amount" ? Math.abs((x.deniedAmount ?? 0) - route.cents) <= AMOUNT_TOLERANCE_CENTS
        : contains(x.patientName, term) || contains(x.payerName, term) || contains(x.carcDescription, term) || contains(x.carcCode, term),
      verification: (x) =>
        route.kind === "id" ? contains(x.memberId, term)
        : route.kind === "amount" ? false
        : contains(x.patientName, term) || contains(x.payerName, term) || contains(x.memberId, term),
    };

    if (route.kind !== "recent" && route.kind !== "code") {
      const pts = r.patients.filter(match.patient).slice(0, 6);
      if (pts.length) {
        groups.push({
          title: `Patients (${pts.length})`,
          items: pts.map((x) => ({
            label: maskName(x.patientName),
            /* §5.7: enough metadata to disambiguate two people with the same surname. */
            meta: `${maskId(x.patientKey)} · ${usdExact(x.balance)} outstanding · ${x.daysOutstanding ?? 0}d old`,
            run: () => { go("patients"); openDrill({ kind: "patient", id: x.patientId, label: maskName(x.patientName) }); },
          })),
        });
      }

      const cls = r.claims.filter(match.claim).slice(0, 6);
      if (cls.length) {
        groups.push({
          title: `Claims (${cls.length})`,
          items: cls.map((x) => ({
            label: `${maskName(x.patientName)} · ${x.payerName ?? "no payer"}`,
            meta: `${usdExact(x.totalFee)} billed · ${String(x.status).replace(/_/g, " ")} · service ${x.serviceDate}`,
            run: () => { go("claims"); openDrill({ kind: "claim", id: x.id, label: maskName(x.patientName) }); },
          })),
        });
      }

      const dns = r.denials.filter(match.denial).slice(0, 6);
      if (dns.length) {
        groups.push({
          title: `Denials (${dns.length})`,
          items: dns.map((x) => ({
            label: `${maskName(x.patientName)} · ${x.carcDescription}`,
            meta: `${usdExact(x.deniedAmount)} denied · ${x.payerName} · CARC ${x.carcCode}`,
            run: () => { go("recovery"); openDrill({ kind: "denial", id: x.id, label: maskName(x.patientName) }); },
          })),
        });
      }

      const vfs = r.verifications.filter(match.verification).slice(0, 6);
      if (vfs.length) {
        groups.push({
          title: `Verifications (${vfs.length})`,
          items: vfs.map((x) => ({
            label: `${maskName(x.patientName)} · ${x.payerName ?? "no payer"}`,
            meta: `${x.provenance?.shortLabel ?? "unknown source"} · ${String(x.outcome).replace(/_/g, " ")}`,
            run: () => { go("verifications"); openDrill({ kind: "verification", id: x.id, label: maskName(x.patientName) }); },
          })),
        });
      }
    }

    if (route.kind === "recent" && recent.length) {
      groups.unshift({ title: "Recent", items: recent.slice(0, 5) });
    }
    return groups;
  }

  /* ── Rendering ────────────────────────────────────────────────────────────────────────────── */
  function draw() {
    const route = routeQuery(input.value);
    const groups = loading ? [] : search(route);
    results = groups.flatMap((g) => g.items);
    if (active >= results.length) active = Math.max(0, results.length - 1);

    list.replaceChildren();
    if (loading) {
      list.append(node("p", "pal__empty", "Reading the working set…"));
    } else if (results.length === 0) {
      list.append(
        node("p", "pal__empty",
          route.kind === "amount"
            ? `Nothing within a dollar of ${route.term}.`
            : `Nothing matches “${route.term}”.`)
      );
    }

    let i = 0;
    for (const g of groups) {
      list.append(node("div", "pal__g", g.title));
      for (const item of g.items) {
        const idx = i++;
        const b = node("button", "pal__i" + (idx === active ? " is-active" : ""));
        b.type = "button";
        b.setAttribute("role", "option");
        b.setAttribute("aria-selected", String(idx === active));
        b.append(node("span", "pal__i-l", item.label));
        if (item.meta) b.append(node("span", "pal__i-m", item.meta));
        b.addEventListener("click", () => choose(idx));
        /* Hover moves the selection so the mouse and the keyboard cannot disagree about it. */
        b.addEventListener("mouseenter", () => { active = idx; paintActive(); });
        list.append(b);
      }
    }

    foot.replaceChildren();
    foot.append(node("span", "pal__hint", "↑↓ to move · ↵ to open · esc to close"));
    /*
     * The limitation, stated. There is no search endpoint; this searches the working set the list
     * APIs return. A palette that looked like it searched everything while searching a page of it
     * would be worse than one that says which it is.
     */
    if (records) {
      const n = records.patients.length + records.claims.length + records.denials.length + records.verifications.length;
      foot.append(
        node("span", "pal__scope",
          records.partial
            ? `Searching ${n} loaded records — one source did not answer, so this is incomplete.`
            : `Searching ${n} loaded records, not the whole database.`)
      );
    }
  }

  function paintActive() {
    [...list.querySelectorAll(".pal__i")].forEach((el, idx) => {
      el.classList.toggle("is-active", idx === active);
      el.setAttribute("aria-selected", String(idx === active));
      if (idx === active) el.scrollIntoView({ block: "nearest" });
    });
  }

  function choose(idx) {
    const item = results[idx];
    if (!item) return;
    close();
    /* Remembered before running, so a destination that replaces the screen still lands in Recent. */
    if (item.label && !recent.some((r) => r.label === item.label)) {
      recent.unshift({ ...item });
      recent.length = Math.min(recent.length, 8);
    }
    item.run();
  }

  /* ── Open / close ─────────────────────────────────────────────────────────────────────────── */
  let lastFocus = null;

  function open() {
    if (!root.hidden) return;
    lastFocus = document.activeElement;
    root.hidden = false;
    input.value = "";
    active = 0;
    draw();
    ensureRecords();
    input.focus();
  }
  function close() {
    if (root.hidden) return;
    root.hidden = true;
    /* Focus goes back where it came from, or the palette steals it from the screen behind it. */
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  input.addEventListener("input", () => { active = 0; draw(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); active = Math.min(active + 1, results.length - 1); paintActive(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); active = Math.max(active - 1, 0); paintActive(); }
    else if (ev.key === "Enter") { ev.preventDefault(); choose(active); }
    else if (ev.key === "Escape") { ev.preventDefault(); close(); }
  });
  /* Clicking the backdrop closes; clicking the sheet must not. */
  root.addEventListener("click", (ev) => { if (ev.target === root) close(); });

  document.addEventListener("keydown", (ev) => {
    const key = String(ev.key).toLowerCase();
    if ((ev.metaKey || ev.ctrlKey) && key === "k") { ev.preventDefault(); root.hidden ? open() : close(); return; }
    /*
     * `/` opens it too, the way every list-shaped tool does — but only when the caret is not already
     * in a field, or it would swallow the slash out of someone's search term.
     */
    if (key === "/" && root.hidden && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      const t = ev.target;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (!typing) { ev.preventDefault(); open(); }
    }
  });

  return { el: root, open, close, isOpen: () => !root.hidden };
}
