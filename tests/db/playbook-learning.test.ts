/**
 * The learning loop's write path, against a real database.
 *
 * An appeal outcome is the only real-world evidence this system ever receives, and the counts it
 * lands in are load-bearing: `sampleSize` gates `trusted` and weights every posterior rate. The
 * write therefore has to be an atomic observation — two outcomes for the same rule recorded
 * concurrently (the request drain and the background worker both dispatch events) must BOTH land,
 * which absolute read-modify-write counts cannot guarantee.
 *
 * `payer_playbook_rules` is global (no practice, no RLS), so this file cleans up its own rows by
 * their unique test CARC codes rather than through `dropPractices`.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withoutPractice } from "@mermaid/db";
import { PayerProfileService, PgPlaybookRepository, type PlaybookRule } from "@mermaid/payer-profile";
import { dbTest, shutdown } from "./harness.ts";

const TEST_CARCS: string[] = [];
const testCarc = (): string => {
  const code = `T${Math.floor(Math.random() * 1_000_000)}`;
  TEST_CARCS.push(code);
  return code;
};

after(async () => {
  if (TEST_CARCS.length > 0) {
    await withoutPractice(async () => {
      await requireContext().tx.query("DELETE FROM payer_playbook_rules WHERE carc_code = ANY($1::text[])", [
        TEST_CARCS,
      ]);
    });
  }
  await shutdown();
});

/** A repository whose rule reads dawdle, so two writers provably overlap. */
class SlowFindPlaybook extends PgPlaybookRepository {
  override async findRules(carcCode: string): Promise<PlaybookRule[]> {
    const rules = await super.findRules(carcCode);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return rules;
  }
}

test("two concurrent appeal outcomes both land — no observation is ever erased", dbTest, async () => {
  const service = new PayerProfileService(new SlowFindPlaybook());
  const carc = testCarc();

  // Both start with no rule on file, both read during each other's flight, and the rule must end
  // with BOTH observations: 2 samples, 1 win. Under the old absolute-count write, the second commit
  // erased the first and this reads 1 sample.
  await Promise.all([
    service.recordOutcome({ payerId: "test-payer-a", carcCode: carc, cdtCode: "D2750", won: true }),
    service.recordOutcome({ payerId: "test-payer-a", carcCode: carc, cdtCode: "D2750", won: false }),
  ]);

  const rules = await service.listRules("test-payer-a");
  const rule = rules.find((r) => r.carcCode === carc);
  assert.ok(rule, "the payer-specific rule was created");
  assert.equal(rule!.sampleSize, 2, "both outcomes are evidence; losing one misweights every rate");
  assert.equal(rule!.wonCount, 1);
  assert.equal(rule!.trusted, false, "two observations are far below the trust threshold");
});

test("the trust flag flips exactly at the threshold, derived from the store's own count", dbTest, async () => {
  const service = new PayerProfileService(new PgPlaybookRepository());
  const carc = testCarc();

  for (let i = 0; i < 19; i++) {
    const rule = await service.recordOutcome({ payerId: "test-payer-b", carcCode: carc, cdtCode: null, won: true });
    assert.equal(rule.trusted, false, `observation ${i + 1} of 19 must stay provisional`);
  }
  const twentieth = await service.recordOutcome({ payerId: "test-payer-b", carcCode: carc, cdtCode: null, won: true });
  assert.equal(twentieth.sampleSize, 20);
  assert.equal(twentieth.trusted, true, "the twentieth observation earns trust");
});
