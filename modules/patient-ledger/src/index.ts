/**
 * @mermaid/patient-ledger — the patient's half of every dollar.
 *
 * Through M8 this product tracked the payer's half completely and the patient's half not at all: a
 * posting recorded what the payer said the patient owed, a denial could be closed as "bill the
 * patient", and then the money stopped existing. This context is where it goes instead.
 *
 * An append-only ledger, not a balance column: when a patient disputes a statement the only useful
 * answer is how the number was arrived at, and a mutable total cannot produce one.
 */
export {
  PatientLedgerService,
  PatientAccountNotFoundError,
  LedgerActionError,
  type HumanEntryInput,
} from "./service.ts";
export {
  InMemoryLedgerRepository,
  type LedgerRepository,
  type LedgerFilter,
  type PatientScope,
} from "./repository.ts";
export { PgLedgerRepository } from "./repository.pg.ts";
export { registerPatientLedgerSubscriptions, LEDGER_SUBSCRIBER } from "./subscriptions.ts";
export {
  buildAccount,
  buildStatement,
  buildSummary,
  statementLines,
  bucketFor,
  signed,
} from "./engine/account.ts";
export { ledgerHistory } from "./engine/history.ts";
export {
  AGING_BUCKETS,
  ENTRY_SIGN,
  type AgingBucket,
  type EntryKind,
  type LedgerEntry,
  type LedgerSummary,
  type AccountPerson,
  type PatientAccount,
  type PatientStatement,
} from "./types.ts";
