# Open Dental: the claim export for the revenue-leak audit

The audit needs one row per claim **sent** in the period, paid or not, under the number it was sent
with. Open Dental's standard reports do not produce that file; the query below does.

> **Status.** Written against Open Dental's published database schema (v26.2,
> `opendental.com/OpenDentalDocumentation26-2.xml`, read 2026-10-16). It has **not** been run against
> a live Open Dental database. The first time it is run at a practice, do the five-row check at the
> end before the audit reads the file.

## Why not the Outstanding Insurance Claims report

It is the report a practice will offer first, and the audit refuses it (and says why):

- It has **no claim number**. Open Dental sends each claim as `claim.ClaimIdentifier` in CLM01
  (default `PatNum/ClaimNum`, for example `3246/5412`), and the payer's 835 returns that value in
  CLP01. That is the only join between the two files.
- It has **no paid claims**. Prompt-pay interest is owed on claims that *were* paid late, so the
  filing date of every paid claim is needed.
- Its `Amount` is the fee billed, not what is still owed by the payer.

## Run it

1. **Reports → User Query.** Pasting a new query needs the *User Query Admin* permission. The query
   is a `SELECT`: it reads, and changes nothing.
2. Paste the query. Change the two dates: start early enough that a claim paid in the first 835 was
   sent inside the window (about 90 days before the first 835 is enough for most payers).
3. Set **Format** to **Raw**.
4. **Submit Query**, then **Export .txt** (tab-delimited) or **Export .csv**. The audit reads either
   as-is. No `--aging-columns` map is needed: the query names the columns the audit expects.
5. Save it straight to the encrypted location in `PILOT-PREREQUISITES.md` Part B. Never email it.

```sql
/* Mermaid revenue-leak audit: every claim sent in the window, paid or not, under the number it was
   sent with (X12 CLM01, which the payer's 835 returns as CLP01). Read-only. */
SET @FromDate = '2025-07-01', @ToDate = '2026-09-30';

SELECT
  c.ClaimIdentifier                                                 AS claim,
  ca.CarrierName                                                    AS payer,
  DATE_FORMAT(c.DateService, '%Y-%m-%d')                            AS service_date,
  DATE_FORMAT(COALESCE(DATE(f.DateTimeTrans), c.DateSentOrig), '%Y-%m-%d') AS submitted_date,
  (CASE WHEN f.Etype = 0 THEN 'electronic'
        WHEN f.Etype = 1 THEN 'paper'
        ELSE '' END)                                                AS channel,
  ROUND(c.ClaimFee, 2)                                              AS billed,
  (CASE WHEN c.ClaimStatus = 'R' THEN 0
        ELSE ROUND(c.InsPayEst, 2) END)                             AS balance
FROM claim c
INNER JOIN insplan ip ON ip.PlanNum = c.PlanNum
INNER JOIN carrier ca ON ca.CarrierNum = ip.CarrierNum
/* The claim's first transmission the clearinghouse did not reject: an e-claim (Etype 0) or a
   printed claim (Etype 1). AckCode 'R' is a rejection from the 997/999. */
LEFT JOIN etrans f ON f.EtransNum = (
  SELECT e.EtransNum
  FROM etrans e
  WHERE e.ClaimNum = c.ClaimNum
    AND e.Etype IN (0, 1)
    AND COALESCE(e.AckCode, '') <> 'R'
  ORDER BY e.DateTimeTrans, e.EtransNum
  LIMIT 1
)
WHERE c.ClaimType NOT IN ('PreAuth', 'Cap')
  AND c.DateSentOrig BETWEEN @FromDate AND @ToDate
ORDER BY c.DateSentOrig, c.ClaimNum;
```

## What each column is

| Column | Taken from | Read it as |
|---|---|---|
| `claim` | `claim.ClaimIdentifier` | X12 CLM01. Some clearinghouses alter it to keep it unique on their side; if the join check warns, compare one 835's CLP01 with this column. |
| `payer` | `carrier.CarrierName` | For reading the report only. Payers are matched from the 835, not from this name. |
| `service_date` | `claim.DateService` | |
| `submitted_date` | the date of the first transmission the clearinghouse did not reject; `claim.DateSentOrig` when none is recorded | A printed claim is dated when it was printed, not when it was mailed. |
| `channel` | `electronic` for an e-claim, `paper` for a printed one; blank when no transmission is recorded | Blank means prompt-pay is **not assessed** for that claim. It is never assumed. |
| `billed` | `claim.ClaimFee` | |
| `balance` | `0` once the claim is received (`ClaimStatus` `R`); otherwise `claim.InsPayEst` | What is still expected from the payer, not the fee. |

Left out on purpose: preauthorizations, capitation claims, and claims never sent (their
`DateSentOrig` is `0001-01-01`, outside any window).

Known limits:

- A claim the clearinghouse accepted and the **payer** later rejected still counts from that first
  transmission. Before acting on a prompt-pay finding, open the claim's Status History and confirm
  the payer received a clean claim on that date. Each finding already says the filing date must be
  provable.
- Claims sent before the practice moved to Open Dental have no transmission record. They get
  `DateSentOrig` (if it was carried over) and a blank channel.

## The five-row check, the first time

Before the audit reads the file:

1. Pick five rows: two paid, two still open, one printed if there is one.
2. Open each claim from the patient's Account module. Check the Misc tab's **Claim Identifier**
   against `claim`, the **Date Sent** against `submitted_date`, the fee against `billed`, and the
   status (Received or not) against `balance`.
3. Open one 835 from the same period. A paid claim's CLP01 must equal its `claim` value exactly.

If any of the five disagree, stop and fix the query before running the audit. Note which rows were
checked in the engagement record.
