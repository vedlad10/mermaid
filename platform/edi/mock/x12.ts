/**
 * X12 primitives shared by the transaction codecs (271 eligibility, 837D/277CA claims).
 *
 * Extracted when the second codec landed rather than duplicated: separator handling and segment
 * tokenization are the layer where a subtle divergence between two codecs turns into a wire bug
 * that only one payer notices.
 */

/** Segment terminator Mermaid WRITES with, and the fallback when a payload declares none. */
export const SEG = "~";
/** Element separator Mermaid WRITES with, and the fallback when a payload declares none. */
export const ELEM = "*";
/** Component (sub-element) separator Mermaid WRITES with. */
export const COMP = ":";

export interface X12Segment {
  id: string;
  elements: string[];
}

/** The three delimiters one interchange is written with. */
export interface X12Delimiters {
  element: string;
  segment: string;
  component: string;
}

/**
 * The delimiters THIS interchange declares, read from its ISA header.
 *
 * ── WHY THESE ARE READ AND NOT ASSUMED ─────────────────────────────────────────────────────────
 * X12 does not fix the delimiters; the ISA header declares them, and every reader is required to
 * take them from there. This module hard-coded `*` and `~` — the set Mermaid's own builder writes —
 * so the codecs round-tripped their own output perfectly and would have rejected a real payer's
 * file that used any other legal set.
 *
 * That failure is quiet in the worst place. A structurally valid 835 whose segments end in a
 * newline tokenizes into one enormous pseudo-segment, so `parse835All` throws "Payload is not an
 * X12 835 transaction" — the ERA worker records a PERMANENT parse failure, dead-letters the
 * artifact, and the payer's money never reaches the ledger. It fails closed, which is right, but
 * "closed" here means a real payment sitting in the bank against no ledger entry.
 *
 * The layout is fixed by the standard and this reads it structurally rather than by byte offset:
 * the character after `ISA` is the element separator, ISA16 is the single character following the
 * SIXTEENTH separator, and the segment terminator is the character immediately after ISA16.
 * Counting separators rather than trusting the 106-byte width tolerates a sender whose padding is
 * off, which is common enough to matter and costs nothing to allow.
 *
 * Falls back to Mermaid's own delimiters when there is no parseable ISA — every codec test builds
 * bare segment fragments, and so does the 271 the mock hands back.
 */
export function detectDelimiters(raw: string): X12Delimiters {
  const fallback: X12Delimiters = { element: ELEM, segment: SEG, component: COMP };
  const text = raw.replace(/^[\s]+/, "");
  if (!text.startsWith("ISA") || text.length < 20) return fallback;

  const element = text[3]!;
  // A separator that is alphanumeric or whitespace is not a separator; something is wrong with the
  // header and guessing from it would be worse than using the default.
  if (/[A-Za-z0-9\s]/.test(element)) return fallback;

  let seen = 0;
  for (let i = 3; i < text.length; i++) {
    if (text[i] !== element) continue;
    if (++seen < 16) continue;
    const component = text[i + 1];
    const segment = text[i + 2];
    // ISA16 and the terminator must both exist and neither may be the element separator itself.
    if (!component || !segment || component === element || segment === element) return fallback;
    return { element, segment, component };
  }
  return fallback;
}

/**
 * Split a raw X12 payload into segments, using the delimiters the payload itself declares.
 *
 * `elements` is zero-indexed from the segment's FIRST data element — so for
 * `NM1*IL*1*ALPHA*ADA*****MI*ABC123`, `elements[0]` is NM101 and `elements[8]` is NM109.
 */
export function parseSegments(raw: string): X12Segment[] {
  const { element, segment } = detectDelimiters(raw);
  return raw
    .split(segment)
    .map((s) => s.replace(/[\r\n]/g, "").trim())
    .filter(Boolean)
    .map((s) => {
      const parts = s.split(element);
      return { id: parts[0] ?? "", elements: parts.slice(1) };
    });
}

/**
 * The component separators seen often enough to guess from, when a payload declares none.
 *
 * `:` is the near-universal choice and the one Mermaid writes; `>` and `^` are both in active use by
 * real payers (`^` is what the 005010 ISA16 examples carry). A composite read with the wrong one
 * comes back as a single unsplit string, which turns `AD:D2750` into a procedure code no catalog
 * holds and a PLB reference into "the payer named no claim".
 *
 * ── THIS SET IS A FALLBACK, NOT THE ANSWER ─────────────────────────────────────────────────────
 * It used to be the answer, described as "every character X12 permits". X12 permits ANY character
 * and says which one in ISA16 — and a real clearinghouse promptly used one that is not in this set:
 * Stedi's 277CA declares a BACKTICK, so `STC*A1`20` came back with `statusCategory` = "A1`20" and
 * `statusCode` = null, and the accept/reject decision was made on a malformed string. The same
 * payload's `SVC*AD`D0120` would have defeated line attribution for exactly the reason this comment
 * already gave.
 *
 * `componentSeparatorOf` reads the declaration. This is only what to do when there is none.
 */
export const COMPONENT_SEPARATORS = /[:>^]/;

/** Characters that cannot be a delimiter — a separator that is one means the header is wrong. */
const NOT_A_DELIMITER = /[A-Za-z0-9\s]/;

/**
 * A matcher for the component separator THIS payload declares in ISA16.
 *
 * Falls back to the permitted set for a fragment with no interchange header — a bare `ST`-level
 * excerpt in a fixture, say — because guessing from the common three is still better than assuming
 * one. Escaped for regex use: the declared character is frequently a regex metacharacter (`^` and
 * `*` both appear in the wild).
 */
export function componentSeparatorOf(raw: string): RegExp {
  const { component } = detectDelimiters(raw);
  if (!component || NOT_A_DELIMITER.test(component)) return COMPONENT_SEPARATORS;
  return new RegExp(component.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

/** Date → X12 D8 format (CCYYMMDD), local time. */
export const d8 = (date: Date): string =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;

/** ISO date ("2026-07-27") → X12 D8 ("20260727"). Passes through anything already D8. */
export const isoToD8 = (iso: string): string => iso.replace(/-/g, "").slice(0, 8);

/**
 * Deterministic 9-digit control number from a seed. Deterministic on purpose: the same claim
 * resubmitted presents the same control number, which is how a payer recognizes a duplicate rather
 * than paying twice.
 */
export function controlNumber(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return String(h % 1_000_000_000).padStart(9, "0");
}

/**
 * Join segments into a wire payload, terminating the final segment.
 *
 * ── NO VALUE MAY CARRY A DELIMITER ─────────────────────────────────────────────────────────────
 * `build837D` already refuses a CLM01 containing `*` or `~`, and its comment gives the reason: such
 * a value "would SPLIT THE CLM SEGMENT and produce a structurally different claim than the one
 * authorised". That reasoning is not specific to CLM01. Every other element is interpolated the same
 * way and was checked by nothing — subscriber names and addresses come from what someone typed at
 * check-in, and the provider identity comes from environment configuration.
 *
 * The consequence is worse than a rejection. An extra `*` shifts every following element of the
 * segment by one position, so a payer does not read a malformed claim — it reads a well-formed claim
 * that says something else. A `~` ends the segment early and starts a new one from the remainder.
 * Neither is detectable downstream, and our own parser would round-trip the corrupted result.
 *
 * Enforced HERE rather than at each call site because this is the one place every codec passes
 * through, and because the guard has to hold for callers that do not exist yet. Throwing rather than
 * stripping, for the reason the CLM01 guard already gives: silently altering a value breaks the
 * matching it exists for, and a claim nobody can match is how the same treatment gets paid twice.
 *
 * `:` is deliberately allowed — composites (CLM05, SV301) are joined with it before they arrive, and
 * ISA16 declares it.
 */
export function render(segments: string[][]): string {
  for (const segment of segments) {
    const id = segment[0] ?? "?";
    segment.forEach((value, index) => {
      if (index > 0 && (value.includes(ELEM) || value.includes(SEG))) {
        throw new Error(
          `Refusing to render X12: ${id}${String(index).padStart(2, "0")} contains a delimiter ` +
            `(${JSON.stringify(value)}). An element carrying "${ELEM}" or "${SEG}" does not produce a ` +
            `malformed claim — it produces a well-formed claim that says something else.`
        );
      }
    });
  }
  return segments.map((s) => s.join(ELEM)).join(SEG) + SEG;
}
