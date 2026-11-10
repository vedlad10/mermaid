/**
 * The metric spine, and the drill panel.
 *
 * ── THE SPINE IS THE ANSWER TO THE KPI CARD GRID ─────────────────────────────────────────────────
 * It is deliberately NOT four boxes in a row. It is one continuous strip divided by hairline rules:
 * no card borders, no card backgrounds, no radii, no gaps between boxes. That single structural
 * difference is most of what separates this from the template it is replacing, and it is why the
 * rule is worth stating rather than leaving to taste.
 *
 * Each metric is a control. Selecting one re-points the primary visual below it, which is the
 * mechanism that lets one chart region serve four questions instead of four charts serving one
 * each.
 *
 * On load the active metric is the one that deviates most from its own baseline — the screen opens
 * on the thing that changed, rather than on whatever happened to be first in the array.
 */

const NS = "http://www.w3.org/2000/svg";

/** A sparkline: real readings, no smoothing, no axis, never a value to read off. */
function sparkline(values, { active }) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "sp__spark" + (active ? " is-active" : ""));
  svg.setAttribute("viewBox", "0 0 100 24");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const nums = (values ?? []).filter((v) => Number.isFinite(Number(v))).map(Number);
  /* Two readings do not make a trend; the spine shows nothing rather than a line implying one. */
  if (nums.length < 3) return svg;
  const max = Math.max(...nums), min = Math.min(0, ...nums);
  const y = (v) => (max === min ? 12 : 22 - ((v - min) / (max - min)) * 20);
  const d = nums.map((v, i) => `${i === 0 ? "M" : "L"}${((i / (nums.length - 1)) * 100).toFixed(2)} ${y(v).toFixed(2)}`).join(" ");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("class", "sp__sparkline");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(path);
  return svg;
}

/**
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {object} opts.store
 * @param {object[]} opts.metrics [{key, label, value, format, delta, basis, series, tone}]
 */
/** 320ms, decelerating — §6.1's `--motion-chart`, which is the longest anything here may run. */
const COUNT_MS = 320;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Count a figure from one value to another (§6, "the one authored moment").
 *
 * ── WHY THIS IS NOT A CSS TRANSITION ─────────────────────────────────────────────────────────────
 * The thing changing is TEXT — "$1,669" becoming "$2,468" — and CSS cannot interpolate a formatted
 * number. So each frame re-formats an interpolated value through the metric's own formatter, which
 * also keeps the intermediate frames in the product's money vocabulary rather than showing raw
 * cents for 320ms.
 *
 * `prefers-reduced-motion` skips straight to the final value. §6.2 keeps a single opacity change
 * there so a reader still perceives that something updated, which the caller's redraw provides.
 */
function countTo(el, from, to, format) {
  const fmt = typeof format === "function" ? format : (v) => String(Math.round(v));
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) || !Number.isFinite(to)) {
    el.textContent = fmt(to);
    return;
  }
  /* A figure already counting is replaced, not raced — two loops on one element fight each frame. */
  if (el._countStop) el._countStop();
  let raf = 0;
  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / COUNT_MS);
    el.textContent = fmt(from + (to - from) * easeOut(t));
    if (t < 1) raf = requestAnimationFrame(step);
    else el._countStop = null;
  };
  el._countStop = () => { cancelAnimationFrame(raf); el._countStop = null; };
  raf = requestAnimationFrame(step);
}

export function createSpine(host, { store, metrics = [] }) {
  host.classList.add("sp");
  host.setAttribute("role", "tablist");
  let items = metrics;
  /** What the last set of figures was about; see `update`. */
  let lastBasis = null;

  function draw() {
    host.replaceChildren();
    const active = store.get().metric;
    for (const m of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sp__m" + (m.key === active ? " is-active" : "");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(m.key === active));
      b.dataset.metric = m.key;

      const label = document.createElement("span");
      label.className = "sp__label";
      label.textContent = m.label;

      const fig = document.createElement("span");
      fig.className = "sp__fig" + (m.tone ? ` is-${m.tone}` : "") + (m.zero ? " is-zero" : "");
      fig.textContent = m.display;

      const delta = document.createElement("span");
      delta.className = "sp__delta";
      if (m.delta === null || m.delta === undefined) {
        /* §2.3 — a delta without a stated basis is forbidden, so with no basis there is no delta. */
        delta.textContent = m.basis ?? "";
      } else {
        const arrow = document.createElement("span");
        arrow.className = "sp__arrow " + (m.delta >= 0 ? "is-up" : "is-down");
        arrow.textContent = m.delta >= 0 ? "▲" : "▼";
        const val = document.createElement("span");
        val.textContent = ` ${Math.abs(m.delta).toFixed(1)}% `;
        const basis = document.createElement("span");
        basis.className = "sp__basis";
        basis.textContent = m.basis ?? "";
        delta.append(arrow, val, basis);
      }

      b.append(label, fig, delta, sparkline(m.series, { active: m.key === active }));
      b.addEventListener("click", () => store.setMetric(m.key));
      host.append(b);
    }
  }

  const un = store.subscribe((_s, reason) => { if (reason === "metric") draw(); });
  draw();

  return {
    /**
     * @param {object[]} next
     * @param {object} [opts]
     * @param {string} [opts.basis]
     *   What these figures are ABOUT — the window, the filters, the population. See `countTo` for
     *   why a figure counts when this is unchanged and snaps when it is not.
     */
    update(next, { basis = null } = {}) {
      const previous = new Map(items.map((m) => [m.key, m.value]));
      const sameBasis = basis !== null && basis === lastBasis;
      items = next ?? [];
      lastBasis = basis;

      /* Open on what changed most — measured, not arbitrary. */
      if (!store.get().metric && items.length) {
        const ranked = [...items].sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
        store.setMetric(ranked[0].key);
      }
      draw();

      /*
       * §6.2, and the distinction is the whole rule: "Numbers count only when they changed for a
       * reason the user caused or should notice… A metric changing because the user switched
       * timeframe SNAPS instantly — the old value was about a different thing entirely and counting
       * between them implies a false relationship."
       *
       * So the animation is gated on the BASIS being unchanged. Same question, new answer: count,
       * because the movement is the information. Different question: snap, because there was never
       * a path between those two numbers to trace.
       */
      if (!sameBasis) return;
      for (const m of items) {
        const from = previous.get(m.key);
        if (from === undefined || m.value === undefined || from === m.value) continue;
        const el = host.querySelector(`[data-metric="${m.key}"] .sp__fig`);
        if (el) countTo(el, from, m.value, m.format);
      }
    },
    destroy() { un(); host.replaceChildren(); },
  };
}

/**
 * The drill panel — a drawer beside live context, never a modal that blanks the world.
 *
 * Content behind it stays interactive, and clicking a sibling row swaps the panel's content in
 * place rather than closing and reopening it. That is what makes a drill feel like moving deeper
 * into one thing instead of visiting a series of pages.
 */
export function createDrill(host, { store, render }) {
  host.classList.add("dr");
  host.setAttribute("role", "complementary");
  host.hidden = true;

  function draw() {
    const stack = store.get().drill;
    if (stack.length === 0) {
      host.hidden = true;
      host.replaceChildren();
      document.body.classList.remove("has-drill");
      return;
    }
    document.body.classList.add("has-drill");
    host.hidden = false;
    host.replaceChildren();

    /* Deeper than three, the oldest layers collapse to a spine of tabs rather than stacking off-screen. */
    const crumbs = document.createElement("nav");
    crumbs.className = "dr__crumbs";
    stack.forEach((entry, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dr__crumb" + (i === stack.length - 1 ? " is-current" : "");
      b.textContent = entry.label;
      b.addEventListener("click", () => store.popDrill(i + 1));
      crumbs.append(b);
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "dr__close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", () => store.closeDrill());

    const bodyEl = document.createElement("div");
    bodyEl.className = "dr__body";

    const top = document.createElement("div");
    top.className = "dr__top";
    top.append(crumbs, close);
    host.append(top, bodyEl);

    Promise.resolve(render(stack[stack.length - 1], stack)).then((node) => {
      if (!node) return;
      bodyEl.replaceChildren(node);
    });
  }

  const un = store.subscribe((_s, reason) => { if (reason === "drill") draw(); });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && store.get().drill.length > 0) store.popDrill();
  });

  draw();
  return { destroy() { un(); host.replaceChildren(); } };
}
