/**
 * The actions a person takes on a payer advice, inside the advice drill every screen opens.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 * The rebuilt Money screen's advice drill was read-only. Release and reject lived in the legacy
 * renderer, which only the Test Lab sidebar still mounts — so no operator-facing screen could act on
 * a held advice at all. Coordination of benefits needed a place to ASK the coverage question, and
 * this is that place; release and reject come with it, because the questions are the same decision.
 *
 * What it shows is decided by the server, never re-derived here:
 *   • `releaseBlocked` — a duplicate or test file: the only action is the matching reject.
 *   • `coordination` with coverage unconfirmed — the coverage question, with the payer's evidence,
 *     what is known, what is missing, and a structured form. NO release form: there is nothing a
 *     person could type into one that answers the question.
 *   • `canPost` — an ordinary hold: release, or reject.
 *   • a posted advice with secondary work — the secondary claim, its money and its next step.
 */
const usd = (cents) =>
  (Number(cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Who is acting. A signed-in deployment ignores this and attributes every decision to the session
 * (`actorName` on the server); the DB-free demo has no session and needs a name in the body. Asked
 * once, and never invented beyond a label that says plainly it is the demo.
 */
let whoPromise = null;
const who = (api) =>
  (whoPromise ??= api("GET", "/api/v1/auth/session")
    .then((s) => s?.user?.email ?? "Demo operator")
    .catch(() => "Demo operator"));
async function withActor(api, body) {
  const actor = await who(api);
  return { actor, releasedBy: actor, rejectedBy: actor, ...body };
}

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function field(label, control) {
  const wrap = h("label", "field mb-12");
  wrap.append(h("span", "field__label", label), control);
  return wrap;
}

function input(id, { type = "text", value = "", placeholder = "" } = {}) {
  const i = h("input", "input");
  i.id = id;
  i.type = type;
  i.value = value;
  if (placeholder) i.placeholder = placeholder;
  return i;
}

function select(id, options) {
  const s = h("select", "input");
  s.id = id;
  for (const [value, label] of options) {
    const o = h("option", "", label);
    o.value = value;
    s.append(o);
  }
  return s;
}

/** A submit button that holds itself down while its request is in flight, and says what went wrong. */
function action(label, cls, run, { onDone, errorHost }) {
  const b = h("button", `btn ${cls}`, label);
  b.type = "button";
  b.addEventListener("click", async () => {
    b.disabled = true;
    const was = b.textContent;
    b.textContent = "Working…";
    errorHost.replaceChildren();
    try {
      await run();
      await onDone();
    } catch (err) {
      /* The server lists every missing item at once; show them as a list, not one line. */
      errorHost.append(h("p", "dr__p dr__err", err.message));
    } finally {
      b.disabled = false;
      b.textContent = was;
    }
  });
  return b;
}

const SOURCES = [
  ["", "Choose…"],
  ["payer-portal", "Payer portal"],
  ["payer-phone", "Phone call with the payer"],
  ["patient", "The patient"],
  ["eligibility-response", "The payer's eligibility response (271), reviewed"],
  ["other", "Other — describe it"],
];

const WORK_LABEL = {
  "not-needed": "No secondary claim needed",
  "awaiting-coverage": "Waiting on a coverage answer",
  "ready-to-file": "Ready to file with the other plan",
  "return-to-primary": "Return to the primary",
  filed: "Filed — waiting on the other plan",
  closed: "Closed",
};

/**
 * Everything a person does on this advice, as one section — or null when there is nothing to do.
 * `reload` re-renders the drill after any change, so the panel always shows the server's answer.
 */
export async function renderAdviceActions(view, { api, reload }) {
  const r = view.remittance ?? view;
  const section = h("section", "dr__s");
  const errors = h("div", "");
  const done = { onDone: reload, errorHost: errors };

  // ── A duplicate or a test file: reject is the only way out ──────────────────────────────────
  if (r.status === "held" && view.releaseBlocked) {
    const kind = view.releaseBlocked.rejectAs;
    section.append(h("div", "dr__k", kind === "test-file" ? "Test file — cannot be released" : "Duplicate — cannot be released"));
    const flags = h("div", "flags");
    const f = h("div", "flag flag--critical");
    f.append(h("span", "flag__sev", kind === "test-file" ? "test file" : "duplicate"), h("span", "", view.releaseBlocked.message));
    flags.append(f);
    section.append(flags, rejectForm(r, api, done, kind), errors);
    return section;
  }

  // ── Coordination of benefits: each claim this advice signalled ──────────────────────────────
  for (const brief of view.coordination ?? []) {
    let item;
    try {
      item = await api("GET", `/api/v1/coordination-cases/${encodeURIComponent(brief.caseId)}`);
    } catch (err) {
      section.append(h("p", "dr__p dr__err", `Could not load the coordination case — ${err.message}`));
      continue;
    }
    section.append(coordinationPanel(item, r, api, done));
  }

  // ── An ordinary hold: release or reject ─────────────────────────────────────────────────────
  if (r.status === "held" && view.canPost) {
    section.append(releaseForm(r, api, done), rejectForm(r, api, done, null));
  } else if (r.status === "held" && !(view.coordination ?? []).some((c) => c.coverageStatus === "unconfirmed")) {
    /* Held for arithmetic the payer's own file does not support: nothing a person can override. */
    section.append(
      h("p", "dr__p", "This advice cannot be posted until its arithmetic agrees with the payer's own totals. Reconcile it against the paper EOB — that is not overridable."),
      rejectForm(r, api, done, null)
    );
  }

  if (!section.children.length) return null;
  section.prepend(h("div", "dr__k", "What to do"));
  section.append(errors);
  return section;
}

function releaseForm(r, api, done) {
  const box = h("div", "review");
  box.append(h("div", "review__title", "Release this advice for posting"));
  const reason = input("adv-release-reason", { placeholder: "e.g. Reconciled against the payer's paper EOB" });
  box.append(field("Reason", reason));
  const acts = h("div", "review__actions");
  acts.append(
    action("Release & post", "btn--approve", async () =>
      api("POST", `/api/v1/remittances/${encodeURIComponent(r.id)}/release`, await withActor(api, { reason: reason.value.trim() })), done)
  );
  box.append(acts);
  return box;
}

function rejectForm(r, api, done, fixedKind) {
  const box = h("div", "review");
  box.append(
    h("div", "review__title", fixedKind === "test-file" ? "Reject as a test file" : fixedKind === "duplicate" ? "Reject as a duplicate" : "Or reject it — it will never post")
  );
  box.append(h("p", "review__hint", "The advice and its 835 are kept as a record; nothing reaches the ledger, the claim or the patient."));
  const kind = fixedKind
    ? null
    : select("adv-reject-kind", [["", "It is…"], ["duplicate", "A duplicate of a payment already recorded"], ["test-file", "A test file, not a real payment"]]);
  if (kind) box.append(field("It is", kind));
  const reason = input("adv-reject-reason", { placeholder: "e.g. Same payment as the posted advice; one deposit" });
  box.append(field("Reason", reason));
  const acts = h("div", "review__actions");
  acts.append(
    action(fixedKind ? `Reject as ${fixedKind === "test-file" ? "test file" : "duplicate"}` : "Reject & never post", "btn--reject", async () =>
      api("POST", `/api/v1/remittances/${encodeURIComponent(r.id)}/reject`, await withActor(api, { kind: fixedKind ?? kind.value, reason: reason.value.trim() })), done)
  );
  box.append(acts);
  return box;
}

function coordinationPanel(item, r, api, done) {
  const box = h("div", "review");
  const c = item.case;
  const title =
    item.coverageStatus === "unconfirmed"
      ? "Coverage needs confirming"
      : item.coverageStatus === "other-coverage"
        ? `Other coverage confirmed — ${c.confirmation?.secondary?.payerName ?? "another plan"}`
        : "No other coverage confirmed";
  box.append(h("div", "review__title", title));

  // Why it is held, in the payer's own terms.
  const signal = [
    item.forwarded ? `${item.primaryPayerName} said it forwarded claim ${item.patientControlNumber} to another plan` : `${item.primaryPayerName} assigned money on claim ${item.patientControlNumber} to another plan`,
    item.assignedCents > 0 ? `and assigned ${usd(item.assignedCents)} to that plan` : "and assigned no money to it",
  ].join(" ");
  box.append(h("p", "review__hint", `${signal}.`));

  // What is known — the evidence, each piece with its source.
  const known = h("dl", "dr__dl");
  const row = (k, v, mono) => known.append(h("dt", "", k), h("dd", mono ? "mono" : "", v));
  row("Payer named", item.crossoverCarrier ? `${item.crossoverCarrier.name}${item.crossoverCarrier.id ? ` (${item.crossoverCarrier.idQualifier ?? "id"} ${item.crossoverCarrier.id})` : ""}` : "No other plan (the 835 names nobody)");
  row(
    "Eligibility (271) said",
    item.eligibilityOtherPayers.length
      ? item.eligibilityOtherPayers.map((o) => `${o.name ?? "an unnamed plan"}${o.role !== "unspecified" ? ` as ${o.role}` : ""}`).join("; ")
      : "Nothing about another plan"
  );
  if (c.request) row("Asked", `the ${c.request.from} on ${c.request.requestedOn} — follow up by ${c.request.followUpBy}`);
  if (c.confirmation) {
    row("Answered", `${c.confirmation.outcome === "other-coverage" ? "Other coverage exists" : "No other coverage"} — ${c.confirmation.source}${c.confirmation.sourceNote ? ` (${c.confirmation.sourceNote})` : ""}, ${c.confirmation.confirmedOn}, by ${c.confirmation.confirmedBy}`);
  }
  box.append(known);

  // The money, split so assigned-to-another-plan can never be read as collected.
  const posting = (r.postings ?? []).find((p) => p.patientControlNumber === item.patientControlNumber);
  if (posting && item.assignedCents > 0) {
    const money = h("dl", "dr__dl");
    const m = (k, v) => money.append(h("dt", "", k), h("dd", "", v));
    m("Billed", usd(posting.chargedAmount));
    m("Paid by this payer", usd(posting.paidAmount));
    m("Assigned to another plan", `${usd(item.assignedCents)} — not collected`);
    m("Patient responsibility", usd(posting.patientResponsibility));
    m("Still unresolved", item.workStatus === "closed" ? usd(0) : usd(item.assignedCents));
    box.append(money);
  }

  if (item.coverageStatus === "unconfirmed") {
    box.append(
      h("p", "review__hint", "Missing before this can be released: whether the patient has another plan, where you learned it, and the date you learned it. Releasing with a reason alone is not possible — a reason is not an answer."),
      confirmForm(item, api, done),
      requestForm(item, api, done)
    );
  }

  if (item.workStatus !== "not-needed") box.append(secondaryPanel(item, api, done));
  return box;
}

function confirmForm(item, api, done) {
  const form = h("div", "");
  const outcome = select(`cob-outcome-${item.caseId}`, [["", "Choose…"], ["no-other-coverage", "No other coverage confirmed"], ["other-coverage", "Other coverage exists"]]);
  const source = select(`cob-source-${item.caseId}`, SOURCES);
  const note = input(`cob-note-${item.caseId}`, { placeholder: "Required when the source is “other”" });
  const date = input(`cob-date-${item.caseId}`, { type: "date", value: today() });
  const payer = input(`cob-payer-${item.caseId}`, { placeholder: "e.g. Delta Dental" });
  const member = input(`cob-member-${item.caseId}`, { placeholder: "The patient's ID on that plan" });
  const secondary = h("div", "");
  secondary.append(field("Other plan's payer", payer), field("Member ID on the other plan", member));
  secondary.hidden = true;
  outcome.addEventListener("change", () => { secondary.hidden = outcome.value !== "other-coverage"; });
  form.append(field("Does the patient have another plan?", outcome), field("Where the answer came from", source), field("Source details", note), field("Date the answer was obtained", date), secondary);
  const acts = h("div", "review__actions");
  acts.append(
    action("Record the answer", "btn--approve", async () =>
      api("POST", `/api/v1/coordination-cases/${encodeURIComponent(item.caseId)}/confirm-coverage`, await withActor(api, {
        outcome: outcome.value,
        source: source.value,
        sourceNote: note.value.trim(),
        confirmedOn: date.value,
        secondary: outcome.value === "other-coverage" ? { payerName: payer.value.trim(), memberId: member.value.trim() } : null,
      })), done)
  );
  form.append(acts);
  return form;
}

function requestForm(item, api, done) {
  const form = h("div", "");
  form.append(h("div", "review__title", "Or record that you asked, and when to follow up"));
  const from = select(`cob-from-${item.caseId}`, [["", "Asked…"], ["patient", "The patient"], ["payer", "The payer"]]);
  const asked = input(`cob-asked-${item.caseId}`, { type: "date", value: today() });
  const follow = input(`cob-follow-${item.caseId}`, { type: "date" });
  form.append(field("Who was asked", from), field("Asked on", asked), field("Follow up by", follow));
  const acts = h("div", "review__actions");
  acts.append(
    action("Record the request", "btn--quiet", async () =>
      api("POST", `/api/v1/coordination-cases/${encodeURIComponent(item.caseId)}/request-confirmation`, await withActor(api, {
        from: from.value,
        requestedOn: asked.value,
        followUpBy: follow.value,
      })), done)
  );
  form.append(acts);
  return form;
}

function secondaryPanel(item, api, done) {
  const box = h("div", "");
  box.append(h("div", "review__title", `Secondary claim — ${WORK_LABEL[item.workStatus] ?? item.workStatus}`));
  if (item.blockedReason) box.append(h("p", "review__hint", item.blockedReason));
  if (item.deadline) {
    box.append(
      h("p", "review__hint", `File by ${item.deadline.deadline} (${item.deadline.daysRemaining} days). ${item.deadline.estimateNote ?? ""}`.trim())
    );
  } else if (item.workStatus !== "closed") {
    box.append(h("p", "review__hint", "No filing deadline can be computed: this claim has no service date on record."));
  }

  if (item.workStatus === "ready-to-file") {
    const filed = input(`cob-filed-${item.caseId}`, { type: "date", value: today() });
    const ref = input(`cob-ref-${item.caseId}`, { placeholder: "The other plan's claim reference, if any" });
    box.append(field("Filed on", filed), field("Reference", ref));
    const acts = h("div", "review__actions");
    acts.append(
      action("Record the secondary filing", "btn--approve", async () =>
        api("POST", `/api/v1/coordination-cases/${encodeURIComponent(item.caseId)}/mark-filed`, await withActor(api, { filedOn: filed.value, reference: ref.value.trim() })), done)
    );
    box.append(acts);
  }
  if (item.workStatus === "filed" || item.workStatus === "return-to-primary") {
    const outcomes =
      item.workStatus === "filed"
        ? [["", "Outcome…"], ["secondary-paid", "The other plan paid"], ["secondary-denied", "The other plan denied it"], ["written-off", "Not pursued further"]]
        : [["", "Outcome…"], ["primary-reprocessed", "The primary reprocessed it"], ["written-off", "Not pursued further"]];
    const outcome = select(`cob-close-${item.caseId}`, outcomes);
    const note = input(`cob-close-note-${item.caseId}`, { placeholder: "What happened" });
    box.append(field("Outcome", outcome), field("Note", note));
    const acts = h("div", "review__actions");
    acts.append(
      action("Close this work", "btn--quiet", async () =>
        api("POST", `/api/v1/coordination-cases/${encodeURIComponent(item.caseId)}/close`, await withActor(api, { outcome: outcome.value, note: note.value.trim() })), done)
    );
    box.append(acts);
  }
  return box;
}

/** A one-line label for a coordination item on a worklist. */
export function coordinationLabel(item) {
  return item.coverageStatus === "unconfirmed" ? "Coverage needs confirming" : WORK_LABEL[item.workStatus] ?? item.workStatus;
}

