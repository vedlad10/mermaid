/**
 * Alert gating.
 *
 * These tests protect restraint, which is the hard half of monitoring. Every assertion here is
 * about NOT speaking: not on the first blip, not again a second later, not at all when nothing was
 * ever wrong. A monitor people mute is worse than no monitor, because it looks like coverage — the
 * same reasoning that kept the Today queue from being a materialised projection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertGate } from "../alerts.ts";

const at = (ms: number): Date => new Date(1_700_000_000_000 + ms);
const breach = (key = "outbox.lag") => ({ key, breaching: true, message: "stalled", detail: { lagMs: 9_000 } });
const clear = (key = "outbox.lag") => ({ key, breaching: false, message: "recovered" });

test("a single breach says nothing — one slow tick during a deploy is not an incident", () => {
  const gate = new AlertGate({ consecutive: 3, cooldownMs: 60_000 });
  assert.equal(gate.evaluate(breach(), at(0)), null);
});

test("it fires only once the condition is sustained", () => {
  const gate = new AlertGate({ consecutive: 3, cooldownMs: 60_000 });

  assert.equal(gate.evaluate(breach(), at(0)), null);
  assert.equal(gate.evaluate(breach(), at(1_000)), null);

  const fired = gate.evaluate(breach(), at(2_000));
  assert.equal(fired?.kind, "firing");
  assert.equal(fired?.key, "outbox.lag");
  assert.equal(fired?.since, at(2_000).toISOString());
  assert.equal(fired?.detail.lagMs, 9_000, "the numbers a responder needs must travel with the alert");
});

test("a recovery before the threshold resets the streak entirely", () => {
  const gate = new AlertGate({ consecutive: 3, cooldownMs: 60_000 });

  gate.evaluate(breach(), at(0));
  gate.evaluate(breach(), at(1_000));
  assert.equal(gate.evaluate(clear(), at(2_000)), null, "nothing was ever announced, so nothing resolved");

  // The streak must start over, not resume where it left off.
  assert.equal(gate.evaluate(breach(), at(3_000)), null);
  assert.equal(gate.evaluate(breach(), at(4_000)), null);
  assert.equal(gate.evaluate(breach(), at(5_000))?.kind, "firing");
});

test("while it keeps firing it repeats at most once per cooldown", () => {
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });

  assert.equal(gate.evaluate(breach(), at(0))?.kind, "firing");
  assert.equal(gate.evaluate(breach(), at(10_000)), null, "10s later is not news");
  assert.equal(gate.evaluate(breach(), at(59_000)), null);

  const again = gate.evaluate(breach(), at(60_000));
  assert.equal(again?.kind, "firing");
  assert.equal(again?.since, at(0).toISOString(), "a repeat must still date from when it started");
});

test("recovery is announced once, then never again", () => {
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });
  gate.evaluate(breach(), at(0));

  const resolved = gate.evaluate(clear(), at(5_000));
  assert.equal(resolved?.kind, "resolved");
  assert.equal(resolved?.since, at(0).toISOString(), "'it cleared' is only useful with 'it started at'");

  assert.equal(gate.evaluate(clear(), at(6_000)), null, "healthy is not news");
});

test("conditions are tracked independently — a stalled queue does not mute a money alert", () => {
  const gate = new AlertGate({ consecutive: 2, cooldownMs: 60_000 });

  gate.evaluate(breach("outbox.lag"), at(0));
  assert.equal(gate.evaluate(breach("outbox.lag"), at(1_000))?.kind, "firing");

  // The money condition has its own streak and has not earned an alert yet.
  assert.equal(gate.evaluate(breach("money.drift"), at(1_000)), null);
  assert.equal(gate.evaluate(breach("money.drift"), at(2_000))?.kind, "firing");
});

test("a fully healthy system is silent", () => {
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 0 });
  for (let i = 0; i < 50; i++) {
    assert.equal(gate.evaluate(clear(), at(i * 1_000)), null);
  }
});
