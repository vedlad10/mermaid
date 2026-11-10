// demo-verify.mjs — one-command clinic demo of the deterministic verification pipeline.
// Run: npm run demo:verify
//
// No database, no live payer — the mock EDI adapter runs the PRODUCTION 271 parser, so this is the
// exact code path a live clearinghouse integration uses. Shows: paste a card → verify → estimate →
// human-routing decision → patient-ready summary + printable report.
import { runVerification, decideVerification, plainEnglishEstimate } from "@mermaid/verification";
import { getEdiAdapter } from "@mermaid/edi";
import { cents } from "@mermaid/shared";

const adapter = getEdiAdapter(); // EDI_ADAPTER=mock by default (swap to a vendor with one env var)
const now = new Date("2026-07-15T12:00:00Z");

const procedures = [
  { code: "D0120", quantity: 1 },                 // periodic exam (diagnostic, 100%)
  { code: "D1110", quantity: 1, fee: cents(110) }, // cleaning (preventive)
  { code: "D2740", quantity: 1, fee: cents(1250) }, // crown (major, 50%)
];

const scenarios = [
  { title: "Active member — clean auto-verify", memberId: "ABC12345", card: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100" },
  { title: "Inactive coverage — routed to a human", memberId: "MEM10000", card: "Delta Dental\nMember ID: MEM10000" },
  { title: "Waiting period on major — crown denied", memberId: "MEM10077", card: "Delta Dental\nMember ID: MEM10077" },
  { title: "Unknown payer — blocked, verify manually", memberId: "ABC12345", card: "Obscure Plan Co\nMember ID: ABC12345" },
];

for (const s of scenarios) {
  const rec = await runVerification(
    { patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-01-01", memberId: s.memberId }, cardText: s.card, planItems: procedures },
    adapter,
    now
  );
  const decision = decideVerification(rec, now);

  console.log("\n" + "=".repeat(72));
  console.log(`SCENARIO: ${s.title}`);
  console.log("=".repeat(72));
  console.log(`Status        : ${rec.status.toUpperCase()}   (confidence ${rec.confidence.overall})`);
  console.log(`Decision      : ${decision.outcome}  →  ${decision.recommendedAction}`);
  console.log(`Can share est.: ${decision.canNotifyPatient ? "yes (a human delivers it)" : "no"}   priority ${decision.priority}`);
  const summary = plainEnglishEstimate(rec);
  if (summary.length) console.log(`Patient words : ${summary.join(" ")}`);
  if (rec.exceptions.length) console.log(`Flags         : ${rec.exceptions.map((e) => `[${e.severity}] ${e.code}`).join(", ")}`);
}

console.log("\n" + "-".repeat(72));
console.log("Full printable report for scenario 1:\n");
const rec1 = await runVerification(
  { patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-01-01", memberId: "ABC12345" }, cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100", planItems: procedures },
  adapter,
  now
);
console.log(rec1.reportText);
