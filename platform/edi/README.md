# platform/edi

## Adapters

| `EDI_ADAPTER` | Eligibility (270/271) | Claims (837D/277CA) | Remittance (835) |
|---|---|---|---|
| `mock` (default) | ✅ ported X12 codecs | ✅ | ✅ |
| `stedi` | ✅ **real clearinghouse** | ❌ refuses | ❌ refuses |

**`stedi` is eligibility-only today, and refuses the money paths loudly rather than delegating to the
mock.** Filing a claim is a legal attestation to a payer and posting a remittance moves money;
neither may run through a vendor path nobody has built or tested. The refusal is non-retryable so the
outbox cannot queue a claim submission against it forever.

### Stedi

`vendors/stedi/client.ts` is transport only — it moves bytes and classifies failures. `vendors/stedi/index.ts`
maps the result into Mermaid's model. **Stedi returns the payer's actual X12 271 and that 271 goes
through `parse271`** — the same production parser the mock has always fed. There is no second
eligibility engine: payer identification, the estimate calculator, confidence aggregation, the review
gate and the audit trail all sit downstream and cannot tell where the 271 came from.

If Stedi returns a body with no `x12`, that is a parse error — *not* an invitation to rebuild
benefits from Stedi's JSON summary. Two readers of one payer response is exactly the second
interpreter this seam exists to prevent.

**Tier-2 fields are empty on a real check.** Waiting periods, frequency limits and exclusions are
payer-portal data that a 271 cannot carry. The mock fills them from its profile because it stands in
for the payer's whole system; the real adapter must not, because inventing "no waiting periods"
would let an estimate quote a patient for a crown that is actually inside a twelve-month wait. The
per-field confidence reports 0 for them so the review gate can see it.

**The test/production interlock.** Stedi issues separate test and production keys, and a test key
returns mock benefits that look exactly like real ones. So the adapter refuses to construct unless
`STEDI_TEST_MODE` and the key's `test_` prefix agree, and refuses any response whose
`meta.applicationMode` disagrees with the mode it believes it is in.

**Verify the live connection:** `npm run stedi:check` — drives the real adapter against Stedi TEST
using Stedi's published mock subscriber. It refuses to run unless the adapter is in test mode.


Swappable EDI clearinghouse adapter (270/271/837/835 → normalized JSON). `EDI_ADAPTER=mock` uses the ported X12 codecs (edi271/era835) as the dev + paper-EOB fallback; a real vendor is wired at P2. EDI is bought, not built (roadmap §1,§7).
