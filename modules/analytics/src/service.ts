/**
 * Analytics service — record facts, produce reports.
 *
 * Deliberately thin. All the judgement lives in the pure report engine, and all the durability in
 * the repository; this layer exists to give the transport one thing to call and to own the default
 * reporting window.
 */
import { buildReport } from "./engine/report.ts";
import type { FactRepository } from "./repository.ts";
import type { Fact, Period, PracticeReport } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The default window. A month is what a practice owner reasons in. */
export const DEFAULT_PERIOD_DAYS = 30;

export class AnalyticsService {
  #repo: FactRepository;

  constructor(repo: FactRepository) {
    this.#repo = repo;
  }

  /** Record one business fact. Idempotent on the source event id. */
  async record(fact: Fact): Promise<boolean> {
    return this.#repo.record(fact);
  }

  /**
   * The practice report for a window.
   *
   * `to` is exclusive, so a caller chaining windows — [day 1, day 2), [day 2, day 3) — cannot
   * double-count the boundary itself.
   *
   * The DEFAULT `to` is therefore one millisecond past "now" rather than "now": an exclusive bound
   * at exactly now omits whatever just happened in the current millisecond, and the thing that just
   * happened is precisely what someone refreshing a dashboard is looking for. That is not
   * theoretical — a write-off followed immediately by a report read the report without the
   * write-off in it whenever both landed in the same millisecond, which is why the money looked
   * forgiven nowhere. Explicit windows keep the exclusive bound exactly as passed; only the default
   * moves, so two reports taken in the same millisecond still agree.
   */
  async report(period?: Partial<Period>, now: Date = new Date()): Promise<PracticeReport> {
    const to = period?.to ?? new Date(now.getTime() + 1).toISOString();
    const from = period?.from ?? new Date(new Date(to).getTime() - DEFAULT_PERIOD_DAYS * DAY_MS).toISOString();
    const window: Period = { from, to };
    return buildReport(await this.#repo.inPeriod(window), window);
  }

  /** Total facts recorded — an operational signal that the projection is actually being fed. */
  async factCount(): Promise<number> {
    return this.#repo.count();
  }
}
