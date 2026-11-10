import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../logger.ts";
import { createMetrics } from "../metrics.ts";
import { recordAudit, type Queryable } from "../audit.ts";

test("logger emits one JSON line per event with level, channel, message, fields", () => {
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l), () => "2026-07-26T00:00:00.000Z");
  log.info("hello", { channel: "security", traceId: "t1", userId: "u1" });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.channel, "security");
  assert.equal(parsed.message, "hello");
  assert.equal(parsed.traceId, "t1");
  assert.equal(parsed.userId, "u1");
  assert.equal(parsed.ts, "2026-07-26T00:00:00.000Z");
});

test("logger defaults channel to app", () => {
  const lines: string[] = [];
  createLogger((l) => lines.push(l)).error("boom");
  assert.equal(JSON.parse(lines[0]!).channel, "app");
});

test("metrics counters and gauges", () => {
  const m = createMetrics();
  m.inc("events.published");
  m.inc("events.published", 4);
  m.gauge("outbox.lag_seconds", 12);
  assert.equal(m.get("events.published"), 5);
  assert.equal(m.get("outbox.lag_seconds"), 12);
  assert.deepEqual(m.snapshot(), { "events.published": 5, "outbox.lag_seconds": 12 });
  m.reset();
  assert.equal(m.get("events.published"), 0);
});

test("recordAudit calls record_audit with 11 params and serializes before/after", async () => {
  let captured: { text: string; params?: unknown[] } | null = null;
  const tx: Queryable = {
    query(text, params) {
      captured = { text, params };
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  };
  await recordAudit(tx, {
    practiceId: "p1", traceId: "tr1", actorId: "u1", actorRole: "biller",
    action: "post_payment", resource: "claim", resourceId: "c1",
    after: { paid: 1000 }, outcome: "success", ip: "1.2.3.4",
  });
  assert.match(captured!.text, /record_audit/);
  assert.equal(captured!.params?.length, 11);
  assert.equal(captured!.params?.[0], "p1");
  assert.equal(captured!.params?.[8], JSON.stringify({ paid: 1000 })); // after_json
  assert.equal(captured!.params?.[7], null); // before absent → null
});

test("logger automatically redacts PHI fields and values", () => {
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l));

  log.info("processing claim for patient", {
    patient: { firstName: "John", lastName: "Doe", memberId: "MEM123456" },
    ssn: "123-45-6789",
    raw835: "ISA*00*...",
    practiceId: "prac-123",
  });

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.patient, "[REDACTED_PHI]");
  assert.equal(parsed.ssn, "[REDACTED_PHI]");
  assert.equal(parsed.raw835, "[REDACTED_PHI]");
  assert.equal(parsed.practiceId, "prac-123");
});

test("logger automatically redacts SSNs and member IDs from message strings", () => {
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l));

  log.warn("Check failed for SSN 123-45-6789 and member ID AETNA12345");

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.ok(!parsed.message.includes("123-45-6789"));
  assert.ok(parsed.message.includes("***-**-****"));
});
