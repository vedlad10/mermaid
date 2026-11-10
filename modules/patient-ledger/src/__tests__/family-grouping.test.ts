/**
 * One Money-screen row per PERSON, not per policy (F-4).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * The Money screen grouped ledger entries on `patientKey`, which is the member ID — a POLICY. A
 * dental plan covers a whole family under one subscriber id, so a parent and child sharing
 * `FAM-STG001` collapsed into a single row carrying both balances, labelled with whichever of them
 * the payer had mentioned most recently. Staging showed $1,015.02 owed by "Ada Stagetest" with Kit
 * absent from the screen entirely, when each of them owed $507.51.
 *
 * Two things made it hard to see. `ledger_entries.patient_id` was already correct — only the
 * grouping was wrong — and the patient record screen, which reads by patient, showed the right
 * figures. So the same balance was right on one screen and wrong on another.
 *
 * ── WHAT THESE TESTS PIN ───────────────────────────────────────────────────────────────────────
 * The split itself, and the invariant that makes it safe: regrouping REDISTRIBUTES money and must
 * never create or destroy a cent. Practice-level A/R is asserted identical before and after, which
 * is the check that would have caught a fix that dropped the unattributed entries on the floor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { InMemoryLedgerRepository, PatientLedgerService } from "../index.ts";
import type { LedgerEntry } from "../types.ts";

const NOW = new Date("2026-08-30T12:00:00Z");

/** Ada and Kit are a family: two people, one subscriber policy. */
const ADA = "11111111-1111-4111-8111-111111111111";
const KIT = "22222222-2222-4222-8222-222222222222";
const FAMILY_POLICY = "FAM-STG001";

const entry = (over: Partial<LedgerEntry> & { patientKey: string; amount: number }): LedgerEntry =>
  ({
    id: `e-${Math.abs(over.amount)}-${over.patientId ?? "none"}-${over.occurredAt ?? "x"}`,
    patientName: "Unknown patient",
    kind: "charge",
    occurredAt: "2026-08-01T00:00:00.000Z",
    description: "",
    claimId: null,
    denialId: null,
    sourceRef: null,
    recordedBy: "system",
    patientId: null,
    ...over,
  }) as LedgerEntry;

async function ledgerWith(entries: LedgerEntry[]) {
  const repo = new InMemoryLedgerRepository();
  for (const e of entries) await repo.append(e);
  return { repo, service: new PatientLedgerService(repo) };
}

/** The audited family: both on FAM-STG001, $507.51 each. */
const family = () => [
  entry({ patientKey: FAMILY_POLICY, patientId: ADA, patientName: "Ada Stagetest", amount: cents(507.51), occurredAt: "2026-08-01T00:00:00.000Z" }),
  entry({ patientKey: FAMILY_POLICY, patientId: KIT, patientName: "Kit Stagetest", amount: cents(507.51), occurredAt: "2026-08-02T00:00:00.000Z" }),
];

// ── The split ─────────────────────────────────────────────────────────────────────────────────

test("two people on one policy are two rows, each with their own balance", async () => {
  const { service } = await ledgerWith(family());
  const rows = await service.list(undefined, NOW);

  assert.equal(rows.length, 2, "one row per person — not one row per policy");
  const byName = Object.fromEntries(rows.map((r) => [r.patientName, r]));
  assert.equal(byName["Ada Stagetest"]!.balance, cents(507.51));
  assert.equal(byName["Kit Stagetest"]!.balance, cents(507.51));
  assert.notEqual(
    byName["Ada Stagetest"]!.balance,
    cents(1015.02),
    "the whole family's money under one name is the defect"
  );
});

test("each row carries the person it belongs to", async () => {
  const { service } = await ledgerWith(family());
  const rows = await service.list(undefined, NOW);
  assert.deepEqual(rows.map((r) => r.patientId).sort(), [ADA, KIT].sort());
});

test("the name follows the person, because a group is now one person's own entries", async () => {
  /**
   * `latestName` used to label a merged family with whichever member the payer mentioned last —
   * here Kit, who is later. Once the group is one person, the same function is right by
   * construction: the commingling WAS the naming bug.
   */
  const { service } = await ledgerWith(family());
  const rows = await service.list(undefined, NOW);
  const ada = rows.find((r) => r.patientId === ADA)!;
  assert.equal(ada.patientName, "Ada Stagetest", "not Kit, whose entry is more recent");
});

// ── The invariant that makes the change safe ──────────────────────────────────────────────────

test("regrouping redistributes money and never creates or destroys a cent", async () => {
  const { service, repo } = await ledgerWith(family());
  const total = (await repo.list()).reduce((t, e) => t + e.amount, 0);
  const rows = await service.list(undefined, NOW);
  assert.equal(
    rows.reduce((t, r) => t + r.balance, 0),
    total,
    "the practice's A/R is the same money, split differently"
  );
  assert.equal(total, cents(1015.02));

  const summary = await service.summary(NOW);
  assert.equal(summary.totalOutstanding, total, "and the summary agrees with the rows");
});

// ── Money nobody has identified yet ───────────────────────────────────────────────────────────

test("entries with no patient still appear, grouped by the policy they arrived under", async () => {
  /**
   * `byMemberId` returns null on exactly the family policies this fix is about — a member id is a
   * policy and it cannot name one of several people. That money is real and must stay visible; it
   * simply cannot be split by person until somebody identifies it. Dropping it would hide a balance.
   */
  const { service } = await ledgerWith([
    ...family(),
    entry({ patientKey: "FAM-UNKNOWN", patientId: null, patientName: "Unnamed Family", amount: cents(200) }),
  ]);
  const rows = await service.list(undefined, NOW);
  assert.equal(rows.length, 3);
  const orphan = rows.find((r) => r.patientId === null)!;
  assert.equal(orphan.balance, cents(200));
  assert.equal(orphan.patientKey, "FAM-UNKNOWN");
});

test("two unidentified entries on one policy stay together — that is all we know about them", async () => {
  const { service } = await ledgerWith([
    entry({ patientKey: "FAM-UNKNOWN", patientId: null, patientName: "A", amount: cents(100), occurredAt: "2026-08-01T00:00:00.000Z" }),
    entry({ patientKey: "FAM-UNKNOWN", patientId: null, patientName: "B", amount: cents(150), occurredAt: "2026-08-02T00:00:00.000Z" }),
  ]);
  const rows = await service.list(undefined, NOW);
  assert.equal(rows.length, 1, "grouping them apart would be inventing an identity");
  assert.equal(rows[0]!.balance, cents(250));
});

// ── The filter has to group the same way the display does ─────────────────────────────────────

test("a settled person inside a family that still owes money is not listed as owing", async () => {
  /**
   * The trap the shared `groupKeyFor` exists to close. Kit is square; Ada owes $507.51. Grouped by
   * policy the filter sees one non-zero family and pulls BOTH in, so Kit appears on a screen headed
   * "still owes something" with a zero balance.
   */
  const { service } = await ledgerWith([
    entry({ patientKey: FAMILY_POLICY, patientId: ADA, patientName: "Ada Stagetest", amount: cents(507.51) }),
    entry({ patientKey: FAMILY_POLICY, patientId: KIT, patientName: "Kit Stagetest", amount: cents(300), occurredAt: "2026-08-02T00:00:00.000Z" }),
    entry({ patientKey: FAMILY_POLICY, patientId: KIT, patientName: "Kit Stagetest", kind: "payment", amount: cents(-300), occurredAt: "2026-08-03T00:00:00.000Z" }),
  ]);

  const owing = await service.list({ withBalanceOnly: true }, NOW);
  assert.deepEqual(owing.map((r) => r.patientId), [ADA], "only the person who actually owes");
  assert.equal(owing[0]!.balance, cents(507.51));
});

test("a person who owes money inside a family that nets to zero is still listed", async () => {
  /**
   * The same divergence in the other direction, and the more dangerous one: grouped by policy the
   * family nets to zero, the filter drops it, and a real $400.00 debt disappears from the screen
   * that exists to collect it.
   */
  const { service } = await ledgerWith([
    entry({ patientKey: FAMILY_POLICY, patientId: ADA, patientName: "Ada Stagetest", amount: cents(400) }),
    entry({ patientKey: FAMILY_POLICY, patientId: KIT, patientName: "Kit Stagetest", kind: "payment", amount: cents(-400), occurredAt: "2026-08-02T00:00:00.000Z" }),
  ]);

  const owing = await service.list({ withBalanceOnly: true }, NOW);
  assert.ok(
    owing.some((r) => r.patientId === ADA && r.balance === cents(400)),
    "Ada owes $400.00 whatever her relative paid"
  );
});

// ── The account-level surfaces are deliberately unchanged ─────────────────────────────────────

test("a statement is still per-ACCOUNT, because that is what a payer and a payment address", async () => {
  /**
   * Not an oversight. `statement()` answers "what is on this policy", which is the question a
   * payment posted against a member id is answering. An earlier attempt to unify account and person
   * identity broke thirteen tests and was reverted; this change deliberately touches only the
   * grouping the Money SCREEN uses.
   */
  const { service } = await ledgerWith(family());
  const statement = await service.statement(FAMILY_POLICY, NOW);
  assert.equal(statement!.account.balance, cents(1015.02), "the whole policy, as before");
});
