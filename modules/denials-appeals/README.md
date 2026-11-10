# module: denials-appeals

**Bounded context.** denials, appeals — denial triage against the shared payer playbook, deterministic
appeal drafting, the human approval gate, and outcome recording that feeds the learning loop.

Owns its own tables, services, and repository. Communicates with other modules **only** via domain
events (see `../../docs/MODULE-BOUNDARIES.md`).

## The idea

M5 could already tell a clinic exactly which money a payer was withholding and why. Nothing *worked*
it. This module is the difference between a report and a recovery.

```
variance.detected  ──▶  triage against the payer playbook   (@mermaid/payer-profile)
                          │
                          ▼
                    a denial, ranked by EXPECTED recovery
                          │
                          ▼
                    draftAppeal()  → letter + evidence checklist  (deterministic)
                          │
                    approveAppeal() ← A HUMAN. Always.
                          │
                    submitAppeal()  → the payer
                          │
                    recordOutcome() → appeal.outcome.recorded ──▶ the playbook learns
```

## The unit of work is a REASON, not a claim

A payer can withhold money on one claim for two unrelated codes — a missing tooth number and a
bundling dispute. Those are two different jobs, with different evidence, different odds and possibly
different outcomes. Collapsing them into one denial per claim is how a practice ends up appealing a
bundling denial with radiographs.

## Ranked by what is retrievable, not by what was denied

`engine/priority.ts` (ported from the donor's `scoreQueueItem`) scores expected value × urgency ×
actionability. A $2,000 denial at 5% odds is worth less attention than a $400 denial at 75%, and a
queue sorted by amount denied sends staff to the wrong work every morning. Urgency comes from the
appeal window, because a closed window is unrecoverable revenue.

## Two invariants worth protecting

1. **Nothing reaches a payer without a named human.** `draftAppeal` produces a draft that goes
   nowhere; `approveAppeal` requires an actor; `submitAppeal` refuses anything unapproved. An appeal
   is a factual assertion to a payer about a patient's care — the human-in-the-loop workflow names
   appeal submission as a first-class gate, and it is enforced as one.

2. **The triage is FROZEN at decision time.** The playbook keeps learning, but the odds a human saw
   when they decided to appeal must never change underneath them. An audit trail whose reasoning
   mutates is not an audit trail.

Plus the usual: creation is idempotent on (posting, reason code, procedure), enforced by a UNIQUE
constraint, because `variance.detected` is delivered at least once and a duplicated denial is
duplicated work in a queue whose entire value is that everything in it is real.

## Where AI is, and is not, allowed

`engine/letter.ts` is pure and deterministic. The DISPOSITION comes from the playbook; the letter's
factual content comes from the denial record. An LLM must never choose whether to appeal, what to
assert, or what the money is. An invented sentence in a letter to a payer is a compliance problem,
not a typo (blueprint doc 10).

The **checklist** is the more valuable half of the draft anyway: a letter without its radiographs is
a wasted appeal window, and the checklist is derived from what the procedure and the reason code
actually require.

Two AI features are built, both narration-class, both degrading to exactly what this module did
before they existed:

**`engine/narrative.ts` — the appeal argument** (workflow S14). A model writes ONE paragraph: the
argument for why this procedure, denied under this reason code, by this payer, should be reprocessed.
That is the sentence a template cannot write well. Everything else — claim number, member ID, date of
service, denied amount, procedure code, reason code, enclosure list, closing request — is still
written by `letter.ts` from the denial record, and the model never gets the chance to restate them.

It runs before the appeal is drafted and *after* the playbook has already refused a non-pursuable
denial, so no prompt is ever built for a decision that was already made deterministically.

`NarrativeInput` is a **closed type carrying no patient identity, no dates, no money** — an argument
about a CDT code and a CARC code is not information about an identifiable person. That is why this
feature runs on a deployment with no BAA: it never had anything to disclose. Do not widen that type
"because it reads better".

`sanitizeNarrative` refuses any paragraph containing a dollar figure, a placeholder, or a model
narrating its own task — and refusal means the deterministic letter is sent, not that the appeal is
blocked.

**`engine/explanation.ts` — root-cause narration** (workflow S10/S13). One plain-English sentence
over the already-decoded CARC/RARC data, given the *other* reason codes on the same claim. It states
no numbers and recommends nothing: both are already on the screen, computed. Not persisted — it is a
reading aid over stored data, generated on an explicit click.

**`reviseAppeal` clears any existing approval.** An approval is a named person's signature on
specific words; if the words can change afterwards while the signature stays, the record says someone
approved a letter they never read.

## Not yet built

- Second-level appeals are modelled (`level`) but the UI only drives level 1.
- Appeal windows use a documented 90-day default; `payers.appeal_window_days` exists and is not yet
  read.
- Correction-and-resubmit dispositions produce a recommendation, not an actual corrected claim —
  that needs a Claims-side "refile from denial" flow.
- No attachment storage: the checklist tells a human what to gather, and they gather it.
