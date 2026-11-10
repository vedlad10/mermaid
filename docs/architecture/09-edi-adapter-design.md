# 09 — EDI Adapter Design

*Blueprint doc 9 of 16. EDI is **bought, not built**: Mermaid integrates a clearinghouse that returns
normalized JSON, behind a swappable adapter (`ai-revenue-cycle-implementation-roadmap.md` §1, §7;
`architecture-risk-review.md` §5). The donor X12 codecs are demoted to the mock/dev + paper-fallback
implementation of that adapter — real, tested code, but not the go-live transport.*

## Decision & rationale

Differentiation is what Mermaid does with the data, not its ability to parse X12. A single
clearinghouse vendor is also a **coverage/reliability ceiling** (risk §5), so the integration is a
swappable adapter from day one — a second vendor later must not touch every module that calls it.

**Approved (this build):** build the adapter interface now; `EDI_ADAPTER=mock` uses the ported
codecs; the concrete vendor (Stedi / Availity / Change Healthcare) is wired at P2.

## The adapter interface

```ts
// platform/edi/adapter.ts — the ONLY EDI surface any module sees.
export interface EdiAdapter {
  /** 270 → 271: real-time eligibility. Returns normalized benefits + raw payload for provenance. */
  checkEligibility(req: EligibilityRequest): Promise<Result<EligibilityResponse>>;

  /** 837: submit a claim. Returns clearinghouse claim id + acceptance status. */
  submitClaim(req: ClaimSubmission): Promise<Result<SubmissionAck>>;

  /** 835: pull/receive a remittance, normalized to JSON. (Push arrives via webhook, same shape.) */
  fetchRemittance(ref: RemittanceRef): Promise<Result<NormalizedRemittance>>;

  /** 276/277 (later): claim status. Optional in v1. */
  claimStatus?(ref: ClaimRef): Promise<Result<ClaimStatus>>;
}

export interface Result<T> {
  ok: boolean; data?: T; error?: { code: string; message: string; retryable: boolean };
  raw?: string;           // original X12/JSON, stored ENCRYPTED for audit (never logged)
  source: "edi" | "portal" | "manual" | "mock";
}
```

### Normalized shapes (what modules consume — never raw X12)

```ts
export interface EligibilityResponse {
  eligibility: "active" | "inactive" | "unknown";
  benefits: BenefitSnapshot;                 // the shared domain type (doc 04)
  perFieldConfidence: Record<string, number>;// 271s are often partial → confidence per field
}
export interface NormalizedRemittance {
  traceNumber: string; payerName: string; method: string; checksum: string;
  totalPaid: Cents;
  claims: {
    claimNo: string; status: string; patient: string; memberId?: string;
    charged: Cents; paid: Cents; patientResp: Cents;
    adjustments: CasAdjustment[]; lines: { cdt: string; charged: Cents; paid: Cents;
      adjustments: CasAdjustment[]; rarc: string[] }[];
    balanced: boolean;
  }[];
  plb: { providerId: string; reason: string; amount: Cents }[];
}
```

## Implementations

```
platform/edi/
├── adapter.ts                 # interface + Result + normalized types
├── index.ts                   # factory: reads EDI_ADAPTER → returns the impl
├── mock/                      # EDI_ADAPTER=mock  (dev, tests, paper-EOB fallback)
│   ├── x12-271.ts             # ported edi271.ts (270 build + 271 parse)
│   ├── x12-835.ts             # ported era835.js (835 parse + balancing + reversal)
│   └── index.ts               # MockEdiAdapter: simulated payers → normalized JSON
└── vendors/
    └── <vendor>.ts            # P2: real clearinghouse; maps vendor JSON ↔ normalized shapes
```

- **MockEdiAdapter** wraps the donor codecs and simulated payers to produce identical normalized
  output to a real vendor — so the rest of the system is written once, against the interface.
- **Paper EOB fallback** (roadmap §6) reuses `x12-835`-style CAS synthesis for manual entry, then
  flows through the same normalization + posting pipeline.

## Security & reliability (mandatory, risk §3–5)

- **Webhook authenticity:** clearinghouse push (271/835 arrival) hits
  `POST /api/v1/webhooks/edi/:vendor` and is **signature-verified** before anything else; invalid →
  401. Verified payload is written to the outbox and processed by workers — never synchronously.
- **Idempotency:** normalized remittances dedupe on `(practice_id, trace_number)` at ingest — a
  redelivered 835 does not double-post (doc 03, risk §1.4).
- **Raw payloads** (`raw_271`, `raw_835`) are stored **encrypted**, segregated columns, tighter
  access tier than derived fields; never written to logs.
- **Retries/degradation:** `Result.error.retryable` drives worker backoff; a vendor outage degrades
  eligibility to the **manual-review queue**, it does not hang the request path.
- **BAA** with the clearinghouse before any PHI flows (risk §4).

## Swapping vendors

Add `vendors/<new>.ts` implementing `EdiAdapter`, map its JSON to the normalized shapes, set
`EDI_ADAPTER=<new>`. No module changes. A second vendor for coverage/redundancy is additive (risk §5).
