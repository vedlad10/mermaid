/**
 * A file that parses as EDI but carries nothing must not become a remittance.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `ingestRaw` refuses a parse that FAILS. Nothing refused one that succeeded and yielded nothing.
 *
 * Uploading a truncated payload — `ISA*00*…*ZZ*BROKEN~GS*HP~ST*835*0001~SE*2*0001~` — begins with
 * ISA, so it is X12-shaped, and parses without error into an advice with no trace number, no payer,
 * no claims and no provider adjustments. Against the deployed build it was accepted with a 201 and
 * stored as a held remittance.
 *
 * What that leaves behind is worse than a rejection. The row sits on the Money worklist with no
 * payer and no trace to identify it, and `release` refuses any remittance without a trace number —
 * deliberately and correctly, because a payment nobody can name must not be posted. So the row can
 * never be cleared, and every malformed upload adds another one permanently.
 *
 * ── WHY THE REFUSAL IS NARROW ────────────────────────────────────────────────────────────────────
 * An advice with no CLAIMS is legitimate: a payer sending only provider-level adjustments is
 * recording a recoupment, and that is real money the product must keep. The last test here exists to
 * hold that line — the refusal requires all of nothing paid, nobody adjudicated and nothing withheld.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { InMemoryExpectationRepository, InMemoryRemittanceRepository } from "../repository.ts";
import { RemittanceService } from "../service.ts";

const NOW = new Date("2026-09-01T12:00:00Z");
const silent = createLogger(() => {});

/** The service wired exactly as the other tests in this folder wire it. */
function service() {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const repo = new InMemoryRemittanceRepository();
  return new RemittanceService(repo, new InMemoryExpectationRepository(), new MockEdiAdapter(), bus);
}

const EMPTY_X12 = "ISA*00*          *00*          *ZZ*BROKEN~GS*HP~ST*835*0001~SE*2*0001~";

test("an X12-shaped file with no payment, no claims and no adjustments is refused", async () => {
  const svc = service();
  await assert.rejects(
    () => svc.ingestRaw(EMPTY_X12, NOW),
    (e: Error & { code?: string }) => {
      /**
       * The code matters as much as the refusal: the upload route turns it into the message a person
       * reads, and "there is nothing in this file" is a different instruction from "this file is
       * corrupt" — one says re-export, the other says re-upload.
       */
      assert.match(e.message, /nothing to record|no payment/i, `unhelpful message: ${e.message}`);
      return true;
    },
    "a file carrying nothing must not be stored as a remittance"
  );
});

test("the refusal carries a code the API can turn into a 400", async () => {
  /**
   * The code is load-bearing. `RemittanceUnavailableError` defaults to a 502
   * `clearinghouse_error`, which would tell an operator the payer's system had failed and invite a
   * retry that can never succeed — the file is truncated, and retrying sends the same bytes. The
   * route maps `empty_advice` to a 400 alongside `parse_error`, and that mapping is keyed on this
   * exact string.
   */
  const svc = service();
  await assert.rejects(
    () => svc.ingestRaw(EMPTY_X12, NOW),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "empty_advice", "the API's 400 mapping is keyed on this code");
      assert.equal((e as { retryable?: boolean }).retryable, false, "a truncated file does not become whole on retry");
      return true;
    }
  );
});

test("nothing is stored when the file carries nothing", async () => {
  const svc = service();
  await svc.ingestRaw(EMPTY_X12, NOW).catch(() => {});
  const listed = await svc.list();
  assert.equal(
    listed.length,
    0,
    "an unclearable row with no trace number and no payer is worse than a rejection — it can never be released"
  );
});

test("an advice carrying ONLY a provider adjustment is still ingested", async () => {
  /**
   * The line the refusal must not cross. A payer recouping an earlier overpayment sends exactly this:
   * no claims, a real PLB, real money. Refusing it would lose a recoupment the practice has to
   * account for.
   */
  const svc = service();

  /**
   * The mock adapter builds an 835 from a description, so the file is real X12 and the parse is the
   * production one. A single provider-level adjustment, no claims.
   */
  const { build835 } = await import("../../../../platform/edi/mock/x12-835.ts");
  const plbOnly = build835({
    payerName: "MetLife Dental",
    payeeName: "MERMAID DEMO DENTAL",
    traceNumber: "EFT-PLB-ONLY",
    paymentTotal: 0,
    paymentDate: "2026-09-01",
    paymentMethod: "ACH",
    claims: [],
    providerAdjustments: [{ providerId: "1234567893", reasonCode: "WO", amount: 250, referenceId: "PRIOR-1" }],
  });

  const view = await svc.ingestRaw(plbOnly, NOW);
  assert.ok(view, "a provider-level recoupment is real money and must be recorded");
  assert.equal((await svc.list()).length, 1);
});
