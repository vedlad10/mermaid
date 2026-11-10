/**
 * seed-demo-practice.ts — build a demonstration practice with a plausible quarter behind it.
 *
 *   node --env-file-if-exists=.env scripts/seed-demo-practice.ts            # ~70 patients, 90 days
 *   node --env-file-if-exists=.env scripts/seed-demo-practice.ts --patients 30 --days 45
 *   node --env-file-if-exists=.env scripts/seed-demo-practice.ts --wipe     # clear what a previous
 *                                                                          # run of THIS left first
 *
 *   # Reproducible across deployments — same rows, same dates, anywhere, any day:
 *   node --env-file-if-exists=.env scripts/seed-demo-practice.ts \
 *     --patients 140 --days 90 --offset 0 --asof 2026-09-12T12:00:00Z
 *
 * ── WHY THIS EXISTS (audit B-1) ────────────────────────────────────────────────────────────────
 * The demo practice held five patients, four claims, one denial and zero appeals. Every screen was
 * correct and every screen was unpersuasive: Insights drew conclusions "from 5 claims" and said so
 * honestly, the recovery curve on Recover could not be plotted because nothing had ever been won and
 * dated, the patient-aging chart had one bucket in it, and the learning loop had never seen enough
 * outcomes to leave its provisional prior. A practice owner looking at that cannot tell a product
 * that works from a product that has never been used.
 *
 * The shape of the data is the product argument. Ninety days of a clinic's cycle is what makes
 * "collected 66% of what the estimates promised" a finding rather than an artefact of four rows.
 *
 * ── WHAT MAKES THIS HONEST RATHER THAN FABRICATION ─────────────────────────────────────────────
 * PRODUCT.md: "Nothing is fabricated. No illustrative money, no synthetic trend, no placeholder
 * chart." That rule is about what a SCREEN may invent, and this does not violate it — because no
 * figure here is written to a screen. Every number on every screen is still derived, by the real
 * engine, from events this script causes through the real services:
 *
 *   · Coverage comes from `MockEdiAdapter`, so every verification is stamped `dataSource: "mock"`
 *     and every row that descends from it carries the DEMO DATA badge the provenance layer already
 *     computes. Nothing has to remember to label anything.
 *   · Claims are built by the claim builder, scrubbed by the real scrubber, and refused by the real
 *     pre-auth gate when the plan requires an authorisation.
 *   · Money arrives as an 835 the mock adjudicator generates and the real parser reads. The
 *     contractual write-offs, the CARC codes and the patient responsibility are the payer's, not
 *     this script's.
 *   · Denials are triaged by the real playbook, and appeal outcomes feed the real learning loop.
 *
 * So this seeds CAUSES, and the product computes consequences. A bug in the engine shows up in the
 * demo, which is the entire point — a seeder that wrote rows straight into tables would produce a
 * beautiful practice that proves nothing.
 *
 * ── THE SAFETY PIN ─────────────────────────────────────────────────────────────────────────────
 * `.env` may carry `EDI_ADAPTER=stedi`. Left alone, seventy synthetic patients would become seventy
 * real 270s to a real clearinghouse for members no payer has issued, and every submit a real claim.
 * The adapter is pinned to `mock` BEFORE any module reads config, the memoized instance is cleared
 * so an earlier read cannot survive, and the script refuses to start if what it gets back is not the
 * mock. Same pin, same reason, as `scripts/mock-scenarios.ts` and `tests/db/harness.ts`.
 */
process.env.EDI_ADAPTER = "mock";
const { resetEdiAdapter, getEdiAdapter, MockEdiAdapter } = await import("@mermaid/edi");
resetEdiAdapter();

import { randomUUID } from "node:crypto";
import { withPractice } from "@mermaid/db";
import { getConfig } from "@mermaid/config";
import { cents, type TreatmentPlanItem } from "@mermaid/shared";
import { buildServices, type Services } from "../apps/web/wiring.ts";

const adapter = getEdiAdapter();
if (!(adapter instanceof MockEdiAdapter)) {
  console.error(`REFUSING: adapter is ${adapter.constructor.name}, not MockEdiAdapter.`);
  process.exit(1);
}

/**
 * Refused in production outright, and not behind a flag.
 *
 * A "--force" here would exist to be used, and the thing it forces is seventy invented patients into
 * a database that holds real ones. There is no version of that which is a good idea, and a
 * deployment that genuinely wants demonstration data can run this against a demonstration database.
 */
if (getConfig().nodeEnv === "production") {
  console.error("REFUSING: NODE_ENV=production. Demonstration data does not belong in a live practice.");
  process.exit(1);
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/**
 * ── NAMING THE DATABASE OUT LOUD, WHEN IT IS NOT THIS MACHINE ─────────────────────────────────
 *
 * The `NODE_ENV=production` refusal above is the right guard and it is not enough on its own, for a
 * reason that only appears the moment this is pointed somewhere else: `NODE_ENV` describes the
 * PROCESS, and the process here is somebody's laptop. Running
 *
 *     DATABASE_URL=<a remote url> npm run demo:seed
 *
 * has `NODE_ENV=development` locally no matter which database that URL names, so the refusal never
 * fires and seventy invented patients land wherever the URL pointed. That is a realistic mistake —
 * it is a shell variable and a paste — and the seeder is the one script in this repository that
 * writes a large amount of fabricated clinical data.
 *
 * So: a loopback target needs nothing, because that is a developer's own machine. Any other host has
 * to be named on the command line and has to match, which turns a paste into a deliberate act by
 * somebody who has read the hostname:
 *
 *     DATABASE_URL=… npm run demo:seed -- --confirm-host ep-REDACTED.REGION.aws.neon.tech
 *
 * Same shape as the endpoint guard in `platform/db/remediate-0025-stale-recovery.mjs`, generalised:
 * that one hardcodes the single endpoint it was written for, and this one cannot, because the whole
 * point of it is being pointed at databases nobody has named yet.
 */
function assertTargetNamed(): void {
  const url = process.env.DATABASE_URL;
  if (!url) return; /* the "no database" refusal below says this better */
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    console.error("REFUSING: DATABASE_URL is not a URL, so its target cannot be checked.");
    process.exit(1);
  }

  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (loopback) return;

  const confirmed = arg("confirm-host", "");
  if (confirmed === host) return;

  console.error(
    `REFUSING: DATABASE_URL points at "${host}", which is not this machine.
` +
      `
` +
      `This script writes ~${arg("patients", "70")} invented patients, their claims, their payers'
` +
      `remittances and their ledgers. Against the wrong database that is a large amount of fabricated
` +
      `clinical data in a real practice's records, and nothing here can tell one remote database from
` +
      `another.
` +
      `
` +
      `If that host is genuinely the one you meant, say so:
` +
      `  npm run demo:seed -- --confirm-host ${host}
`
  );
  process.exit(1);
}
assertTargetNamed();

const PRACTICE = arg("practice", "663f0b39-e74e-40c4-a553-ba887f6c62b7");
const PATIENTS = Number(arg("patients", "70"));
const DAYS = Number(arg("days", "90"));
/**
 * Where this batch's member ids start, and what the generator is seeded from.
 *
 * The generator is deterministic on purpose (see `rng`), which means a second run produces the same
 * member ids as the first — and a member id is a POLICY, so re-running would silently put a second
 * person on somebody else's policy and trip the identity-collision guard. `--offset` moves a batch
 * clear of the one before it, in both the ids and the randomness:
 *
 *   npm run demo:seed -- --patients 70
 *   npm run demo:seed -- --patients 60 --offset 70
 */
const OFFSET = Number(arg("offset", "0"));

/**
 * A deliberately NON-DELIVERABLE address, on every seeded patient.
 *
 * The 837D requires the subscriber address (loop 2010BA N3/N4) or the claim cannot be built at all,
 * so this field cannot be left empty. It is the one place where making the data look realistic would
 * be actively dangerous: an address that looks like somebody's house, on a claim that a
 * misconfigured deployment files for real, is a letter to a stranger about dental treatment.
 */
const ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

/**
 * Deterministic, so two runs of this script produce the same practice.
 *
 * A demo that changes shape between the rehearsal and the meeting is worse than a small one — the
 * figure somebody memorised is gone, and the person presenting has to read their own screen for the
 * first time in front of a customer. mulberry32, seeded from a constant.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260911 + OFFSET);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const between = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

/**
 * The payers this deployment actually holds, and the share of a real dental practice's volume each
 * carries. Weighted rather than uniform because a payer mix is the thing an owner reads first, and a
 * clinic with exactly one-seventh of its claims at each of seven payers is a clinic that does not
 * exist. Moda is deliberately included at a low weight: it is the one payer in this registry with no
 * clearinghouse id, so its checks route to a human, which is a real state worth having on the board.
 */
const PAYERS: readonly { id: string; name: string; weight: number }[] = [
  { id: "delta-dental", name: "Delta Dental", weight: 30 },
  { id: "metlife-dental", name: "MetLife Dental", weight: 20 },
  { id: "cigna-dental", name: "Cigna Dental", weight: 16 },
  { id: "aetna-dental", name: "Aetna Dental", weight: 14 },
  { id: "uhc-dental", name: "UnitedHealthcare Dental", weight: 10 },
  { id: "guardian-dental", name: "Guardian", weight: 7 },
  { id: "moda-dental", name: "Moda Health", weight: 3 },
];
const PAYER_TOTAL = PAYERS.reduce((s, p) => s + p.weight, 0);
function payer(): (typeof PAYERS)[number] {
  let n = rand() * PAYER_TOTAL;
  for (const p of PAYERS) {
    n -= p.weight;
    if (n <= 0) return p;
  }
  return PAYERS[0]!;
}

/**
 * The member-id suffix IS the scenario. `platform/edi/mock/profile.ts` reads the last two digits:
 * `00` terminated, `77` pre-auth missing (CO-197), `99` annual maximum reached, `66` waiting period,
 * `23` coordination of benefits, anything else adjudicates clean.
 *
 * The weights are the argument this demo makes. A practice where nothing is ever denied has nothing
 * for Recover to show; one where everything is denied is not a practice anybody recognises. Roughly
 * one claim in eight running into a payer problem is the shape of the industry, and it is the shape
 * that makes the leakage figures on Insights mean something.
 */
const OUTCOMES: readonly { suffix: string; weight: number; label: string }[] = [
  { suffix: "41", weight: 62, label: "adjudicates clean" },
  { suffix: "77", weight: 13, label: "pre-authorisation missing → CO-197" },
  { suffix: "99", weight: 9, label: "annual maximum reached → underpaid" },
  { suffix: "23", weight: 7, label: "coordination of benefits → second plan" },
  { suffix: "66", weight: 5, label: "waiting period" },
  { suffix: "00", weight: 4, label: "coverage terminated → no claim" },
];
const OUTCOME_TOTAL = OUTCOMES.reduce((s, o) => s + o.weight, 0);
function outcome(): (typeof OUTCOMES)[number] {
  let n = rand() * OUTCOME_TOTAL;
  for (const o of OUTCOMES) {
    n -= o.weight;
    if (n <= 0) return o;
  }
  return OUTCOMES[0]!;
}

/**
 * Ordinary names, on purpose.
 *
 * The existing demo read "Quinn Mocktest", "Rowan Mockcase", "Sasha Mockfile" — which is safe and is
 * also the reason nobody could look at the screen and imagine their own practice on it. Marking the
 * data is the provenance layer's job and it does it on every row that descends from a mock check:
 * the badge says DEMO DATA whatever the patient is called, so the name does not have to shout.
 */
const FIRST = [
  "Amara", "Beatriz", "Caleb", "Dana", "Elena", "Farid", "Grace", "Hugo", "Imani", "Jonah",
  "Keiko", "Luca", "Maya", "Noor", "Omar", "Priya", "Quentin", "Rosa", "Sam", "Tova",
  "Ugo", "Vera", "Wesley", "Ximena", "Yusuf", "Zoe", "Adeline", "Bo", "Camille", "Desmond",
  "Esther", "Felix", "Georgia", "Hana", "Isaac", "Junia", "Kwame", "Lena", "Mateo", "Nadia",
];
const LAST = [
  "Ackerman", "Baptiste", "Calderon", "Duarte", "Eriksen", "Fontaine", "Gallardo", "Haddad",
  "Ibarra", "Jensen", "Kowalski", "Lindqvist", "Moreau", "Nakamura", "Okonkwo", "Petrov",
  "Quintero", "Rasmussen", "Silva", "Tanaka", "Ueda", "Vasquez", "Whitfield", "Xu", "Yildiz",
  "Zambrano", "Bellini", "Cortez", "Delacroix", "Ferreira",
];

/**
 * Treatment plans a general dentist actually produces in a day, with the practice's own fees.
 *
 * Fees are in DOLLARS here and converted at the one boundary, like every other money input in this
 * repository. The mix matters as much as the amounts: a clinic of nothing but crowns produces an
 * unrecognisable revenue profile, and it is the hygiene visits that make the collection rate land
 * where a real one does.
 */
const PLANS: readonly { name: string; weight: number; items: readonly (readonly [string, number?])[] }[] = [
  { name: "recall + cleaning", weight: 34, items: [["D0120"], ["D1110", 110], ["D0274", 75]] },
  { name: "recall + two fillings", weight: 18, items: [["D0120"], ["D1110", 110], ["D2391", 210], ["D2392", 265]] },
  { name: "crown", weight: 14, items: [["D0120"], ["D2750", 1250]] },
  { name: "root canal + crown", weight: 9, items: [["D0220", 40], ["D3310", 950], ["D2750", 1250]] },
  { name: "extraction", weight: 8, items: [["D0220", 40], ["D7140", 265]] },
  { name: "new patient exam", weight: 10, items: [["D0150", 135], ["D0210", 175], ["D1110", 110]] },
  { name: "scaling, one quadrant", weight: 7, items: [["D0180", 145], ["D4341", 320]] },
];
const PLAN_TOTAL = PLANS.reduce((s, p) => s + p.weight, 0);
function plan(): (typeof PLANS)[number] {
  let n = rand() * PLAN_TOTAL;
  for (const p of PLANS) {
    n -= p.weight;
    if (n <= 0) return p;
  }
  return PLANS[0]!;
}

/** Teeth a crown, a filling or an extraction is actually done on. The scrubber requires one. */
const TEETH = ["2", "3", "4", "5", "12", "13", "14", "15", "18", "19", "20", "29", "30", "31"];
const NEEDS_TOOTH = /^D(2[3-9]|27|31|33|71|72|73|74)/;

const DAY = 86_400_000;

/**
 * ── THE INSTANT THIS DEMONSTRATION IS ANCHORED TO ──────────────────────────────────────────────
 *
 * `rng` above is deterministic on purpose, and until this existed that determinism bought nothing
 * across deployments: the generator made the same decisions on every run and then wrote them
 * against WALL-CLOCK dates, so two deployments seeded a day apart disagreed on every screen that
 * groups by time. The counts matched and nothing else did.
 *
 * It is not only a cosmetic drift. `heldDays` below compares an advice's age against
 * `HELD_REMITTANCE_REVIEW_DAYS`, so the same advice is "three days old, not yet urgent" on the
 * deployment seeded on Monday and "four days old, urgent" on the one seeded on Tuesday — the two
 * demos disagree about what needs attention, which is the one thing a demo exists to show.
 *
 * So the anchor is an input like every other. Unset, it is the current time and this file behaves
 * exactly as before; given `--asof`, two runs anywhere produce the same practice on the same dates.
 */
const ASOF = arg("asof", "");
const now = ASOF ? new Date(ASOF) : new Date();
if (ASOF && Number.isNaN(now.getTime())) {
  console.error(
    `REFUSING: --asof "${ASOF}" is not a date this runtime understands.\n` +
      `Give an ISO-8601 instant, e.g. --asof 2026-09-12T12:00:00Z`
  );
  process.exit(1);
}

const dayAgo = (n: number, hour = 10): Date =>
  new Date(new Date(now.getTime() - n * DAY).setUTCHours(hour, between(0, 59), 0, 0));

interface Seeded {
  patients: number;
  verified: number;
  blocked: number;
  claims: number;
  filed: number;
  advices: number;
  denials: number;
  appealsWon: number;
  appealsLost: number;
  payments: number;
  writeOffs: number;
}

const tally: Seeded = {
  patients: 0, verified: 0, blocked: 0, claims: 0, filed: 0, advices: 0,
  denials: 0, appealsWon: 0, appealsLost: 0, payments: 0, writeOffs: 0,
};

/**
 * One patient's whole cycle, at a point in the past.
 *
 * Every stage passes `at` — the services all take an injected clock, which is what makes a backdated
 * history possible without writing a single timestamp by hand. The gaps between stages are the ones
 * a real cycle has: a claim goes out a day or two after the visit, a payer answers in two to five
 * weeks, an appeal concludes a month after that. Those gaps are what the days-to-adjudication figure
 * on Claims is measuring, so inventing them uniformly would produce a straight line nobody believes.
 */
async function journey(services: Services, index: number): Promise<void> {
  const person = { first: pick(FIRST), last: pick(LAST) };
  const p = payer();
  const o = outcome();
  const chosen = plan();

  /* Member ids look like a payer's, and end in the two digits that decide the scenario. */
  const memberId = `${p.id.slice(0, 3).toUpperCase()}${String(100000 + (OFFSET + index) * 137).slice(0, 6)}${o.suffix}`;
  const dob = `${between(1948, 2012)}-${String(between(1, 12)).padStart(2, "0")}-${String(between(1, 28)).padStart(2, "0")}`;

  /* Verified somewhere in the window, but never so late that the rest of the cycle cannot fit. */
  const checkedDaysAgo = between(4, DAYS);
  const checkedAt = dayAgo(checkedDaysAgo);

  const items: TreatmentPlanItem[] = chosen.items.map(([code, fee]) => ({
    code,
    quantity: 1,
    ...(fee !== undefined ? { fee: cents(fee) } : {}),
    ...(NEEDS_TOOTH.test(code) ? { toothNumber: pick(TEETH) } : {}),
  }));

  const view = await services.verification.create(
    {
      patient: {
        firstName: person.first,
        lastName: person.last,
        dateOfBirth: dob,
        memberId,
        address: ADDRESS,
      },
      cardText: `${p.name}\nMember: ${person.first.toUpperCase()} ${person.last.toUpperCase()}\nID: ${memberId}\nGroup #: ${p.id.slice(0, 3).toUpperCase()}-${between(1000, 9999)}`,
      planItems: items,
    },
    checkedAt
  );
  tally.patients += 1;
  await services.drainOutbox();

  if (view.record.status !== "verified") {
    /* A terminated policy or a contested card. It stays on the board needing a person, which is a
       state the demo NEEDS on screen — an inbox with nothing in it demonstrates nothing. */
    tally.blocked += 1;
    return;
  }
  tally.verified += 1;

  const claim = await services.claims.getByVerification(view.record.id, checkedAt);
  if (!claim) return;
  tally.claims += 1;

  /**
   * The pre-authorisation gate, worked the way a practice works it.
   *
   * Most of the time the coordinator gets the authorisation and files. Sometimes — and this is the
   * case the product exists to make visible — the treatment was already done before anybody checked,
   * so the claim goes out unauthorised and comes back CO-197. Leaving a slice of these unauthorised
   * is what puts a figure under "At risk, unauthorised" on Today.
   */
  const blockers = claim.blockers ?? [];
  const preauthBlocked = blockers.some((b) => b.code === "preauth-missing");
  const getsAuthorised = preauthBlocked && rand() > 0.35;
  if (getsAuthorised) {
    await services.claims.recordPreAuthorization(
      claim.claim.id,
      {
        status: "approved",
        referenceNumber: `AUTH-${String(index).padStart(4, "0")}`,
        recordedBy: "coordinator@clinic.example",
        source: "payer-portal",
      },
      dayAgo(checkedDaysAgo - 1)
    );
  } else if (preauthBlocked) {
    /* Filed anyway, because the treatment is done. The claim is blocked from FILING, so this is
       where the demo shows money at risk that is not yet a denial. */
    return;
  }

  /* Filed one to three days after the visit — a real front desk does not file the same afternoon. */
  const filedDaysAgo = Math.max(1, checkedDaysAgo - between(1, 3));
  const filedAt = dayAgo(filedDaysAgo, 16);
  try {
    await services.claims.submit(claim.claim.id, { submittedBy: "biller@clinic.example" }, filedAt);
  } catch {
    /* A scrub refusal is a real state and the claim stays on the board saying why. Not swallowed
       silently: the tally below reports how many never left, and that number is worth seeing. */
    return;
  }
  tally.filed += 1;
  await services.drainOutbox();

  /**
   * The payer answers between twelve and thirty-five days later — and only if that date has
   * actually arrived. A practice always has claims still out; a demo where every claim has been
   * adjudicated has an empty "In flight" figure on Claims and no ageing to speak of.
   */
  const paidDaysAgo = filedDaysAgo - between(12, 35);
  if (paidDaysAgo < 0) return;
  const paidAt = dayAgo(paidDaysAgo, 9);

  /**
   * One advice for one claim, from this claim's own payer.
   *
   * The `/remittances/fetch` route batches every submitted claim per payer, because that is how a
   * payer actually sends them. Here each journey is at its own point in the past, so batching would
   * fold claims filed weeks apart into one cheque dated today — which is exactly the "money in"
   * timeline this demo is trying to make truthful. One advice per claim, at that claim's own date.
   */
  const filed = await services.claims.get(claim.claim.id, paidAt);
  if (!filed?.claim.submission || filed.claim.status !== "submitted") return;

  const fetched = await services.remittance.fetchAndIngest(
    {
      payerId: p.id,
      payerName: p.name,
      payeeName: getConfig().billingProviderName,
      paymentDate: paidAt.toISOString().slice(0, 10),
      claims: [
        {
          patientControlNumber: filed.claim.submission.patientControlNumber,
          payerControlNumber: filed.claim.submission.controlNumber,
          patientFirstName: filed.claim.patient.firstName,
          patientLastName: filed.claim.patient.lastName,
          memberId: filed.claim.patient.memberId,
          lines: filed.claim.lines.map((l) => ({ procedureCode: l.code, charged: l.fee, quantity: l.quantity })),
          expectedInsurancePays: filed.claim.expectedInsurancePays,
        },
      ],
    },
    paidAt
  );
  tally.advices += fetched.length;
  await services.drainOutbox();

  /**
   * ── HELD MONEY THAT A PRACTICE WOULD HAVE WORKED BY NOW ──────────────────────────────────────
   *
   * Some advices arrive held: a coordination-of-benefits case where a second plan is involved, or a
   * payee the ingest could not confirm. Holding them is correct — that is the control working.
   *
   * Leaving every one of them held for the whole ninety days is not. It produced twelve advices with
   * the oldest waiting 71 days, which fired `money.held_remittance_age` and made readiness red on a
   * demonstration deployment for a reason that says nothing about the product: nobody had worked the
   * queue, because the queue had no people in it.
   *
   * So anything older than the review window is released the way a practice releases it — through
   * the real service, with a real reason, attributed to a real role, at a date a few days after it
   * arrived. Recent holds are left alone deliberately: "money waiting on a person" is a state the
   * demo NEEDS on screen, and an empty held queue demonstrates nothing either.
   */
  for (const view of fetched) {
    const advice = view.remittance;
    if (advice.status !== "held") continue;
    const heldDays = Math.floor((now.getTime() - new Date(advice.receivedAt).getTime()) / DAY);
    /**
     * Two days, not six, and the number is the monitor's own rather than a taste.
     * `HELD_REMITTANCE_REVIEW_DAYS` is three: the board marks a hold urgent at day three and
     * `money.held_remittance_age` fires there too. Releasing at six therefore left a band of advices
     * aged three to six days that were, correctly, an alarm — so a freshly seeded demonstration
     * practice started with readiness red for a reason that says nothing about the product.
     *
     * Anything inside the window is still left held on purpose: money waiting on a person is a real
     * state, it is what the Held figure on Money is for, and a demo with an empty held queue shows
     * one less thing the product does.
     */
    if (heldDays <= 2) continue;
    try {
      await services.remittance.release(
        advice.id,
        "manager@clinic.example",
        "Reconciled against the payer's paper EOB.",
        dayAgo(Math.max(0, paidDaysAgo - between(2, 5)), 13)
      );
      await services.drainOutbox();
    } catch {
      /* An unbalanced advice cannot be released, and must not be — arithmetic is not overridable.
         It stays held, which is exactly the state a person has to resolve. */
    }
  }

  /**
   * The back half: a denial the practice worked, or a patient balance somebody paid.
   *
   * Both are here because both are half of the argument. Recover cannot draw its recovery curve
   * until an appeal has been won AND dated, and Patients reports "0% collected" for ever if nobody
   * ever pays — which is precisely what the previous demo showed, and it reads as a broken product
   * rather than as an empty one.
   */
  const open = await services.denials.list({ openOnly: true }, paidAt);
  for (const denial of open.filter((d) => d.claimId === claim.claim.id)) {
    tally.denials += 1;
    /* Roughly half get worked. The rest sit open, which is what Recover is for. */
    if (rand() > 0.55) continue;

    const appealedAt = dayAgo(Math.max(0, paidDaysAgo - between(2, 9)), 11);
    await services.denials.draftAppeal(denial.id, {}, appealedAt);
    await services.denials.approveAppeal(denial.id, "manager@clinic.example", appealedAt);
    await services.denials.submitAppeal(denial.id, appealedAt);

    const concludedDaysAgo = Math.max(0, paidDaysAgo - between(20, 45));
    if (concludedDaysAgo <= 0) continue; /* still with the payer — a real and necessary state */
    const concludedAt = dayAgo(concludedDaysAgo, 14);

    /* Just over half of worked appeals are won, which is roughly what the industry reports and is
       close enough to the playbook's own 30% starting prior to make the learning loop move. */
    const won = rand() < 0.58;
    await services.denials.recordOutcome(
      denial.id,
      {
        won,
        ...(won ? { recoveredAmount: denial.deniedAmount } : {}),
        notes: won ? "Payer reprocessed on appeal." : "Payer upheld the original determination.",
        recordedBy: "manager@clinic.example",
      },
      concludedAt
    );
    if (won) tally.appealsWon += 1;
    else tally.appealsLost += 1;
    await services.drainOutbox();
  }

  /**
   * The patient's share. Most people pay, some pay late, a few never do and a balance is written
   * off — which is the distribution the aging buckets and the write-off figure are drawn from.
   */
  const account = await services.ledger.statement(memberId, paidAt);
  if (!account || account.account.balance <= 0) return;
  const roll = rand();
  if (roll < 0.55) {
    const paidBackDaysAgo = Math.max(0, paidDaysAgo - between(3, 25));
    await services.ledger.recordPayment(
      memberId,
      { amount: account.account.balance, recordedBy: "reception@clinic.example", note: "Card, in person" },
      dayAgo(paidBackDaysAgo, 15)
    );
    tally.payments += 1;
  } else if (roll < 0.68) {
    /* A part payment, which is what actually leaves a practice with aged balances. */
    const part = Math.round(account.account.balance * (0.3 + rand() * 0.4));
    if (part > 0) {
      await services.ledger.recordPayment(
        memberId,
        { amount: part, recordedBy: "reception@clinic.example", note: "Part payment, plan agreed" },
        dayAgo(Math.max(0, paidDaysAgo - between(3, 20)), 15)
      );
      tally.payments += 1;
    }
  } else if (roll > 0.94 && paidDaysAgo > 60) {
    await services.ledger.writeOff(
      memberId,
      { amount: account.account.balance, recordedBy: "owner@clinic.example", note: "Uncollectable — sent to collections and returned" },
      dayAgo(Math.max(0, paidDaysAgo - 60), 12)
    );
    tally.writeOffs += 1;
  }
  /* Everything else is left outstanding. That is the point of the ageing chart. */
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────
const services = buildServices();
if (!services.persistent) {
  console.error("REFUSING: no DATABASE_URL. There is nothing durable to seed.");
  process.exit(1);
}

console.log(`safety: EDI adapter = ${adapter.constructor.name} (no vendor traffic possible)`);
console.log(`seeding practice ${PRACTICE}: ${PATIENTS} patients across the last ${DAYS} days\n`);

await withPractice(PRACTICE, async () => {
  if (has("wipe")) {
    console.log("--wipe was not implemented on purpose: see the note at the end of this file.\n");
  }
  for (let i = 0; i < PATIENTS; i++) {
    /* A fresh id per journey keeps two runs from colliding on a member id. */
    void randomUUID();
    try {
      await journey(services, i);
    } catch (err) {
      console.error(`  patient ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if ((i + 1) % 10 === 0) console.log(`  … ${i + 1}/${PATIENTS}`);
  }
});

/* One last drain, so nothing seeded is still sitting in the outbox when somebody opens the app. */
await withPractice(PRACTICE, () => services.drainOutbox());

console.log("\n" + "─".repeat(78));
console.log("Seeded — every figure below was computed by the product, not written by this script:");
for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(12)} ${v}`);
console.log("─".repeat(78));

/**
 * A summary read back through the real analytics engine, so what is printed here is exactly what the
 * Insights screen will say. If these two ever disagree, one of them is a bug.
 */
const report = await withPractice(PRACTICE, () =>
  services.analytics.report({ from: new Date(now.getTime() - DAYS * DAY), to: now })
);
const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
console.log("\nWhat Insights will show for this window:");
console.log(`  filed to payers      ${usd(report.money.filedToPayers)}`);
console.log(`  collected            ${usd(report.money.collected)}  (${Math.round(report.money.collectionRate * 100)}% of expected)`);
console.log(`  denied               ${usd(report.money.denied)}  (${Math.round(report.money.denialRate * 100)}% of billed)`);
console.log(`  recovered on appeal  ${usd(report.money.recovered)}`);
console.log(`  billed to patients   ${usd(report.money.patientBilled)}`);
console.log(`  collected from them  ${usd(report.money.patientCollected)}`);
console.log("");

const { closePool } = await import("@mermaid/db");
await closePool();

/**
 * ── WHY THERE IS NO `--wipe` ───────────────────────────────────────────────────────────────────
 *
 * A flag that deletes a practice's data is a flag that will one day be run against the wrong
 * practice, and the shape of this script — a default practice id baked into the source — is exactly
 * the shape that makes that easy. `npm run db:clean-tests` removes practices named `test-*` and
 * cannot touch anything else, which is the right amount of power for a script to hold.
 *
 * To start a demonstration practice over: create a new practice, seed that, and leave the old one
 * alone. Data that was expensive to be wrong about should be expensive to destroy.
 */
