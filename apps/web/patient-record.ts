/**
 * The Unified Patient Financial Record (M14 deliverable 4) — one human, assembled.
 *
 * ── WHAT THIS IS ───────────────────────────────────────────────────────────────────────────────
 * Node **B** of the unified RCM workflow diagram: the `("Unified Patient Financial Record")` with
 * `-.same record.->` edges to claim creation and to posting. It is the diagram's structural centre,
 * and until M14 it was a table nothing wrote. Deliverables 1–3 made it real in the data; this is the
 * screen that makes it real to a person.
 *
 * Everything the practice knows about one patient, in one place: who they are, which plans they hold,
 * every coverage check and what it quoted them, every claim and what the payer did with it, every
 * payment, every denial and the appeals fought over it, and the balance they are actually left with —
 * with a single chronological spine tying the lot together.
 *
 * ── WHY IT IS COMPOSED HERE, NOT PROJECTED ─────────────────────────────────────────────────────
 * The same reasoning as `today.ts`, and it is worth repeating because the alternative is tempting.
 * A materialised `patient_timeline` table fed by domain events would have to be told about every
 * correction, every void, every reopened appeal as reliably as it is told about the creations — and
 * a patient record that disagrees with the claim it describes is worse than no patient record at
 * all, because this is the screen a practice quotes when a patient disputes a bill.
 *
 * Composing from each module's own history is both simpler and strictly more correct: each context
 * is the authority on what its own facts mean, and the answer cannot go stale.
 *
 * ── WHAT IT COSTS, STATED RATHER THAN GLOSSED ──────────────────────────────────────────────────
 * Ten indexed, practice-scoped queries per load — two for the patient and their member IDs, then a
 * `list` and a `history` from each of the four contexts — issued in **two waves**, because the only
 * dependency in the whole assembly is that denials are reached through the patient's claims.
 *
 * The `list`/`history` pairs read the same rows twice. A module's worklist row and its chronology
 * are different projections of one aggregate and neither is derivable from the other, so collapsing
 * them would mean a combined method on every service: more surface on four modules to save four
 * indexed lookups on one screen. That is the wrong trade at the scale this serves (one practice,
 * hundreds of patients, every query hitting an index migration 0016 added). Worth revisiting if this
 * screen is ever loaded in a loop; it is not today.
 *
 * ── HOW THE FIVE CONTEXTS ARE REACHED, AND WHY IT IS TWO HOPS ──────────────────────────────────
 * No module may read another's tables, so the join is done here, in the one place permitted to know
 * every context exists:
 *
 *   patient  ──(coverages)──▶  member IDs  ──▶  verifications, claims, ledger
 *                                  claims  ──▶  denials  ──▶  appeals
 *
 * The member ID is the identity the money already carries from a verification all the way to the
 * payer's advice; `coverages` is where it was tied to a person (M14 part 1). Denials hang off claims
 * rather than off the patient because that is the relationship they actually have — a payer denies a
 * claim line — and `idx_denials_claim` has indexed it since migration 0008.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────────────────────
 * The security audit trail (`audit_events`). It answers a different question for different people —
 * who looked at and changed this record — is read under `audit.read`, and lives on the Ops screen.
 * Putting it here would either leak access records to everyone who can open a patient, or bury the
 * clinical and financial story under them. The BUSINESS history below is assembled from facts the
 * aggregates themselves carry, and every one of them is already visible to a caller with
 * `patients.read`.
 *
 * Nothing here is auto-delivered to a patient. This is a screen a person reads, and the statement
 * lines on it are written to be read ALOUD — the human-in-the-loop doctrine, unchanged.
 */
import { orderHistory, type HistoryEntry } from "@mermaid/shared";
import type { PatientRecord, VerificationListItem } from "@mermaid/verification";
import type { ClaimListItem } from "@mermaid/claims";
import { ADJUDICATED_STATUSES } from "@mermaid/claims";
import { DISPUTED_DENIAL_STATUSES } from "@mermaid/denials-appeals";
import type { DenialListItem } from "@mermaid/denials-appeals";
import type { PatientStatement } from "@mermaid/patient-ledger";
import type { Services } from "./wiring.ts";

/** One plan this patient is known to hold, as far as the practice's own records show. */
export interface PatientCoverage {
  memberId: string;
  /** The payer's display name from the most recent verification or claim under this member ID. */
  payerName: string | null;
  /** When this member ID was last seen on a verification or a claim. */
  lastSeenAt: string | null;
  /** How many times coverage has been checked under this ID. */
  verificationCount: number;
  /** How many claims have been filed under it — zero means checked but never billed. */
  claimCount: number;
}

/**
 * The money, end to end, for one person.
 *
 * The payer's half and the patient's half are reported SEPARATELY and never blended — the same
 * decision the practice report makes, for the same reason: a payer that has adjudicated will pay,
 * while a patient balance decays with age, and one combined number hides the half a practice can
 * actually influence.
 */
/**
 * Money that has actually moved on this patient. Cash, and only cash.
 *
 * ── WHY `recovered` IS NOT IN HERE ANY MORE (F-9) ──────────────────────────────────────────────
 * It used to sit between `denied` and `chargedToPatient`, and it was two different mistakes at once.
 *
 * Before F-2 it was set the moment a person recorded a won appeal, so a block of cash figures
 * carried one that was a workflow outcome — the patient record reported $1,125.00 "recovered" beside
 * $21.49 actually collected, and an owner reading it would reasonably conclude the money had come in.
 *
 * F-2 made it cash, which fixed the lie and left a subtler one: recovered cash arrives as a posting,
 * so it is ALREADY counted in `paidByPayers`. Two overlapping figures side by side in a column that
 * otherwise adds up invites exactly the addition that double-counts them.
 *
 * So the cash block holds only cash, each figure independent of its neighbours, and everything about
 * the recovery WORKFLOW moved to `recovery` below — where the one cash figure it carries is labelled
 * as a subset rather than an addition.
 */
export interface PatientTotals {
  /** What the practice billed payers across every claim. */
  billed: number;
  /** What the estimates said the plans would pay. */
  expectedFromPayers: number;
  /** What the payers actually paid, across every posting. */
  paidByPayers: number;
  /** Still expected from payers on open claims. */
  outstandingFromPayers: number;
  /** Everything ever charged to the patient themselves. */
  chargedToPatient: number;
  /** What the patient has paid. */
  paidByPatient: number;
  /** Adjusted or written off — money the practice chose not to collect from them. */
  forgiven: number;
  /** What the patient owes right now. The number a person is asked for at the desk. */
  balance: number;
  /**
   * Money on this patient's claims that a SECOND plan has not ruled on yet (M8).
   *
   * ── WHY A PATIENT RECORD HAS TO CARRY IT ──────────────────────────────────────────────────────
   * The ledger correctly refuses to bill a balance under coordination, so `balance` is zero — and
   * the record then said "Nothing owed" beside a claim with $482.51 still with a secondary. That is
   * the one sentence this screen must never get wrong: it is read out at the desk, and it tells a
   * patient a question is closed while the answer is still being decided.
   *
   * Kept OUT of `balance` deliberately. It is not the patient's money yet, and folding it in would
   * bill them for a secondary payer's share. It is reported alongside so the screen can say
   * "nothing owed *yet*" and mean it.
   */
  coordinationPending: number;
  /** The recovery workflow, kept apart from the cash above. */
  recovery: PatientRecoveryTotals;
  /** How close the practice's quote came to what this patient was actually charged. */
  quote: PatientQuoteAccuracy;
}

/**
 * What this patient was TOLD they would owe, against what they were charged.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 * The estimate quotes a patient a figure before treatment. The payer then decides, and the ledger
 * charges what the payer assigned. Nothing compared the two — `expectedPatientPays` was stored,
 * displayed and scrub-validated, and never once measured against what the person actually owed.
 *
 * F-7 built exactly this for the PAYER side and its message tells a biller, in as many words, to
 * "check what they were told before billing the difference". There was no way to check. The figure
 * was on a verification from three weeks ago and nobody was going to open it.
 *
 * The patient side matters more than the payer side, for a reason that has nothing to do with the
 * amounts. An insurance variance is a practice problem — chase the payer. A quote variance is a
 * TRUST problem: somebody was given a number, made a decision about their care with it, and got a
 * different bill. A practice that can see it can lead the conversation; one that cannot is told
 * about it by the patient.
 *
 * ── ONLY ADJUDICATED CLAIMS ────────────────────────────────────────────────────────────────────
 * A claim the payer has not ruled on has a quote and no answer, so including it would report every
 * unfiled claim as a variance the size of its own estimate. Unknown is not a discrepancy.
 */
export interface PatientQuoteAccuracy {
  /** What the estimates promised this patient across claims the payer has since ruled on. */
  quoted: number;
  /** What the payer actually assigned them on those same claims. */
  assigned: number;
  /**
   * `assigned − quoted`. Positive means the patient owes MORE than they were told, which is the
   * direction that produces the phone call.
   */
  variance: number;
  /** How many adjudicated claims the comparison covers. Zero means there is nothing to compare yet. */
  claims: number;
}

/**
 * What payers withheld on this patient and how far the practice has got with it.
 *
 * These are three different states of the same money and they never overlap, so a reader can add
 * them without double-counting: `denied` is withheld and unresolved, `awardOutstanding` is agreed
 * and unpaid, and `recoveredCash` has arrived.
 */
export interface PatientRecoveryTotals {
  /**
   * Withheld by a payer, and nobody has yet got the payer to agree otherwise.
   *
   * Excludes awards: once a payer agrees to pay on appeal the money is no longer disputed, it is
   * owed, and it is reported as `awardOutstanding` instead. Counting it in both would show the
   * practice chasing the same dollar twice.
   */
  denied: number;
  /** What payers have agreed to pay on appeal. A decision, not money in the bank. */
  awarded: number;
  /** Agreed and not yet arrived — the receivable a won appeal creates. */
  awardOutstanding: number;
  /**
   * How much of the award has actually been received and posted.
   *
   * A SUBSET of `paidByPayers`, not an addition to it: this cash arrived as a posting like any
   * other. Stated here so the recovery story is complete in one place, and named `recoveredCash` so
   * nothing reads it as a second pot of money.
   */
  recoveredCash: number;
}

export interface PatientRecordView {
  patient: PatientRecord;
  coverages: PatientCoverage[];
  verifications: VerificationListItem[];
  claims: ClaimListItem[];
  denials: DenialListItem[];
  /**
   * The ledger, unified across every member ID this person holds.
   *
   * Null when they have no financial history — a patient the practice has verified but never billed
   * is a normal state, not an empty one, and the screen says so rather than showing a $0.00 account.
   */
  ledger: PatientStatement | null;
  totals: PatientTotals;
  /** The chronological spine: every context's history, interleaved, oldest first. */
  timeline: HistoryEntry[];
  /**
   * How this record was assembled — the member IDs it resolved through and what each source
   * contributed. Shown on the screen because a unified number that cannot be traced back to its
   * accounts is exactly the number a patient will dispute.
   */
  provenance: {
    memberIds: string[];
    verificationCount: number;
    claimCount: number;
    denialCount: number;
    ledgerEntryCount: number;
  };
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

/**
 * Assemble one patient's record.
 *
 * Runs inside the caller's practice-scoped transaction, so every underlying query is RLS-scoped and
 * a patient id from another tenant simply does not resolve. Returns null when the patient does not
 * exist *for this practice* — which is the same answer, and deliberately indistinguishable from,
 * "does not exist at all".
 */
export async function buildPatientRecord(
  services: Services,
  patientId: string,
  now: Date = new Date()
): Promise<PatientRecordView | null> {
  const patient = await services.patients.findById(patientId);
  if (!patient) return null;

  /**
   * Every member ID this person holds. This is the join key for everything below, and it is read
   * once — a second read could disagree with the first if a verification landed in between, and a
   * record whose halves were assembled from different views of the same person is worse than one
   * assembled a moment later.
   */
  const memberIds = await services.patients.memberIdsFor(patientId);
  const scope = { patientId, memberIds };
  const ledgerScope = { patientId, patientKeys: memberIds };

  /**
   * Awaited in sequence, and the "two waves" this used to describe were never real.
   *
   * ── WHY `Promise.all` BOUGHT NOTHING HERE ──────────────────────────────────────────────────────
   * This ran eight reads as two `Promise.all` waves, on the stated reasoning that the screen should
   * cost the longest of two waves rather than the sum of eight round trips. That reasoning assumes
   * eight connections. There is ONE: `withPractice` checks a single client out of the pool and every
   * repository in the request reads it back out of `AsyncLocalStorage`, which is precisely what
   * makes the tenant context and the outbox's atomicity work.
   *
   * node-postgres serialises queries queued on one client, so the results were always correct — the
   * concurrency simply did not exist, and the driver says so out loud: *"Calling client.query() when
   * the client is already executing a query is deprecated and will be removed in pg@9.0."* That
   * warning is on every live-database run today, and on pg@9 these call sites stop working.
   *
   * So this is sequential now: identical cost, no deprecated call, and a shape that no longer claims
   * a parallelism the architecture cannot give it. Real parallelism here would mean eight
   * connections and eight transactions, which would abandon the single-transaction guarantee this
   * request is built on — a far worse trade than eight sequential indexed reads on one screen.
   *
   * The DEPENDENCY the old comment named is still real and still ordered: denials are reached
   * through the patient's claims, so they cannot be read until the claim ids are known.
   */
  const verifications = await services.verification.list({ patient: scope }, now);
  /**
   * ── CLAIMS FOLLOW THE VERIFICATION, NOT THE POLICY (B2) ────────────────────────────────────────
   *
   * This asked for `{ memberIds }`, and a member ID is a POLICY: a dental plan issues one to the
   * subscriber and covers the family under it. So a parent and child on one subscriber id resolved
   * to the same key, and each chart carried the other's claims — and the denials hanging off them,
   * because those are reached through the claim ids this produces.
   *
   * `claims` has no `patient_id` and deliberately does not want one; the mapping it would copy from
   * `coverages` is the one that is ambiguous here. The authoritative chain already exists:
   * `verification_id` is NOT NULL and unique per claim, and `verifications.patient_id` is resolved
   * on name and date of birth rather than on the policy. So the verifications read immediately
   * above — already scoped to this person, legacy rows included — ARE the answer, and their ids are
   * the key.
   *
   * `verificationHistory` deliberately keeps `scope`: it asks the verification module about
   * verifications, which is its own question and its own correct key.
   */
  const verificationIds = verifications.map((v) => v.id);
  const claims = await services.claims.list({ verificationIds }, now);
  const ledger = await services.ledger.unifiedStatement(ledgerScope, now);
  const verificationHistory = await services.verification.history({ patient: scope });
  const claimHistory = await services.claims.history({ verificationIds });
  const ledgerHistory = await services.ledger.history({ patient: ledgerScope });

  const claimIds = claims.map((c) => c.id);
  const denials = await services.denials.list({ claimIds }, now);
  const denialHistory = await services.denials.history({ claimIds });

  const timeline = orderHistory([
    ...verificationHistory,
    ...claimHistory,
    ...denialHistory,
    ...ledgerHistory,
  ]);

  return {
    patient,
    coverages: buildCoverages(memberIds, verifications, claims),
    verifications,
    claims,
    denials,
    ledger,
    totals: buildTotals(claims, denials, ledger),
    timeline,
    provenance: {
      memberIds,
      verificationCount: verifications.length,
      claimCount: claims.length,
      denialCount: denials.length,
      ledgerEntryCount: ledger?.entries.length ?? 0,
    },
  };
}

/**
 * What plans this person holds, derived rather than stored.
 *
 * `coverages` records the member ID and the person, and nothing else — `linkCoverage` writes exactly
 * those two columns, because they are the only two facts verification can honestly assert at that
 * moment. The payer, and whether anything was ever billed under the ID, are both knowable from the
 * verifications and claims that used it, so they are read from there rather than denormalised into a
 * row that would then need keeping in step.
 *
 * A member ID with no verification and no claim still appears, with nulls. That is a real state — a
 * coverage recorded by a verification that has since been deleted, or a plan added out of band — and
 * hiding it would make the record quietly incomplete.
 */
function buildCoverages(
  memberIds: string[],
  verifications: VerificationListItem[],
  claims: ClaimListItem[]
): PatientCoverage[] {
  return memberIds.map((memberId) => {
    // Newest first: a plan that was renamed should read under its current name.
    const mine = verifications
      .filter((v) => v.memberId === memberId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const myClaims = claims
      .filter((c) => c.memberId === memberId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const latestVerification = mine[0];
    const latestClaim = myClaims[0];
    const lastSeen = [latestVerification?.createdAt, latestClaim?.createdAt]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);

    return {
      memberId,
      payerName: latestVerification?.payerName ?? latestClaim?.payerName ?? null,
      lastSeenAt: lastSeen ?? null,
      verificationCount: mine.length,
      claimCount: myClaims.length,
    };
  });
}

/**
 * The money, from both directions.
 *
 * Every figure is read from a module's own view — nothing here recomputes what a payer paid or what
 * a patient owes. That is the same rule the claim applies to the estimate it inherited, applied one
 * level up: this screen is an assembly, never a second opinion.
 */
/**
 * What this patient was told they would owe, against what the payer assigned.
 *
 * Restricted to claims the payer has RULED on. A claim still in flight has a quote and no answer, so
 * counting it would report every unfiled claim as a variance the size of its own estimate — unknown
 * is not a discrepancy, which is the same rule the rest of this system applies to every other
 * missing payer answer.
 *
 * The assigned figure comes from `totalPatientResponsibility` by way of the claim view, never
 * re-derived here: each advice restates the patient's share rather than adding to it, and summing
 * two advices that each say $482.51 would report $965.02. That is the double-bill L-2 fixed, and
 * re-deriving it in a second place is how it would come back.
 */
function quoteAccuracy(claims: ClaimListItem[]): PatientQuoteAccuracy {
  /**
   * ── A CLAIM UNDER COORDINATION HAS NOT PRODUCED AN ANSWER TO COMPARE AGAINST (M8) ─────────────
   * This measures what a patient was TOLD against what the payer ASSIGNED. A coordinated claim
   * states `patientResponsibility: 0` because a SECOND plan has not ruled yet — so including it
   * records the full quote as error. Kira Demo read "quoted $625.00 … assigned $0.00 — $625.00 less
   * than they were told", which is not a cautious estimate, it is an unanswered question counted as
   * a perfect outcome for the patient.
   *
   * The claim is excluded rather than treated as zero. It rejoins the measurement the moment the
   * secondary's remittance posts and the coordination clears, which is when there is finally
   * something to measure.
   */
  const ruled = claims.filter(
    (c) => ADJUDICATED_STATUSES.includes(c.status) && (c.coordinationPending ?? 0) === 0
  );
  const quoted = sum(ruled.map((c) => c.expectedPatientPays));
  const assigned = sum(ruled.map((c) => c.patientResponsibility));
  return { quoted, assigned, variance: assigned - quoted, claims: ruled.length };
}

export function buildTotals(
  claims: ClaimListItem[],
  denials: DenialListItem[],
  ledger: PatientStatement | null
): PatientTotals {
  // A voided claim was withdrawn: it was never really billed, and counting it would overstate what
  // the practice asked payers for on this patient.
  const live = claims.filter((c) => c.status !== "void");

  return {
    billed: sum(live.map((c) => c.totalFee)),
    expectedFromPayers: sum(live.map((c) => c.expectedInsurancePays)),
    paidByPayers: sum(live.map((c) => c.paidAmount)),
    outstandingFromPayers: sum(live.map((c) => c.outstanding)),
    quote: quoteAccuracy(live),
    chargedToPatient: ledger?.account.charged ?? 0,
    paidByPatient: ledger?.account.paid ?? 0,
    forgiven: ledger?.account.forgiven ?? 0,
    balance: ledger?.account.balance ?? 0,
    /**
     * Summed across claims rather than selected, because these are DIFFERENT claims — each one
     * contributes its own pending coordination, and a patient can have two.
     */
    coordinationPending: sum(live.map((c) => c.coordinationPending ?? 0)),
    recovery: {
      /**
       * Withheld and still disputed. A denial that is written off or moved to the patient has an
       * owner, and one the payer has AGREED to pay is owed rather than disputed — both are excluded
       * so the three recovery figures partition the money instead of overlapping it.
       */
      denied: sum(
        denials.filter((d) => DISPUTED_DENIAL_STATUSES.includes(d.status)).map((d) => d.deniedAmount)
      ),
      awarded: sum(denials.map((d) => d.awardedAmount ?? 0)),
      awardOutstanding: sum(denials.map((d) => d.awardOutstanding ?? 0)),
      /** Cash. Already inside `paidByPayers` above — see the note on the type. */
      recoveredCash: sum(denials.map((d) => d.awardSettledAmount ?? d.recoveredAmount ?? 0)),
    },
  };
}
