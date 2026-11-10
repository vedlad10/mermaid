# module: verification

**Bounded context.** patients, coverages, verifications — the front half (card capture, eligibility
270/271, benefit/estimate math, confidence + review routing).

Owns its own tables, services, and repository. Communicates with other modules **only** via domain
events (see `../../docs/MODULE-BOUNDARIES.md`).

## The pipeline (deterministic end to end)

```
card text → interpret → validate patient → identify payer → EDI eligibility (270/271)
          → coverage estimate → exception detection → confidence aggregation
          → review routing → report
```

No AI decides anything here. AI (OCR/extraction) only *proposes* fields, which flow through the same
confidence + human-review gate as everything else. The EDI adapter is injected, so the clearinghouse
vendor stays swappable.

## What it publishes

This module's entire outward surface is two events (`src/events.ts`). Claims, Analytics and the Today
queue learn about verifications through these payloads and nothing else — they never import this
module, read its tables, or call its service.

| Event | When | Carries |
|---|---|---|
| `verification.completed` | status settled to `verified` or `reviewed`, **and** a coverage snapshot exists | the immutable `CoverageSnapshot` a claim inherits |
| `verification.needs_review` | status `needs_review` or `failed` | the reasons and work priority — deliberately **no** snapshot |

The asymmetry is the point: an unreviewed or unbacked estimate must never reach billing, so
`buildCompletedEvent` returns `null` rather than a partial payload. A settled verification with no
benefits publishes nothing billable.

`VerificationService.completionEvent(id)` exposes the same payload on demand, so a "bill this now"
action from the UI goes through exactly one path into billing rather than a second, divergent one.

## The coverage snapshot

`src/engine/snapshot.ts` freezes a completed verification into the document a claim inherits
(blueprint doc 00 keystone). It **copies** what the pipeline already computed and never recalculates
— if the claim could re-derive the estimate, the two could drift, and estimate-vs-actual
reconciliation would compare Mermaid against Mermaid instead of against the payer.

## Reading a card from a photograph

`engine/card-vision.ts` (workflow S2). A model reads the card image and returns structured fields
*plus a verbatim transcription*; the existing regex engine (`engine/ocr.ts`) then reads that
transcription independently, and the two readings are compared field by field.

**Confidence is earned from that cross-check, never reported by the model.** A self-reported 0.95
correlates with how confident an answer sounds, not with how often it is right, and this number
decides whether a human looks at a card before a member ID reaches a payer.

- Both readers agree → high. The field was read twice by unrelated methods.
- One reader only → moderate, scored on structural plausibility.
- **They disagree → neither wins.** For the payer name or the member ID this is a CRITICAL
  `card-reading-contested` exception, not merely a low score. Lowering the field's confidence alone
  was not enough: the overall score is a weighted average across four components, so one contested
  member ID against three healthy signals still cleared the auto-verify threshold. Pinned by a
  regression test that asserts the average *would* have passed.

`engine/ocr.ts` is unchanged and is not deprecated. Typed card text is a first-class path — it is
what runs when the reader is off, unapproved for PHI, or defeated by a blurred photo, and the API
requires it alongside any photograph for exactly that reason.

**No second payer-matching engine.** The model transcribes the payer NAME as a string; `identifyPayer`
still resolves it to a connector, from the one registry. A model that "identified the payer" would be
a second registry that disagrees with the first about which payer to bill.

**This feature genuinely waits for the BAA.** Unlike appeal drafting and denial explanation, an
insurance card cannot be made PHI-free — the image *is* the PHI. It declares `containsPhi: true` and
is refused before it leaves the process until `LLM_PHI_APPROVED=1`.

## Not yet built

- Postgres repository (`patients` / `coverages` / `verifications` + RLS) — migration 0006.
- Payer identification from the Payer Profile module rather than the local registry.
- Consuming `appeal.outcome.recorded` to sharpen confidence — the feedback loop (P6).
