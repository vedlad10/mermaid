/**
 * The selection/filter store — one store, and selection IS filter.
 *
 * ── WHY THIS EXISTS BEFORE ANY SCREEN ────────────────────────────────────────────────────────────
 * The specification is emphatic that this must exist first, and the reason is concrete: if each
 * screen owns its own idea of "what is selected", drill-downs get re-implemented eight inconsistent
 * ways and the chart's highlighted point drifts out of agreement with the table's filter. The bug
 * that produces is the worst kind in a money product — two elements on one screen describing
 * different populations while looking like they describe the same one.
 *
 * So there is exactly one state object. A click on a chart point and a chip chosen from a filter
 * menu produce the SAME state; the chart renders its selection by reading that state back, not by
 * remembering what it drew. They cannot disagree because there is nothing to disagree with.
 *
 * ── WHAT IS AND IS NOT IN HERE ───────────────────────────────────────────────────────────────────
 * In: the timeframe, the active metric, the filter/selection set, the brushed range, and the drill
 * stack. These are the things that decide WHICH RECORDS a screen is about.
 *
 * Out: fetched data, loading flags, anything a component can derive. The store answers "what is the
 * user looking at"; the screen answers "and here is that data". Keeping the fetched payloads out is
 * what lets this file be tested without a DOM or a network.
 */

/** A timeframe the control offers. `days: null` means "everything". */
export const RANGES = [
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
  { key: "12mo", label: "12 months", days: 365 },
];

const clone = (v) => (v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v)));

/**
 * A filter is identified by dimension + value. Two chips for the same dimension are an OR within
 * that dimension and an AND across dimensions, which is what a person means when they click two
 * payers and then one aging bucket.
 */
const sameFilter = (a, b) => a.dim === b.dim && String(a.value) === String(b.value);

export function createStore(initial = {}) {
  /** @type {{timeframe: object, metric: string|null, filters: object[], point: object|null, brush: object|null, drill: object[]}} */
  let state = {
    timeframe: { key: "30d", days: 30, compare: "prior" },
    metric: null,
    filters: [],
    point: null,
    brush: null,
    drill: [],
    ...clone(initial),
  };

  const listeners = new Set();
  let depth = 0;

  const emit = (reason) => {
    /* Re-entrancy guard: a listener that dispatches must not re-notify mid-flight. */
    if (depth > 0) return;
    depth++;
    try {
      for (const fn of [...listeners]) fn(state, reason);
    } finally {
      depth--;
    }
  };

  const set = (next, reason) => {
    state = { ...state, ...next };
    emit(reason);
  };

  const api = {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /* ── Timeframe ─────────────────────────────────────────────────────────────────────────────
     * Changing it clears the point and brush: both are positions inside a range that no longer
     * exists, and carrying them across would filter the new window by a bucket it does not contain.
     */
    setTimeframe(key) {
      const range = RANGES.find((r) => r.key === key);
      if (!range || range.key === state.timeframe.key) return;
      set(
        { timeframe: { ...state.timeframe, key: range.key, days: range.days }, point: null, brush: null },
        "timeframe"
      );
    },
    setCompare(mode) {
      if (state.timeframe.compare === mode) return;
      set({ timeframe: { ...state.timeframe, compare: mode } }, "compare");
    },

    /** The window as ISO instants, which is exactly what the report endpoint takes. */
    window(now = new Date()) {
      const to = new Date(now.getTime());
      const from = new Date(to.getTime() - state.timeframe.days * 86400000);
      return { from: from.toISOString(), to: to.toISOString() };
    },

    /* ── Metric spine ──────────────────────────────────────────────────────────────────────────── */
    setMetric(key) {
      if (state.metric === key) return;
      set({ metric: key }, "metric");
    },

    /* ── Filters, which are also selections ────────────────────────────────────────────────────── */
    toggleFilter(filter) {
      const existing = state.filters.find((f) => sameFilter(f, filter));
      set(
        { filters: existing ? state.filters.filter((f) => !sameFilter(f, filter)) : [...state.filters, filter] },
        "filters"
      );
    },
    removeFilter(filter) {
      if (!state.filters.some((f) => sameFilter(f, filter))) return;
      set({ filters: state.filters.filter((f) => !sameFilter(f, filter)) }, "filters");
    },
    clearFilters() {
      if (state.filters.length === 0 && !state.point && !state.brush) return;
      set({ filters: [], point: null, brush: null }, "filters");
    },
    isFiltered: (dim, value) => state.filters.some((f) => sameFilter(f, { dim, value })),

    /* ── A point on a chart is a filter on a time bucket ────────────────────────────────────────
     * Clicking the same point again clears it, so a chart is a toggle rather than a trap.
     */
    selectPoint(bucket) {
      const same = state.point && state.point.bucket === bucket;
      set({ point: same ? null : { bucket }, brush: null }, "point");
    },
    setBrush(range) {
      set({ brush: range, point: null }, "brush");
    },

    /* ── Drill stack ───────────────────────────────────────────────────────────────────────────
     * A stack, not a route. Going deeper preserves what is behind it, which is the whole point of a
     * panel rather than a page: the context a user drilled FROM stays live and stays visible.
     */
    pushDrill(entry) {
      const top = state.drill[state.drill.length - 1];
      if (top && top.kind === entry.kind && top.id === entry.id) return;
      set({ drill: [...state.drill, entry] }, "drill");
    },
    /** Swap the top of the stack — clicking a sibling row replaces, it does not deepen. */
    replaceDrill(entry) {
      const rest = state.drill.slice(0, Math.max(0, state.drill.length - 1));
      set({ drill: [...rest, entry] }, "drill");
    },
    popDrill(toDepth = null) {
      if (state.drill.length === 0) return;
      set({ drill: toDepth === null ? state.drill.slice(0, -1) : state.drill.slice(0, toDepth) }, "drill");
    },
    closeDrill() {
      if (state.drill.length === 0) return;
      set({ drill: [] }, "drill");
    },

    /* ── The predicate every list obeys ────────────────────────────────────────────────────────
     * One function decides what a filtered view contains, so a table, a chart and a count can never
     * disagree about the population they are describing.
     *
     * `accessors` maps a dimension to how it is read off a record, which is the only thing that
     * differs between screens.
     */
    matches(record, accessors = {}) {
      const byDim = new Map();
      for (const f of state.filters) {
        if (!byDim.has(f.dim)) byDim.set(f.dim, []);
        byDim.get(f.dim).push(String(f.value));
      }
      for (const [dim, values] of byDim) {
        const read = accessors[dim];
        if (!read) continue; /* A dimension this screen does not know about cannot exclude anything. */
        if (!values.includes(String(read(record)))) return false;
      }
      if (state.point && accessors.bucket) {
        if (String(accessors.bucket(record)) !== String(state.point.bucket)) return false;
      }
      if (state.brush && accessors.at) {
        const t = new Date(accessors.at(record)).getTime();
        if (Number.isNaN(t) || t < new Date(state.brush.from).getTime() || t > new Date(state.brush.to).getTime()) {
          return false;
        }
      }
      return true;
    },

    /** Everything narrowing the view right now, as removable chips — including chart selections. */
    chips() {
      const out = state.filters.map((f) => ({ ...f, kind: "filter" }));
      if (state.point) out.push({ kind: "point", dim: "bucket", value: state.point.bucket, label: state.point.bucket });
      if (state.brush) {
        out.push({
          kind: "brush",
          dim: "range",
          value: `${state.brush.from}..${state.brush.to}`,
          label: `${String(state.brush.from).slice(0, 10)} to ${String(state.brush.to).slice(0, 10)}`,
        });
      }
      return out;
    },
    /** True when anything at all is narrowing the view. */
    narrowed: () => state.filters.length > 0 || state.point !== null || state.brush !== null,

    /**
     * Notify every subscriber without changing anything.
     *
     * ── WHY A DELIBERATE NO-OP EMIT IS THE RIGHT MECHANISM ─────────────────────────────────────
     * Some things change how a screen READS without changing which records it is about —
     * presentation mode masking patient names is the case this exists for. Every screen already
     * subscribes here and redraws on any change, so one bump redraws all of them.
     *
     * The alternative was a `redraw()` on each screen's returned handle, wired up one screen at a
     * time in the shell. That is seven places to remember and one place to forget, and the screen
     * that forgot would keep showing names after the manager turned the laptop around.
     */
    bump(reason = "bump") {
      emit(reason);
    },

    /**
     * Return to a clean view, keeping only the timeframe.
     *
     * ── WHY A SCREEN CHANGE HAS TO DO THIS ─────────────────────────────────────────────────────
     * Everything else in here is a position inside ONE screen's picture. A selected point is a day
     * on a chart the next screen does not draw; a `metric` key names a spine entry the next screen
     * does not have, and because the spine only auto-selects when nothing is active, carrying a
     * stale key leaves the new screen with no active metric and therefore no primary visual. A
     * filter on a dimension the next screen cannot read is worse than useless: `matches` correctly
     * ignores an unknown dimension, so the chip would sit in the bar claiming to narrow a view it
     * has no effect on.
     *
     * The timeframe survives deliberately. "The last 90 days" is a question about the practice, not
     * about a screen, and re-choosing it on every tab is the kind of friction that makes people
     * stop moving between screens at all.
     */
    reset() {
      if (state.filters.length === 0 && !state.point && !state.brush && !state.metric && state.drill.length === 0) {
        return;
      }
      set({ filters: [], point: null, brush: null, metric: null, drill: [] }, "reset");
    },
  };

  return api;
}
