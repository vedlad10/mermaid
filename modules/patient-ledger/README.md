# module: patient-ledger

**Bounded context.** What each patient owes the practice, how it got there, and how old it is.

## Why it exists

Through M8 the product tracked the payer's half of every dollar completely and the patient's half not
at all. A verification quoted the patient a number, a posting recorded what the payer said the patient
owed, and a denial could be closed as "bill the patient" — and then the money simply stopped
existing. A practice could not answer *what do our patients owe us?*, which is the second question
every practice owner asks and typically 20–30% of collectable revenue.

## Shape

An **append-only ledger**, not a balance column. Every movement is an immutable entry and the balance
is a fold over them. Two reasons, both practical:

- When a patient disputes a statement, the only useful answer is *how the number was arrived at*. A
  mutable total cannot produce one.
- Idempotency becomes natural: an entry carries `source_ref`, the id of the event that caused it, and
  a UNIQUE index refuses a second entry for the same cause. A double-charged patient is the worst
  failure this product can produce — unlike a wrong dashboard figure, it leaves the building.

Amounts are stored **signed** (charge positive, everything else negative) so a balance is a `sum()`
rather than a switch statement someone will one day add a case to and forget to negate. A CHECK
constraint enforces the convention in the database.

## Aging

Payments are applied **oldest charge first**, and only the unpaid remainder of each charge is aged.
The naive alternative — bucket every charge by its own age — double-counts: a patient charged $200
ninety days ago who paid last week would still show $200 in the 90-plus bucket, and the practice would
chase money it already has. Applying oldest-first means the aging always sums to the balance, which is
the property that makes an aging report worth printing.

## Inbound events

| Event | Produces |
|---|---|
| `remittance.posted` | A charge for `patientResponsibility` — the deductible/coinsurance the payer itself assigned to the patient. Skipped when zero, or when the payment could not be tied to a filed claim. |
| `denial.closed` | A charge for the denied amount, **only** when a human closed it as `patient_billed`. `written_off` means the practice absorbed it, and absorbing it means nobody is billed. |

## Outbound events

`patient.charged` and `patient.payment.recorded`. Published even though this module could report on
itself, because a practice's collection rate is only honest when it counts both halves of every
dollar — and Analytics must not read another module's tables to get the patient half.

## Human gates

Charges are never created by a person; they arrive from the cycle. Money never *leaves* a balance
without a named one — payments, courtesy adjustments and write-offs all require an actor, and
adjustments and write-offs additionally require a reason. Reducing what a patient owes is exactly how
a practice loses money quietly.

## The account key

The **member ID the claim was filed under** — the identity that travels with the money from
verification through to the payer's advice. A practice-management system would key on its own patient
record; this system does not create one (`patients` exists and nothing writes it), and inventing a
second identity here would be worse than using the one the money already carries. When the patient
master is populated, this becomes a foreign key and the member ID becomes an attribute of it.

Owns its own tables (`ledger_entries`, migration 0013). Communicates with other modules **only** via
domain events — see `../../docs/MODULE-BOUNDARIES.md`.
