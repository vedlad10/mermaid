/**
 * Automatic logoff, the browser's half (45 CFR 164.312(a)(2)(iii)).
 *
 * The server ends a session nobody has used for SESSION_IDLE_MINUTES, but the screen in front of the
 * empty chair is the browser's. Two defects made the server-side control insufficient alone:
 *
 *   1. The drill panel and the command palette live OUTSIDE `.layout`. `showLogin` hid the layout and
 *      left an open patient or claim on screen behind the sign-in gate.
 *   2. Polling stops while a drill panel is open, so a patient left open would never learn its
 *      session had ended — no request would ever arrive to be refused.
 *
 * So the client locks on its OWN clock and reports its idleness on every request. This runs the real
 * `app.js` in `node:vm` against a stub DOM, as `today-board-renders.test.ts` does, and asserts on
 * the state of the elements that hold patient data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), "utf8");

/** Each imported module inlined as an IIFE that returns its exports — real code, not stubs. */
const ns = (file: string, binding: string) => {
  const src = read(file);
  const exports = [...src.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]!);
  return `const ${binding} = (() => {
${src.replace(/^import .*$/gm, "").replace(/\bexport /g, "")}
return { ${exports.join(", ")} };
})();
`;
};

const MODULES =
  ns("charts.js", "Cx") +
  ns("store.js", "__store") +
  ns("chart.js", "__chart") +
  ns("table.js", "__table") +
  ns("spine.js", "__spine") +
  ns("privacy.js", "__privacy") +
  ns("palette.js", "__palette") +
  `const { createStore } = __store;
const { createDrill } = __spine;
const { presentingToggle } = __privacy;
const { createPalette } = __palette;
const stubScreen = () => ({ destroy() {}, reload() {}, renderDrill: async () => null });
const mountMoney = stubScreen, mountClaims = stubScreen, mountRecover = stubScreen, mountVerify = stubScreen;
const mountToday = stubScreen, mountOps = stubScreen, mountPatients = stubScreen, mountInsights = stubScreen;
`;

const CLIENT = MODULES + read("app.js").replace(/^import .*$/gm, "").replace(/\nboot\(\);\s*$/, "\n");

type Stub = Record<string, unknown> & { hidden?: boolean; textContent?: string };
const el = (): Stub => ({
  innerHTML: "",
  hidden: false,
  textContent: "",
  replacedCount: 0,
  replaceChildren(this: Stub) {
    this.replacedCount = (this.replacedCount as number) + 1;
  },
  dataset: {},
  style: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {},
  removeEventListener() {},
  append() {},
  appendChild() {},
  remove() {},
  setAttribute() {},
  removeAttribute() {},
  hasAttribute: () => false,
  getAttribute: () => null,
  querySelector: () => el(),
  querySelectorAll: () => [],
  closest: () => null,
  focus() {},
  scrollIntoView() {},
});

function client() {
  const byId: Record<string, Stub> = { "login-gate": el(), drill: el(), "login-error": el() };
  const layout = el();
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};
  const document = {
    getElementById: (id: string) => (byId[id] ??= el()),
    querySelector: (sel: string) => (sel === ".layout" ? layout : el()),
    querySelectorAll: () => [],
    createElement: () => el(),
    addEventListener: (type: string, fn: (ev: unknown) => void) => (listeners[type] ??= []).push(fn),
    removeEventListener() {},
    body: el(),
    documentElement: el(),
    visibilityState: "visible",
    title: "",
  };
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const intervals: (() => void)[] = [];
  const ctx = vm.createContext({
    document,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { pathname: "/" } },
    location: { pathname: "/" },
    navigator: { userAgent: "test" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url: string, init: { headers?: Record<string, string> } = {}) => {
      requests.push({ url: String(url), headers: { ...(init.headers ?? {}) } });
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}) };
    },
    console: { ...console, error() {}, warn() {} },
    setTimeout,
    clearTimeout,
    // Captured, not run: the test drives the clock by hand rather than waiting on wall time.
    setInterval: (fn: () => void) => intervals.push(fn),
    clearInterval() {},
    requestAnimationFrame: (f: () => void) => f(),
    Intl, Date, Math, JSON, Number, String, Object, Array, Promise, URL, URLSearchParams,
  });
  vm.runInContext(CLIENT, ctx, { filename: "app.js" });
  const run = <T>(code: string) => vm.runInContext(code, ctx) as T;
  return { run, byId, layout, requests, listeners };
}

test("an untouched signed-in screen locks on its own clock and leaves no patient on it", () => {
  const c = client();
  c.run(`state.persistent = true; state.user = { role: "owner" }; state.csrf = "csrf-1"; state.idleTimeoutMs = 30 * 60000;`);
  // A patient open in the drill panel, and the app visible.
  c.byId.drill!.hidden = false;
  c.layout.hidden = false;
  c.byId["login-gate"]!.hidden = true;

  // 29 minutes untouched: nothing happens.
  c.run(`checkIdle(Date.now() + 29 * 60000)`);
  assert.equal(c.byId["login-gate"]!.hidden, true, "still inside the window");

  // 31 minutes untouched: the screen locks.
  c.run(`checkIdle(Date.now() + 31 * 60000)`);
  assert.equal(c.byId["login-gate"]!.hidden, false, "the sign-in gate is up");
  assert.equal(c.layout.hidden, true, "the screens are hidden");
  assert.equal(c.byId.drill!.hidden, true, "the drill panel — outside .layout — is closed too");
  assert.ok((c.byId.drill!.replacedCount as number) > 0, "and emptied, not merely hidden");
  assert.match(String(c.byId["login-error"]!.textContent), /signed out after 30 minutes without activity/);
  assert.equal(c.run<null>("state.user"), null);
  assert.equal(c.run<null>("state.csrf"), null);

  const logout = c.requests.find((r) => r.url === "/api/v1/auth/logout");
  assert.ok(logout, "the server is told, so the session ends there as well");
  assert.match(logout!.headers["x-mermaid-idle-ms"] ?? "", /^\d+$/, "with the idleness, so it is recorded as an idle expiry");
});

test("every request reports how long it has been since a real input, and an input resets it", async () => {
  const c = client();
  c.run(`state.persistent = true; state.user = { role: "owner" };`);
  await c.run<Promise<unknown>>(`api("GET", "/api/v1/today")`);
  const idle = Number(c.requests.at(-1)!.headers["x-mermaid-idle-ms"]);
  assert.ok(Number.isInteger(idle) && idle >= 0, "a whole number of milliseconds");

  c.run(`lastInputAt = Date.now() - 600000;`);
  await c.run<Promise<unknown>>(`api("GET", "/api/v1/today")`);
  assert.ok(Number(c.requests.at(-1)!.headers["x-mermaid-idle-ms"]) >= 600000, "a poll from an untouched screen says so");

  // Every keydown listener sees it, the palette's included, so it is a real-shaped, harmless key.
  const shift = { key: "Shift", target: { tagName: "BODY" }, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {} };
  for (const fn of c.listeners["keydown"] ?? []) fn(shift);
  await c.run<Promise<unknown>>(`api("GET", "/api/v1/today")`);
  assert.ok(Number(c.requests.at(-1)!.headers["x-mermaid-idle-ms"]) < 1000, "a key press is presence");
});

test("the DB-free demo, which has no sessions, never locks", () => {
  const c = client();
  c.run(`state.persistent = false; state.user = null; state.idleTimeoutMs = 60000;`);
  c.byId["login-gate"]!.hidden = true;
  c.run(`checkIdle(Date.now() + 10 * 3600000)`);
  assert.equal(c.byId["login-gate"]!.hidden, true);
});
