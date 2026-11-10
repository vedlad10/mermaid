/**
 * The evidence table — the surface every drill-down lands on.
 *
 * ── VIRTUALISED, AND WHY THAT IS NOT PREMATURE ───────────────────────────────────────────────────
 * Staging holds thirteen payment advices, so windowing is invisible today. It is built anyway
 * because the specification's number is 100k rows at 60fps and because the alternative — pagination
 * — is forbidden for a good reason: a practice manager selecting claims to appeal needs the
 * aggregate dollars of their selection, and a selection that cannot span pages is not a selection
 * of the population, it is a selection of a page.
 *
 * The window renders only the rows in view plus an overscan, and holds the scroll height with two
 * spacer elements whose heights are assigned through the CSSOM. That is the same CSP-driven
 * technique the charts use: markup carries no `style=` attribute, because the policy would drop it.
 *
 * ── THE SELECTION AGGREGATE IS THE POINT ─────────────────────────────────────────────────────────
 * "A user selecting 14 claims must instantly see the dollars at stake." The floating bar is not
 * chrome; it is the reason multi-select exists in a money product.
 */

const px = (n) => `${Math.max(0, Math.round(n))}px`;

/**
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {object[]} opts.columns  [{key, label, type, get, sort, width, className}]
 * @param {(row:object)=>string} opts.rowKey
 * @param {(row:object)=>string|null} opts.rail   semantic state for the 2px leading rail
 * @param {(row:object)=>number} opts.amount      what a selection sums
 * @param {(row:object)=>void} opts.onOpen        drill
 * @param {(row:object)=>HTMLElement|null} opts.expand
 */
export function createTable(host, opts) {
  const {
    columns,
    rowKey = (r) => r.id,
    rail = () => null,
    amount = null,
    onOpen = null,
    expand = null,
    rowHeight = 36,
    formatAmount = (c) => String(c),
    empty = "No records.",
  } = opts;

  let rows = [];
  let sorts = [];               // [{key, dir}] — multi-sort via shift-click
  let selected = new Set();
  let expandedKey = null;
  let scrollTop = 0;

  host.classList.add("tbl");
  host.innerHTML = "";

  const head = document.createElement("div");
  head.className = "tbl__head";
  head.setAttribute("role", "row");

  const scroller = document.createElement("div");
  scroller.className = "tbl__scroll";
  scroller.setAttribute("role", "rowgroup");
  scroller.tabIndex = 0;

  const padTop = document.createElement("div");
  const body = document.createElement("div");
  body.className = "tbl__body";
  const padBottom = document.createElement("div");
  scroller.append(padTop, body, padBottom);

  const emptyMsg = document.createElement("p");
  emptyMsg.className = "tbl__empty";

  const bar = document.createElement("div");
  bar.className = "tbl__bar";

  const foot = document.createElement("div");
  foot.className = "tbl__foot";

  host.append(head, scroller, emptyMsg, foot, bar);

  /**
   * ── THE GRID IS DERIVED FROM THE COLUMNS, NOT WRITTEN IN THE STYLESHEET ────────────────────────
   * The track list used to be a constant in `styles.css`, sized for the six columns the first screen
   * happened to have. Any table with a different column count then rendered misaligned against its
   * own header — silently, because CSS grid simply repeats or drops tracks rather than complaining.
   * On an evidence table in a money product, a value under the wrong heading is a wrong answer.
   *
   * So each column declares its own track, by type: an `entity` gets the flexible remainder, a
   * measured quantity gets a fixed width wide enough for its digits, and anything else gets a
   * modest fixed track. A column may override with an explicit `width`.
   *
   * Assigned through the CSSOM rather than as a `style=` attribute, because `style-src 'self'` drops
   * the attribute form — the same constraint that shapes the charts.
   */
  const TRACKS = {
    entity: "minmax(0, 2fr)",
    currency: "116px",
    count: "72px",
    date: "92px",
    /* Wide enough for a status written as a short phrase rather than a single word — "Could not be
       checked" clipped to "Could not be chec…" at 116px, which reads as a different outcome. */
    status: "140px",
    mono: "132px",
    text: "minmax(0, 1fr)",
  };
  function applyGrid() {
    const tracks = columns.map((c) => c.width ?? TRACKS[c.type] ?? TRACKS.text).join(" ");
    const template = `var(--rail-w) ${tracks}`;
    head.style.gridTemplateColumns = template;
    /* Rows are created per render, so the template is held here and read by `drawRows`. */
    rowTemplate = template;
    reserveScrollbarGutter();
  }
  let rowTemplate = "";

  /**
   * Reserve the scrollbar's width on the header, so its tracks resolve to the same widths the rows'
   * do.
   *
   * ── WHY THE HEADER DRIFTS WITHOUT THIS ─────────────────────────────────────────────────────────
   * The rows live inside `.tbl__scroll`, which overflows; the header is its sibling and does not.
   * Once there are enough rows to scroll, the scroller loses its scrollbar's width from the space
   * its grid has to divide, while the header keeps it — so every flexible track in the header comes
   * out wider than the same track in the rows, and each label slides right of its own column. It
   * only appears once a table is long enough to scroll, which is exactly when a table is being read
   * carefully.
   *
   * Measured rather than assumed: scrollbar width is 0 on overlay-scrollbar platforms and varies
   * elsewhere, so a hardcoded 15px would introduce the misalignment it was meant to remove.
   */
  function reserveScrollbarGutter() {
    const gutter = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
    head.style.paddingRight = gutter ? `${gutter}px` : "";
  }

  /* ── Header ───────────────────────────────────────────────────────────────────────────────── */
  function drawHead() {
    head.replaceChildren();
    applyGrid();
    /*
     * A spacer for the status-rail track.
     *
     * Every ROW opens with a rail element, and the header did not — so the header's cells occupied
     * tracks 1..n of an n+1 track grid and each label sat one column to the LEFT of the data it
     * named. With six narrow columns that read as slightly-off padding; with eight it collides the
     * labels into each other. On an evidence table in a money product, a figure under the wrong
     * heading is a wrong answer, so this is a correctness fix and not an alignment nicety.
     */
    const railSpacer = document.createElement("span");
    railSpacer.className = "tbl__rail";
    railSpacer.setAttribute("aria-hidden", "true");
    head.append(railSpacer);
    for (const c of columns) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = `tbl__h tbl__c--${c.type ?? "text"}${c.className ? " " + c.className : ""}`;
      cell.dataset.key = c.key;
      const active = sorts.findIndex((s) => s.key === c.key);
      cell.textContent = c.label;
      if (c.sort !== false) {
        cell.classList.add("is-sortable");
        if (active >= 0) {
          cell.classList.add("is-sorted");
          const caret = document.createElement("span");
          caret.className = "tbl__caret";
          caret.textContent = sorts[active].dir === "asc" ? "▲" : "▼";
          cell.append(caret);
          if (sorts.length > 1) {
            const ord = document.createElement("span");
            ord.className = "tbl__ord";
            ord.textContent = String(active + 1);
            cell.append(ord);
          }
        }
        cell.addEventListener("click", (ev) => {
          const i = sorts.findIndex((s) => s.key === c.key);
          const next = i >= 0 && sorts[i].dir === "asc" ? "desc" : "asc";
          if (ev.shiftKey) {
            sorts = i >= 0 ? sorts.map((s, k) => (k === i ? { ...s, dir: next } : s)) : [...sorts, { key: c.key, dir: next }];
          } else {
            sorts = [{ key: c.key, dir: next }];
          }
          apply();
        });
      } else {
        cell.disabled = true;
      }
      head.append(cell);
    }
  }

  /**
   * ── §9: WHICH FOUR COLUMNS SURVIVE ON A PHONE ──────────────────────────────────────────────────
   * "Tables become record-lists: each item shows entity, one figure, one state, one timestamp."
   *
   * The four are INFERRED from the column types rather than configured per screen, and the choices
   * are the ones a person scanning a phone actually needs:
   *
   *   entity  the FIRST entity column — who or what this row is about
   *   figure  the LAST currency column — every one of these tables puts its most consequential
   *           money last, because that is the order the desktop row reads in
   *   state   the first status column
   *   stamp   the first date column
   *
   * Inference rather than configuration because eight screens would otherwise each declare it, and
   * the one that forgot would silently get the old two-column squeeze. A screen that disagrees can
   * still override with an explicit `card` on the column.
   */
  const CARD_ROLE = (() => {
    const roles = new Map();
    const claimed = new Set();
    /* An explicit declaration always wins. */
    for (const c of columns) {
      if (c.card && !claimed.has(c.card)) { roles.set(c.key, c.card); claimed.add(c.card); }
    }
    const takeFirst = (role, type) => {
      if (claimed.has(role)) return;
      const c = columns.find((x) => x.type === type && !roles.has(x.key));
      if (c) { roles.set(c.key, role); claimed.add(role); }
    };
    const takeLast = (role, type) => {
      if (claimed.has(role)) return;
      const c = [...columns].reverse().find((x) => x.type === type && !roles.has(x.key));
      if (c) { roles.set(c.key, role); claimed.add(role); }
    };
    takeFirst("entity", "entity");
    takeLast("figure", "currency");
    takeFirst("state", "status");
    takeFirst("stamp", "date");
    /* A table with no entity column still needs a name on the row; fall back to its first column. */
    if (!claimed.has("entity") && columns[0] && !roles.has(columns[0].key)) roles.set(columns[0].key, "entity");
    return roles;
  })();

  /* ── Sorting ──────────────────────────────────────────────────────────────────────────────── */
  function sorted(list) {
    if (sorts.length === 0) return list;
    const byKey = new Map(columns.map((c) => [c.key, c]));
    return [...list].sort((a, b) => {
      for (const s of sorts) {
        const c = byKey.get(s.key);
        if (!c) continue;
        const va = c.value ? c.value(a) : c.get(a);
        const vb = c.value ? c.value(b) : c.get(b);
        let d = 0;
        if (typeof va === "number" && typeof vb === "number") d = va - vb;
        else d = String(va ?? "").localeCompare(String(vb ?? ""), undefined, { numeric: true });
        if (d !== 0) return s.dir === "asc" ? d : -d;
      }
      return 0;
    });
  }

  /* ── The window ───────────────────────────────────────────────────────────────────────────── */

  /**
   * At phone width the table becomes a record-list (§9) and a row is two lines tall, not
   * `rowHeight`. Virtualising against the wrong height would leave the spacers wrong and most of
   * the list unrendered — so below the breakpoint the window is the whole list.
   *
   * That is safe for the reason virtualisation was built for the opposite case: a phone showing a
   * hundred-thousand-row table is not a scenario, because §9 says the three tasks mobile must do
   * fully are approving flagged actions, checking today's unverified appointments, and looking up
   * one patient's balance. None of them is "scroll the whole ledger".
   */
  const isRecordList = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 767px)").matches
      : false;

  function visibleRange() {
    if (isRecordList()) return { first: 0, last: rows.length };
    const h = scroller.clientHeight || 400;
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 6);
    const count = Math.ceil(h / rowHeight) + 12;
    return { first, last: Math.min(rows.length, first + count) };
  }

  function drawBody() {
    const { first, last } = visibleRange();
    padTop.style.height = px(first * rowHeight);
    padBottom.style.height = px(Math.max(0, (rows.length - last) * rowHeight));
    body.replaceChildren();

    for (let i = first; i < last; i++) {
      const r = rows[i];
      const key = rowKey(r);
      const row = document.createElement("div");
      row.className = "tbl__row";
      /* Same track list as the header, so a cell can never drift out from under its own label. */
      row.style.gridTemplateColumns = rowTemplate;
      row.setAttribute("role", "row");
      row.tabIndex = -1;
      row.dataset.key = key;
      if (selected.has(key)) row.classList.add("is-selected");

      const state = rail(r);
      const railEl = document.createElement("span");
      railEl.className = "tbl__rail" + (state ? ` is-${state}` : "");
      row.append(railEl);

      for (const c of columns) {
        const cell = document.createElement("span");
        cell.className = `tbl__c tbl__c--${c.type ?? "text"}${c.className ? " " + c.className : ""}`;
        /*
         * The four roles a phone shows (§9). Stamped on the cell so the stylesheet can build the
         * record-list at narrow widths without JavaScript measuring anything — no resize listener,
         * no re-render, and the desktop table is untouched because nothing reads these above 767px.
         */
        const role = CARD_ROLE.get(c.key);
        if (role) cell.dataset.card = role;
        const v = c.get(r);
        if (v === null || v === undefined || v === "") {
          cell.textContent = "—";
          cell.classList.add("is-blank");
        } else if (v instanceof Node) {
          cell.append(v);
        } else {
          cell.textContent = String(v);
        }
        row.append(cell);
      }

      row.addEventListener("click", (ev) => {
        if (ev.target.closest(".tbl__check")) return;
        if (expand && ev.altKey) { toggleExpand(key); return; }
        if (onOpen) onOpen(r);
      });
      row.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); onOpen && onOpen(r); }
        if (ev.key === " ") { ev.preventDefault(); toggleSelect(key); }
      });

      body.append(row);

      if (expandedKey === key && expand) {
        const panel = expand(r);
        if (panel) {
          const wrap = document.createElement("div");
          wrap.className = "tbl__expand";
          wrap.append(panel);
          body.append(wrap);
        }
      }
    }
  }

  function toggleExpand(key) {
    expandedKey = expandedKey === key ? null : key;
    drawBody();
  }

  function toggleSelect(key) {
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    drawBody();
    drawBar();
  }

  /* ── Selection bar: count AND dollars, always ─────────────────────────────────────────────── */
  function drawBar() {
    bar.replaceChildren();
    if (selected.size === 0) { bar.classList.remove("is-on"); return; }
    bar.classList.add("is-on");
    const chosen = rows.filter((r) => selected.has(rowKey(r)));
    const n = document.createElement("span");
    n.className = "tbl__bar-n";
    n.textContent = `${chosen.length} selected`;
    bar.append(n);
    if (amount) {
      const sum = chosen.reduce((t, r) => t + Number(amount(r) || 0), 0);
      const s = document.createElement("span");
      s.className = "tbl__bar-sum";
      s.textContent = formatAmount(sum);
      bar.append(s);
    }
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "tbl__bar-clear";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => { selected.clear(); drawBody(); drawBar(); });
    bar.append(clear);
  }

  function drawFoot() {
    foot.replaceChildren();
    const n = document.createElement("span");
    n.textContent = `${rows.length.toLocaleString("en-US")} ${rows.length === 1 ? "record" : "records"}`;
    foot.append(n);
    if (amount) {
      const div = document.createElement("span");
      div.className = "tbl__foot-div";
      const sum = document.createElement("span");
      sum.textContent = formatAmount(rows.reduce((t, r) => t + Number(amount(r) || 0), 0));
      foot.append(div, sum);
    }
  }

  scroller.addEventListener("scroll", () => {
    scrollTop = scroller.scrollTop;
    drawBody();
  }, { passive: true });

  function apply() {
    rows = sorted(rows);
    drawHead();
    drawBody();
    drawFoot();
    drawBar();
    const none = rows.length === 0;
    emptyMsg.classList.toggle("is-on", none);
    scroller.classList.toggle("is-hidden", none);
    /*
     * Re-measured AFTER the body exists. `drawHead` runs before any row is laid out, when the
     * scroller has nothing to overflow and reports a gutter of zero — so measuring only there would
     * reserve nothing on precisely the tables that need it.
     */
    reserveScrollbarGutter();
  }

  drawHead();

  /*
   * Crossing the phone breakpoint changes what a row IS — a grid line becomes a two-line record —
   * so the body is redrawn rather than left in whichever shape it was first built in. Registered
   * once and removed on destroy, because a screen is mounted and unmounted on every tab switch.
   */
  const phone = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(max-width: 767px)")
    : null;
  const onBreakpoint = () => apply();
  phone?.addEventListener?.("change", onBreakpoint);

  return {
    /** Replace the population. Selection is kept only for rows that survive the new filter. */
    update(next, { emptyMessage = null } = {}) {
      rows = sorted(next ?? []);
      const alive = new Set(rows.map(rowKey));
      for (const k of [...selected]) if (!alive.has(k)) selected.delete(k);
      if (expandedKey && !alive.has(expandedKey)) expandedKey = null;
      emptyMsg.textContent = emptyMessage ?? empty;
      scroller.scrollTop = 0;
      scrollTop = 0;
      apply();
    },
    selectedRows: () => rows.filter((r) => selected.has(rowKey(r))),
    destroy() { phone?.removeEventListener?.("change", onBreakpoint); host.replaceChildren(); },
  };
}
