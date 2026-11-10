/**
 * One advice counts once, however many times the outbox delivers it.
 *
 * ── WHY THIS NEEDS A TEST AND NOT A COMMENT ────────────────────────────────────────────────────
 * `full_price_since` counts consecutive adjudications carrying no contractual reduction, and at
 * three the monitor declares the contract lapsed. It is a COUNTER driving an alert, on an
 * at-least-once bus — the shape that double-counts if anything goes wrong.
 *
 * It is safe today, and not because the handler is careful. The dispatcher runs the handler and its
 * delivery checkpoint inside ONE transaction, so a handler that succeeded is never re-run and one
 * that failed rolled its increment back with it. `wiring.ts` says this explicitly about the
 * neighbouring payer-profile counter, and adds the warning that matters here: "the guarantee belongs
 * to the DISPATCHER, not to this handler. A future subscriber that increments a counter outside the
 * ambient transaction — its own pool, an HTTP call, a second connection — has none of this
 * protection."
 *
 * This counter now depends on that guarantee. The test exists so that moving the handler off the
 * ambient transaction fails here rather than showing up as a practice being told its contract has
 * lapsed when the only thing that happened was a retry.
 *
 * Driven through the BUS deliberately. Calling the repository three times proves nothing about
 * redelivery — it proves the repository adds, which it should.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryOutbox } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import { buildServices } from "../apps/web/wiring.ts";

const EVENT = {
  remittanceId: "rem-1",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  observedAt: "2026-02-01T00:00:00.000Z",
  lines: [],
  fullPriceCodes: ["D2750"],
};

async function clinicWithRate() {
  const bus = new InMemoryOutbox();
  const services = buildServices({ inMemory: true, bus });
  await services.allowedAmounts.record({
    payerId: "delta-dental",
    cdtCode: "D2750",
    allowed: cents(1125),
    charged: cents(1250),
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  return { bus, services };
}

test("one full-price advice counts once even when the event is retried", async () => {
  /**
   * ── THE SCENARIO THAT ACTUALLY EXERCISES THE CHECKPOINT ─────────────────────────────────────
   * Draining a settled event repeatedly proves nothing: the dispatcher skips it because it is
   * settled, checkpoint or no checkpoint. My first version of this test did exactly that and passed
   * with the checkpoint REMOVED, which made it worthless for the property it claimed.
   *
   * The retry that matters is caused by a DIFFERENT subscriber on the same event failing. The event
   * is then re-claimed, and the subscriber that already succeeded must not run again — otherwise one
   * advice plus one flaky neighbour reads as two full-price adjudications, and three retries declare
   * a healthy contract lapsed.
   */
  const { bus, services } = await clinicWithRate();

  let attempts = 0;
  bus.subscribe("remittance.allowed_amounts_observed", "test:flaky-neighbour", async () => {
    attempts += 1;
    if (attempts <= 2) throw new Error("transient");
  });

  await bus.publish("remittance.allowed_amounts_observed", "rem-1", EVENT as never);
  for (let i = 0; i < 5; i++) await bus.drain();

  assert.ok(attempts >= 3, `the neighbour must actually have forced retries (ran ${attempts}x)`);
  const rate = (await services.allowedAmounts.find("delta-dental", "D2750"))!;
  assert.equal(
    rate.fullPriceSince,
    1,
    `the event was retried ${attempts} times and the counter reached ${rate.fullPriceSince} — ` +
      `a flaky neighbouring subscriber would declare the contract lapsed`
  );
});

test("two genuinely different advices count twice", async () => {
  /**
   * The other half. A checkpoint that suppressed real evidence would be worse than one that
   * double-counted: the alert would never fire and a lapsed contract would discount quotes forever,
   * which is the defect the counter exists to catch.
   */
  const { bus, services } = await clinicWithRate();

  await bus.publish("remittance.allowed_amounts_observed", "rem-1", EVENT as never);
  await bus.drain();
  await bus.publish("remittance.allowed_amounts_observed", "rem-2", {
    ...EVENT,
    remittanceId: "rem-2",
    observedAt: "2026-03-01T00:00:00.000Z",
  } as never);
  await bus.drain();

  const rate = (await services.allowedAmounts.find("delta-dental", "D2750"))!;
  assert.equal(rate.fullPriceSince, 2, "two advices are two pieces of evidence");
});

test("a rate observation and a full-price observation on one advice do not fight", async () => {
  /**
   * An advice can carry both: the payer discounted the code on one claim and paid it at full price
   * on another. Evidence the contract IS being applied must win, because it is the more specific
   * fact — a CO adjustment names the contract, a full-price line merely fails to.
   */
  const { bus, services } = await clinicWithRate();

  await bus.publish("remittance.allowed_amounts_observed", "rem-1", {
    ...EVENT,
    lines: [{ cdtCode: "D2750", charged: cents(1250), allowed: cents(1125) }],
    fullPriceCodes: ["D2750"],
  } as never);
  await bus.drain();

  const rate = (await services.allowedAmounts.find("delta-dental", "D2750"))!;
  assert.equal(rate.allowed, cents(1125), "the rate still stands");
  assert.ok(
    rate.fullPriceSince <= 1,
    `contradictory evidence in one advice must not stack toward a lapse (${rate.fullPriceSince})`
  );
});

test("the counter is cleared by a later advice that does apply the contract", async () => {
  const { bus, services } = await clinicWithRate();

  for (const id of ["rem-1", "rem-2"]) {
    await bus.publish("remittance.allowed_amounts_observed", id, { ...EVENT, remittanceId: id } as never);
    await bus.drain();
  }
  assert.equal((await services.allowedAmounts.find("delta-dental", "D2750"))!.fullPriceSince, 2);

  await bus.publish("remittance.allowed_amounts_observed", "rem-3", {
    ...EVENT,
    remittanceId: "rem-3",
    observedAt: "2026-04-01T00:00:00.000Z",
    lines: [{ cdtCode: "D2750", charged: cents(1250), allowed: cents(1125) }],
    fullPriceCodes: [],
  } as never);
  await bus.drain();

  assert.equal(
    (await services.allowedAmounts.find("delta-dental", "D2750"))!.fullPriceSince,
    0,
    "the payer applied the contract again — the run is over"
  );
});
