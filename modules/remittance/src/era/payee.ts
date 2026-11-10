/**
 * The payee cross-check — the one thing the 835 is allowed to say about identity, and the strictly
 * limited authority it is granted for saying it.
 *
 * ── WHY THIS IS NOT A TENANT SELECTOR ──────────────────────────────────────────────────────────
 * Loop 1000B `N1*PE` names who the payer says it paid. It is the obvious candidate for routing an
 * inbound ERA to a practice, and using it that way would be a serious defect: the identifier is
 * supplied by whoever authored the file, so a payer error — or a forged file — would choose which
 * ledger money lands in. Tenant comes from the CREDENTIAL that fetched the artifact, always.
 *
 * ── SO WHAT IS IT FOR ──────────────────────────────────────────────────────────────────────────
 * Withholding trust, never granting it. A match adds nothing (the tenant was already known). A
 * MISMATCH is real evidence that something is wrong — most plausibly a credential pointed at the
 * wrong clearinghouse account — and the safe response to "this money may not be yours" is to stop
 * and ask a human, not to post it and reconcile later.
 *
 * The asymmetry is the point: this function can only ever move a remittance from "post it" to
 * "hold it". There is no input that makes it post something it otherwise would not.
 */
import type { PayeeCheck } from "./types.ts";

/**
 * Compare what the file claims against what the source registered.
 *
 * Identifiers are compared case-insensitively with surrounding whitespace removed, because an NPI
 * is a number and a payer that pads or lower-cases it has not paid a different practice. Nothing
 * more aggressive than that: stripping punctuation or matching a prefix would start making two
 * genuinely different identifiers compare equal, which is the failure this exists to catch.
 */
export function checkPayee(claimed: string | null | undefined, expected: string | null | undefined): PayeeCheck {
  const theirs = (claimed ?? "").trim();
  const ours = (expected ?? "").trim();

  // No registered NPI: nothing to compare. Reported distinctly from a match so a deployment that
  // never configured one cannot read as "checked and fine" on every remittance it ever takes in.
  if (!ours) return "not-registered";
  // The payer sent a bare name. Legal in an 835, and no evidence either way.
  if (!theirs) return "absent";

  return theirs.toLowerCase() === ours.toLowerCase() ? "matched" : "mismatched";
}

/** The blocker text for a mismatch. Written for the person who has to decide what to do. */
export function payeeMismatchMessage(claimed: string | null, expected: string | null): string {
  return (
    `This remittance names payee "${claimed ?? "—"}", but this practice's ERA source is registered ` +
    `to "${expected ?? "—"}". It was retrieved with this practice's own clearinghouse credential, ` +
    `so it has NOT been posted to another practice — but one of the two is wrong. Confirm which ` +
    `before releasing it.`
  );
}
