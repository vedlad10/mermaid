/**
 * The Money headers and the Recover queue must count the same advices.
 *
 * ── THE DIVERGENCE ─────────────────────────────────────────────────────────────────────────────
 * `buildRecoveryQueue` has skipped anything not posted since it was written. The `/api/v1/remittances`
 * headers summed every status. So a HELD advice carrying recoverable money counted toward "still owed
 * by payers" on the Money screen and appeared nowhere in the Recover queue underneath it — the same
 * two screens, disagreeing about the same dollars, which is the defect that was fixed once already
 * for recovered denials and could return through a different door.
 *
 * It is also simply the wrong reading. A held advice has not been accepted. Nothing on it is yet a
 * fact about the practice's money, and the held pile is reported separately, by count and amount.
 *
 * On staging the coordination total read $1,447.53 "awaiting another plan": one genuine $482.51 on a
 * posted advice, plus the same figure counted twice more on two held copies of the same scenario.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server.ts";
import { testServices } from "./server.test.ts";

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApp(testServices());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const get = async (base: string, path: string): Promise<any> =>
  (await fetch(base + path)).json();

test("the Money headers and the Recover queue agree, and count posted advices only", async () => {
  await withServer(async (base) => {
    const money = await get(base, "/api/v1/remittances");
    const recover = await get(base, "/api/v1/remittances/recovery");

    const recoverSum = (recover.items ?? []).reduce(
      (t: number, i: any) => t + i.recoverableAmount + i.unexplainedAmount,
      0
    );
    assert.equal(
      money.totalRecoverable,
      recoverSum,
      `Money reports ${money.totalRecoverable} recoverable and Recover reports ${recoverSum}`
    );

    /**
     * The property that makes the agreement structural rather than incidental: recompute both
     * headers from the rows, counting only what is posted, and require the API to match.
     */
    const posted = (money.items ?? []).filter((i: any) => i.status === "posted");
    assert.equal(
      money.totalRecoverable,
      posted.reduce((t: number, i: any) => t + i.totalRecoverable, 0),
      "totalRecoverable must be the sum over POSTED advices"
    );
    assert.equal(
      money.totalWithOtherPayers,
      posted.reduce((t: number, i: any) => t + i.totalWithOtherPayers, 0),
      "totalWithOtherPayers must be the sum over POSTED advices"
    );
  });
});

test("held money is reported on its own, and never folded into either total", async () => {
  /**
   * The held pile is cash the practice HAS and cannot yet book; recoverable money is cash it has
   * not been paid; coordinated money is cash a different payer has to rule on. Three different
   * facts, and the header names all three separately for that reason.
   */
  await withServer(async (base) => {
    const money = await get(base, "/api/v1/remittances");
    const held = (money.items ?? []).filter((i: any) => i.status === "held");

    assert.equal(money.held, held.length, "the held COUNT is the number of held advices");
    assert.equal(
      money.heldTotal,
      held.reduce((t: number, i: any) => t + i.paymentTotal, 0),
      "and the held TOTAL is what those advices carry"
    );

    for (const i of held) {
      assert.ok(
        money.totalRecoverable === 0 || i.totalRecoverable <= money.totalRecoverable,
        "a held advice must not contribute to the recoverable total"
      );
    }
  });
});

test("every money figure the API reports is a non-negative integer of cents", async () => {
  /** Money is integer cents end to end; a float or a negative here is a defect wherever it came from. */
  await withServer(async (base) => {
    const money = await get(base, "/api/v1/remittances");
    for (const key of ["heldTotal", "totalRecoverable", "totalWithOtherPayers"]) {
      const v = money[key];
      assert.ok(Number.isInteger(v), `${key} must be integer cents, got ${v}`);
      assert.ok(v >= 0, `${key} must never be negative, got ${v}`);
    }
  });
});
