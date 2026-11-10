/**
 * Payer identification — resolve the raw payer name read off the card to a known payer (id +
 * canonical name) so the EDI adapter can be called.
 *
 * ── THE REGISTRY MOVED INTO THE DATABASE (NEW-08) ────────────────────────────────────────────────
 * This file used to carry the catalog itself: seven rows of slug, name, hand-written regular
 * expression and clearinghouse id, under a comment that called itself a mock "until the Payer
 * Profile module is live on the database". That module has been live, on a `payers` table holding
 * the same payers under the same slugs, since M12 — so the two facts that decide whether a patient
 * can be verified at all (does the card match, and what id routes the request) lived in a source
 * file while the deadlines lived in a table.
 *
 * The cost was not abstract. A practice whose card said "Ameritas" could not verify that patient,
 * could not file that claim, and could not be helped by anyone without a code change and a deploy.
 *
 * ── AND YET THIS IS STILL A PURE FUNCTION ────────────────────────────────────────────────────────
 * The matching runs inside the verification pipeline, which is deterministic by design — the suite
 * asserts that two identical clinics produce identical claims. A step that reached into a database
 * mid-pipeline would make that untestable without one and unreproducible whenever the catalog
 * changed between runs.
 *
 * So the DIRECTORY is a parameter. It is read once, at the edge of a verification, and passed in.
 * `BUILTIN_PAYERS` below is the fallback for the database-free demo and for callers that have no
 * catalog to offer; it is derived from the same seed the database is seeded from, so the two cannot
 * drift into disagreeing about what a card says.
 */
import type { Scored } from "@mermaid/shared";
import type { NetworkParticipation } from "@mermaid/edi";
import { PAYER_CATALOG, normalizePayerName, type PayerConnector } from "@mermaid/payer-profile";

export type { PayerConnector } from "@mermaid/payer-profile";

/** The catalog as the matcher reads it: every payer, with every spelling a card may use. */
export type PayerDirectory = readonly PayerConnector[];

export interface IdentifiedPayer {
  payerId: string;
  payerName: string;
  /**
   * The payer's id **at the clearinghouse** — a different namespace from Mermaid's slug.
   *
   * ── WHY BOTH IDS EXIST ─────────────────────────────────────────────────────────────────────
   * `payerId` is Mermaid's own stable slug: it keys the playbook, the payer scorecard and every
   * learned overturn rate, and it must not change when a clearinghouse is swapped. A clearinghouse
   * has its own registry with its own ids (Stedi calls Aetna `60054`), and those ids are significant
   * to the leading zero.
   *
   * Sending the slug to a clearinghouse produces a 271 with no benefit segments — which the parser
   * correctly refuses, so nothing unsafe happens, but no check can ever succeed. Undefined here
   * means "this deployment has no clearinghouse id for this payer", and the adapter says so plainly
   * rather than guessing.
   */
  clearinghouseId?: string;
}

/**
 * The catalog a caller gets when it offers none — the database-free demo, and every unit test that
 * is about something else.
 *
 * Derived from `PAYER_CATALOG`, the same seed `PayerProfileService.ensurePayers` writes, so the
 * fallback and the database cannot come to disagree about what a card says. It is a FALLBACK and
 * not a default in the operational sense: a deployment with a database always matches against the
 * table, including the payers an administrator added after the last deploy.
 */
export const BUILTIN_PAYERS: PayerDirectory = PAYER_CATALOG.map((p) => ({
  payerId: p.slug,
  payerName: p.name,
  ...(p.clearinghouseId ? { clearinghouseId: p.clearinghouseId } : {}),
  aliases: p.aliases.map((a) => ({ alias: a.alias, kind: a.kind ?? ("contains" as const) })),
}));

/**
 * Does `alias` match this card's payer name?
 *
 * Both sides are normalised first — lower case, every run of non-alphanumerics collapsed to one
 * space — so "Delta-Dental", "DELTA  DENTAL" and "delta dental" are one thing. That normalisation is
 * `normalizePayerName`, shared with the write path, so an alias cannot be stored in a form the
 * matcher can never produce.
 *
 * `word` bounds the alias to whole words. The array this replaces bounded `\bmoda\b` for exactly
 * this reason: identifying the WRONG payer sends a patient's eligibility request to a company that
 * has never heard of them, and the error surfaces as "not covered" — which reads like an answer
 * rather than a mistake.
 */
function aliasMatches(alias: { alias: string; kind: "contains" | "word" }, normalizedName: string): boolean {
  if (!alias.alias) return false;
  if (alias.kind === "word") {
    // Padded on both sides so a whole-word alias matches only at token boundaries, without building
    // a regular expression out of a value somebody typed into a form.
    return ` ${normalizedName} `.includes(` ${alias.alias} `);
  }
  return normalizedName.includes(alias.alias);
}

/**
 * The clearinghouse whose namespace `clearinghouseId` belongs to.
 *
 * Named rather than left implicit because the UI has to be able to say *whose* payer id `60054` is.
 * "Payer ID 60054" on a screen is meaningless — every clearinghouse has its own registry and the
 * same payer has a different number in each — so the namespace is part of the value, not decoration.
 */
export const CLEARINGHOUSE_NAME = "Stedi";

/**
 * Look up a payer's clearinghouse id by Mermaid's own slug. Pure read of the directory it is given.
 *
 * Exists for provenance display: a completed verification carries `payerId`, and a screen showing
 * where its benefits came from needs the id that actually went out on the wire. Deriving it here
 * rather than storing it on the record keeps this a read of the same single source of truth the
 * pipeline used — a copy on the record could disagree with the catalog after an id is corrected,
 * and the screen would then explain a request that was never made.
 */
export function clearinghouseIdFor(
  payerId: string | null,
  directory: PayerDirectory = BUILTIN_PAYERS
): string | null {
  if (!payerId) return null;
  return directory.find((p) => p.payerId === payerId)?.clearinghouseId ?? null;
}

/**
 * ── V3: whether this practice is in a payer's network ──────────────────────────────────────────
 *
 * A 271 quotes both columns; which one applies to the patient in the chair depends on a contract
 * between the practice and the payer that the payer's response says nothing about. Before this, the
 * parser always preferred the in-network figure, which is right for the in-network practice this was
 * built for and wrong — quietly, in the practice's disfavour — for anyone else. See
 * `NetworkParticipation` in `platform/edi/adapter.ts` for what reading the wrong column costs.
 *
 * ── WHY IT IS CONFIGURED, AND WHY THE DEFAULT IS `unknown` ─────────────────────────────────────
 * Participation cannot be derived from anything Mermaid holds. It is not in the 271, not in the
 * claim, and not inferable from payment history without a body of adjudicated claims this system
 * does not have on day one. So it is stated by the practice or it is not known.
 *
 * `unknown` is the default and is a real answer, not a placeholder for in-network. It preserves the
 * existing behaviour exactly, so no deployment's quotes move until someone says something true —
 * a config change is the only thing that can move a quote to the other column.
 *
 * ── THE LIMIT, STATED PLAINLY ──────────────────────────────────────────────────────────────────
 * Pilot scope is one practice, so this reads from environment configuration, exactly as the billing
 * provider identity does. Multi-practice production must read it from the `practices` row for the
 * authenticated session — one clinic in Delta's network and another out of it cannot share a process
 * setting. That is a real migration, not a rename, and it is deliberately not attempted here.
 */
export type { NetworkParticipation } from "@mermaid/edi";

/**
 * Parse the practice's participation map — `"delta-dental:in,cigna-dental:out"`.
 *
 * Unparseable entries are IGNORED rather than defaulted, and the payer stays `unknown`. A typo in a
 * config string must not silently move a whole payer's quotes to the other column; not knowing is
 * the safe state, and it is the state the system already behaves correctly in.
 */
export function parseParticipationMap(raw: string | undefined): Map<string, NetworkParticipation> {
  const map = new Map<string, NetworkParticipation>();
  for (const entry of (raw ?? "").split(",")) {
    const [id, value] = entry.split(":").map((s) => s.trim().toLowerCase());
    if (!id || !value) continue;
    if (value === "in" || value === "in-network") map.set(id, "in-network");
    else if (value === "out" || value === "out-of-network") map.set(id, "out-of-network");
    // Anything else: not a statement about participation, so nothing is recorded.
  }
  return map;
}

/** This practice's participation in one payer's network. `unknown` when nobody has said. */
export function participationFor(
  payerId: string | null,
  map: Map<string, NetworkParticipation>
): NetworkParticipation {
  if (!payerId) return "unknown";
  return map.get(payerId) ?? "unknown";
}

export function identifyPayer(
  payerNameRaw: string | null,
  directory: PayerDirectory = BUILTIN_PAYERS
): Scored<IdentifiedPayer | null> {
  if (!payerNameRaw) {
    return { value: null, confidence: 0, explanation: "No payer name was extracted from the card." };
  }
  const normalized = normalizePayerName(payerNameRaw);

  /**
   * The LONGEST matching alias wins, across the whole catalog.
   *
   * The array this replaces resolved ambiguity by declaration order, which is invisible and depends
   * on who edited the file last. Length is a statement about specificity that survives the catalog
   * becoming rows an administrator reorders: a card reading "Delta Dental of California" must reach
   * Delta Dental even if some other payer has also claimed "dental".
   */
  let best: { payer: PayerConnector; alias: string } | null = null;
  for (const payer of directory) {
    for (const alias of payer.aliases) {
      if (!aliasMatches(alias, normalized)) continue;
      if (!best || alias.alias.length > best.alias.length) best = { payer, alias: alias.alias };
    }
  }

  if (best) {
    return {
      value: {
        payerId: best.payer.payerId,
        payerName: best.payer.payerName,
        ...(best.payer.clearinghouseId ? { clearinghouseId: best.payer.clearinghouseId } : {}),
      },
      confidence: 0.95,
      explanation: `"${payerNameRaw}" matched the ${best.payer.payerName} connector.`,
    };
  }
  return {
    value: null,
    confidence: 0.3,
    explanation:
      `No connector is registered for "${payerNameRaw}". ` +
      `Supported payers: ${directory.map((p) => p.payerName).join(", ")}. ` +
      `A payer can be added from the payer catalog screen without a deploy.`,
  };
}
