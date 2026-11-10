-- 0033 — a held remittance can be REJECTED, not only released.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────────────────
-- `remittances.status` allowed exactly 'held' and 'posted', so a held advice had one exit, release,
-- and release posts. A duplicate of money already on the books, or a clearinghouse TEST file
-- (ISA15 = T), is correctly held by the safety gate — and could then leave the held pile only by
-- being posted, which is the one outcome that must never happen to either. Found on staging: two
-- copies of an already-posted $799.99 Cigna payment sat held for weeks; the gate's own remediation
-- text said "reject the other", and there was no reject.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────────────────────────
-- One more allowed value. The row, its raw 835, its trace and its postings projection all stay:
-- the payer did send the file, and "did this payer pay twice?" must remain answerable from the
-- books. Who rejected it, when, why, and as what (duplicate / test file) lives in the versioned
-- `record` (v3) and in the append-only `audit_events` row written in the same transaction.
--
-- Nothing downstream counts a rejected advice as money: every money reading selects
-- status = 'posted', and the held pile — and the readiness check built on it — selects 'held'.
--
-- ── SAFE TO APPLY ONLINE ────────────────────────────────────────────────────────────────────────
-- Widening a CHECK constraint touches no existing row. Every current row is 'held' or 'posted' and
-- satisfies the new constraint, so the ADD validates without rewriting anything. The DROP and ADD
-- run in the runner's single transaction, so there is no instant at which status is unconstrained.
-- The constraint name is the one Postgres generated for 0006's inline CHECK (verified on staging).

ALTER TABLE remittances DROP CONSTRAINT remittances_status_check;
ALTER TABLE remittances
  ADD CONSTRAINT remittances_status_check CHECK (status IN ('held', 'posted', 'rejected'));
