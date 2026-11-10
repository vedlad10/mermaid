/**
 * The states every screen owes its user (spec §7).
 *
 * ── THE TWO DEFECTS THIS EXISTS TO FIX ───────────────────────────────────────────────────────────
 * Every rebuilt screen loaded like this:
 *
 *     try { ...fetch... } finally { loading = false }
 *     drawAll();
 *
 * There is no `catch`. When a request failed the exception escaped `load()` as an unhandled
 * rejection, `drawAll()` never ran, and the screen stayed blank — permanently, with no message and
 * no way to retry short of switching tabs. §7.3 is explicit that an error must state what failed and
 * what it means for the user's money; a blank page states nothing at all.
 *
 * The second is quieter and constant: between the click and the data there was nothing on the
 * screen. On a slow connection that is several seconds of blank page per navigation, and §7.1 asks
 * for a skeleton at the FINAL geometry so nothing jumps when the data arrives.
 *
 * ── WHY THIS IS A MODULE AND NOT EIGHT COPIES ────────────────────────────────────────────────────
 * Eight screens, each needing loading, error and retry, is eight chances to write the version that
 * apologises, or the one that takes over the whole screen when half of it still holds valid data
 * (§7.3 forbids both). Written once, the wording and the rules are decided once.
 */

const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * A skeleton for the metric spine.
 *
 * §7.1: the LABELS appear immediately, because they are known before the data is — only the figure
 * and the sparkline are skeleton. A spine that greyed out its own labels would be hiding something
 * it already had, and would leave the reader with no idea what is about to appear.
 */
export function spineSkeleton(host, labels) {
  host.replaceChildren();
  host.classList.add("sp");
  for (const label of labels) {
    const b = node("div", "sp__m is-skeleton");
    b.append(node("span", "sp__label", label));
    b.append(node("span", "sk sk--fig"));
    b.append(node("span", "sk sk--delta"));
    host.append(b);
  }
}

/**
 * A block of skeleton at a fixed height.
 *
 * The height is required and is the caller's real geometry, because the whole value of a skeleton is
 * that the layout does not move when it is replaced. One that guessed its own height would produce
 * exactly the jump it exists to prevent.
 */
export function blockSkeleton(host, height, lines = 0) {
  host.replaceChildren();
  const wrap = node("div", "sk-block");
  wrap.style.minHeight = `${height}px`;
  for (let i = 0; i < lines; i++) {
    const line = node("span", "sk sk--line");
    /* Varying widths so a stack of rows reads as content rather than as a striped pattern. */
    line.style.width = `${[92, 76, 84, 64, 88][i % 5]}%`;
    wrap.append(line);
  }
  host.append(wrap);
}

/** Skeleton rows at the evidence table's own row height, so the table does not resize under them. */
export function tableSkeleton(host, rows = 6, rowHeight = 36) {
  host.replaceChildren();
  const wrap = node("div", "sk-block sk-block--rows");
  for (let i = 0; i < rows; i++) {
    const r = node("span", "sk sk--row");
    r.style.height = `${rowHeight - 8}px`;
    wrap.append(r);
  }
  host.append(wrap);
}

/**
 * The §7.3 error treatment.
 *
 * Three sentences, in this order and for this reason: what failed, what it means for the money, and
 * the way out. It does not apologise — an apology is a sentence that occupies the place where the
 * recovery action should be — and it does not take over a screen that still holds valid data, which
 * is why this returns a node for one region rather than replacing a stage.
 *
 * @param {object} opts
 * @param {string} opts.what     what could not be loaded, in the user's terms
 * @param {string} opts.stakes   what the reader cannot currently see or do because of it
 * @param {string} opts.shows    what this screen displays, for the §7.6 restricted treatment
 * @param {Error}  opts.error    the underlying failure, shown as detail rather than as the headline
 * @param {() => void} [opts.retry]
 */
/**
 * The strings a browser hands you when the request never reached a server.
 *
 * Chrome says "Failed to fetch", Safari "Load failed", Firefox "NetworkError when attempting to
 * fetch resource." — three different sentences for one condition, and not one of them says what
 * happened. Photographing the error state with the API blocked put "Failed to fetch" on screen as
 * the sole explanation of why a practice could not see its coverage checks.
 */
const NETWORK_FAILURE =
  /^(failed to fetch|load failed|networkerror|network request failed|the internet connection appears to be offline)/i;

/**
 * Fill the "why" slot with something a person can act on.
 *
 * §7's error block is what failed, why, and the way back. The middle slot was carrying the fetch
 * API's own words, which name a JavaScript condition rather than a situation — and the situation
 * here is worth knowing, because "the request never left" means the practice's data is fine and
 * pressing the button again is genuinely worth doing.
 *
 * The raw string is kept beside the sentence rather than replaced. It is what somebody on the phone
 * to support gets asked to read out, and it is the only part of this block that distinguishes one
 * transport failure from another.
 */
export function explainNetwork(message) {
  return NETWORK_FAILURE.test(message.trim())
    ? `Mermaid could not reach the server, so nothing was loaded. (${message})`
    : message;
}

export function errorBlock({ what, stakes, shows, error, retry }) {
  const wrap = node("div", "errb");
  wrap.setAttribute("role", "status");

  /*
   * ── §7.6: A PERMISSION BOUNDARY IS NOT A FAILURE ───────────────────────────────────────────────
   * "Restricted content shows the shape of what exists and why it's restricted, not a blank space."
   *
   * A 403 rendered with the failure copy — "could not be loaded", "try again" — describes an outage
   * that is not happening, and sends someone looking for a bug in a system that is working exactly
   * as configured. So it gets its own treatment: what the screen WOULD have shown, and the server's
   * own sentence about why it did not, which already names the role held, the permission missing,
   * and who can grant it.
   *
   * There is no Try again, deliberately. Nothing about pressing it would change the answer.
   */
  if (error && error.status === 403) {
    wrap.classList.add("errb--restricted");
    wrap.append(node("p", "errb__t", "Not visible to your role."));
    /*
     * The server's own sentence, unedited. The guard already names the role the caller holds, the
     * permission they lack and who can grant it — better than anything the client could
     * reconstruct, and it stays correct when the permission model changes.
     */
    wrap.append(node("p", "errb__s", error.message));
    /* The SHAPE of what exists, which is the half §7.6 insists on and a blank space cannot give. */
    if (shows) wrap.append(node("p", "errb__d", `This screen shows ${shows}.`));
    return wrap;
  }

  wrap.append(node("p", "errb__t", what));
  if (stakes) wrap.append(node("p", "errb__s", stakes));
  /*
   * The technical reason is kept, and kept SECONDARY. A person on the phone to support needs it;
   * a person trying to work needs the two sentences above it more.
   */
  const detail = error && error.message ? explainNetwork(String(error.message)) : null;
  if (detail) wrap.append(node("p", "errb__d", detail));
  if (retry) {
    const b = node("button", "errb__b", "Try again");
    b.type = "button";
    b.addEventListener("click", retry);
    wrap.append(b);
  }
  return wrap;
}

/**
 * A whole-screen skeleton at the standard shell's geometry (§7.1).
 *
 * The header is kept — it is already known, and blanking a question the screen can answer while it
 * loads the answer is the jump this exists to prevent. Below it: the spine strip, a block the
 * primary visual's height, and rows at the table's row height. Nothing here guesses: the caller
 * passes the geometry it is about to use.
 *
 * @param {HTMLElement} stage
 * @param {HTMLElement} header  kept as-is, because its content does not depend on the fetch
 * @param {object} [geo]
 * @param {string[]} [geo.metrics] the spine's labels, which are known before its figures are
 * @param {number} [geo.chartHeight]
 * @param {number} [geo.rows]
 */
export function stageSkeleton(stage, header, { metrics = [], chartHeight = 190, rows = 6 } = {}) {
  const frag = [];
  if (header) frag.push(header);

  if (metrics.length) {
    const spine = node("div", "");
    spineSkeleton(spine, metrics);
    frag.push(spine);
  }
  const viz = node("section", "viz2");
  viz.append(node("div", "sk sk--title"));
  const chart = node("div", "");
  blockSkeleton(chart, chartHeight);
  viz.append(chart);
  frag.push(viz);

  const table = node("div", "");
  tableSkeleton(table, rows);
  frag.push(node("div", "scr__rule"), table);

  stage.replaceChildren(...frag);
}

/**
 * Put a screen's real layout back after an error state replaced it.
 *
 * The error path calls `stage.replaceChildren(header, errorBlock)`, which detaches every host the
 * screen holds a reference to. Without this, a successful retry would draw into elements that are
 * no longer in the document — the fetch would work, the render would run, and the screen would stay
 * showing the error. Cheap to call every render, and it does nothing when the layout is already in
 * place.
 */
export function restoreLayout(stage, layout) {
  if (stage.firstChild === layout[0] && stage.childElementCount === layout.length) return;
  stage.replaceChildren(...layout);
}

/**
 * Re-read a live screen on an interval, and only while anyone could be looking at it.
 *
 * ── WHY POLLING AT ALL ───────────────────────────────────────────────────────────────────────────
 * §8.1's activity stream and §8.8's queue board are described as live, and §6 reserves the
 * product's one authored moment for a figure that changed on its own. None of that means anything
 * in a screen that only ever reloads when someone clicks a tab: the animation would be built for an
 * event that cannot occur.
 *
 * ── THE THREE RESTRAINTS, EACH FOR A REASON ──────────────────────────────────────────────────────
 * Nothing polls while the tab is hidden. A practice leaves this open all day beside a
 * practice-management system; a background tab quietly re-querying a database every minute for
 * eight hours is a cost the practice pays for nothing.
 *
 * Nothing polls while a drill panel is open. The reader is looking at one record; refreshing the
 * screen behind it can only move things they are not looking at, and risks moving the row they came
 * from.
 *
 * A poll that fails is silent. This is a background refresh of a screen that already has data —
 * §7.3's error treatment is for a screen with nothing to show, and turning a transient blip into a
 * full error state would erase good data to report a problem that has already passed.
 */
export function poll(intervalMs, shouldRun, run) {
  let timer = null;
  const tick = async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (!shouldRun()) return;
    try { await run(); } catch { /* see above: a background refresh never becomes an error state */ }
  };
  timer = setInterval(tick, intervalMs);
  /* Coming back to a tab is exactly when the data is most likely to be stale. */
  const onVisible = () => { if (document.visibilityState === "visible") tick(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/**
 * §7.5 freshness, as a dot and a sentence.
 *
 * Three states and no fourth: live, synced-a-while-ago, and stale. The threshold between the last
 * two is what makes it worth having — data quietly shown as current when it is three hours old is
 * the failure this indicator exists to prevent, and a component that only ever says "synced" is
 * that failure with a dot next to it.
 */
export function freshness(atIso, nowMs = Date.now()) {
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) return { state: "unknown", label: "never synced" };
  const ms = Math.max(0, nowMs - t);
  if (ms < 60_000) return { state: "live", label: "live" };
  if (ms < 60 * 60_000) return { state: "synced", label: `synced ${Math.round(ms / 60_000)}m ago` };
  if (ms < 3 * 60 * 60_000) return { state: "synced", label: `synced ${Math.round(ms / 3_600_000)}h ago` };
  return { state: "stale", label: `stale — ${Math.round(ms / 3_600_000)}h old` };
}

/** The freshness indicator as an element, for a screen header. */
export function freshnessTag(atIso, nowMs = Date.now()) {
  const f = freshness(atIso, nowMs);
  const el = node("span", `frsh is-${f.state}`);
  el.append(node("span", "frsh__dot"));
  el.append(node("span", "frsh__t", f.label));
  return el;
}

/**
 * Wrap a screen's data load so a failure becomes a state rather than an unhandled rejection.
 *
 * The contract is deliberately narrow: it calls `render` three times — once when the load starts, so
 * a skeleton can be drawn; once if it fails; once when it finishes — and never decides what any of
 * those look like. Screens differ too much for a shared renderer, and they do not differ at all in
 * needing all three to happen.
 *
 * @param {object} handle  a mutable object the screen also reads: {loading, failed, loaded}
 * @param {() => Promise<void>} fetchAll
 * @param {() => void} render
 */
/**
 * Mark a screen's handle dead, so a load still in flight cannot paint over its successor.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * `load` renders in a `finally`, and nothing checked whether the screen that asked for it still
 * existed. Switch tabs while the first fetch is in the air and the sequence is:
 *
 *   Today.load() starts → user clicks Claims → Today.destroy() clears the stage → Claims renders
 *   → Today's fetch resolves → Today's render() paints Today into the stage Claims now owns.
 *
 * The result is a screen showing one thing while the rail, the title and `data-stage-titled` all
 * say another. It was reproduced at 375px on a slow machine, where Today's first fetch had not
 * landed before the click; on a fast connection the window is small enough to look like it never
 * happens, which is exactly why it survived — a practice on bad surgery wifi lives inside that
 * window all day.
 *
 * A generation counter would also work. A flag is enough because a handle belongs to exactly one
 * mount and is never revived: `mountX` makes a new one every time.
 */
export function retire(handle) {
  handle.destroyed = true;
}

export async function load(handle, fetchAll, render) {
  if (handle.loading || handle.destroyed) return;
  handle.loading = true;
  handle.failed = null;
  render();
  try {
    await fetchAll();
    handle.loaded = true;
  } catch (err) {
    /*
     * Caught, recorded, and NOT rethrown. Rethrowing here would restore exactly the unhandled
     * rejection this exists to remove — the screen would have its error state and the console would
     * still have a crash, and the next person would fix the wrong one.
     */
    handle.failed = err instanceof Error ? err : new Error(String(err));
  } finally {
    handle.loading = false;
    /* The screen may have been unmounted while the fetch was in the air; painting now would put it
       back on top of whatever replaced it. */
    if (!handle.destroyed) render();
  }
}
