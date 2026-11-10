# Mermaid — product truth

## What it is
A revenue-cycle operating system for dental practices. It follows one thing end to end: the money a
practice is owed, from the moment coverage is checked to the moment the last dollar is collected or
written off.

## The mechanism nothing else has
Mermaid holds the *whole* cycle in one ledger. Verification, claim, payer remittance, denial, appeal
and patient balance are not six tools reporting to each other — they are one chain of domain events,
and every figure on every screen is derived from that chain rather than re-entered. That is why the
product can say *why* a number is what it is, and why a contradiction between two screens is a bug
rather than a difference of opinion.

## Who uses it
A practice owner or office manager, usually mid-morning between patients, on a laptop at a cramped
front desk under fluorescent light — and increasingly on a phone. They are not analysts. They are
deciding what to chase today. They are interrupted constantly.

## The eight surfaces
| Screen | The question it answers |
|---|---|
| Today | What needs a person right now? |
| Verify | Whose coverage has been checked, and what did it say? |
| Claims | What has been filed, and where is it stuck? |
| Money | What has the payer actually sent, and what is held? |
| Recover | What was denied, and what is worth appealing? |
| Patients | Who owes us, how much, and how old is it? |
| Insights | Is the practice's revenue cycle healthy? |
| Ops | Is the machine itself working? |

## Product truths that outrank any visual decision
- **Money is integer cents.** Never a float, never rounded for display without saying so.
- **Colour on a figure is a claim about that money.** Five states, one meaning each: settled (cash
  arrived), open (expected, on track — the quiet default), attention (a person must act), lost
  (withheld and not recovered), zero (nothing here). Nothing else may colour a figure.
- **An account keyed by member ID is a POLICY.** A family plan is one policy over several people.
  People and policies are different counts and must never be presented as the same number.
- **Appeal recoveries are netted out of estimate accuracy.** Left in, they invert the sign.
- **Provenance is part of the number.** Live / test / mock data are labelled, never blended silently.
- **Nothing is fabricated.** No illustrative money, no synthetic trend, no placeholder chart.

## Constraints
- Vanilla ES modules served static. No client build step, no framework.
- `script-src 'self'` and `style-src 'self'`: inline `style=` attributes are dropped by CSP.
  Every data-driven visual must therefore be SVG using geometry *attributes*, not CSS lengths.
- Self-hosted Inter Variable + JetBrains Mono. No external font or asset host.
- Must work at 393 / 768 / 1280 / 1440.
