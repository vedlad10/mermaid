/**
 * Work priority for a denial — expected value × urgency × actionability.
 *
 * Ported from `dental-rcm-platform`'s `scoreQueueItem`, with the donor's open-ended dollar score
 * normalised to the 0–100 scale every other queue in this codebase uses, so a denial can eventually
 * be ranked in one list against a claim or a verification.
 *
 * The central idea is the donor's and it is the right one: **rank by what is actually retrievable,
 * not by what was denied.** A $2,000 denial with 5% odds is worth less attention than a $400 denial
 * with 75% odds, and a queue sorted by denied amount sends staff to the wrong work every morning.
 */
import { calendarDay, daysBetween, type Cents, type PayerWindowSource } from "@mermaid/shared";
import { appealWindowNote } from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PriorityInput {
  deniedAmount: Cents;
  /** Probability of recovery, 0–1. */
  overturnRate: number;
  /** ISO date the payer stops accepting an appeal. */
  appealDeadline: string | null;
  /**
   * True when the date above came from Mermaid's default window instead of the payer's catalogued
   * terms. Affects the WORDING of the urgency lines only — the score is deliberately identical,
   * because an assumed window runs out just as really as a stated one.
   */
  appealDeadlineEstimated?: boolean;
  /** The window that produced the deadline, so the caveat can quote it. */
  appealWindowDays?: number;
  /** The payer's own document behind that window, when there is one (B-1). Wording only. */
  appealWindowSource?: PayerWindowSource | null;
  /** How long this denial has been sitting. */
  detectedAt: string;
  /** Correctable denials are fast wins and deserve a nudge over slow appeals of equal value. */
  quickWin: boolean;
}

export interface PriorityResult {
  /** 0–100, comparable with every other queue in the product. */
  priority: number;
  expectedRecovery: Cents;
  explain: string[];
}

export function scoreDenial(input: PriorityInput, now: Date = new Date(), timeZone = "UTC"): PriorityResult {
  const explain: string[] = [];
  const amount = Math.max(0, input.deniedAmount);
  const expectedRecovery = Math.round(amount * input.overturnRate) as Cents;

  explain.push(
    `Expected recovery ${usd(expectedRecovery)} = ${usd(amount as Cents)} × ${Math.round(input.overturnRate * 100)}% odds.`
  );

  // Urgency from appeal-deadline proximity. A missed appeal window is money that can never be
  // recovered, so it dominates everything else.
  let urgency = 1;
  if (input.appealDeadline) {
    // These sentences are read by a biller deciding what to work. Each one counts down to a date,
    // so each one has to say when that date is Mermaid's assumption rather than the payer's word.
    // Both cases carry a caveat now: an uncatalogued payer's window is a default nobody stated, and
    // a catalogued one is a typical figure rather than this payer's own terms. Same words as every
    // other surface, from the same function.
    const note = appealWindowNote(input.appealDeadlineEstimated === true, input.appealWindowDays, input.appealWindowSource ?? null);
    const assumed = note ? ` ${note}` : "";
    // The practice’s calendar day, not the server’s — an appeal window that closes a day early
    // on screen is money nobody goes back for. See packages/shared/src/calendar.ts.
    const days = daysBetween(calendarDay(now, timeZone), input.appealDeadline);
    if (days <= 0) {
      urgency = 3;
      explain.push(`The appeal window has closed or closes today — maximum urgency.${assumed}`);
    } else if (days <= 5) {
      urgency = 2.5;
      explain.push(`${days} day${days === 1 ? "" : "s"} left to appeal — critical.${assumed}`);
    } else if (days <= 14) {
      urgency = 1.8;
      explain.push(`${days} days left to appeal — elevated.${assumed}`);
    } else if (days <= 30) {
      urgency = 1.3;
      explain.push(`${days} days left to appeal.${assumed}`);
    }
  }

  // Aging pressure: a denial nobody has touched in two months is a process failure, not just a task.
  const ageDays = Math.floor((now.getTime() - new Date(input.detectedAt).getTime()) / DAY_MS);
  if (ageDays > 60) {
    urgency = Math.max(urgency, 1.6);
    explain.push(`${ageDays} days old — this has been sitting too long.`);
  } else if (ageDays > 30) {
    urgency = Math.max(urgency, 1.25);
    explain.push(`${ageDays} days old.`);
  }

  const actionability = input.quickWin ? 1.25 : 1;
  if (input.quickWin) explain.push("Correctable rather than contestable — a fast win.");

  // The donor's raw score is unbounded dollars. Normalising against a $2,000 expected recovery puts
  // a genuinely large, urgent denial at the top of the scale without letting one outlier flatten
  // everything else to zero.
  const raw = (expectedRecovery / 100) * urgency * actionability;
  const priority = Math.max(1, Math.min(100, Math.round((raw / 2000) * 100)));

  return { priority, expectedRecovery, explain };
}

const usd = (c: Cents): string => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
