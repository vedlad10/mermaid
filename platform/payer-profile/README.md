# platform/payer-profile — the shared brain

**What a payer does about a given denial code, and how often fighting it actually works.**

`payers` + `payer_playbook_rules` (migration 0004), plus the learning logic that turns recorded
appeal outcomes into sharper recommendations.

## Why this is in `platform/` and not `modules/`

Blueprint doc 02 lists Payer Profile among the six bounded contexts, and it was originally scaffolded
as `modules/payer-profile/`. **M7 moved it to `platform/`.** This is a flagged, deliberate deviation,
and the reasons come from the blueprint's own design rather than from convenience:

1. **The data is explicitly GLOBAL.** Migration 0004 creates both tables with *no* `practice_id` and
   *no* RLS — deliberately, and its own header says why: "one payer catalog, one set of CARC×CDT
   rules whose overturn_rate/sample_size accumulate across the platform." One clinic appealing three
   CO-197s learns nothing; a thousand clinics appealing them learns a great deal. There is no tenant
   dimension here to isolate.

2. **The blueprint itself requires cross-context reads.** Doc 02 describes this context as "written
   by Appeals, read by Verification." But a module may not read another module
   (`docs/MODULE-BOUNDARIES.md`, enforced in CI). Implemented as a peer module it would therefore
   have to either violate that rule or carry event-projection machinery — for data that has no tenant
   to project along, and whose whole value is being shared rather than copied.

3. **It is reference data plus learned statistics** — the same category as the CDT catalog and the
   CARC table, which already live in shared/platform and are imported freely. `platform/` is defined
   as the shared capabilities every module may depend on (db, events, auth, edi, observability); a
   global payer knowledge base fits that definition exactly.

**Nothing else moved.** The tables are unchanged, Denials & Appeals is still the only writer (via
`appeal.outcome.recorded`), and the learning loop is unchanged. Reverting to a module would mean
adding an event projection per consumer — mechanical, but only worth doing if the data ever gains a
tenant dimension.

## How a rule is chosen

Most specific wins:

```
payer + CDT prefix  →  payer  →  default + CDT prefix  →  default  →  the CARC's own category
```

That last fallback matters. `@mermaid/shared` already knows whether a code is contractual, the
patient's, or recoverable, so an unrecognised code still gets a safe disposition — defaulting to
*recoverable*, because the safe failure is making a human look at money that did not arrive.

## How it learns, and why it is hard to fool

`recordOutcome` blends observation with the prior and keeps two guards, both of which exist because
a recommendation engine that can be swung by luck will be trusted exactly once:

- **A permanent 25% prior floor.** A payer that overturned 3 of 3 appeals has not proven a 100%
  overturn rate. The blend can approach certainty but never reach it — in either direction, so a
  losing streak can never drive a code to 0% and silently hide it forever.
- **A small-sample trust gate** (`TRUST_THRESHOLD`, 20 observations). Below it the rate is presented
  as *provisional*; at or above it the rule is `trusted` and the UI may show the rate as evidence.
  This is the sanity gate blueprint doc 11 and the human-in-the-loop workflow (§9) both call for.

Learning is always recorded against a **payer-specific** rule. A global default is a starting belief
shared by every practice on the platform; one payer's behaviour must never rewrite it for everyone.

## What is NOT here

- **Editing rules by hand.** The HTTP surface is read-only. A hand-set overturn rate is a number
  nobody can account for, and it would corrupt the only real-world evidence the system has.
- **Per-practice overlays.** The tables support them without a schema change (add `practice_id` and
  a scoped policy) if a practice ever needs to override platform-wide guidance.
- **Payer filing/appeal windows.** `payers.filing_window_days` and `appeal_window_days` exist but are
  not yet read — Claims and Denials still use documented local defaults. Wiring them here is a small,
  obvious next step.
