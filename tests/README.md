# tests

Cross-module and end-to-end harnesses — the tests that no single module can own because their
subject is the seam between several.

## `tests/*.test.ts` — vertical slices (`npm test`, no database)

Each drives the real composition root (`buildServices({ inMemory: true })`), so it exercises the
wiring that actually ships rather than a hand-rolled parallel copy that can drift from it.

| File | The question it exists to answer |
|---|---|
| `vertical-verify-to-claim.test.ts` | Does the estimate reach billing unchanged, over an event? |
| `vertical-verify-to-payment.test.ts` | Does the payer's money reconcile against the frozen estimate? |
| `vertical-learning-loop.test.ts` | Does the system get *better*? An outcome must change the next triage. |
| `vertical-today-and-insights.test.ts` | Do the two screens that see everything agree with the modules they summarise? |
| `vertical-patient-money.test.ts` | Where does the money the payer did not pay go? |

Every other test in this repository checks that a calculation is correct. These check that the parts
add up to a product.

## `tests/db/*.test.ts` — live database (`npm run test:db`)

Properties of Postgres, not of TypeScript, which an in-memory double cannot establish: tenant
isolation under RLS, idempotency under concurrent redelivery, JSONB round-trip fidelity, money
arriving as integers rather than strings, and PHI actually being ciphertext in the column.

They **skip loudly** when `DATABASE_URL` is unset, and run sequentially
(`--test-concurrency=1`) because they share one database and one outbox queue.

⚠ Do not run them while `npm run web` is up against the same database: its background worker claims
the tests' events and dispatches them to its own subscribers, after which a test's own drain finds
nothing and fails, seemingly at random. The fix is to stop the app, not to weaken the queue.

Set `PHI_ENCRYPTION_KEY` to run them in the production configuration (CI does).

## Human-in-the-loop gates

There is no single `tests/hitl/` suite yet. Each gate is enforced and covered where it lives —
claim submission (`modules/claims`), remittance release (`modules/remittance`), appeal approval and
submission (`modules/denials-appeals`), and every reduction of a patient balance
(`modules/patient-ledger`) — plus the vertical tests above, which assert that none of them can be
reached without a named actor. Worth consolidating the moment a patient-messaging feature is
contemplated, since that is the constraint currently satisfied by absence rather than by a guard.
