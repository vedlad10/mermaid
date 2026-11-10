/**
 * Patient identity — turning "the person in the chair" into one stable record.
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────────────────────────
 * The unified RCM workflow's central node is `("Unified Patient Financial Record")`, with
 * `-.same record.->` edges to claim creation and to posting. It is the diagram's structural centre,
 * and until now it did not exist: `patients` was created by migration 0005 and written only by a
 * test fixture, while the ledger keyed accounts on the member ID the claim was filed under.
 *
 * That interim was the right call — inventing a second identity would have been worse than using
 * the one the money already carries (`modules/patient-ledger/README.md`) — but it has a ceiling.
 * One human with two coverages is two unrelated accounts, and a member-ID change orphans history.
 *
 * ── WHY chart_id IS DERIVED, NOT ALLOCATED ─────────────────────────────────────────────────────
 * `patients` already carries `UNIQUE (practice_id, chart_id)` from migration 0005, modelled on the
 * roadmap's schema where `chart_id` comes from the practice's existing PMS. Mermaid has no PMS to
 * ask, so a chart id has to come from somewhere.
 *
 * Deriving it deterministically from the natural key a dental practice actually uses — surname,
 * given name, date of birth — makes the EXISTING unique constraint do the identity resolution, with
 * no new index, no new migration and no allocation step that could hand the same person two ids on
 * a retry. Upsert becomes `ON CONFLICT (practice_id, chart_id) DO UPDATE`, which is idempotent by
 * construction: the same person verified twice resolves to the same row.
 *
 * ── THE LIMIT OF THIS, STATED PLAINLY ──────────────────────────────────────────────────────────
 * Two different people with the same name and the same date of birth collide into one record. In a
 * single practice that is rare but not impossible (a parent and child sharing a first name do NOT
 * collide — the dates differ — but two unrelated J. Smiths born the same day would).
 *
 * This is a deliberate, bounded trade: the alternative at this stage is a manual merge/unmerge UI
 * nobody has asked for. The resolution path is already open — when a real PMS chart id arrives it
 * becomes the id and this derivation becomes the fallback for practices without one, which is
 * exactly the direction migration 0005 modelled. Recorded here so the limit is a known one rather
 * than a surprise.
 */
import { createHash } from "node:crypto";

/** The fields a dental practice actually identifies a person by. */
export interface PatientIdentity {
  firstName: string;
  lastName: string;
  /** ISO date; only the date part is significant. */
  dateOfBirth: string;
}

/**
 * Normalise before hashing, so trivial differences in how a name was typed do not create a second
 * person: case, surrounding whitespace, and internal runs of whitespace are all insignificant.
 *
 * Deliberately NOT normalising accents or punctuation — "O'Brien" and "OBrien" are different
 * spellings that a human should reconcile, and silently merging them would be the identity system
 * making a clinical-record decision on its own.
 */
const norm = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * A stable chart id for this identity within a practice.
 *
 * Prefixed and short-hashed rather than raw: it appears on screens and in support conversations, so
 * it needs to be sayable, and it must not be reversible into a patient's name and birth date — a
 * chart id is quoted in places a name should not be.
 */
export function deriveChartId(identity: PatientIdentity): string {
  const key = [norm(identity.lastName), norm(identity.firstName), identity.dateOfBirth.slice(0, 10)].join("|");
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 10).toUpperCase();
  return `MRM-${digest}`;
}

/** True when two identities resolve to the same person. Exposed for tests and for a future merge UI. */
export const sameIdentity = (a: PatientIdentity, b: PatientIdentity): boolean =>
  deriveChartId(a) === deriveChartId(b);

/**
 * Fold a member ID for COMPARISON only — never for what is stored or put on the wire.
 *
 * The same folding `pipeline.ts` and `detectExceptions` already apply, and for the reason
 * `pipeline.ts` states outright: "a mismatch flag that fires on `ABC-123` versus `abc123` is a flag
 * staff learn to ignore". Payers and cards print one identifier in both forms, and the front desk
 * types whichever is in front of them.
 */
export const foldMemberId = (value: string): string => value.replace(/[\s-]/g, "").toUpperCase();

/** One coverage already on file, as the collision check needs to see it. */
export interface CoverageOnFile {
  memberId: string;
  /** Mermaid's payer slug, or null when the stored row names no resolvable payer. */
  payerKey: string | null;
}

/**
 * Is this incoming coverage evidence that the chart we just resolved belongs to somebody else?
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT (M14) ────────────────────────────────────────
 * `deriveChartId` resolves on surname + given name + date of birth, and the header above states the
 * limit honestly: two unrelated people sharing all three collide into one record. This does NOT
 * change that resolution — the chart id derivation is untouched and nothing is re-keyed. It adds
 * the one question that can tell the dangerous case apart from the ordinary one, so a human is
 * asked instead of the merge happening in silence.
 *
 * The financial consequence of the silent merge is what makes this worth a critical flag:
 * `unifiedStatement` merges the two people's ledgers, so one patient's statement carries another's
 * balance and a payment from one reduces the other's. That is a billing dispute and a PHI
 * disclosure in the same document.
 *
 * ── THE DISCRIMINATOR ──────────────────────────────────────────────────────────────────────────
 * A new member ID against a chart we already hold is completely ordinary — it is what a job change
 * looks like. What is NOT ordinary is the same payer issuing a second, different member ID for what
 * claims to be the same person: payers do not routinely re-number a member mid-plan, and two
 * distinct member IDs at one payer for one name and one birth date are far more likely to be two
 * people.
 *
 *   same payer,      different member ID  → COLLISION CANDIDATE. Ask a human.
 *   different payer, different member ID  → an insurance change. Say nothing.
 *   same member ID                        → the same person returning. Say nothing.
 *   payer unknown on either side          → no evidence either way. Say nothing.
 *
 * ── WHY NULL IS NOT A WILDCARD, STATED SEPARATELY BECAUSE IT IS THE EASY MISTAKE ───────────────
 * `coverages.payer_id` has been nullable since migration 0015 and was NEVER WRITTEN until M14, so
 * every coverage row in every existing deployment carries null. If null compared equal to anything,
 * this would flag every returning patient in the entire existing data set on their next visit —
 * turning a safety control into noise on first contact with real data. Null means "we do not know
 * which payer this was", and an unknown can never establish a match.
 *
 * ── AND THE MEMBER IDS ARE COMPARED FOLDED, FOR THE SAME REASON ────────────────────────────────
 * They were compared as typed. The stored id is whatever the front desk entered at a previous
 * check-in and the incoming one is whatever they entered today, so `ABC-12345` on file against
 * `abc12345` today — one person, one policy, one payer — read as two different member IDs and
 * raised a CRITICAL "two different people resolve to one chart" flag on an ordinary returning
 * patient. That is the noise failure this whole check is written to avoid: a control that fires on
 * the routine case is one staff clear by reflex, and then they clear the real one too.
 */
export function detectIdentityCollision(
  onFile: readonly CoverageOnFile[],
  incoming: { memberId: string; payerKey: string | null }
): CoverageOnFile | null {
  const memberId = foldMemberId(incoming.memberId);
  const payerKey = incoming.payerKey?.trim() || null;
  // No payer on the incoming verification is no evidence, exactly as no payer on the stored row is.
  if (!memberId || !payerKey) return null;

  return (
    onFile.find(
      (existing) =>
        existing.payerKey !== null &&
        existing.payerKey === payerKey &&
        foldMemberId(existing.memberId) !== memberId
    ) ?? null
  );
}
