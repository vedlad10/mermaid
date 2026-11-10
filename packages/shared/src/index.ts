/**
 * @mermaid/shared — the only package every module may import from.
 *
 * Cross-module coupling is forbidden (see docs/MODULE-BOUNDARIES.md); shared *types* and
 * conventions live here so modules agree on shape without reaching into each other.
 */
export * from "./snapshot.ts";
export * from "./ids.ts";
export * from "./money.ts";
export * from "./scored.ts";
export * from "./roles.ts";
export * from "./cdt.ts";
export * from "./carc.ts";
export * from "./calendar.ts";
export * from "./domain/estimate.ts";
export * from "./domain/preauth.ts";
export * from "./domain/partition.ts";
export * from "./domain/coverage-snapshot.ts";
export * from "./domain/history.ts";
export * from "./domain/subscriber.ts";
export * from "./domain/payer-window.ts";
