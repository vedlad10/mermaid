# Pilot materials

| File | What it is |
|---|---|
| `ONE-PAGE-OFFER.md` | Draft offer for the first three practices: a free retrospective audit. Not yet sent. |
| `PILOT-PREREQUISITES.md` | What must be true before real data is read, and what the software still lacks. |
| `synthetic-audit/report.html` | **Open this one.** The report a practice would receive, built from **invented** data. Static: no script, no network. |
| `synthetic-audit/report.md` | The same report as Markdown. Every finding is labelled `[SYNTHETIC]`. |
| `synthetic-audit/worklist.csv` | One row per finding, with blank status / owner / notes columns, for a biller to work down in a spreadsheet. |
| `synthetic-audit/findings.json` | The same findings, machine-readable, with evidence, caveats, data checks and the SHA-256 of every input. |
| `synthetic-audit/ground-truth.json` | What the generator planted, and which claims were left deliberately clean. |
| `synthetic-audit/835/`, `aging.csv` | The invented input files. Real clearinghouse output has not been tested. |

## Re-generate

```bash
node scripts/revenue-leak-audit.ts --synthetic --out docs/pilot/synthetic-audit
node --test tests/leak-audit.test.ts
```

Output is deterministic: running it twice produces identical files.

## Real data (do not, until `PILOT-PREREQUISITES.md` Part A and B are satisfied)

```bash
node scripts/revenue-leak-audit.ts --era-dir <dir of .835 files> --aging <csv> \
  --state NJ --as-of 2026-09-30 --practice-label "<practice>" \
  --safeguards-attestation <file> --out <encrypted location OUTSIDE this repository>
```

- The attestation file must contain each line in `REQUIRED_ATTESTATIONS` (in
  `scripts/revenue-leak-audit.ts`) verbatim. Without it the command exits 3 and reads nothing.
- `--out` is required, and a path inside this repository is refused (exit 3): a real report is PHI.
- Optional: `--merchant-rate-bps 290` (2.9%) prices non-ACH payments; without it they are counted,
  not priced.

### The aging export

**What to ask the practice for.** Every claim *sent* in the period, paid or not, one row each, with
the claim number the practice sent (X12 CLM01: the payer's 835 returns it as CLP01). An "aging" or
"outstanding claims" report is not enough: it holds no paid claims (prompt-pay needs their filing
dates), and the ones checked so far carry no claim number at all.

| Practice software | Export | Status |
|---|---|---|
| Open Dental | The user query in [`exports/open-dental.md`](exports/open-dental.md) | Written against the published schema; not yet run on a live database |
| Open Dental, Outstanding Insurance Claims report | Refused, with a pointer to the query | No claim number, no paid claims |
| Dentrix | Not worked out. The Insurance Aging Report prints to PDF only | Open |
| Eaglesoft | Not worked out. Some reports export to CSV/XLS | Open |

Expected header: `claim,payer,service_date,submitted_date,channel,billed,balance`
(`submitted_date` and `channel` optional; dates `YYYY-MM-DD` or `M/D/YYYY`, a time after the date
is ignored; `channel` is `electronic` or `paper`). A practice-management export with its own column
names is mapped explicitly, never guessed:

```bash
--aging-columns "claim=Claim #;payer=Carrier;service_date=Service Date;submitted_date=Sent Date;billed=Billed Amount;balance=Balance"
```

If a required column is missing, the error lists the headers it found and the flag to use.

The **format** of a real export is read as it comes; its values never are guessed:

- comma- or tab-delimited (`.csv`, or Open Dental's and Excel's `.txt`), in UTF-8, UTF-16 (Excel's
  "Unicode Text") or Windows-1252;
- a title or date-range line above the header (the header must be within the first 30 lines);
- `Total` / `Subtotal` / `<carrier> Total` rows with no service date, and one-cell group headings
  such as a carrier's name;
- amounts as `$1,234.50` or, for a negative, `(12.50)`.

The command prints what it read, and the report's file list repeats it: the delimiter, the
encoding, the header line, and every line it left out by number. Check those lines once against the
file.

### What the command checks before you read a finding

Every report opens with **data checks**, and the command prints any that are not OK:

| Check | What it catches |
|---|---|
| Remittance files read | A truncated or non-835 file (a PDF EOB, say) is listed with its reason; the rest of the run continues. |
| Each payment counted once | The same ERA downloaded twice is counted once. Two copies of one payment that disagree are both set aside. |
| Advice arithmetic balances | Advices whose amounts do not close are never used as evidence. |
| Claim numbers join | How many remitted claims appear on the aging export. **None** means the two exports number claims differently: RESOLVE FIRST, exit 4. |
| Filing date and channel present | Without them, prompt-pay is not assessed for that claim. |

Exit codes: `0` written · `1` bad input (the message names the file, line or column) · `2` usage ·
`3` refused by a safeguard · `4` written, but a data check failed and the report must not be shown
to anyone until it is resolved.

## What the numbers are

`estimated recoverable`, `at stake` and `avoidable cost` are three different kinds of number and the
report never adds them. None is money recovered.
