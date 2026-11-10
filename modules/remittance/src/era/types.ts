/**
 * ERA ingestion types — where a remittance came from, and how we knew whose it was.
 *
 * The provenance record is not bookkeeping. An ERA is the one thing in this system that arrives
 * unsolicited and moves money, so "which practice does this belong to, and on what evidence" has to
 * be a recorded ANSWER rather than an assumption buried in a call stack.
 */

/** How the practice for an inbound ERA was decided. */
export type TenantResolution =
  /**
   * The practice's own registered clearinghouse credential fetched it. The tenant was known before
   * the file was read, and nothing in the file contributed to the decision. This is the only value
   * that permits automatic posting.
   */
  | "source-credential"
  /**
   * A human uploaded the file inside their own authenticated session. The tenant is the session's
   * practice — equally trustworthy, and equally not derived from the payload.
   */
  | "authenticated-session";

/** What the payee cross-check concluded. Never selects a tenant; only ever withholds trust. */
export type PayeeCheck =
  /** The 835's payee identifier matches the one this source registered. */
  | "matched"
  /** The source has no registered NPI, so there was nothing to compare against. */
  | "not-registered"
  /** The 835 carried no payee identifier — legal, and no evidence either way. */
  | "absent"
  /** The 835 names a DIFFERENT payee. The remittance is held; see `checkPayee`. */
  | "mismatched";

/**
 * Where one ingested remittance came from, recorded on the remittance itself.
 *
 * `artifactId` is the clearinghouse's own handle for the file (Stedi's `fileExecutionId`). Keeping
 * it means a disputed payment can be traced back to the exact artifact it was read from, months
 * later, without trusting anything the file says about itself.
 */
export interface EraProvenance {
  resolution: TenantResolution;
  payeeCheck: PayeeCheck;
  /** The vendor that served the artifact: `stedi`, `mock`, or `upload` for a human-supplied file. */
  vendor: string;
  /** The clearinghouse's artifact handle, or null for an upload. */
  artifactId: string | null;
  /** The payee identifier the FILE claimed, recorded verbatim even when it did not match. */
  claimedPayeeId: string | null;
  /** The payee identifier the SOURCE registered, which is what it was compared against. */
  expectedPayeeId: string | null;
}

/** One practice's ERA source: the credential that defines the tenant, and its polling state. */
export interface EraSource {
  id: string;
  practiceId: string;
  vendor: string;
  /** Decrypted only in the composition root, to build a vendor client. Never logged, never returned. */
  credential: string;
  payeeNpi: string | null;
  cursor: string | null;
  enabled: boolean;
  lastPolledAt: string | null;
  lastError: string | null;
}

export type EraArtifactStatus = "pending" | "ingested" | "failed" | "held";

/** One ERA file the clearinghouse has told us about, tracked from discovery to outcome. */
export interface EraArtifact {
  id: string;
  practiceId: string;
  sourceId: string;
  fileExecutionId: string;
  transactionId: string | null;
  processedAt: string | null;
  status: EraArtifactStatus;
  attempts: number;
  deadLettered: boolean;
  lastError: string | null;
  remittanceCount: number;
  ingestedAt: string | null;
}
