/**
 * Alert gating — turning a repeatedly-sampled condition into notifications a human will still read
 * in six months.
 *
 * ── WHY THIS EXISTS AS A SEPARATE THING ────────────────────────────────────────────────────────
 * The two failures this platform most needs to notice are silent ones: a stalled outbox (the
 * feedback loop stops learning and every business screen still looks healthy) and money that does
 * not reconcile against the payer's own 835. Both were *displayed* on the Ops screen from M10 and
 * neither was *announced* — and the Ops screen is the one screen nobody opens until they already
 * suspect a problem. `architecture-risk-review.md` §1.2 names the exact failure: "nobody notices
 * until a practice owner asks why the confidence score hasn't moved in weeks."
 *
 * ── THE PART THAT IS EASY TO GET WRONG ─────────────────────────────────────────────────────────
 * A monitor that emits on every sample is worse than no monitor. Staff mute it, and then it is
 * decorative — the identical failure mode that made a materialised Today queue the wrong choice
 * (`apps/web/today.ts`). So this gate does three things and they are all about restraint:
 *
 *   1. **Sustained, not instantaneous.** A condition must hold for `consecutive` checks before it
 *      fires. A single slow drain during a deploy is not an incident.
 *   2. **Once, then a cooldown.** While a condition keeps firing it re-notifies at most every
 *      `cooldownMs`, so a genuine outage produces a handful of lines, not thousands.
 *   3. **Resolution is news too.** "It cleared" is exactly what tells an operator to stop looking,
 *      and it is emitted once, not repeated.
 *
 * Pure and clock-injected, so all of the above is unit-testable without waiting in real time.
 */

export interface AlertPolicy {
  /** Consecutive breaching samples required before the alert fires. */
  consecutive: number;
  /** Minimum gap between repeat notifications while the condition persists. */
  cooldownMs: number;
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = { consecutive: 3, cooldownMs: 15 * 60_000 };

/** One sampled condition. `breaching` is the only thing the caller has to decide. */
export interface AlertSample {
  key: string;
  breaching: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

export type AlertNotification =
  | { kind: "firing"; key: string; message: string; detail: Record<string, unknown>; since: string }
  | { kind: "resolved"; key: string; message: string; detail: Record<string, unknown>; since: string };

interface Tracked {
  streak: number;
  firingSince: string | null;
  lastNotifiedMs: number;
}

/**
 * Decides, for a stream of samples, when a human should actually be told.
 *
 * One instance holds the state for many keys; the caller feeds it every sample it takes and emits
 * whatever comes back. Returning notifications rather than writing them keeps this free of any
 * opinion about the destination — a log channel today, a pager once hosting is chosen.
 */
export class AlertGate {
  #policy: AlertPolicy;
  #tracked = new Map<string, Tracked>();

  constructor(policy: AlertPolicy = DEFAULT_ALERT_POLICY) {
    this.#policy = policy;
  }

  /** Feed one sample. Returns a notification when — and only when — a human should hear about it. */
  evaluate(sample: AlertSample, now: Date = new Date()): AlertNotification | null {
    const nowMs = now.getTime();
    const state = this.#tracked.get(sample.key) ?? { streak: 0, firingSince: null, lastNotifiedMs: 0 };
    const detail = sample.detail ?? {};

    if (!sample.breaching) {
      this.#tracked.set(sample.key, { streak: 0, firingSince: null, lastNotifiedMs: 0 });
      // Only worth saying if we had actually said something was wrong.
      return state.firingSince
        ? { kind: "resolved", key: sample.key, message: sample.message, detail, since: state.firingSince }
        : null;
    }

    state.streak += 1;

    // Not sustained yet — watch, say nothing.
    if (state.streak < this.#policy.consecutive) {
      this.#tracked.set(sample.key, state);
      return null;
    }

    const firstFiring = state.firingSince === null;
    if (firstFiring) state.firingSince = now.toISOString();

    const dueAgain = nowMs - state.lastNotifiedMs >= this.#policy.cooldownMs;
    if (!firstFiring && !dueAgain) {
      this.#tracked.set(sample.key, state);
      return null;
    }

    state.lastNotifiedMs = nowMs;
    this.#tracked.set(sample.key, state);
    return { kind: "firing", key: sample.key, message: sample.message, detail, since: state.firingSince! };
  }

  /** Whether a key is currently in the firing state — for a health endpoint to report. */
  isFiring(key: string): boolean {
    return this.#tracked.get(key)?.firingSince !== null && this.#tracked.get(key) !== undefined;
  }
}
