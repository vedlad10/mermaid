/**
 * Render the app at exact viewport widths, measure it, and photograph it.
 *
 *   node scripts/shoot.mjs --out .screens
 *   node scripts/shoot.mjs --widths 375,1280 --tabs today,money --out .screens
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 * §12 requires every screen to work at 375, 768, 1280 and 1680, and that requirement went
 * unverified for the whole build because there was no way to get a real narrow viewport. Resizing
 * the desktop browser window reported success and changed nothing — `document.documentElement
 * .clientWidth` stayed at its old value, so every measurement taken through it was of a viewport
 * that was never that wide. Measurements you cannot trust are worse than none: they read as
 * verification in a commit message.
 *
 * CDP's `Emulation.setDeviceMetricsOverride` sets the viewport the layout engine actually uses, so
 * a media query at 980px fires because the page genuinely is 979px wide. That is the difference
 * between checking the rule and checking the result.
 *
 * ── WHY IT TALKS TO CHROME DIRECTLY ────────────────────────────────────────────────────────────
 * No Playwright, no Puppeteer, no devDependency, nothing downloaded. Node 22+ ships a global
 * `WebSocket` and this machine already has Chrome, which is the whole protocol requirement — and
 * this machine has 4GB of RAM and a slow disk, where a second browser download is a real cost
 * rather than a rounding error.
 *
 * Point it at the DB-free demo (`npm run web:demo`), not at staging: the demo has no login, so
 * nothing here ever handles a credential.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const URL_BASE = arg("url", "http://localhost:3007");
const OUT = arg("out", ".screens");
const WIDTHS = arg("widths", "375,768,1280,1680").split(",").map(Number);
const TABS = arg("tabs", "today,verifications,claims,money,recovery,patients,insights,ops").split(",");
const PORT = Number(arg("port", "9333"));
/*
 * Two ways to photograph something other than a screen's resting state.
 *
 *   --block "*​/api/v1/*"   fail every API call, so §7's error state is what renders
 *   --after "<js>"          run an expression once the screen has settled — opening a drill, say
 *   --tag <name>            suffix for the filenames, so a run does not overwrite the plain shots
 *   --probe "<js>"          an expression evaluated after `--after` settles; its value (anything
 *                           JSON can carry) is saved in report.json as `probe`. For MEASURING a
 *                           layout at a real emulated width — widths of the elements competing for a
 *                           row, say — rather than estimating them from the stylesheet.
 *
 * Both exist because the states this app is most likely to get wrong are the ones nobody looks at:
 * an error block and a drill panel are rendered by the same eight screens and were, until now,
 * unreachable by the only instrument that has ever caught a layout defect here.
 */
const BLOCK = arg("block", null);
const AFTER = arg("after", null);
const PROBE = arg("probe", null);
const TAG = arg("tag", null);

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));

if (!CHROME) {
  console.error("No Chrome found. Pass one on PATH or install Chrome.");
  process.exit(1);
}

const profile = join(tmpdir(), `mermaid-shoot-${process.pid}`);

/** A tiny CDP client. `id` is per-connection; `sessionId` routes to a page rather than the browser. */
class Devtools {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      const waiting = this.pending.get(msg.id);
      if (!waiting) return;
      this.pending.delete(msg.id);
      msg.error ? waiting.reject(new Error(msg.error.message)) : waiting.resolve(msg.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), reject(new Error(`${method} timed out`))), 90_000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a page-side predicate until it is true. Throws with what it was waiting for, not a stack. */
async function until(dt, sessionId, expression, what, budgetMs = 45_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const { result } = await dt.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
    if (result.value === true) return;
    await sleep(300);
  }
  throw new Error(`gave up waiting for ${what} (${Math.round(budgetMs / 1000)}s)`);
}

async function connect() {
  /*
   * Chrome writes its port only once it is listening, so poll the version endpoint rather than
   * sleep. The window is generous because it has to be: on a slow disk a cold Chrome took over
   * eight seconds to start listening here, and a fifteen-second budget failed while the browser
   * was in fact coming up fine — a timeout that looks exactly like a broken tool.
   */
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("Chrome never opened its debugging port (waited 120s)");
}

/** What the page reports about itself once it has settled at a given width. */
const MEASURE = `(() => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  /*
   * An element overflows the page when its RIGHT EDGE passes the viewport, not only when it is wider
   * than the viewport. A 120px button pushed to x=300 on a 375px screen widens the document just as
   * surely as a 500px table — and the width-only test this replaced reported "no offender" for
   * exactly that, on every screen, while the page scrolled sideways by 24px.
   *
   * Only the OUTERMOST crossing is named: every ancestor of a pushed-out button also "ends" past the
   * edge once it grows to contain it, and a list of ten nested wrappers hides the one that matters.
   * An element counts only if its parent does not itself cross, or clips it.
   */
  const crosses = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.right > vw + 1;
  };
  const clips = (e) => {
    const s = getComputedStyle(e);
    return s.overflowX !== 'visible';
  };
  const offenders = [...document.querySelectorAll('body *')]
    .filter((e) => {
      if (!crosses(e)) return false;
      const s = getComputedStyle(e);
      if (s.position === 'fixed') return false;
      // Inside a scroller or a clipping box the overflow is contained there, not on the page.
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (clips(p)) return false;
      const parent = e.parentElement;
      return !parent || parent === document.body || !crosses(parent);
    })
    .slice(0, 6)
    .map((e) => {
      const r = e.getBoundingClientRect();
      return (e.tagName + '.' + String(e.className).split(' ')[0]) +
        ' @' + Math.round(r.left) + '→' + Math.round(r.right) + ' (+' + Math.round(r.right - vw) + ')';
    });

  /* Chrome above the data region is a bug over 200px (§11). */
  const top = document.querySelector('.topbar');
  const rail = document.querySelector('.rail');
  const chrome = (top ? top.getBoundingClientRect().height : 0) +
    (rail && getComputedStyle(rail).flexDirection === 'row' ? rail.getBoundingClientRect().height : 0);

  /* Any text box whose content is taller than its box is clamped; that is intended, not a defect. */
  const rows = [...document.querySelectorAll('.needs__i, .worklist__row, .wl__row')]
    .map((e) => Math.round(e.getBoundingClientRect().height));

  return {
    viewport: vw,
    scrollWidth: de.scrollWidth,
    horizontalScroll: de.scrollWidth > vw + 1,
    offenders,
    chromeHeight: Math.round(chrome),
    rowHeights: { n: rows.length, min: Math.min(...rows), max: Math.max(...rows) },
    textLength: (document.querySelector('.stage')?.textContent || '').trim().length,
    errorBlock: !!document.querySelector('.errb'),
    stuckSkeleton: !!document.querySelector('.sk'),
  };
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      /* headless=new has no GPU surface here; without these the compositor never commits a frame
         and Page.captureScreenshot hangs forever rather than failing. */
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  /* Chrome's own complaint, kept so a failure to start says why instead of only "port never opened". */
  let chromeSaid = "";
  chrome.stderr?.on("data", (d) => (chromeSaid += d.toString()));
  chrome.on("exit", (code) => code && (chromeSaid += `\n[chrome exited ${code}]`));

  const report = [];
  let dt;
  try {
    const wsUrl = await connect().catch((e) => { throw new Error(e.message + (chromeSaid ? `
--- chrome said ---
${chromeSaid.trim()}` : " (chrome printed nothing)")); });
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    dt = new Devtools(ws);

    const { targetId } = await dt.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await dt.send("Target.attachToTarget", { targetId, flatten: true });
    await dt.send("Page.enable", {}, sessionId);
    await dt.send("Runtime.enable", {}, sessionId);
    if (BLOCK) {
      /* Fail the API rather than the page, so the shell boots normally and each screen takes its
         own documented failure path — which is the thing being photographed. */
      await dt.send("Network.enable", {}, sessionId);
      await dt.send("Network.setBlockedURLs", { urls: BLOCK.split(",") }, sessionId);
    }
    await dt.send("Log.enable", {}, sessionId);

    /* A screen that renders nothing has usually thrown. Without this the report says "empty" and
       the reason is in a console nobody is watching. */
    let pageErrors = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Log.entryAdded" && m.params?.entry?.level === "error") {
        pageErrors.push(m.params.entry.text?.slice(0, 300));
      }
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params?.exceptionDetails;
        pageErrors.push((d?.exception?.description || d?.text || "exception").slice(0, 300));
      }
    });

    for (const width of WIDTHS) {
      /* A tall viewport on purpose: the question is what the layout does with the WIDTH, and a
         short one would just add scrolling noise to every screenshot. */
      await dt.send(
        "Emulation.setDeviceMetricsOverride",
        { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 },
        sessionId
      );

      for (const tab of TABS) {
       try {
        pageErrors = [];
        await dt.send("Page.navigate", { url: URL_BASE }, sessionId);

        /*
         * Wait for a CONDITION, never a duration. A fixed 1.4s sleep produced a blank white PNG and
         * a zero-length stage on this disk: the app had not booted, so the screenshot was of
         * nothing and the measurement was of nothing — and both looked like results. It also
         * explained the earlier `captureScreenshot` hangs, because a page still doing its first
         * paint never hands the compositor a frame to capture.
         */
        /*
         * Wait for the app to be RUNNING, not merely present.
         *
         * The rail ships in the static HTML, so waiting for the button to exist was satisfied
         * before app.js had booted — the click then landed on an element with no listener yet and
         * did nothing at all. Today still looked fine, because Today is what the app renders on its
         * own once it starts; the tabs that needed the click were the ones that failed, and they
         * failed as "screen never became selected" rather than as "the click was too early".
         *
         * A stage with children is the app's own evidence that it has taken over the page.
         */
        await until(
          dt,
          sessionId,
          `(document.querySelector('.stage')?.children.length ?? 0) > 0`,
          "app.js to boot and render its first screen",
          60_000
        );
        await dt.send(
          "Runtime.evaluate",
          { expression: `document.querySelector('.rail__item[data-tab="${tab}"]').click()` },
          sessionId
        );
        /*
         * Wait for THIS tab, not for any content.
         *
         * The first version waited only for a non-empty stage, and Today renders on load — so the
         * wait was already satisfied before the clicked screen had swapped in, and every shot was
         * of Today. Sixteen renders came back reporting exactly 2406 characters each, four
         * different screens agreeing to the character, and the report said "0 findings" while
         * having photographed the same page sixteen times.
         *
         * `aria-selected` is what the shell actually sets when a tab wins, so it is the honest
         * signal that the screen under the camera is the screen that was asked for. The skeleton
         * has to be gone too: §7 renders one while data is in flight, and it carries enough text to
         * satisfy a length check, so waiting on content alone photographed the loading state and
         * reported it as the screen.
         */
        await until(
          dt,
          sessionId,
          `document.querySelector('.rail__item[data-tab="${tab}"]')?.getAttribute('aria-selected') === 'true'` +
            ` && !document.querySelector('.sk')` +
            ` && (document.querySelector('.stage')?.textContent || '').trim().length > 40`,
          `${tab} to finish loading`,
          60_000
        );
        /* Let the arrival transition settle so the photograph is of the resting state (§6). */
        await sleep(500);

        if (AFTER) {
          /* The expression opens whatever this run is about — a drill, a menu — and then the same
             settle applies again, because a panel animates in exactly as a screen does. */
          await dt.send("Runtime.evaluate", { expression: AFTER }, sessionId);
          await sleep(700);
        }

        const { result } = await dt.send(
          "Runtime.evaluate",
          { expression: MEASURE, returnByValue: true },
          sessionId
        );
        const measured = { width, tab, ...result.value };
        if (PROBE) {
          const probed = await dt.send("Runtime.evaluate", { expression: PROBE, returnByValue: true }, sessionId);
          measured.probe = probed.result?.value ?? { error: probed.exceptionDetails?.text ?? "no value" };
        }
        report.push(measured);

        const shot = await dt.send(
          "Page.captureScreenshot",
          /* Viewport-only: a full-page capture of a long screen took over thirty seconds on this
             disk and answers a different question. What matters here is what the layout does at
             this WIDTH. `fromSurface` stays true — it is the real composited pixels, and with the
             readiness wait above there is now always a frame to take. */
          { format: "png", captureBeyondViewport: false },
          sessionId
        );
        writeFileSync(join(OUT, `${tab}-${width}${TAG ? `-${TAG}` : ""}.png`), Buffer.from(shot.data, "base64"));

        const flags = [
          measured.horizontalScroll ? "H-SCROLL" : "",
          measured.errorBlock ? "ERROR" : "",
          measured.stuckSkeleton ? "SKELETON" : "",
          measured.chromeHeight > 200 ? `CHROME ${measured.chromeHeight}px` : "",
        ].filter(Boolean);
        console.log(
          `${String(width).padStart(4)}  ${tab.padEnd(14)} ${String(measured.textLength).padStart(5)} chars` +
            (flags.length ? `  ⚠ ${flags.join(" ")}` : "  ok")
        );
       } catch (err) {
        /*
         * Record and carry on. An early version aborted the whole sweep on the first screen that
         * would not render, which threw away the other fifteen results and told you less than the
         * one failure did.
         */
        report.push({ width, tab, failed: err.message, pageErrors: [...new Set(pageErrors)] });
        console.log(
          `${String(width).padStart(4)}  ${tab.padEnd(14)}   FAILED  ${err.message}` +
            (pageErrors.length ? `\n        page said: ${[...new Set(pageErrors)].join(" | ")}` : "")
        );
       }
      }
    }

    writeFileSync(join(OUT, TAG ? `report-${TAG}.json` : "report.json"), JSON.stringify(report, null, 2));
  } finally {
    chrome.kill();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Windows sometimes still holds the profile; it is a temp dir either way. */
    }
  }

  /* With --block the error block is the subject, not a finding; everything else still is. */
  const bad = report.filter(
    (r) => r.failed || r.horizontalScroll || (r.errorBlock && !BLOCK) || r.stuckSkeleton || r.chromeHeight > 200
  );
  console.log(`\n${report.length} renders, ${bad.length} with findings. Images + report.json in ${OUT}/`);
  if (bad.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
