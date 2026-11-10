/**
 * How the ledger learns what a patient owes — and its entire inbound coupling.
 *
 * Two events, both about the same moment from different angles: the payer has ruled, and some part
 * of the bill is not theirs. `remittance.posted` carries the part the payer itself assigned to the
 * patient (deductible, coinsurance, amounts over the annual maximum). `denial.closed` carries the
 * part a human decided is the patient's after the payer refused it and the practice chose not to
 * fight — a decision that, before this subscription existed, ended with the money charged to nobody.
 *
 * Both handlers are idempotent through the repository's `sourceRef` key, because the outbox delivers
 * at least once and a double-charged patient is the one failure here that leaves the building.
 */
import type { EventBus } from "@mermaid/events";
import type { PatientLedgerService } from "./service.ts";

/** The outbox's per-subscriber checkpoint key. Stable — changing it replays history. */
export const LEDGER_SUBSCRIBER = "patient-ledger:charge";

export function registerPatientLedgerSubscriptions(bus: EventBus, service: PatientLedgerService): void {
  bus.subscribe("remittance.posted", LEDGER_SUBSCRIBER, async (event) => {
    await service.chargeFromPosting(event.payload);
  });

  bus.subscribe("denial.closed", LEDGER_SUBSCRIBER, async (event) => {
    await service.chargeFromDenial(event.payload);
  });
}
