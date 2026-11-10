/**
 * Mutation testing for the money-partition laws.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 * `buildPartition` now checks its own output against I1, I3 and I4 and throws when one breaks. On
 * today's code that check CANNOT fire: each of those laws is a tautology of the derivation, so no
 * input makes them fail. A guard that never fires is indistinguishable from a guard that is not
 * there — which is exactly the failure this codebase keeps finding (an offline invariant script
 * nothing on the money path called; a probe that reported `SET ROLE` refusals as the database
 * refusing a write; a test called "append-only by grant" that asserted a policy, not a grant).
 *
 * So the guard is proven the only way a never-firing guard can be: break the construction on
 * purpose, and require that each break DIES. A mutant that survives is a law that is stated but not
 * enforced, and this script exits non-zero for it.
 *
 * ── WHY IT MUTATES THE FILE ON DISK ──────────────────────────────────────────────────────────────
 * The production call path (`computeVariance` → `@mermaid/shared`) resolves through the workspace,
 * so a mutant has to be visible to the real module graph to be exercised by the real caller. Each
 * mutant is applied, run in a child process, and reverted in a `finally`; the original text is held
 * in memory AND written to a sibling `.mutation-backup`, so an interrupted run can be recovered
 * rather than leaving mutated source behind. The script refuses to start if that file already
 * exists, which is precisely what an interrupted run leaves.
 *
 * Usage: node scripts/mutation-partition.mjs
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(HERE, "../packages/shared/src/domain/partition.ts");
const BACKUP = `${TARGET}.mutation-backup`;
const PROBE = resolve(HERE, "../packages/shared/src/__tests__/.mutation-probe.mjs");

if (existsSync(BACKUP)) {
  console.error(
    `A backup already exists at ${BACKUP}.\n` +
      "A previous run was interrupted with the source mutated. Restore it before running again:\n" +
      `  mv "${BACKUP}" "${TARGET}"`
  );
  process.exit(2);
}

const ORIGINAL = readFileSync(TARGET, "utf8");

/**
 * ── THE ANCHORS HAVE TO SURVIVE CRLF ─────────────────────────────────────────────────────────────
 * This checkout stores the file with CRLF line endings, so a multi-line anchor written with plain
 * newlines matches nothing. The first version of this script hit exactly that: two I4 mutants
 * reported "anchor appears 0 times" — which, had the count not been asserted, would have run an
 * UNMUTATED file and reported both as killed. A mutation that fails to apply is indistinguishable
 * from a mutant that died, and that is the same false-pass shape this script exists to prevent.
 *
 * So anchors are matched against a newline-normalised copy and written back in the file's own
 * ending, and the occurrence count is asserted rather than assumed.
 */
const CRLF = ORIGINAL.includes("\r\n");
const NORMAL = ORIGINAL.split("\r\n").join("\n");
const toSource = (text) => (CRLF ? text.split("\n").join("\r\n") : text);

/** Each mutant breaks the construction in a way a plausible edit could. */
const MUTANTS = [
  {
    law: "I1",
    what: "allowed is derived by ADDING the contractual write-off instead of subtracting it",
    find: "    allowed: subCents(input.charged, input.contractual),",
    replace: "    allowed: addCents(input.charged, input.contractual),",
  },
  {
    law: "I1",
    what: "allowed is taken straight from the charge, ignoring the write-off",
    find: "    allowed: subCents(input.charged, input.contractual),",
    replace: "    allowed: input.charged,",
  },
  {
    law: "I3",
    what: "the residual is clamped to zero, discarding an overpayment — the pre-partition bug",
    find: "    overpayment: (gap < 0 ? -gap : 0) as Cents,",
    replace: "    overpayment: 0 as Cents,",
  },
  {
    law: "I3",
    what: "both halves of the residual are populated, so a shortfall is also an overpayment",
    find: "    unexplained: (gap > 0 ? gap : 0) as Cents,",
    replace: "    unexplained: Math.abs(gap) as Cents,",
  },
  {
    law: "I4",
    what: "coordination is dropped from accountedFor, inventing an unexplained shortfall on COB",
    find: "    p.coordination,\n    p.recoverable,",
    replace: "    p.recoverable,",
  },
  {
    law: "I4",
    what: "informational is dropped from accountedFor — the shortfall the module comment warns about",
    find: "    p.recoverable,\n    p.informational\n",
    replace: "    p.recoverable\n",
  },
];

/**
 * The probe drives the PRODUCTION caller, not `buildPartition` directly.
 *
 * Calling `buildPartition` would prove the check exists inside the function; calling
 * `computeVariance` proves it is reached on the path a remittance actually takes. The distinction is
 * the entire point — these laws were always enforced somewhere, just never there.
 *
 * ── WHY THREE FIXTURES AND NOT ONE ───────────────────────────────────────────────────────────────
 * The first version used a single claim whose buckets summed exactly to the charge. Its residual was
 * therefore zero, and BOTH I3 mutants survived — clamping `overpayment` to zero changes nothing when
 * the overpayment is already zero, and `Math.abs(0)` is `0`. The mutants were fine; the fixture
 * could not tell the difference, which made the run a green light over an untested law.
 *
 * A residual has three possible signs and each one exercises a different half of the split, so all
 * three are run and a mutant must die on at least one. `balanced` still earns its place: it is the
 * case that must NOT throw, so a mutant which simply makes `buildPartition` throw unconditionally
 * cannot pass itself off as a working guard.
 */
const PROBE_SOURCE = `import { computeVariance } from "../../../../modules/remittance/src/engine/variance.ts";

const claim = (paidAmount, adjustments) => ({
  chargedAmount: 100000,
  paidAmount,
  patientResponsibility: 20000,
  adjustments,
});

const CASES = [
  // accountedFor === charged: residual 0, the case that must stay clean.
  ["balanced", claim(60000, [
    { category: "contractual", amount: 15000, code: "45", group: "CO" },
    { category: "patient", amount: 20000, code: "2", group: "PR" },
    { category: "coordination", amount: 3000, code: "23", group: "OA" },
    { category: "informational", amount: 2000, code: "94", group: "OA" },
  ])],
  // accountedFor < charged: a positive residual — money that went missing (unexplained).
  ["shortfall", claim(40000, [
    { category: "contractual", amount: 15000, code: "45", group: "CO" },
    { category: "patient", amount: 20000, code: "2", group: "PR" },
  ])],
  // accountedFor > charged: a negative residual — more arrived than the charge absorbs (overpayment).
  ["overpaid", claim(90000, [
    { category: "contractual", amount: 15000, code: "45", group: "CO" },
    { category: "patient", amount: 20000, code: "2", group: "PR" },
  ])],
];

const outcomes = [];
for (const [name, paid] of CASES) {
  try {
    computeVariance(paid, 60000);
    outcomes.push(name + "=survived");
  } catch (e) {
    outcomes.push(name + "=" + (e && e.name === "PartitionLawViolated" ? "killed" : "OTHER(" + (e && e.message) + ")"));
  }
}
// The mutant dies if ANY case caught it; the run is clean only if EVERY case survived.
const anyKilled = outcomes.some((o) => o.endsWith("=killed"));
const anyOther = outcomes.some((o) => o.includes("=OTHER("));
console.log((anyOther ? "OTHER" : anyKilled ? "KILLED" : "SURVIVED") + " :: " + outcomes.join(" "));
`;

writeFileSync(PROBE, PROBE_SOURCE);

const runProbe = () => {
  try {
    return execFileSync(process.execPath, ["--experimental-strip-types", PROBE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    /** A mutant that does not compile is not a killed mutant — it is a mutant that proves nothing. */
    return `UNCOMPILABLE :: ${String(e.stderr || e.message).split("\n")[0].slice(0, 120)}`;
  }
};

let survived = 0;
let killed = 0;
try {
  writeFileSync(BACKUP, ORIGINAL);

  /**
   * The unmutated file must SURVIVE every case. Without this the whole run is unfalsifiable: if the
   * probe threw for an unrelated reason — a bad fixture, an import error — every mutant would report
   * KILLED and the script would pass while testing nothing.
   */
  const baseline = runProbe();
  if (!baseline.startsWith("SURVIVED")) {
    console.error(`baseline is not clean: probe reported "${baseline}" on unmutated source`);
    process.exit(3);
  }
  console.log(`baseline: clean source passes every case\n          ${baseline}\n`);

  for (const m of MUTANTS) {
    const occurrences = NORMAL.split(m.find).length - 1;
    if (occurrences !== 1) {
      console.log(`  NOT APPLIED  ${m.law}  ${m.what}`);
      console.log(`               anchor appears ${occurrences} times, expected exactly 1`);
      survived++;
      continue;
    }
    try {
      writeFileSync(TARGET, toSource(NORMAL.replace(m.find, m.replace)));
      const result = runProbe();
      if (result.startsWith("KILLED")) {
        killed++;
        console.log(`  killed       ${m.law}  ${m.what}`);
        console.log(`               ${result.split(" :: ")[1] ?? ""}`);
      } else {
        survived++;
        console.log(`  SURVIVED     ${m.law}  ${m.what}`);
        console.log(`               ${result}`);
      }
    } finally {
      writeFileSync(TARGET, ORIGINAL);
    }
  }
} finally {
  writeFileSync(TARGET, ORIGINAL);
  if (readFileSync(TARGET, "utf8") !== ORIGINAL) {
    console.error("\nFAILED TO RESTORE the original source — recover it from the backup, do not commit.");
    process.exit(4);
  }
  if (existsSync(BACKUP)) unlinkSync(BACKUP);
  if (existsSync(PROBE)) unlinkSync(PROBE);
}

console.log(`\n${killed} killed, ${survived} survived, of ${MUTANTS.length} mutants`);
if (survived > 0) {
  console.error(
    "A surviving mutant means the production path accepts a partition that breaks its own law — " +
      "the law is stated but not enforced."
  );
  process.exitCode = 1;
} else {
  console.log("Every break in the construction is caught on the production money path.");
}
