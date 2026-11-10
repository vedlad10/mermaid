/**
 * Every tab a role can see is a tab that role can actually open.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * The client rendered all nine tabs for everyone and printed the role name in the corner. The
 * server enforced `PERMISSIONS` exactly as designed, so a dentist — who holds neither `queue.read`
 * nor `remittances.read` nor `patients.read` — landed on Today, the DEFAULT tab, and was shown
 * "role dentist lacks queue.read", then found five of the nine tabs failing the same way. Correct
 * enforcement, presented as a broken application.
 *
 * The navigation is now built from the permission list the session returns, and each tab declares
 * what it needs via `data-requires`.
 *
 * ── WHY THIS TEST READS THE HTML AND THE ROUTE TABLE ───────────────────────────────────────────
 * The declaration in `index.html` and the enforcement in `ROUTE_PERMISSIONS` are two statements of
 * one fact, in two languages, that nothing else compares. A tab tagged with the wrong permission
 * fails in one of two silent ways: it is hidden from someone entitled to it, or it is shown and
 * then 403s — which is the bug this whole change exists to remove.
 *
 * That is not hypothetical: `recovery` was first tagged `remittances.read` because the tab is
 * called "Recover". It loads `/api/v1/denials`, needs `denials.read`, and the mistake would have
 * hidden the appeals screen from the dentist whose only job in Mermaid is to write on appeals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PERMISSIONS, ROLES, type Permission, type Role } from "@mermaid/shared";

const html = readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");

/** The endpoint each tab's loader actually calls, read from app.js's dispatch in `loadQueue`. */
const TAB_ENDPOINT: Record<string, string> = {
  today: "/api/v1/today",
  verifications: "/api/v1/verifications",
  claims: "/api/v1/claims",
  money: "/api/v1/remittances",
  recovery: "/api/v1/denials",
  patients: "/api/v1/patients",
  insights: "/api/v1/analytics/report",
  ops: "/api/v1/ops/outbox",
  testlab: "/api/v1/ops/integration-tests",
};

/** What the server demands of a GET on that path — mirrors `ROUTE_PERMISSIONS` in server.ts. */
const ENDPOINT_PERMISSION: Record<string, Permission> = {
  "/api/v1/today": "queue.read",
  "/api/v1/verifications": "verifications.read",
  "/api/v1/claims": "claims.read",
  "/api/v1/remittances": "remittances.read",
  "/api/v1/denials": "denials.read",
  "/api/v1/patients": "patients.read",
  "/api/v1/analytics/report": "analytics.read",
  "/api/v1/ops/outbox": "audit.read",
  "/api/v1/ops/integration-tests": "audit.read",
};

function declaredTabs(): { tab: string; requires: string | null }[] {
  const out: { tab: string; requires: string | null }[] = [];
  /**
   * ── READ THE WHOLE TAG, NOT TWO ADJACENT ATTRIBUTES ──────────────────────────────────────────
   * This matched `data-tab="x"` immediately followed by `data-requires="y"`. Attribute order in
   * HTML carries no meaning, so the moment `aria-label` and `title` were added to the rail buttons —
   * to give nine icon-only tabs an accessible name — `data-requires` stopped being adjacent, every
   * tab reported `null`, and three permission tests failed. Nothing about the permissions had
   * changed.
   *
   * A security test that breaks when an unrelated attribute is added is testing the markup's
   * typography rather than its meaning. So the tag is captured as a unit and each attribute is read
   * from it independently.
   */
  for (const tag of html.matchAll(/<button\b[^>]*\bdata-tab="[a-z]+"[^>]*>/g)) {
    const open = tag[0]!;
    const tab = /\bdata-tab="([a-z]+)"/.exec(open)?.[1];
    if (!tab) continue;
    const requires = /\bdata-requires="([a-z.]+)"/.exec(open)?.[1] ?? null;
    out.push({ tab, requires });
  }
  return out;
}

test("every tab declares the permission its own endpoint requires", () => {
  const tabs = declaredTabs();
  assert.ok(tabs.length >= 9, `expected the full rail, found ${tabs.length} tabs`);

  for (const { tab, requires } of tabs) {
    const endpoint = TAB_ENDPOINT[tab];
    assert.ok(endpoint, `tab "${tab}" is not in TAB_ENDPOINT — add it when adding a tab`);
    assert.equal(
      requires,
      ENDPOINT_PERMISSION[endpoint],
      `tab "${tab}" loads ${endpoint} but declares "${requires}" — it would ${
        requires === null ? "show for everyone and 403" : "be hidden from, or 403 for, the wrong people"
      }`
    );
  }
});

test("every role can open at least one tab, so nobody lands on an error", () => {
  /**
   * The landing screen is the first tab the person can open. A role with none would sign in to an
   * empty rail and a failed request, which is the state a dentist was already in.
   */
  for (const role of ROLES) {
    const held = PERMISSIONS[role];
    const open = declaredTabs().filter((t) => !t.requires || held.includes(t.requires as Permission));
    assert.ok(open.length > 0, `role "${role}" can open no tab at all`);
  }
});

test("a dentist is given the appeals screen and not the money screens", () => {
  /**
   * The specific case that exposed this. A dentist holds `appeals.write` so a clinician can put
   * their name to an appeal narrative; `denials.read` is held for the same reason. They hold
   * neither `remittances.read` nor `patients.read`, deliberately — see roles.ts.
   */
  const held = PERMISSIONS.dentist as readonly string[];
  const visible = declaredTabs()
    .filter((t) => !t.requires || held.includes(t.requires))
    .map((t) => t.tab);

  assert.ok(visible.includes("recovery"), "the appeals screen is the dentist's actual job");
  assert.ok(visible.includes("claims"), "and the claim behind the appeal");
  assert.ok(!visible.includes("money"), "a dentist does not post payments");
  assert.ok(!visible.includes("patients"), "or look at account balances");
  assert.ok(!visible.includes("today"), "Today needs queue.read, which a dentist does not hold");
  assert.notEqual(visible[0], "today", "so Today cannot be the screen they land on");
});

test("front desk gets the patient and queue screens and no money screens", () => {
  const held = PERMISSIONS.front_desk as readonly string[];
  const visible = declaredTabs()
    .filter((t) => !t.requires || held.includes(t.requires))
    .map((t) => t.tab);

  assert.deepEqual(visible, ["today", "verifications", "patients"]);
});

test("an auditor sees every read-only screen and the audit log", () => {
  const held = PERMISSIONS.auditor as readonly string[];
  const visible = declaredTabs()
    .filter((t) => !t.requires || held.includes(t.requires))
    .map((t) => t.tab);

  for (const tab of ["today", "verifications", "claims", "money", "recovery", "patients", "insights", "ops"]) {
    assert.ok(visible.includes(tab), `an auditor must be able to read ${tab}`);
  }
});
