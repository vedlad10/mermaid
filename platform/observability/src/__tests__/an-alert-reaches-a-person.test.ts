/**
 * The alert gate had nowhere to send anything, and this is the thing that must not break when it does.
 *
 * ── WHAT IS BEING PINNED (audit A-4) ───────────────────────────────────────────────────────────
 * Three properties, in the order they would hurt if they were wrong:
 *
 *   1. **It cannot take the monitor down.** A notifier is called from a timer that samples every
 *      operational check this platform has. If a slow chat provider can make that tick hang, or a
 *      rejected POST can make it throw, then configuring alerting has stopped the monitoring — which
 *      is a strictly worse outcome than the silence it was meant to fix.
 *   2. **It cannot leak a person.** The destination is somebody else's server and quite possibly a
 *      chat history that thirty people can scroll. No monitor measures anything patient-shaped
 *      today; this is the guarantee that a future one which starts attaching a name cannot ship that
 *      name to Slack because nobody thought about it.
 *   3. **It refuses plaintext.** An alert names the deployment and says which practice's money will
 *      not reconcile. Over http:// that is readable in transit, and the failure is invisible because
 *      the alert still arrives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAlertNotifier, redact, type AlertPayload } from "../notify.ts";

const payload: AlertPayload = {
  key: "money.reconciliation_drift",
  state: "firing",
  message: "Auto-posted money does not reconcile against the payers' advice.",
  since: "2026-09-11T08:00:00.000Z",
  detail: { driftCents: 4211, practicesBreaching: 1 },
};

/** Collects what the logger was told, so the "never throws" tests can prove it said something. */
function recorder() {
  const lines: { level: string; message: string }[] = [];
  const push = (level: string) => (message: string) => void lines.push({ level, message });
  return { lines, logger: { info: push("info"), error: push("error"), warn: push("warn"), debug: push("debug") } as never };
}

/** The notifier is fire-and-forget, so a test has to let its microtasks run before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test("with no URL configured, nothing is sent and nothing complains", async () => {
  const { logger, lines } = recorder();
  let called = false;
  const notify = createAlertNotifier({
    logger,
    fetchImpl: (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch,
  });

  notify(payload);
  await settle();

  assert.equal(called, false, "an unconfigured deployment must open no sockets");
  assert.ok(
    lines.some((l) => l.message.includes("not configured")),
    "and it must say so once at boot, because silence is indistinguishable from a broken webhook"
  );
});

test("a configured https URL receives the alert, with the deployment named", async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const notify = createAlertNotifier({
    url: "https://hooks.example.invalid/T000/B000",
    environment: "staging",
    fetchImpl: (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
  });

  notify(payload);
  await settle();

  assert.equal(sent.length, 1, "exactly one POST per notification");
  assert.match(sent[0]!.url, /^https:\/\/hooks\.example\.invalid\//);

  const body = sent[0]!.body;
  /* `text` is the field Slack and Discord render with no mapping at all, which is why it exists. */
  assert.match(String(body.text), /staging/, "an operator with two environments must be able to tell them apart");
  assert.match(String(body.text), /money\.reconciliation_drift/);
  assert.equal(body.state, "firing");
  assert.equal(body.since, payload.since);
  assert.deepEqual(body.detail, { driftCents: 4211, practicesBreaching: 1 });
});

test("an http:// URL is refused outright rather than used", async () => {
  const { logger, lines } = recorder();
  let called = false;
  const notify = createAlertNotifier({
    url: "http://hooks.example.invalid/plain",
    logger,
    fetchImpl: (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch,
  });

  notify(payload);
  await settle();

  assert.equal(called, false, "an alert naming a practice's money must not travel in the clear");
  assert.ok(lines.some((l) => l.level === "error" && /https/.test(l.message)));
});

test("a rejected POST is logged and cannot throw at the caller", async () => {
  const { logger, lines } = recorder();
  const notify = createAlertNotifier({
    url: "https://hooks.example.invalid/gone",
    logger,
    fetchImpl: (async () => new Response("no such hook", { status: 404 })) as unknown as typeof fetch,
  });

  /* The assertion is that this line returns normally — a throw here would propagate into the
     monitor tick and stop every other check being sampled. */
  assert.doesNotThrow(() => notify(payload));
  await settle();
  assert.ok(lines.some((l) => l.level === "error" && /rejected/.test(l.message)));
});

test("a transport that throws is logged and cannot throw at the caller either", async () => {
  const { logger, lines } = recorder();
  const notify = createAlertNotifier({
    url: "https://hooks.example.invalid/dead",
    logger,
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
  });

  assert.doesNotThrow(() => notify(payload));
  await settle();
  assert.ok(lines.some((l) => l.level === "error" && /delivery failed/.test(l.message)));
});

test("the notifier returns before the request does", async () => {
  /**
   * The property that makes this safe on a timer. A chat provider taking four seconds must not delay
   * the next sample of the outbox lag by four seconds, so the call has to return before the round
   * trip completes rather than after it.
   */
  let resolveFetch: (() => void) | undefined;
  const notify = createAlertNotifier({
    url: "https://hooks.example.invalid/slow",
    fetchImpl: (async () => {
      await new Promise<void>((r) => { resolveFetch = r; });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch,
  });

  const before = Date.now();
  notify(payload);
  assert.ok(Date.now() - before < 50, "notify() must not await the request");
  await settle();
  assert.ok(resolveFetch !== undefined, "and the request must nevertheless have started");
  resolveFetch!();
});

test("redaction keeps the measurements and withholds anything identifier-shaped", () => {
  const out = redact({
    driftCents: 4211,
    balanced: false,
    nothing: null,
    checkName: "money.reconciliation_drift",
    /* The three shapes a leak actually takes. None of these is measured by a monitor today, and that
       is exactly why the guard has to be structural rather than a promise. */
    memberId: "AETNA9WCSU00412",
    patientEmail: "someone@example.com",
    note: "x".repeat(400),
  });

  assert.equal(out.driftCents, 4211, "numbers are the whole point of an alert");
  assert.equal(out.balanced, false);
  assert.equal(out.nothing, null);
  assert.equal(out.checkName, "money.reconciliation_drift", "a short, non-identifier string survives");

  assert.equal(out.memberId, "[withheld]", "a long run of digits is an identifier");
  assert.equal(out.patientEmail, "[withheld]", "an address is a person");
  assert.equal(out.note, "[withheld]", "and free text is where a name ends up");

  /* Withheld, not dropped: an absent key reads as "the monitor did not measure this", which sends
     an operator looking for a different problem. */
  assert.deepEqual(Object.keys(out).sort(), Object.keys(out).sort());
  assert.ok("memberId" in out);
});
