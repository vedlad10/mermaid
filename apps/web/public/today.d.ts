/**
 * Types for the part of the Today screen that is pure logic rather than DOM.
 *
 * Only `positionRows` is declared, and it is the one piece of this screen worth stating precisely:
 * it makes the null-versus-zero decision about money a viewer's role may not see, and that decision
 * has already gone wrong once in the renderer this replaced. `mountToday` takes a live DOM node and
 * is not usefully typeable here.
 */

/** One line of the practice's standing money position. */
export type PositionRow =
  | {
      key: string;
      label: string;
      /** The viewer may see this figure. */
      visible: true;
      /** The server's figure, in integer cents. Never derived from another row. */
      amount: number;
      /** The formatted amount. */
      display: string;
      note: string;
      /** Semantic emphasis, and only ever on a non-zero amount. */
      tone: "warning" | "critical" | null;
    }
  | {
      key: string;
      label: string;
      /** The viewer's role may not see this figure. */
      visible: false;
      /**
       * Deliberately absent, not zero. There is no value here for a renderer to coerce into a
       * confident "$0.00" under a caption saying the figure is not visible.
       */
      amount?: undefined;
      /** Always the em dash. */
      display: string;
      note: string;
      tone: null;
    };

/**
 * The practice's standing position as rows a screen can render without deciding anything.
 *
 * A `null` or absent input figure means the viewer's role may not see it and yields a withheld row.
 * A ZERO is a real answer and yields a visible row reading `$0.00` — "no payer owes us anything" and
 * "you may not see what payers owe us" are different sentences, and this is where they are kept
 * apart.
 */
/**
 * What `positionRows` reads. Declared field by field rather than as an index signature so it
 * accepts the server's `TodayMoney` exactly, and so adding a figure to the payload without adding
 * a row here is visible rather than silent.
 *
 * Every amount is `number | null`: `null` is the server saying "not for this role".
 */
export interface MoneyPositionInput {
  heldInBank?: number | null;
  heldCount?: number | null;
  owedByPayers?: number | null;
  owedByPatients?: number | null;
  overNinetyShare?: number | null;
  deniedUnrecovered?: number | null;
  preAuthAtRisk?: number | null;
}

export declare function positionRows(money: MoneyPositionInput | null | undefined): PositionRow[];

export declare function mountToday(stage: unknown, deps: { store: unknown; api: unknown }): unknown;

/** Today's schedule strip (§8.1), decided without a DOM — see `scheduleStrip` in today.js. */
export interface ScheduleStrip {
  rows: {
    id: string;
    time: string;
    name: string;
    detail: string;
    production: number | null;
    word: string;
    tone: "warning" | "critical" | null;
    group: import("./schedule.js").ReadinessGroup | null;
    booked: boolean;
    verificationId: string | null;
  }[];
  /** Booked visits only — a cancelled one is listed but counts toward nothing. */
  count: number;
  /** The practice's own planned total, or null when any booked visit's fee is unknown. */
  production: number | null;
  notReady: number;
  provenance: string | null;
}

export declare function scheduleStrip(schedule: import("./schedule.js").Schedule | null, now?: number): ScheduleStrip;
