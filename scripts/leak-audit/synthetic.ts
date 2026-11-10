/**
 * A fictional practice's nine months of remittances, built so the audit has something to find and a
 * ground-truth manifest says exactly what.
 *
 * EVERYTHING HERE IS INVENTED. The payer names are real companies so that the payer-profile matching
 * is exercised, but no rate, claim, patient or date below describes any real payer's behaviour, and
 * nothing in this file is evidence about any real insurer. The leaks are planted by this generator;
 * the audit finding them proves the audit's logic, not that such leaks exist in the world.
 *
 * Deterministic: no clock, no randomness. The same call returns byte-identical files, so a report
 * built from it can be regenerated and diffed.
 */
import { build835, type Build835Claim } from "../../platform/edi/mock/x12-835.ts";
import type { AgingRow, AuditContext } from "./engine.ts";

export interface SyntheticAdvice {
  /** Pseudo file name, e.g. `2026-03-12_Cigna-Dental_EFT000000007.835`. */
  file: string;
  raw: string;
}

export interface GroundTruth {
  /** Claim references the audit MUST flag, by category. */
  expected: { category: string; claim: string | null; cents: number | null; confidence: string }[];
  /** Claim references that are deliberately clean, or deliberately refused, and MUST stay unflagged. */
  mustStayQuiet: { claim: string; why: string }[];
  /** Exclusions the audit must report. */
  expectedExclusionCounts: { area: string; count: number }[];
}

export interface SyntheticDataset {
  context: AuditContext;
  advices: SyntheticAdvice[];
  aging: AgingRow[];
  truth: GroundTruth;
}

interface Planned {
  claim: string;
  payer: string;
  code: string;
  charged: number; // dollars
  allowed: number; // dollars; ignored for denials
  coinsurance: number; // 0..1 of allowed
  serviceDate: string;
  submittedOn: string;
  paidOn: string;
  channel: "electronic" | "paper";
  method?: string;
  denial?: string; // CARC, CO group
  l6?: boolean;
  /** Ordering key inside an advice; set by the builder. */
  tag?: string;
}

const addDays = (day: string, n: number): string => {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

const CHARGE: Record<string, number> = { D2740: 1200, D1110: 150, D4341: 280, D2391: 260, D2140: 150, D0120: 90 };
const COINS: Record<string, number> = { D2740: 0.2, D1110: 0, D4341: 0.2, D2391: 0.2, D2140: 0.2, D0120: 0 };
const RATE: Record<string, Record<string, number>> = {
  "Cigna Dental": { D2740: 900, D1110: 110, D4341: 210 },
  "Delta Dental": { D2740: 850, D1110: 105, D2391: 160, D2140: 100 },
  "MetLife Dental": { D2740: 880, D1110: 108, D0120: 62 },
};

export function buildSyntheticDataset(): SyntheticDataset {
  const planned: Planned[] = [];
  let n = 0;
  const ref = (): string => `SYN-${String((n += 1)).padStart(4, "0")}`;

  // Baseline: six clean, on-time claims per payer × code, spread Feb–Aug. These establish the
  // contracted rates and are the noise the audit must not flag.
  const baselineDates = ["2026-02-03", "2026-03-10", "2026-04-14", "2026-05-12", "2026-06-09", "2026-07-07"];
  const quiet: { claim: string; why: string }[] = [];
  for (const [payer, codes] of Object.entries(RATE)) {
    for (const [code, allowed] of Object.entries(codes)) {
      // MetLife D2740 is the late-payer scenario (C) and Delta D2391 gets only five baselines (B).
      const count = payer === "Delta Dental" && code === "D2391" ? 5 : 6;
      for (let i = 0; i < count; i += 1) {
        const service = baselineDates[i]!;
        const submitted = addDays(service, 1);
        const late = payer === "MetLife Dental" && code === "D2740";
        const paid = addDays(submitted, late ? 55 : 14 + (i % 8));
        const p: Planned = {
          claim: ref(),
          payer,
          code,
          charged: CHARGE[code]!,
          allowed,
          coinsurance: COINS[code]!,
          serviceDate: service,
          submittedOn: submitted,
          paidOn: paid,
          channel: "electronic",
        };
        planned.push(p);
        if (!late) quiet.push({ claim: p.claim, why: "paid the contracted rate inside the statutory window" });
      }
    }
  }
  const baselineCount = planned.length;

  const expected: GroundTruth["expected"] = [];

  // C. MetLife D2740, six claims paid 55 days after electronic filing (NJ allows 30).
  for (const p of planned.filter((x) => x.payer === "MetLife Dental" && x.code === "D2740")) {
    const paidCents = Math.round(p.allowed * (1 - p.coinsurance) * 100);
    expected.push({
      category: "prompt-pay-interest",
      claim: p.claim,
      cents: Math.round((paidCents * 1200 * 25) / 10_000 / 365),
      confidence: "medium",
    });
  }

  // D-refusal: one Cigna D2740 claim paid 52 days late, but the advice carried provider-level
  // interest (PLB L6). The engine must NOT claim interest the payer already paid.
  const cignaD2740 = planned.filter((x) => x.payer === "Cigna Dental" && x.code === "D2740");
  const l6 = cignaD2740[0]!;
  l6.paidOn = addDays(l6.submittedOn, 52);
  l6.l6 = true;
  quiet.splice(
    quiet.findIndex((q) => q.claim === l6.claim),
    1,
    { claim: l6.claim, why: "52 days to pay, but the advice carried provider-level interest (PLB L6): already paid" }
  );

  // Paper channel: 38 days is inside the 40 days a paper claim is allowed.
  const paper = planned.find((x) => x.payer === "Delta Dental" && x.code === "D1110")!;
  paper.channel = "paper";
  paper.paidOn = addDays(paper.submittedOn, 38);
  quiet.splice(
    quiet.findIndex((q) => q.claim === paper.claim),
    1,
    { claim: paper.claim, why: "paper claim paid in 38 days against a 40-day window" }
  );

  // A. Cigna D2740 paid at $810 against a $900 rate, three times, in August.
  const underpaid: Planned[] = [];
  for (const [i, service] of ["2026-08-04", "2026-08-11", "2026-08-18"].entries()) {
    const p: Planned = {
      claim: ref(),
      payer: "Cigna Dental",
      code: "D2740",
      charged: 1200,
      allowed: 810,
      coinsurance: 0.2,
      serviceDate: service,
      submittedOn: addDays(service, 1),
      paidOn: addDays(service, 17),
      channel: "electronic",
    };
    underpaid.push(p);
    planned.push(p);
    expected.push(
      i < 2
        ? { category: "underpayment-vs-learned-rate", claim: p.claim, cents: 9000, confidence: "high" }
        : { category: "rate-drift", claim: p.claim, cents: 9000, confidence: "medium" }
    );
  }

  // B. Delta D2391 paid at the D2140 amalgam rate ($100) against $160, twice.
  for (const service of ["2026-08-06", "2026-08-20"]) {
    const p: Planned = {
      claim: ref(),
      payer: "Delta Dental",
      code: "D2391",
      charged: 260,
      allowed: 100,
      coinsurance: 0.2,
      serviceDate: service,
      submittedOn: addDays(service, 1),
      paidOn: addDays(service, 19),
      channel: "electronic",
    };
    planned.push(p);
    expected.push({ category: "alternate-benefit-downgrade", claim: p.claim, cents: 6000, confidence: "medium" });
  }

  // D. Delta pays three single-claim advices by cheque after paying ACH. Fee unknown on purpose.
  const cheques = planned.filter((x) => x.payer === "Delta Dental" && x.code === "D1110").slice(1, 4);
  for (const p of cheques) {
    p.method = "CHK";
    p.paidOn = addDays(p.submittedOn, 20);
    quiet.splice(
      quiet.findIndex((q) => q.claim === p.claim),
      1
    );
    expected.push({ category: "non-ach-payment", claim: null, cents: null, confidence: "low" });
  }

  // E. Denials. Three administrative (CO-16) with a learned Cigna rate; one judgment (CO-50) at
  //    Delta; one CO-29 (timely filing), which is excluded rather than flagged.
  const denial = (payer: string, code: string, service: string, carc: string): Planned => {
    const p: Planned = {
      claim: ref(),
      payer,
      code,
      charged: CHARGE[code]!,
      allowed: 0,
      coinsurance: 0,
      serviceDate: service,
      submittedOn: addDays(service, 1),
      paidOn: addDays(service, 16),
      channel: "electronic",
      denial: carc,
    };
    planned.push(p);
    return p;
  };
  for (const [code, service] of [["D2740", "2026-07-14"], ["D4341", "2026-07-21"], ["D1110", "2026-08-25"]] as const) {
    const p = denial("Cigna Dental", code, service, "16");
    expected.push({ category: "denial-administrative", claim: p.claim, cents: Math.round(RATE["Cigna Dental"]![code]! * 100), confidence: "medium" });
  }
  const medNecessity = denial("Delta Dental", "D2740", "2026-07-28", "50");
  expected.push({ category: "denial-judgment", claim: medNecessity.claim, cents: 85_000, confidence: "low" });
  denial("MetLife Dental", "D0120", "2026-03-30", "29");

  // F. Silent claims: on the aging report, on no advice.
  const aging: AgingRow[] = [];
  const silent: { payer: string; submitted: string; balance: number; keep: boolean }[] = [
    { payer: "Cigna Dental", submitted: "2026-04-10", balance: 1200_00, keep: true },
    { payer: "Delta Dental", submitted: "2026-05-02", balance: 260_00, keep: true },
    { payer: "MetLife Dental", submitted: "2026-06-18", balance: 280_00, keep: true },
    { payer: "Aetna Dental", submitted: "2026-07-20", balance: 1200_00, keep: true },
    { payer: "Cigna Dental", submitted: "2026-08-03", balance: 150_00, keep: true },
    { payer: "Delta Dental", submitted: "2026-09-20", balance: 1200_00, keep: false }, // 10 days old: too young
  ];
  for (const s of silent) {
    const claim = ref();
    aging.push({
      claim,
      payer: s.payer,
      serviceDate: addDays(s.submitted, -1),
      submittedOn: s.submitted,
      channel: "electronic",
      billedCents: s.balance,
      balanceCents: s.balance,
    });
    if (s.keep) expected.push({ category: "silent-claim", claim, cents: s.balance, confidence: "low" });
    else quiet.push({ claim, why: "open only 10 days: not yet silent" });
  }

  // ── Render advices: one per payer × paid day × method ────────────────────────────────────────
  const groups = new Map<string, Planned[]>();
  for (const p of planned) {
    const key = `${p.paidOn}|${p.payer}|${p.method ?? "ACH"}|${p.l6 ? p.claim : ""}|${p.method === "CHK" ? p.claim : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const advices: SyntheticAdvice[] = [];
  let traceN = 0;
  for (const [key, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [paidOn, payer, method] = key.split("|") as [string, string, string];
    traceN += 1;
    const trace = `EFT${String(traceN).padStart(9, "0")}`;
    const claims: Build835Claim[] = [];
    let total = 0;
    for (const p of members) {
      if (p.denial) {
        claims.push({
          patientControlNumber: p.claim,
          statusCode: "4",
          charged: p.charged,
          paid: 0,
          patientResponsibility: 0,
          payerControlNumber: `PC${p.claim}`,
          patientFirstName: "Synthetic",
          patientLastName: "Patient",
          memberId: `SYN${p.claim.slice(4)}`,
          lines: [
            {
              procedureCode: p.code,
              charged: p.charged,
              paid: 0,
              quantity: 1,
              adjustments: [{ group: "CO", code: p.denial, amount: p.charged }],
            },
          ],
        });
        continue;
      }
      const cents = Math.round(p.allowed * 100);
      const pr = Math.round(cents * p.coinsurance);
      const paid = cents - pr;
      const co = Math.round(p.charged * 100) - cents;
      total += paid;
      const adjustments = [{ group: "CO", code: "45", amount: co / 100 }];
      if (pr > 0) adjustments.push({ group: "PR", code: "2", amount: pr / 100 });
      claims.push({
        patientControlNumber: p.claim,
        statusCode: "1",
        charged: p.charged,
        paid: paid / 100,
        patientResponsibility: pr / 100,
        payerControlNumber: `PC${p.claim}`,
        patientFirstName: "Synthetic",
        patientLastName: "Patient",
        memberId: `SYN${p.claim.slice(4)}`,
        lines: [{ procedureCode: p.code, charged: p.charged, paid: paid / 100, quantity: 1, adjustments }],
      });
    }
    const hasL6 = members.some((m) => m.l6);
    const raw = build835(
      {
        payerName: payer,
        payeeName: "SYNTHETIC DENTAL PRACTICE",
        payeeNpi: "1234567893",
        traceNumber: trace,
        paymentTotal: (total + (hasL6 ? 50 : 0)) / 100,
        paymentDate: paidOn,
        paymentMethod: method,
        claims,
        ...(hasL6
          ? { providerAdjustments: [{ providerId: "1234567893", reasonCode: "L6", referenceId: members[0]!.claim, amount: -0.5 }] }
          : {}),
      },
      new Date(`${paidOn}T00:00:00Z`)
    );
    advices.push({ file: `${paidOn}_${payer.replace(/\s+/g, "-")}_${trace}.835`, raw });
  }

  for (const p of planned) {
    const paidIn = p.denial ? 0 : Math.round(p.allowed * 100 * (1 - p.coinsurance));
    void paidIn;
    aging.push({
      claim: p.claim,
      payer: p.payer,
      serviceDate: p.serviceDate,
      submittedOn: p.submittedOn,
      channel: p.channel,
      billedCents: Math.round(p.charged * 100),
      balanceCents: p.denial ? Math.round(p.charged * 100) : 0,
    });
  }

  const context: AuditContext = {
    practiceLabel: "Synthetic Dental Practice — fictional, not a real practice",
    state: "NJ",
    asOf: "2026-09-30",
    merchantRateBps: null,
    synthetic: true,
  };
  void baselineCount;
  return {
    context,
    advices,
    aging,
    truth: {
      expected,
      mustStayQuiet: quiet,
      expectedExclusionCounts: [{ area: "Denials", count: 1 }],
    },
  };
}
