/**
 * Two-step sign-in, as the browser runs it (migration 0038).
 *
 * The server's half is pinned over HTTP in tests/db/mfa.test.ts. This runs the real `app.js` in
 * `node:vm` against a stub DOM and a scripted server, and checks what the person sees at each step:
 * the code step after a password, the enrolment key when MFA is required and not yet set up, the
 * recovery codes shown once before anything else, and the app only after the factor is given.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), "utf8");
const ns = (file: string, binding: string) => {
  const src = read(file);
  const exports = [...src.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]!);
  return `const ${binding} = (() => {\n${src.replace(/^import .*$/gm, "").replace(/\bexport /g, "")}\nreturn { ${exports.join(", ")} };\n})();\n`;
};
const MODULES =
  ns("charts.js", "Cx") + ns("store.js", "__store") + ns("chart.js", "__chart") + ns("table.js", "__table") +
  ns("spine.js", "__spine") + ns("privacy.js", "__privacy") + ns("palette.js", "__palette") +
  `const { createStore } = __store;
const { createDrill } = __spine;
const { presentingToggle } = __privacy;
const { createPalette } = __palette;
const stubScreen = () => ({ destroy() {}, reload() {}, renderDrill: async () => null });
const mountMoney = stubScreen, mountClaims = stubScreen, mountRecover = stubScreen, mountVerify = stubScreen;
const mountToday = stubScreen, mountOps = stubScreen, mountPatients = stubScreen, mountInsights = stubScreen;
`;
const CLIENT = MODULES + read("app.js").replace(/^import .*$/gm, "").replace(/\nboot\(\);\s*$/, "\n");

type Handler = (ev: unknown) => unknown;
type Stub = Record<string, unknown> & { hidden?: boolean; textContent?: string; listeners: Record<string, Handler[]> };
const el = (): Stub => {
  const node: Stub = {
    innerHTML: "",
    hidden: false,
    textContent: "",
    value: "",
    disabled: false,
    listeners: {},
    attrs: {} as Record<string, string>,
    replaceChildren() {},
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type: string, fn: Handler) {
      (node.listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    append() {},
    appendChild() {},
    remove() {},
    setAttribute(name: string, value: string) {
      (node.attrs as Record<string, string>)[name] = value;
    },
    removeAttribute() {},
    hasAttribute: () => false,
    getAttribute: () => null,
    querySelector: () => el(),
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
    scrollIntoView() {},
  };
  return node;
};

/** A form with named fields and a submit button, as the two sign-in forms are. */
const form = (fields: string[]): Stub => {
  const f = el();
  for (const name of fields) f[name] = el();
  const button = el();
  f.querySelector = () => button;
  return f;
};

function client(responses: Record<string, unknown[]>) {
  const byId: Record<string, Stub> = {
    "login-form": form(["email", "password"]),
    "mfa-form": form(["code"]),
    "mfa-recovery": el(),
    "mfa-enroll": el(),
    "mfa-verify-hint": el(),
    "mfa-secret": el(),
    "mfa-uri": el(),
    "mfa-codes": el(),
    "mfa-error": el(),
    "login-error": el(),
    "mfa-recovery-done": el(),
    "login-gate": el(),
  };
  byId["mfa-form"]!.hidden = true;
  byId["mfa-recovery"]!.hidden = true;
  const layout = el();
  layout.hidden = true;
  const document = {
    getElementById: (id: string) => (byId[id] ??= el()),
    querySelector: (sel: string) => (sel === ".layout" ? layout : el()),
    querySelectorAll: () => [],
    createElement: () => el(),
    addEventListener() {},
    removeEventListener() {},
    body: el(),
    documentElement: el(),
    visibilityState: "visible",
    title: "",
  };
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetch = async (url: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} });
    const queue = responses[String(url)] ?? [];
    const next = (queue.shift() ?? { status: 200, json: {} }) as { status: number; json: unknown };
    return { ok: next.status < 400, status: next.status, headers: { get: () => "application/json" }, json: async () => next.json };
  };
  const ctx = vm.createContext({
    document,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { pathname: "/" } },
    location: { pathname: "/" },
    navigator: { userAgent: "test" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch,
    console: { ...console, error() {}, warn() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    requestAnimationFrame: (f: () => void) => f(),
    Intl, Date, Math, JSON, Number, String, Object, Array, Promise, URL, URLSearchParams,
  });
  vm.runInContext(CLIENT, ctx, { filename: "app.js" });
  // `start()` loads the first screen; it is not what these tests are about.
  vm.runInContext("start = async () => {}; state.persistent = true;", ctx);
  const submit = async (id: string) => {
    for (const fn of byId[id]!.listeners["submit"] ?? []) await fn({ preventDefault() {}, target: byId[id] });
  };
  const click = async (id: string) => {
    for (const fn of byId[id]!.listeners["click"] ?? []) await fn({});
  };
  return { byId, layout, calls, submit, click, run: <T>(code: string) => vm.runInContext(code, ctx) as T };
}

const SIGNED_IN = { status: 200, json: { mfa: null, csrf: "full-csrf", user: { email: "a@b.c", name: "A", role: "owner", permissions: [] }, idleTimeoutMs: 1_800_000 } };

test("after a right password, the code step appears and the app does not", async () => {
  const c = client({ "/api/v1/auth/login": [{ status: 200, json: { mfa: "verify", csrf: "pending-csrf" } }] });
  c.byId["login-form"]!.email = { value: "a@b.c" };
  c.byId["login-form"]!.password = { value: "pw" };
  await c.submit("login-form");

  assert.equal(c.byId["login-form"]!.hidden, true);
  assert.equal(c.byId["mfa-form"]!.hidden, false, "the code step");
  assert.equal(c.byId["mfa-enroll"]!.hidden, true, "no enrolment key for someone who already has an app");
  assert.equal(c.layout.hidden, true, "the app stays behind the gate");
  assert.equal(c.run<string>("state.csrf"), "pending-csrf");
});

test("a right code signs in; a wrong one says so and stays on the step", async () => {
  const c = client({
    "/api/v1/auth/login": [{ status: 200, json: { mfa: "verify", csrf: "pending-csrf" } }],
    "/api/v1/auth/mfa/verify": [{ status: 401, json: { error: { code: "bad_mfa_code", message: "That code did not work." } } }, SIGNED_IN],
  });
  await c.submit("login-form");
  (c.byId["mfa-form"]!.code as Stub).value = "123456";
  await c.submit("mfa-form");
  assert.match(String(c.byId["mfa-error"]!.textContent), /did not work/);
  assert.equal(c.byId["mfa-form"]!.hidden, false, "still on the code step — a wrong code is not a sign-out");

  await c.submit("mfa-form");
  const verify = c.calls.filter((x) => x.url === "/api/v1/auth/mfa/verify").at(-1)!;
  assert.equal(verify.headers["x-csrf-token"], "pending-csrf", "the pending session's CSRF token goes with the code");
  assert.equal(c.layout.hidden, false, "signed in");
  assert.equal(c.byId["mfa-form"]!.hidden, true);
  assert.equal(c.run<string>("state.csrf"), "full-csrf", "the replaced session's token, not the pending one");
});

test("where MFA is required and not set up: the key, then the recovery codes once, then the app", async () => {
  const c = client({
    "/api/v1/auth/login": [{ status: 200, json: { mfa: "enroll", csrf: "pending-csrf" } }],
    "/api/v1/auth/mfa/setup": [{ status: 200, json: { secret: "ABCDEFGHIJKLMNOP", otpauthUri: "otpauth://totp/Mermaid:a%40b.c?secret=ABCDEFGHIJKLMNOP" } }],
    "/api/v1/auth/mfa/enable": [{ status: 200, json: { recoveryCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"], ...SIGNED_IN.json } }],
  });
  await c.submit("login-form");
  assert.equal(c.byId["mfa-enroll"]!.hidden, false, "the enrolment key is shown");
  assert.equal(c.byId["mfa-secret"]!.textContent, "ABCD EFGH IJKL MNOP", "grouped for reading and retyping");
  assert.equal((c.byId["mfa-uri"]!.attrs as Record<string, string>).href, "otpauth://totp/Mermaid:a%40b.c?secret=ABCDEFGHIJKLMNOP");

  (c.byId["mfa-form"]!.code as Stub).value = "654321";
  await c.submit("mfa-form");
  assert.equal(c.byId["mfa-recovery"]!.hidden, false, "the recovery codes, before anything else");
  assert.equal(c.byId["mfa-codes"]!.textContent, "AAAAA-BBBBB\nCCCCC-DDDDD");
  assert.equal(c.layout.hidden, true, "not into the app until they are acknowledged");

  await c.click("mfa-recovery-done");
  assert.equal(c.layout.hidden, false);
  assert.equal(c.byId["mfa-recovery"]!.hidden, true);
  assert.equal(c.byId["mfa-codes"]!.textContent, "", "and they are cleared from the page");
});

test("signing out from anywhere in the flow returns to the password step and forgets the codes", () => {
  const c = client({});
  c.byId["mfa-form"]!.hidden = false;
  c.byId["mfa-recovery"]!.hidden = false;
  c.byId["mfa-codes"]!.textContent = "AAAAA-BBBBB";
  c.run("showLogin()");
  assert.equal(c.byId["login-form"]!.hidden, false);
  assert.equal(c.byId["mfa-form"]!.hidden, true);
  assert.equal(c.byId["mfa-recovery"]!.hidden, true);
  assert.equal(c.byId["mfa-codes"]!.textContent, "");
});

test("the staff screen shows who has two-step sign-in, and offers a reset only for someone else who has it", async () => {
  const c = client({
    "/api/v1/users": [
      {
        status: 200,
        json: {
          items: [
            { id: "u-self", email: "boss@x.test", name: "Boss", role: "owner", disabled: false, mfaEnabled: true, isSelf: true },
            { id: "u-on", email: "biller@x.test", name: "Biller", role: "biller", disabled: false, mfaEnabled: true, isSelf: false },
            { id: "u-off", email: "desk@x.test", name: "Desk", role: "front_desk", disabled: false, mfaEnabled: false, isSelf: false },
          ],
        },
      },
    ],
  });
  await c.run<Promise<void>>("showStaff()");
  const html = String(c.byId["stage"]!.innerHTML);
  assert.match(html, /Two-step sign-in/);
  assert.equal((html.match(/data-mfa-reset-for=/g) ?? []).length, 1, "one reset button");
  assert.match(html, /data-mfa-reset-for="u-on"/, "for the colleague who has it — never for oneself, never for someone without it");
});
