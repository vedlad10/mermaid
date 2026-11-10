/**
 * Branded id types — a `ClaimId` can never be passed where a `PatientId` is expected, even though
 * both are strings at runtime. Zero runtime cost (the brand is a compile-time phantom).
 */

type Brand<T, B extends string> = T & { readonly __brand: B };

export type PracticeId = Brand<string, "PracticeId">;
export type UserId = Brand<string, "UserId">;
export type PatientId = Brand<string, "PatientId">;
export type CoverageId = Brand<string, "CoverageId">;
export type VerificationId = Brand<string, "VerificationId">;
export type PayerId = Brand<string, "PayerId">;
export type ClaimId = Brand<string, "ClaimId">;
export type RemittanceId = Brand<string, "RemittanceId">;
export type DenialId = Brand<string, "DenialId">;
export type AppealId = Brand<string, "AppealId">;

/** Assert an untyped string (e.g. from the DB or a validated request) as a specific id. */
export const asId = <T extends string>(value: string): T => value as T;

/** Basic UUID shape check — cheap guard for ids arriving from the edge. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);
