# platform/crypto

Encryption for the four places this system stores raw protected health information as the outside
world sent it:

| Where | What it is |
|---|---|
| `verifications.record.cardText` | The insurance card, as read off a patient's card |
| `verifications.record.raw271` | The payer's eligibility response — names the patient and their benefits |
| `claims.record.submission.raw837` | The claim as filed: patient, member id, every procedure and fee |
| `remittances.raw_835` + `.record.raw835` | The payer's advice: every patient on it, and what was paid |

All four are kept for **provenance** — a reconciliation you cannot evidence against the payer's own
file is not a reconciliation, and a verification you cannot re-run is worth much less. That makes
them the highest-value target in the database.

## `coverages.raw_card_text` is dead, not pending

Migration `0005_patients_coverages.sql` declares a `coverages.raw_card_text` column whose comment
says it will be *"moved behind column encryption (pgcrypto) as part of the pre-PHI encryption task"*.
That is no longer what happened, and the comment cannot be corrected in place: migrations are
checksummed and immutable once applied (`migrate.mjs` refuses to run — including `--status` — when
an applied file's SHA-256 changes), so the record has to live here instead.

What actually happened: M13 chose **application-layer AES-256-GCM over pgcrypto**, for the reason in
the section below — a pgcrypto key travels as a query parameter and lands in `pg_stat_statements`,
in slow-query logs, and in any DBA's session history. The card text this module protects is
`verifications.record.cardText`, not that column.

**No code in the repository reads or writes `coverages.raw_card_text`.** It is empty rather than
unencrypted, so it is not a disclosure risk today — but it reads as an outstanding commitment to
anyone who finds it, which is why it is written down rather than left to be rediscovered.

Dropping it is a **schema decision and is not taken here**; it would need its own forward migration.

## Why not pgcrypto

`pgp_sym_encrypt(text, key)` is the obvious move and the wrong one: the key becomes a query
parameter, which puts it in `pg_stat_statements`, in slow-query logs, and in any DBA's session
history. Encrypting in the application keeps the key in one process's memory and out of the database
entirely — which also means a stolen backup is inert without the application's environment.

## Format

```
v1:<base64 iv>:<base64 auth tag>:<base64 ciphertext>
```

**Versioned**, so a second key or a second algorithm can arrive without a big-bang rewrite: readers
dispatch on the prefix, writers always emit the current version.

**AES-256-GCM**, not CBC, because it is *authenticated*: a tampered ciphertext fails loudly instead
of decrypting to plausible garbage that then gets shown to a clinician.

**Random IV per encryption**, so two patients with the same payer do not produce identical
ciphertexts — which would leak the grouping even without the key.

## Deploying to a database that already holds plaintext

`decryptPhi` passes through anything without a recognised prefix. That is what makes this shippable
without a maintenance window: existing rows keep reading, every new write is encrypted, and the
backfill runs whenever it suits.

```bash
PHI_ENCRYPTION_KEY=... npm run db:encrypt-phi -- --dry   # report
PHI_ENCRYPTION_KEY=... npm run db:encrypt-phi            # apply (idempotent, resumable)
```

The alternative — refusing to read legacy rows — would mean the deploy and the backfill had to be
simultaneous and perfect.

## Fail closed in production

With no key configured this is a no-op, which is correct for the DB-free laptop demo. In production
it is not a degraded mode, it is a misconfiguration that would silently write cards in the clear, so
`assertPhiKeyInProduction()` refuses to boot the process. A warning in a log nobody reads is how a
compliance control becomes a compliance finding.

**Losing the key means losing the data it protects.** Store it wherever database passwords are
stored, and rotate it by introducing `v2` alongside `v1` rather than by re-encrypting in place.
