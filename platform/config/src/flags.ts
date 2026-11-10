/**
 * Feature flags — per-practice rollout control (blueprint docs 12, 15). The strangler-fig migration
 * flips behavior per practice; every phase's new behavior sits behind a flag so a bad cutover
 * affects one flagged practice, never all — and rolls back with a flag flip, not a DB restore.
 *
 * Design: the flag REGISTRY and its resolver are pure (testable without a DB). Per-practice
 * overrides are loaded from the `feature_flags` table by the caller and passed in — the resolver
 * never touches the database itself (keeps it boundary-clean and unit-testable).
 */

export type FeatureFlagName =
  // phase cutover flags — all default OFF until their phase ships and is enabled per practice
  | "verification.enabled"      // P2
  | "remittance.autopost"       // P3
  | "claims.enabled"            // P4
  | "claims.inheritance"        // P5 — estimate→claim bridge (shadow-mode gated)
  | "learning.loop"             // P6 — rule → confidence feedback
  | "ui.unified_shell";         // P7 — single app shell

export interface FlagDefinition {
  name: FeatureFlagName;
  description: string;
  /** Platform-wide default when a practice has no explicit override. */
  default: boolean;
}

export const FEATURE_FLAGS: Record<FeatureFlagName, FlagDefinition> = {
  "verification.enabled": { name: "verification.enabled", description: "Verification module serves this practice", default: false },
  "remittance.autopost": { name: "remittance.autopost", description: "Auto-post clean remittances (else shadow only)", default: false },
  "claims.enabled": { name: "claims.enabled", description: "Claims module serves this practice", default: false },
  "claims.inheritance": { name: "claims.inheritance", description: "Claims inherit verification coverage snapshot", default: false },
  "learning.loop": { name: "learning.loop", description: "Appeal outcomes sharpen verification confidence", default: false },
  "ui.unified_shell": { name: "ui.unified_shell", description: "Serve the unified Mermaid app shell", default: false },
};

/** Per-practice overrides, as loaded from the feature_flags table: flag → enabled. */
export type FlagOverrides = Partial<Record<FeatureFlagName, boolean>>;

/** Resolve a flag for a practice: explicit override wins, else the platform default. Pure. */
export function isEnabled(flag: FeatureFlagName, overrides: FlagOverrides = {}): boolean {
  const override = overrides[flag];
  if (override !== undefined) return override;
  return FEATURE_FLAGS[flag].default;
}

export const isKnownFlag = (value: unknown): value is FeatureFlagName =>
  typeof value === "string" && value in FEATURE_FLAGS;
