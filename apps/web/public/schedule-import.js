/**
 * Import a schedule export (stage 4) — choose the file, check what will come in, import it.
 *
 * Nothing is read in the browser beyond the file's text: the server parses, maps and validates, and
 * reads the file AGAIN when the import is confirmed, so what is imported is decided in one place.
 * This module only shows the server's answers and carries a person's column choices back to it.
 *
 * ── THE PREVIEW IS THE POINT ─────────────────────────────────────────────────────────────────────
 * An export is a file from another system, read by guesswork about its column names. So nothing is
 * imported until a person has seen which column became which field, how many rows will come in,
 * which dates they cover, and every row that will not — by line, with the reason — and has said yes.
 */
import { clockTime } from "./schedule.js";
import { maskName } from "./privacy.js";

/** A little under the server's 1 MB JSON limit, so the refusal is a sentence, not a 413. */
const MAX_FILE_BYTES = 900_000;

const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const usd = (cents) => `$${(Number(cents ?? 0) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const dayLabel = (d) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The preview's headline, in words. Pure, so the sentence a person decides on is tested without a DOM.
 */
export function importSummary(p) {
  if (p.fileProblems.length > 0) return "Nothing can be imported from this file until the problems below are fixed.";
  const range = p.firstDay ? (p.firstDay === p.lastDay ? ` for ${dayLabel(p.firstDay)}` : `, ${dayLabel(p.firstDay)} to ${dayLabel(p.lastDay)}`) : "";
  const head = `${p.ready} of ${plural(p.total, "appointment", "appointments")} ready to import${range}.`;
  return p.problemCount === 0 ? head : `${head} ${plural(p.problemCount, "row", "rows")} cannot be imported — each is listed with its line.`;
}

/** What an import did, in one sentence. */
export function importResultSummary(r) {
  if (r.fileProblems.length > 0) return "Nothing was imported: the file has a problem that stops it.";
  const parts = [`${plural(r.created, "new visit", "new visits")}`, `${r.updated} updated`, `${r.unchanged} unchanged`];
  const head = `Imported: ${parts.join(", ")}.`;
  return r.rejected.length === 0 ? head : `${head} ${plural(r.rejected.length, "row was", "rows were")} not imported.`;
}

export function mountImport(host, { api, timeZone = () => null, onImported = null }) {
  host.replaceChildren();
  host.classList.add("imp");

  const open = node("button", "btn btn--quiet btn--sm", "Import schedule…");
  open.type = "button";
  const input = node("input", "vh");
  input.type = "file";
  input.accept = ".csv,text/csv";
  input.setAttribute("aria-label", "Choose a schedule export (CSV)");
  const panel = node("div", "imp__p");
  panel.hidden = true;
  panel.setAttribute("aria-live", "polite");
  host.append(open, input, panel);

  let csv = null;
  let fileName = "";
  let mapping = {};
  let busy = false;

  open.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    fileName = file.name;
    mapping = {};
    if (file.size > MAX_FILE_BYTES) {
      csv = null;
      show([node("p", "imp__n is-critical",
        `${fileName} is ${Math.round(file.size / 1000)} KB — larger than one import reads. Export a shorter date range (a month at a time).`)], true);
      return;
    }
    csv = await file.text();
    await preview();
  });

  function show(children, closable = true) {
    panel.hidden = false;
    panel.replaceChildren(...children);
    if (closable) {
      const close = node("button", "btn btn--quiet btn--sm imp__close", "Close");
      close.type = "button";
      close.addEventListener("click", () => { panel.hidden = true; panel.replaceChildren(); csv = null; });
      panel.append(close);
    }
  }

  const failure = (err) =>
    err.status === 403 ? `Not imported. ${err.message}`
      : err.status === 413 ? "This file is too large for one import. Export a shorter date range."
        : `Could not read the file: ${err.message}`;

  async function preview() {
    if (!csv) return;
    show([node("p", "imp__n", `Reading ${fileName}…`)], false);
    let p;
    try {
      p = await api("POST", "/api/v1/appointments/import/preview", { csv, mapping });
    } catch (err) {
      show([node("p", "imp__n is-critical", failure(err))]);
      return;
    }
    drawPreview(p);
  }

  function drawPreview(p) {
    const parts = [node("h3", "imp__t", `Import ${fileName}`)];
    const tz = timeZone();
    if (tz) parts.push(node("p", "imp__n", `Dates and times are read as the practice's local time (${tz}).`));

    if (p.fileProblems.length > 0) {
      const ul = node("ul", "imp__probs");
      for (const f of p.fileProblems) ul.append(node("li", "is-critical", f));
      parts.push(ul);
    }

    /* The mapping: every field, the column it is read from, and a way to change it. */
    const map = node("div", "imp__map");
    map.append(node("div", "imp__mh", "Which column is which"));
    for (const f of p.fields) {
      const row = node("label", "imp__mr");
      row.append(node("span", "imp__ml", f.label + (f.required ? " (required)" : "")));
      const sel = node("select", "imp__ms");
      const none = node("option", "", "— not used —");
      none.value = "";
      sel.append(none);
      for (const h of p.headers) {
        const o = node("option", "", h);
        o.value = h;
        sel.append(o);
      }
      sel.value = p.mapping[f.key] ?? "";
      sel.addEventListener("change", () => { mapping = { ...p.mapping, [f.key]: sel.value || null }; preview(); });
      row.append(sel);
      map.append(row);
    }
    parts.push(map);

    parts.push(node("p", "imp__sum", importSummary(p)));
    if (p.problems.length > 0) {
      const ol = node("ol", "imp__probs");
      for (const x of p.problems) {
        const li = node("li", "");
        li.append(node("span", "imp__line", `Line ${x.line}`), node("span", "", x.problem));
        ol.append(li);
      }
      if (p.problemCount > p.problems.length) ol.append(node("li", "imp__more", `and ${p.problemCount - p.problems.length} more`));
      parts.push(ol);
    }
    if (p.sample.length > 0) {
      const ol = node("ol", "imp__sample");
      ol.setAttribute("aria-label", "The first appointments as they will be imported");
      for (const s of p.sample) {
        const li = node("li", "");
        li.append(
          node("span", "imp__when", `${dayLabel(s.day)} · ${clockTime(s.scheduledFor, tz ?? "UTC")}`),
          node("span", "imp__who", maskName(s.patientName)),
          node("span", "imp__st", s.status[0].toUpperCase() + s.status.slice(1).replace("-", " ")),
          node("span", "imp__amt", s.productionCents === null ? "—" : usd(s.productionCents))
        );
        ol.append(li);
      }
      parts.push(ol);
    }

    const go = node("button", "btn btn--primary btn--sm", busy ? "Importing…" : `Import ${plural(p.ready, "appointment", "appointments")}`);
    go.type = "button";
    go.disabled = busy || p.fileProblems.length > 0 || p.ready === 0;
    go.addEventListener("click", () => runImport());
    parts.push(go);
    show(parts);
  }

  async function runImport() {
    if (busy || !csv) return;
    busy = true;
    show([node("p", "imp__n", `Importing ${fileName}…`)], false);
    let r;
    try {
      r = await api("POST", "/api/v1/appointments/import", { csv, mapping });
    } catch (err) {
      busy = false;
      show([node("p", "imp__n is-critical", failure(err))]);
      return;
    }
    busy = false;
    csv = null;
    const parts = [node("h3", "imp__t", `Imported ${fileName}`), node("p", "imp__sum", importResultSummary(r))];
    const problems = [...r.fileProblems.map((f) => ({ line: null, reason: f })), ...r.rejected];
    if (problems.length > 0) {
      const ol = node("ol", "imp__probs");
      for (const x of problems.slice(0, 200)) {
        const li = node("li", "");
        li.append(node("span", "imp__line", x.line ? `Line ${x.line}` : "File"), node("span", "", x.reason));
        ol.append(li);
      }
      parts.push(ol);
    }
    show(parts);
    if (onImported) await onImported();
  }

  return { destroy() { host.replaceChildren(); } };
}
