/**
 * The composition root — the one place that knows every bounded context exists, and the one place
 * that decides whether this process runs on Postgres or in memory.
 *
 * Extracted from server.ts at M6 because it stopped being three lines: selecting a persistence
 * backend, wiring subscriptions, and owning the outbox worker are a cohesive job, and the HTTP
 * layer should not have to read as though it were also a container.
 *
 * ── PERSISTENCE SELECTION ──────────────────────────────────────────────────────────────────────
 * `DATABASE_URL` decides. With it, everything is durable, tenant-isolated by RLS, and login-gated.
 * Without it, the in-memory stores run exactly as they did through M3–M5 — which keeps the demo
 * runnable on a laptop with no database and, more usefully, keeps the whole business suite running
 * against the same services in CI. The seams were built for this; the module services cannot tell
 * the difference.
 */
import type { Cents, FeeSchedule } from "@mermaid/shared";
import { withCurrentPractice, withPractice, withoutPractice } from "@mermaid/db";
import {
  NoEraSources,
  RepositoryEraSourceAdmin,
  type EraSourceAdmin,
} from "./era-sources.ts";
import {
  AppointmentService,
  VerificationService,
  createCardReader,
  InMemoryAppointmentRepository,
  InMemoryVerificationRepository,
  InMemoryPatientDirectory,
  PgAppointmentRepository,
  PgVerificationRepository,
  PgPatientDirectory,
  type PatientDirectory,
  type PayerAccuracyProvider,
  type VerificationRepository,
} from "@mermaid/verification";
import {
  ClaimService,
  InlineUnitOfWork,
  InMemoryClaimRepository,
  PgClaimRepository,
  registerClaimsSubscriptions,
  type ClaimRepository,
} from "@mermaid/claims";
import {
  RemittanceService,
  InMemoryRemittanceRepository,
  InMemoryExpectationRepository,
  PgRemittanceRepository,
  PgExpectationRepository,
  InMemoryCoordinationRepository,
  PgCoordinationRepository,
  InMemoryEraArtifactRepository,
  PgEraArtifactRepository,
  PgEraSourceRepository,
  registerRemittanceSubscriptions,
  type EraArtifactRepository,
  type ExpectationRepository,
  type RemittanceRepository,
} from "@mermaid/remittance";
import {
  DenialService,
  InMemoryDenialRepository,
  PgDenialRepository,
  createAppealNarrator,
  createDenialExplainer,
  registerDenialSubscriptions,
  type DenialRepository,
} from "@mermaid/denials-appeals";
import {
  InMemoryPlaybookRepository,
  PayerProfileService,
  PgPlaybookRepository,
  type PlaybookRepository,
  InMemoryAllowedAmountRepository,
  InMemoryAllowedVarianceRepository,
  InMemoryStatutoryClockRepository,
  PgAllowedAmountRepository,
  PgAllowedVarianceRepository,
  PgStatutoryClockRepository,
  InMemoryPaymentMethodRepository,
  PgPaymentMethodRepository,
  type AllowedAmountRepository,
  type AllowedVarianceRepository,
  type StatutoryClockRepository,
  assessPromptPay,
  assessUnpaidDeadline,
  assessRecoupment,
  promptPayRuleFor,
  recoupmentRuleFor,
  toStored,
  type PaymentMethodRepository,
} from "@mermaid/payer-profile";
import {
  AnalyticsService,
  InMemoryFactRepository,
  PgFactRepository,
  registerAnalyticsSubscriptions,
  type FactRepository,
} from "@mermaid/analytics";
import {
  InMemoryLedgerRepository,
  PatientLedgerService,
  PgLedgerRepository,
  registerPatientLedgerSubscriptions,
  type LedgerRepository,
} from "@mermaid/patient-ledger";
import { InMemoryOutbox, PostgresEventBus, type EventBus } from "@mermaid/events";
import {
  getConfig,
  InMemoryPracticeSettingsRepository,
  PgPracticeSettingsRepository,
  type PracticeSettingsRepository,
} from "@mermaid/config";
import {
  BUILTIN_PAYERS,
  clearinghouseIdFor,
  parseParticipationMap,
  type PayerDirectory,
} from "@mermaid/verification";
import { getEdiAdapter, type EdiAdapter } from "@mermaid/edi";
import { getLlmAdapter } from "@mermaid/llm";
import { logger } from "@mermaid/observability";

/** Everything the HTTP layer talks to. */
export interface Services {
  verification: VerificationService;
  claims: ClaimService;
  remittance: RemittanceService;
  denials: DenialService;
  analytics: AnalyticsService;
  /** The patient's half of every dollar — what they owe, and how old it is. */
  ledger: PatientLedgerService;
  /**
   * The patient master. Owned by Verification (it is where a person first enters the system), but
   * surfaced here because the unified patient record joins five contexts through it and the
   * composition root is the only place allowed to know all five exist.
   */
  patients: PatientDirectory;
  /**
   * The schedule (0035). Reads the same patient master and verification store as everything
   * else, so a visit's readiness is computed from exactly the verifications the queue shows.
   */
  appointments: AppointmentService;
  /**
   * The practice's IANA timezone, as every deadline is already computed in.
   *
   * Exposed because the Today board renders deadlines from three different modules and two of them
   * already emit a calendar day in this zone. The third emitted a raw instant, and the client — which
   * has no timezone of its own — printed it verbatim, so a biller saw `by 2026-08-31T04:40:14.825Z`
   * where every neighbouring row showed a date.
   */
  timeZone: string;
  /** The shared brain. Global, not tenant-scoped — see platform/payer-profile/src/service.ts. */
  payerProfile: PayerProfileService;
  /** Learned contracted rates (F-1). Exposed so what the system learned is observable, not implied. */
  allowedAmounts: AllowedAmountRepository;
  /** Non-ACH payer payments (F1). Exposed so the Money screen can read what a payer charged to pay. */
  paymentMethods: PaymentMethodRepository;
  /**
   * Effective-dated rate history and the variances measured against it (F2).
   *
   * Exposed in SHADOW MODE: nothing in the product reads it to make a decision. It is here so that
   * what the classifier is finding can be inspected against real traffic before anything acts on it.
   */
  allowedVariances: AllowedVarianceRepository;
  /** Per-practice jurisdiction and merchant rate (migration 0032). */
  practiceSettings: PracticeSettingsRepository;
  /**
   * Prompt-pay interest and out-of-time recoupments (F5).
   *
   * Exposed in SHADOW MODE: nothing in the product acts on a finding. It also carries the savings
   * report, where `claimed` and `recovered` are two numbers that never merge — the first is
   * arithmetic this system did, the second is cash a person confirmed arrived.
   */
  statutoryClock: StatutoryClockRepository;
  /**
   * Registering a clearinghouse ERA source, through the repository that ENCRYPTS the credential
   * (NEW-11). Nothing outside a test reached `EraSourceRepository.upsert` before this existed, so
   * the only registration path was hand-written SQL — which writes a live credential in the clear.
   */
  eraSources: EraSourceAdmin;
  /**
   * The same services over the same stores, but talking to a different clearinghouse.
   *
   * Exists for exactly one caller: the demo seeder. Seeded patients are invented, and once a real
   * clearinghouse was configured they were being sent to it — producing real 271s about members no
   * payer has heard of, which came back empty and were then stamped `dataSource: "edi"`. The demo
   * looked like eight failed live checks, and a screen reading that as "verified" is the whole
   * problem this exists to prevent.
   *
   * So the seeder pins itself to the mock connector explicitly rather than inheriting `EDI_ADAPTER`.
   * That is not a workaround: demonstration data SHOULD come from the demonstration connector, and
   * saying so in code means the provenance badge on those rows is a fact rather than a hope.
   *
   * All three services, not just verification: the seeded day of work continues into filing claims
   * and pulling the payers' advice, and a vendor that implements eligibility but not `submitClaim`
   * refuses the rest of the cycle outright — correctly, and fatally for a demo that assumed the
   * whole loop would run.
   *
   * Nothing else may use this. Real work goes through the top-level services, whose adapter is the
   * configured one, because which clearinghouse a practice uses is a deployment decision.
   */
  via(adapter: EdiAdapter): Pick<Services, "verification" | "claims" | "remittance">;
  /**
   * The ERA artifact ledger — every payment file a clearinghouse has offered this practice.
   *
   * Surfaced here for the same reason `patients` is: it is one store with two legitimate readers
   * that must not each build their own. The ERA worker writes it; the Today queue reads the
   * abandoned rows out of it through `remittance.deadLetteredArtifacts()`. Exposing the instance
   * is what makes "the queue reads the ledger the worker wrote to" a fact rather than a hope — with
   * the in-memory store, two instances would be two unconnected ledgers and the dead-letter queue
   * would render perfectly against a table nothing had ever written to.
   */
  eraArtifacts: EraArtifactRepository;
  /** True when running against Postgres — the API reports it, and auth is only enforced then. */
  persistent: boolean;
  /** The outbox. Durable under Postgres; in-process otherwise. */
  bus: EventBus;
  /** Dispatch any pending events. Called after mutating requests and by the background worker. */
  drainOutbox(): Promise<void>;
}

export interface BuildOptions {
  /** Force in-memory storage regardless of DATABASE_URL (used by the business test suite). */
  inMemory?: boolean;
  bus?: EventBus;
  /**
   * The two-letter state whose statutes the clock applies (F5). Defaults to the billing
   * provider's own state.
   *
   * A seam rather than a convenience. `BILLING_PROVIDER_STATE` is deployment-wide and cached on
   * first read, which makes the one input that decides whether a practice is protected impossible
   * to vary per practice and impossible to exercise in a test without a second process. Naming it
   * here does not fix the underlying shape — jurisdiction belongs on the practice record, not in
   * the environment — but it stops the default being the only reachable value.
   */
  jurisdiction?: string;
}


/**
 * Whether a clearinghouse TEST interchange (ISA15 = T) may post on this deployment.
 *
 * Decided from `filesToRealPayers` — the same fact that decides whether a real billing identity is
 * required — because it is the same question asked from the other side: can a file posted here be
 * about real money? Where claims reach real payers, a test file is cash that was never sent, and it
 * is refused. Everywhere else — the mock clearinghouse, a vendor's test mode, a developer's laptop —
 * every file is a test file by construction, and refusing them would stop the demo posting anything.
 *
 * Exported so the rule is tested as a rule, rather than only through a composition root that a
 * test cannot configure as live without a real clearinghouse key.
 */
export function testInterchangePolicy(config: { filesToRealPayers: boolean }): "accept" | "refuse" {
  return config.filesToRealPayers ? "refuse" : "accept";
}
export function buildServices(options: BuildOptions = {}): Services {
  const config = getConfig();
  const persistent = !options.inMemory && Boolean(config.databaseUrl);
  const adapter = getEdiAdapter();

  const bus: EventBus =
    options.bus ??
    (persistent
      ? new PostgresEventBus({
          // A handler that outlives its lease gets its event redelivered — safe, because every
          // subscriber is idempotent, but wasteful. 120s is far above anything we run.
          leaseSeconds: 120,
        })
      : new InMemoryOutbox());

  const verificationRepo: VerificationRepository = persistent
    ? new PgVerificationRepository()
    : new InMemoryVerificationRepository();
  const claimRepo: ClaimRepository = persistent ? new PgClaimRepository() : new InMemoryClaimRepository();
  const remittanceRepo: RemittanceRepository = persistent
    ? new PgRemittanceRepository()
    : new InMemoryRemittanceRepository();
  const expectationRepo: ExpectationRepository = persistent
    ? new PgExpectationRepository()
    : new InMemoryExpectationRepository();
  /** Coordination-of-benefits cases, persisted exactly where the remittances that open them are. */
  const coordinationRepo = persistent ? new PgCoordinationRepository() : new InMemoryCoordinationRepository();

  /**
   * The ERA artifact ledger, built ONCE and shared by every RemittanceService `via()` produces.
   *
   * One instance for the same reason the playbook repository is one instance: with the in-memory
   * store, two would be two unconnected ledgers, and the dead-letter queue would appear to work
   * while reading a table nothing had ever written to. The ERA worker constructs its own Pg
   * instance per practice transaction — that is correct and not a second store, because Postgres IS
   * the shared state there and RLS is what scopes it.
   */
  const eraArtifactRepo: EraArtifactRepository = persistent
    ? new PgEraArtifactRepository()
    : new InMemoryEraArtifactRepository();

  /**
   * The shared brain is built HERE, before anything that uses it, and there is exactly one of it.
   *
   * That matters more than it looks. Appeals write outcomes into this instance and Verification now
   * reads them back out of it; with the in-memory repository, two instances would be two unconnected
   * brains, and the learning loop would appear to work while quietly closing on nothing.
   */
  const playbookRepo: PlaybookRepository = persistent
    ? new PgPlaybookRepository()
    : new InMemoryPlaybookRepository();
  const payerProfile = new PayerProfileService(playbookRepo);
  /**
   * Learned allowed amounts (F-1). Tenant-scoped under RLS unlike the playbook above, because a
   * contracted rate is one practice's own commercial term rather than shared knowledge.
   */
  const allowedAmounts: AllowedAmountRepository = persistent
    ? new PgAllowedAmountRepository()
    : new InMemoryAllowedAmountRepository();

  /**
   * Payments that did not arrive over ACH (F1, migration 0029). Tenant-scoped for the same reason
   * the rates above are: which payers charge THIS practice to pay it, and what its processor takes,
   * are its own commercial facts rather than shared knowledge.
   */
  const paymentMethods: PaymentMethodRepository = persistent
    ? new PgPaymentMethodRepository()
    : new InMemoryPaymentMethodRepository();

  /**
   * Effective-dated rate history and the variances measured against it (F2, migration 0030).
   *
   * Reads the same event `allowedAmounts` above does, and keeps its own store — because the two
   * answer different questions and only one of them can afford to forget. `allowedAmounts` holds the
   * CURRENT rate and overwrites it on every advice, which is right for quoting a patient and fatal
   * for noticing a cut: the first short payment erases the figure it is short of. This keeps the
   * periods, so the old rate is still provable after the payer stops honouring it.
   *
   * Tenant-scoped, like both stores above, for the same reason: a contracted rate is one practice's
   * own commercial term.
   */
  const allowedVariances: AllowedVarianceRepository = persistent
    ? new PgAllowedVarianceRepository()
    : new InMemoryAllowedVarianceRepository();

  /**
   * Which state's law the clock applies. An ASSUMPTION — which state governs a given plan turns
   * on where the plan is issued, not on where the chair is — so it is stored on every finding
   * rather than implied, and a wrong answer stays findable.
   */
  const jurisdiction = (options.jurisdiction ?? config.billingProviderState).trim().toUpperCase();

  /**
   * The statutory clocks (F5, migration 0031). Tenant-scoped: when a practice was paid, and what a
   * payer owes it for being late, are that practice's facts.
   */
  /**
   * Per-practice configuration (migration 0032): the jurisdiction whose statutes apply, and what
   * this practice's processor charges it. Both were deployment-wide; both are facts about a
   * practice, and a deployment serving two of them gave both the same answer.
   */
  const practiceSettings: PracticeSettingsRepository = persistent
    ? new PgPracticeSettingsRepository()
    : new InMemoryPracticeSettingsRepository();

  const statutoryClock: StatutoryClockRepository = persistent
    ? new PgStatutoryClockRepository()
    : new InMemoryStatutoryClockRepository();

  /**
   * The shared brain, adapted to the one question Verification asks of it.
   *
   * Built here rather than handing over the service itself, so the module depends on a two-field
   * port it owns instead of on the payer profile's full surface. This is the composition root doing
   * the job it exists for: knowing that both sides exist, so neither has to know about the other.
   */
  /**
   * The practice's learned fee schedule, read once per verification (F-1).
   *
   * Shaped `payerId → cdtCode → allowed` because a rate is only meaningful against the payer that
   * stated it, and the payer is not known until the card has been read inside the pipeline. Read at
   * the edge and passed in, so the pipeline stays deterministic — the suite asserts two identical
   * clinics produce identical claims, and a database read mid-run would end that.
   *
   * Small by construction: a practice has a handful of payers and a bounded set of codes it bills.
   */
  const readFeeSchedule = async (): Promise<FeeSchedule> => {
    const byPayer = new Map<string, Map<string, Cents>>();
    for (const rate of await allowedAmounts.listAll()) {
      const rates = byPayer.get(rate.payerId) ?? new Map<string, Cents>();
      rates.set(rate.cdtCode, rate.allowed);
      byPayer.set(rate.payerId, rates);
    }
    return byPayer;
  };

  const payerHistory: PayerAccuracyProvider = {
    async forPayer(payerId) {
      const accuracy = await payerProfile.payerAccuracy(payerId);
      return { confidence: accuracy.confidence, explanation: accuracy.explanation };
    },
  };

  /**
   * The payer catalog, read from the database once per verification (NEW-08).
   *
   * ── WHY THIS IS A FUNCTION AND NOT A VALUE ───────────────────────────────────────────────────
   * The catalog used to be a seven-row array in `engine/payer.ts`, so adding a payer was a deploy.
   * Now it is a table an administrator edits from a screen, and the point of that is that a payer
   * added at 10am is matchable at 10:01. A value captured at boot would put the deploy back.
   *
   * NOT cached, deliberately. One small read at the start of a verification, against a table with
   * single-digit rows, next to an eligibility round trip to a clearinghouse that takes seconds — a
   * cache here would buy nothing measurable and cost the exact property the change exists for.
   *
   * Falls back to the built-in seven when the catalog is empty, which is the state of any database
   * before `ensureDefaults` has run and the permanent state of the database-free demo. An empty
   * catalog must not mean "no payer can be verified".
   */
  const payers = async (): Promise<PayerDirectory> => {
    const catalog = await payerProfile.connectors();
    // Falls back when nothing in the catalog can RECOGNISE a card, not merely when it is empty. A
    // table of payers with no aliases matches nothing, and "no card can be verified" must never be
    // the outcome of an upgrade. `ensurePayers` fills that gap at boot; this is the belt to its
    // braces, and it is what the database-free demo runs on permanently.
    return catalog.some((p) => p.aliases.length > 0) ? catalog : BUILTIN_PAYERS;
  };

  // The patient master (M14). A person entering the system becomes a record here, whatever the
  // verification concludes — the workflow diagram's "Unified Patient Financial Record", which until
  // now was a table nothing wrote.
  const patients: PatientDirectory = persistent ? new PgPatientDirectory() : new InMemoryPatientDirectory();

  const llm = getLlmAdapter();

  /**
   * The camera path (workflow S2). An insurance card is PHI and the image is the input, so unlike
   * appeal drafting and denial explanation this feature cannot be made PHI-free — it is refused
   * before it leaves the process until `LLM_PHI_APPROVED=1`, and typed card text carries the day.
   */
  const cardReader = createCardReader(llm);

  /**
   * Build the three clearinghouse-facing services over the shared stores, for a given adapter.
   *
   * Every collaborator except the adapter comes from the enclosing scope, so services built here
   * share one set of repositories, one outbox and one patient master with the configured ones —
   * which is what makes a seeded record and a live record land in the same queue.
   */
  const via = (ediAdapter: EdiAdapter) => ({
    verification: new VerificationService(
      verificationRepo,
      ediAdapter,
      bus,
      payerHistory,
      patients,
      cardReader,
      // V3 — stated by the deployment, never inferred. Empty config means every payer is `unknown`,
      // which preserves the previous benefit-column selection exactly.
      parseParticipationMap(config.payerNetworkParticipation),
      // The coverage-window check compares the payer's stated dates to TODAY in the clinic's own
      // day, exactly as the deadline engines do. In UTC, a US practice's evening visits read as
      // tomorrow and a plan ending today was flagged as already terminated.
      config.practiceTimeZone,
      payers,
      // F-1 — what these payers have actually been observed to allow. Empty until a remittance has
      // arrived, and an empty schedule prices off billed fees exactly as before.
      readFeeSchedule
    ),
    claims: new ClaimService(
      claimRepo,
      ediAdapter,
      {
        name: config.billingProviderName,
        npi: config.billingProviderNpi,
        // PRACTICE_IS_GROUP — decides whether an 837D must carry loop 2310B (NEW-22).
        isGroup: config.practiceIsGroup,
        taxId: config.billingProviderTaxId,
        // 837D loop 1000A PER and loop 2010AA N3/N4 — both mandatory. Production refuses to boot
        // without them, so anything arriving here in production is the practice's real contact and
        // service address, never a placeholder.
        phone: config.billingProviderPhone,
        street: config.billingProviderStreet,
        city: config.billingProviderCity,
        state: config.billingProviderState,
        zip: config.billingProviderZip,
        // 837D loop 2000A PRV — refused at boot alongside the contact fields when it is missing.
        ...(config.billingProviderTaxonomy ? { taxonomy: config.billingProviderTaxonomy } : {}),
      },
      bus,
      // The payer's own filing window, from the catalog that owns it. Until M12 this lived as a
      // hardcoded map inside the claims deadline engine while the `payers` table carried the same
      // fact and stood empty — two sources of truth, and the authoritative one inert.
      {
        filingWindowDays: (payerId: string | null) => payerProfile.filingWindowDays(payerId),
        // B-1: the payer's own document behind the exact window a claim was given, when there is one.
        sourceOfFilingWindow: (payerId: string | null, days: number) =>
          payerProfile.sourceOfWindow(payerId, "filing", days),
        /**
         * The payer’s id at the clearinghouse. The composition root is the only place that may
         * know both namespaces exist — Mermaid’s slug keys the playbook and every learned rate, and
         * must not change when a vendor is swapped; the vendor’s id is what routes a claim.
         */
        /**
         * From the CATALOG, not from a constant (NEW-08). A claim routed with an id that came from
         * a source file while the verification matched against a table would file under whichever
         * of the two was edited last.
         */
        clearinghouseIdFor: async (payerId: string | null) => clearinghouseIdFor(payerId, await payers()),
      },
      // Deadlines are calendar days in the CLINIC’s day, not the server’s. Without this the
      // engines count in UTC and a US practice is told its claims expired from late afternoon on
      // the last day they were filable. See packages/shared/src/calendar.ts.
      config.practiceTimeZone,
      /**
       * ── SUBMISSION BRACKETS THE CLEARINGHOUSE CALL IN TWO SHORT TRANSACTIONS (NEW-10) ────────
       *
       * `withCurrentPractice` joins an ambient transaction when there is one — so every route that
       * is not self-transacting behaves exactly as before — and opens a fresh short one when only
       * the practice SCOPE is set, which is what the submit route runs inside.
       *
       * Inline (no transaction) without a database: the in-memory repository has nothing to commit.
       */
      persistent ? { run: (fn) => withCurrentPractice(() => fn()) } : InlineUnitOfWork
    ),
    /**
     * `merchantDiscountRateBps` is null unless the practice has stated it (F1). A non-ACH payer
     * payment is detected and published either way; the rate only decides whether the observation
     * can say what receiving it COST. Passing the config value straight through — rather than
     * defaulting here — is what keeps an unset deployment reporting "not known" instead of a
     * plausible number nobody measured.
     */
    remittance: new RemittanceService(
      remittanceRepo,
      expectationRepo,
      ediAdapter,
      bus,
      eraArtifactRepo,
      /**
       * Resolved per POSTING rather than per process, because the rate belongs to the practice
       * whose transaction the posting is running inside. The deployment's own value is the
       * fallback, so a single-practice deployment behaves exactly as it did.
       */
      async () => (await practiceSettings.get()).merchantDiscountRateBps ?? config.merchantDiscountRateBps,
      testInterchangePolicy(config),
      coordinationRepo,
    ),
  });

  const { verification, claims, remittance } = via(adapter);

  const denialRepo: DenialRepository = persistent ? new PgDenialRepository() : new InMemoryDenialRepository();
  /**
   * AI writes the argument paragraph of an appeal letter; everything else in the letter, and the
   * decision to appeal at all, stays deterministic (workflow S14).
   *
   * Built here rather than inside the module for the same reason `payerHistory` is: the module
   * depends on a one-method port it owns, and the composition root is the only place that knows a
   * concrete LLM exists. With `LLM_PROVIDER=off` — the default — the router degrades on every call
   * and the service falls back to the deterministic letter it has always produced.
   */
  const denials = new DenialService(
    denialRepo,
    payerProfile,
    { name: config.billingProviderName },
    bus,
    createAppealNarrator(llm),
    // Narration over the deterministic CARC data — never a second triage engine (workflow S10/S13).
    createDenialExplainer(llm),
    config.practiceTimeZone
  );

  const factRepo: FactRepository = persistent ? new PgFactRepository() : new InMemoryFactRepository();
  const analytics = new AnalyticsService(factRepo);

  const ledgerRepo: LedgerRepository = persistent ? new PgLedgerRepository() : new InMemoryLedgerRepository();
  /**
   * The ledger learns whose money it is (M14 part 2).
   *
   * Resolved through the coverage the verification recorded — the one place a member ID and a person
   * are seen together. Additive: `patientKey` is still the account key for every existing query, so
   * no balance depends on this resolving and none can move because it did.
   */
  const ledger = new PatientLedgerService(ledgerRepo, bus, {
    byMemberId: (memberId) => patients.patientIdForMemberId(memberId),
    /**
     * The cycle's own charges cite a claim, and a claim is unambiguous where a member ID is not:
     * `verification_id` is NOT NULL and unique per claim, and the verification names the patient.
     *
     * Composed from two repositories rather than reached through either module, because neither
     * owns both tables — this is the composition root's job, and it is the same chain the patient
     * record scopes claims by. Null whenever any link is missing, which the ledger then answers
     * from the member ID exactly as before.
     */
    byClaimId: async (claimId) => {
      const claim = await claimRepo.getById(claimId);
      if (!claim) return null;
      const verification = await verificationRepo.getById(claim.verificationId);
      return verification?.patientId ?? null;
    },
  });

  registerClaimsSubscriptions(bus, claims);
  registerRemittanceSubscriptions(bus, remittance);
  registerDenialSubscriptions(bus, denials);
  // The patient ledger catches what the payer did not pay: the responsibility the payer itself
  // assigned, and any denial a human closed as the patient's. Before M9 both simply vanished.
  registerPatientLedgerSubscriptions(bus, ledger);
  // Analytics listens to almost everything and imports nothing — the boundary rule producing a
  // better design rather than merely being obeyed.
  registerAnalyticsSubscriptions(bus, analytics);

  /**
   * ── THE LEARNING LOOP CLOSES HERE ────────────────────────────────────────────────────────────
   *
   * An appeal outcome is the only place real-world evidence enters this system. Everything upstream
   * is deterministic calculation; this is the feedback that makes the next triage better than the
   * last (blueprint doc 11).
   *
   * Wired in the composition root rather than inside a module because the payer profile is platform
   * — global, not tenant-scoped — so no module owns this subscription.
   *
   * ── WHY A REDELIVERY CANNOT DOUBLE-COUNT, AND WHY IT IS NOT THE REASON WRITTEN HERE BEFORE ────
   * This used to say the handler is "idempotent in effect", because a redelivered outcome "nudges a
   * rate that is already a blended running mean" and the small-sample gate stops it moving a trusted
   * rule. Neither half describes the code. `recordOutcome` stores RAW COUNTS — `sampleSize + 1`,
   * `wonCount + 1` — and derives the posterior on read; there is no running mean to nudge. And the
   * small-sample gate is the case with the MOST to lose: on a rule's first outcome a duplicate would
   * move the posterior about five points, and every duplicate inflates `sampleSize`, which is what
   * decides `trusted` — so a rule could cross the 20-sample threshold on fewer than 20 real appeals
   * and start telling a biller "from N recorded outcomes" instead of "provisional".
   *
   * It is safe for a different reason, and the real one is worth naming because it is load-bearing:
   * the dispatcher runs `handler` and `markDelivered` inside ONE `withPractice` transaction
   * (`pg-bus.ts`), and `upsertRule` reuses the ambient transaction through `withoutPractice`. The
   * increment and its delivery checkpoint therefore commit together or roll back together.
   *
   * Which means the guarantee belongs to the DISPATCHER, not to this handler. A future subscriber
   * that increments a counter outside the ambient transaction — its own pool, an HTTP call, a
   * second connection — has none of this protection, and the sentence this replaces would have told
   * its author they were safe.
   */
  /**
   * ── LEARNING WHAT A PAYER ACTUALLY ALLOWS (F-1) ───────────────────────────────────────────────
   *
   * The estimate engine quotes both the insurance and the patient share off the practice's BILLED
   * FEE. For an in-network practice that is wrong twice: the payer pays a percentage of its
   * contracted ALLOWED amount, and the gap between the fee and that amount is a write-off nobody
   * owes — so the patient is quoted money no one will ever collect. A patient who declines a crown
   * over a figure that is $71.25 too high is revenue the practice never sees and never learns it
   * lost, because nothing reports treatment not accepted.
   *
   * The payer states the real figure on every advice and nothing was reading it. Remittance
   * publishes what it saw; the profile records it. Neither reads the other's tables, and the two
   * meet here like every other cross-context pair in this file.
   *
   * Nothing consumes the result yet. That is deliberate — this stage only accumulates observations,
   * and a code with no observation falls back to the billed fee, which is exactly today's
   * behaviour. Adding data changes no quote until the estimate is taught to read it.
   */
  bus.subscribe("remittance.allowed_amounts_observed", "payer-profile:learn-allowed", async (event) => {
    for (const line of event.payload.lines) {
      await allowedAmounts.record({
        payerId: event.payload.payerId,
        cdtCode: line.cdtCode,
        allowed: line.allowed,
        charged: line.charged,
        observedAt: event.payload.observedAt,
      });
    }
    /**
     * The other direction (0028). A code paid with no contractual reduction is evidence the
     * agreement may have lapsed — a practice that leaves a network keeps being paid at full price,
     * and without this the rate learned while in network would discount every future quote forever.
     * A no-op for codes we hold no rate for.
     */
    for (const cdtCode of event.payload.fullPriceCodes) {
      await allowedAmounts.recordFullPrice(event.payload.payerId, cdtCode, event.payload.observedAt);
    }
  });

  /**
   * ── WHAT A PAYER CHARGED THE PRACTICE TO PAY IT (F1) ─────────────────────────────────────────
   *
   * Remittance publishes only the payments that did NOT arrive over ACH; this records them. The fee
   * travels already computed or already null — the rate is a practice-level configuration the
   * remittance service holds, and recomputing it here would put the same arithmetic in two places
   * where they could disagree about the same payment.
   *
   * Idempotent on the remittance id, which is what makes this safe on an at-least-once bus: a
   * redelivered observation overwrites its own row instead of counting a second fee. That is the
   * property the counter-shaped alternative could not have had.
   */
  bus.subscribe("remittance.payment_method_observed", "payer-profile:payment-method", async (event) => {
    await paymentMethods.record({
      remittanceId: event.payload.remittanceId,
      dedupeKey: event.payload.dedupeKey,
      payerName: event.payload.payerName,
      method: event.payload.method,
      paymentTotal: event.payload.paymentTotal,
      feeCents: event.payload.feeCents,
      reverted: event.payload.reverted,
      priorMethod: event.payload.priorMethod,
      observedAt: event.payload.observedAt,
    });
  });

  /**
   * ── DID THE PAYER HONOUR THE RATE IT ITSELF STATED? (F2) ─────────────────────────────────────
   *
   * A SECOND subscriber on the event the learner above already takes, rather than a change to it.
   * The bus checkpoints per subscriber, so the two are independent: this one failing re-delivers
   * only to this one, and the learned-rate path a quote depends on is untouched by anything that
   * happens here. It is also what makes F2 removable — unsubscribe and the system is exactly as it
   * was.
   *
   * ── SHADOW MODE ──────────────────────────────────────────────────────────────────────────────
   * Findings are recorded and read by nothing that decides anything. No estimate consults an epoch,
   * no appeal is built from a variance, no money moves. The classifier accumulates against real
   * traffic so it can be judged before it is allowed to speak — the only honest way to turn on a
   * detector whose false positives would have a biller phoning payers about money they were paid.
   *
   * Idempotent on `(remittanceId, payerId, cdtCode)`, which is what makes it safe on an at-least-once
   * bus. The EPOCH fold is not idempotent on its own — a redelivered observation would count as a
   * second sighting and could corroborate a candidate that only one advice ever supported — so the
   * per-subscriber checkpoint is doing real work here, and this handler must never be renamed.
   */
  bus.subscribe("remittance.allowed_amounts_observed", "payer-profile:allowed-variance", async (event) => {
    if (event.payload.lines.length === 0) return;
    /**
     * This payer's other confirmed rates, loaded ONCE and passed into every fold below — the input
     * the alternate-benefit test needs to say "you paid D2392 at D2150's rate, to the cent". Read
     * before any fold runs so that one line of an advice cannot change what the next line of the
     * same advice is compared against.
     */
    const peerRates = await allowedVariances.confirmedRatesForPayer(event.payload.payerId);

    for (const line of event.payload.lines) {
      await allowedVariances.observe(
        {
          remittanceId: event.payload.remittanceId,
          payerId: event.payload.payerId,
          cdtCode: line.cdtCode,
          allowed: line.allowed,
          charged: line.charged,
          observedAt: event.payload.observedAt,
          /**
           * The name the 835 PRINTED, not the slug beside it. They are normally the same party, and
           * the gap between them is the leased-network finding: a claim contracted with one payer
           * coming back repriced under another entity's name applied someone else's fee schedule.
           */
          observedPayerName: event.payload.payerName,
        },
        { peerRates }
      );
    }
  });

  /**
   * ── THE TWO CLOCKS NOBODY WAS READING (F5) ───────────────────────────────────────────────────
   *
   * PROMPT PAY: a payer that takes longer than its state allows to pay a CLEAN claim owes simple
   * interest on it by statute. Most never volunteer it, and the obligation appears on no remittance
   * and in no aging bucket, because the only evidence of it is the gap between two dates.
   *
   * RECOUPMENT: a payer may only claw a payment back for so long. A PLB `WO` arriving after the
   * window has closed is money the practice can demand back — and it currently balances the advice
   * and reconciles without comment.
   *
   * ── JURISDICTION IS AN ASSUMPTION, AND IT IS RECORDED AS ONE ─────────────────────────────────
   * `config.billingProviderState` is the practice's own state. Which state's law governs a given
   * plan is genuinely a harder question — it turns on where the plan is issued — so the state is
   * stored on every finding rather than implied, and a wrong answer stays findable. Empty state,
   * or a state with no verified rule, produces NOTHING: never a default window, never a typical
   * rate. See `statutes.ts` for why California is deliberately absent.
   *
   * ── SHADOW MODE ──────────────────────────────────────────────────────────────────────────────
   * Nothing here alters a posting, a balance or a ledger entry. It records what the arithmetic
   * found and waits to be read — which matters more here than anywhere else in this file, because
   * these findings are addressed to somebody ELSE. A false positive is not a wrong internal number;
   * it is a demand letter the practice loses, and the credibility it needs on the next one.
   *
   * Idempotent on `(remittanceId, kind, subject)`, so an at-least-once bus cannot raise a second
   * demand for the same money, and a redelivery cannot reopen a dispute a person has closed.
   */
  bus.subscribe("remittance.statutory_clock_observed", "payer-profile:statutory-clock", async (event) => {
    /**
     * The practice's OWN state where it has stated one; the deployment default otherwise. Read
     * inside the handler rather than at build time because this subscriber runs inside the
     * event's practice transaction, which is the only place the answer is knowable.
     */
    const state = ((await practiceSettings.get()).jurisdictionState ?? jurisdiction).trim().toUpperCase();
    const paymentDate = event.payload.paymentDate;
    /**
     * No payment date, no clock. An advice whose BPR16 is missing or not a real day arrives here
     * undated (the normaliser stores no date rather than one Postgres refuses), and both clocks run
     * FROM that date. `claim_payment_clock.paid_at` is `DATE NOT NULL`, so recording it threw on every
     * redelivery until the event dead-lettered. Nothing is lost by stopping: a window counted from
     * a guessed date is one the payer can disprove, which is worse than no window.
     */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate ?? "")) return;

    for (const claim of event.payload.claims) {
      /**
       * Remember when this claim was paid BEFORE assessing anything, and unconditionally.
       *
       * This index is what lets a takeback two years from now be dated, and it has to be written
       * even for a practice in a state with no rule and even for a claim no clock fires on — a
       * practice that moves state, or a rule verified later, must not find a hole where its own
       * payment history should be. The store keeps the FIRST payment per claim, so a supplemental
       * cheque cannot restart the window.
       */
      if (claim.paidAmount > 0) {
        await statutoryClock.recordPayment({
          patientControlNumber: claim.patientControlNumber,
          payerId: claim.payerId,
          payerName: event.payload.payerName,
          paidAt: paymentDate,
          paidCents: claim.paidAmount,
          remittanceId: event.payload.remittanceId,
        });
      }

      const { finding } = assessPromptPay(
        {
          submittedAt: claim.submittedAt,
          paidAt: paymentDate,
          paidCents: claim.paidAmount,
          /**
           * Electronic because this system files through a clearinghouse and has no paper path.
           * It is asserted rather than assumed: only claims carrying an expectation THIS practice
           * recorded reach here, and every one of those was filed as an 837.
           */
          submissionChannel: "electronic",
          adjustments: claim.adjustments,
          interestPaidAtProviderLevel: event.payload.interestPaidAtProviderLevel,
          disposition: claim.disposition,
        },
        promptPayRuleFor(state, paymentDate)
      );
      if (!finding) continue;

      await statutoryClock.record(
        toStored(finding, {
          remittanceId: event.payload.remittanceId,
          subject: claim.patientControlNumber,
          payerId: claim.payerId,
          payerName: event.payload.payerName,
          state,
          detectedAt: event.payload.observedAt,
        })
      );
    }

    for (const plb of event.payload.providerAdjustments) {
      /**
       * The original payment date comes from this feature's own index, which only holds claims paid
       * since it was switched on. A takeback naming a claim it has never seen yields
       * `original-payment-unknown` and no finding — a defence built on a guessed payment date is
       * one the payer can disprove, which is worse than no defence at all.
       */
      const original = plb.referenceId === null ? null : await statutoryClock.paymentFor(plb.referenceId);
      const { finding } = assessRecoupment(
        {
          reasonCode: plb.reasonCode,
          referenceId: plb.referenceId,
          amountCents: plb.amount,
          recoupedAt: paymentDate,
          originalPaidAt: original?.paidAt ?? null,
        },
        recoupmentRuleFor(state, paymentDate)
      );
      if (!finding) continue;

      await statutoryClock.record(
        toStored(finding, {
          remittanceId: event.payload.remittanceId,
          subject: finding.referenceId,
          payerId: original?.payerId ?? null,
          payerName: event.payload.payerName,
          state,
          detectedAt: event.payload.observedAt,
        })
      );
    }
  });
  bus.subscribe("appeal.outcome.recorded", "payer-profile:learn", async (event) => {
    await payerProfile.recordOutcome({
      payerId: event.payload.payerId,
      carcCode: event.payload.carcCode,
      cdtCode: event.payload.procedureCode,
      won: event.payload.won,
    });
  });

  /**
   * ── THE SETTLEMENT LOOP: WHERE A WON APPEAL FINALLY BECOMES CASH (F-2) ────────────────────────
   *
   * Denials owns awards; Remittance owns postings and expectations; neither may read the other's
   * tables. So the two halves of a settlement meet HERE, at the composition root, over the bus:
   *
   *   appeal.outcome.recorded ──→ push the recomputed receivable onto the expectation  (L-1)
   *   remittance.posted       ──→ attribute the cash to the award it settles           (F-2)
   *                           └─→ push the recomputed receivable again                 (S1)
   *
   * Both handlers ASSIGN a figure recomputed from the denials that own it — never an increment.
   * Delivery is at-least-once with per-subscriber checkpointing, so either can legitimately run
   * twice; recomputation makes a replay converge instead of accumulate. That single property is
   * what makes every case in the Phase 3 matrix safe: duplicate ERA, duplicate outcome event,
   * worker retry, crash between consumers.
   *
   * Both run inside the dispatcher's `withPractice` transaction, so they are tenant-scoped by RLS
   * rather than by a WHERE clause anyone could forget, and each commits with its own delivery
   * checkpoint.
   */
  const syncAwardProjection = async (claimId: string, patientControlNumber: string): Promise<void> => {
    /**
     * Invariant S1: `claim_expectations.award_outstanding_cents` equals the sum, over this claim's
     * open awards, of (awarded − settled). Read from Denials, written to Remittance, joined here
     * because the boundary forbids either module doing it directly.
     */
    const outstanding = await denials.awardOutstandingForClaim(claimId);
    await remittance.setAwardOutstanding(patientControlNumber, outstanding);
  };

  bus.subscribe("appeal.outcome.recorded", "remittance:award-expectation", async (event) => {
    const { claimId, claimControlNumber } = event.payload;
    if (!claimControlNumber) return;
    await syncAwardProjection(claimId, claimControlNumber);
  });

  /**
   * A settled award stops the posting it came from advertising the money (F-5).
   *
   * Denials knows an award settled; only Remittance can act on the posting; neither may read the
   * other. So the join happens here, like every other cross-context step. The payload carries the
   * TOTAL resolved, and `resolveRecoverable` assigns it, so a redelivery converges.
   *
   * The payer's own figure on the posting is never touched — what is recorded is what the practice
   * resolved, and the outstanding amount is the difference.
   */
  bus.subscribe("denial.recovery.settled", "remittance:resolve-recoverable", async (event) => {
    const { postingId, resolvedAmount } = event.payload;
    await remittance.resolveRecoverable(postingId, resolvedAmount, new Date(event.payload.settledAt));
  });

  bus.subscribe("remittance.posted", "denials:settle-award", async (event) => {
    const { claimId, postingId, paidAmount, patientControlNumber, procedureCodes } = event.payload;
    if (!claimId) return;

    const { settled, attribution } = await denials.settleAwardsFromPosting(
      { claimId, postingId, paidAmount, procedureCodes },
      new Date(event.payload.postedAt)
    );

    /**
     * Cash arrived that belongs to an award nobody can identify. The money HAS posted — to the
     * claim and to the ledger — so nothing is lost; only the award credit waits for a person. It is
     * raised on the alert channel rather than swallowed, because a silent non-settlement is exactly
     * the disappearing-recovery symptom this whole phase exists to remove.
     */
    if (attribution.kind === "ambiguous") {
      logger.warn("Cash posted but no appeal award could be credited — two or more are open.", {
        channel: "alert",
        claimId,
        postingId,
        candidates: attribution.candidates,
        reason: attribution.reason,
      });
    }

    /**
     * Re-synced whether or not anything settled. A `remittance.posted` that settles nothing can
     * still be the FIRST event after an award was recorded out of order, and the projection has to
     * end up right either way.
     */
    await syncAwardProjection(claimId, patientControlNumber);
    if (settled.length) {
      logger.info("Appeal award settled from posted cash.", {
        channel: "app",
        claimId,
        postingId,
        denialIds: settled.map((d) => d.denial.id),
        status: settled.map((d) => d.denial.status),
      });
    }
  });

  /**
   * Drain the outbox.
   *
   * Under Postgres, `publish()` only enqueues — dispatching inline would run handlers before the
   * business transaction committed. So the HTTP layer drains AFTER a mutating request commits, which
   * makes the demo feel synchronous (the claim exists by the time the response is read) without
   * weakening the transactional guarantee. A background interval catches anything a request missed,
   * plus retries and any events another process enqueued.
   *
   * The in-memory outbox dispatches on publish, so this is a no-op there.
   */
  const drainOutbox = async (): Promise<void> => {
    if (!(bus instanceof PostgresEventBus)) return;
    try {
      await bus.drainAll();
    } catch (err) {
      // Never let queue mechanics fail a request that already committed.
      logger.error("outbox drain failed", {
        channel: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    verification,
    via,
    claims,
    remittance,
    denials,
    analytics,
    ledger,
    patients,
    appointments: new AppointmentService(
      persistent ? new PgAppointmentRepository() : new InMemoryAppointmentRepository(),
      patients,
      verificationRepo,
      config.practiceTimeZone,
      // "Verify all due" runs where no transaction is open (NEW-10): one short one per check.
      persistent ? { run: (fn) => withCurrentPractice(() => fn()) } : { run: (fn) => fn() }
    ),
    timeZone: config.practiceTimeZone,
    payerProfile,
    allowedAmounts,
    paymentMethods,
    allowedVariances,
    statutoryClock,
    practiceSettings,
    eraSources: persistent ? new RepositoryEraSourceAdmin(new PgEraSourceRepository()) : NoEraSources,
    eraArtifacts: eraArtifactRepo,
    persistent,
    bus,
    drainOutbox,
  };
}

/**
 * Start the background outbox worker.
 *
 * In production this is a separate process (blueprint doc 12); in-process is correct for a
 * single-node deployment and is what makes retries and dead-lettering actually happen rather than
 * merely being implemented. `unref()` so it never holds the process open.
 */
/**
 * Run the claim sweeps on a timer, for every active practice (F4).
 *
 * ── WHY THIS HAS TO EXIST ────────────────────────────────────────────────────────────────────
 * `sweepSilentClaims` is an explicit method rather than a timer inside the module, so the caller
 * owns the cadence and the behaviour stays deterministic under test. That is the right shape and
 * it leaves one obligation: SOMETHING has to be the caller. Until it is, the watchdog is a
 * function nobody invokes — which reads, from outside, exactly like a feature that works.
 *
 * ── WHY IT ENUMERATES PRACTICES ──────────────────────────────────────────────────────────────
 * A sweep has no event to inherit a tenant from, and every read it makes is under RLS. Without an
 * explicit practice it would see nothing at all and report a clean pass — the worst available
 * outcome, because silence from a watchdog is indistinguishable from good news.
 *
 * So it takes the shape `readEveryPractice` in monitors.ts already uses: enumerate the active
 * practices outside any tenant, then do each one's work inside `withPractice`. Failure is
 * isolated per practice for the same reason it is there — one tenant whose data trips a bug must
 * not stop the other tenants being swept.
 *
 * ── WHY IT IS SAFE TO RUN IN MORE THAN ONE PROCESS ───────────────────────────────────────────
 * Two workers sweeping at once both reach `lockById`, and the second blocks on the row until the
 * first commits — then re-checks `silenceWorsened` against what it now sees and skips. The
 * escalation is written under the same lock that decides whether to write it, so a claim cannot
 * be escalated twice.
 *
 * Events land in the outbox inside each practice's transaction; the outbox worker delivers them.
 * Nothing here dispatches.
 */
export function startSweeps(services: Services, intervalMs = 60 * 60_000): { stop(): void } {
  /**
   * In-memory deployments are the laptop demo and the test suite. There is no durable store to
   * sweep and no practice table to enumerate, and a timer mutating claims underneath a test that
   * did not ask for one is its own defect.
   */
  if (!services.persistent) return { stop() {} };

  const tick = async (): Promise<void> => {
    let practices: { id: string }[];
    try {
      const { rows } = await withoutPractice((tx) =>
        tx.query("SELECT id FROM practices WHERE status = 'active' ORDER BY id")
      );
      practices = rows as { id: string }[];
    } catch (err) {
      logger.error("sweep: could not enumerate practices", {
        channel: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const practice of practices) {
      try {
        const escalated = await withPractice(practice.id, async () => {
          const silent = await services.claims.sweepSilentClaims();

          /**
           * ── THE CLAIM THE PAYER NEVER ANSWERED AT ALL (F5) ─────────────────────────────────
           *
           * Every verified prompt-pay statute requires the payer to pay OR DENY within the window,
           * so a claim still unanswered past it is already late — and it produces no remittance,
           * which is why the remittance-driven half of F5 could never see it.
           *
           * The watchdog's list is reused rather than a second query written, because it is a
           * SUPERSET: it surfaces an unacknowledged claim at 7 days and a stalled one at 30, and
           * the shortest statutory window is 30 — so anything past a deadline is already on it.
           * Reusing it also means the elapsed-day count is computed once, on the practice's own
           * calendar, instead of being restated here where the two could drift by a day.
           *
           * Only `submitted` claims. A `rejected` one WAS answered — the payer refused it at
           * intake — and no pay-or-deny clock is still running on it.
           */
          /**
           * The practice's own state where it has stated one, and the deployment default where it
           * has not — the same ordering the event subscriber uses, read here from the services
           * surface because this function runs outside the composition root's closure.
           */
          const state = ((await services.practiceSettings.get()).jurisdictionState ?? getConfig().billingProviderState)
            .trim()
            .toUpperCase();
          const today = new Date().toISOString().slice(0, 10);

          for (const claim of await services.claims.silenceWatchlist()) {
            if (claim.status !== "submitted") continue;
            const { finding } = assessUnpaidDeadline(
              {
                elapsedDays: claim.finding.daysSilent,
                submissionChannel: "electronic",
                expectedInsurancePays: claim.finding.amountAtRisk,
              },
              promptPayRuleFor(state, today)
            );
            if (!finding) continue;

            await services.statutoryClock.record(
              toStored(finding, {
                /**
                 * There is no remittance — that is the finding. The CLAIM id takes its place so the
                 * primary key still does its job: one deadline alert per claim, however often this
                 * sweep runs. See migration 0032.
                 */
                remittanceId: claim.id,
                subject: claim.controlNumber || claim.id,
                payerId: null,
                payerName: claim.payerName ?? "",
                state,
                detectedAt: new Date().toISOString(),
              })
            );
          }

          return silent;
        });
        if (escalated.length > 0) {
          logger.info("claims went silent", {
            channel: "app",
            practiceId: practice.id,
            count: escalated.length,
          });
        }
      } catch (err) {
        logger.error("silent-claim sweep failed for one practice", {
          channel: "error",
          practiceId: practice.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
export const DEFAULT_OUTBOX_INTERVAL_MS = 5_000;
/**
 * `OUTBOX_INTERVAL_MS`, read the same way by the web process and the standalone worker.
 *
 * Every drain is a query, so this interval is also how often the database is woken. A serverless
 * Postgres that suspends after a few idle minutes never suspends under a 5s poll, and on a free
 * compute quota that is the whole month's budget gone in about two weeks. Raising it is the knob.
 *
 * Refused rather than coerced: `setInterval` treats NaN, 0 and anything above 2^31-1 as ONE
 * millisecond, so a typo would turn the setting meant to quiet the database into a loop hammering
 * it. Below a second is refused for the same reason — it is never what anyone meant.
 */
export function outboxIntervalMs(raw: string | undefined = process.env.OUTBOX_INTERVAL_MS): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_OUTBOX_INTERVAL_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 1_000 || ms > 2_147_483_647) {
    throw new Error(
      `OUTBOX_INTERVAL_MS must be a whole number of milliseconds between 1000 and 2147483647; got "${raw}"`
    );
  }
  return ms;
}
export function startOutboxWorker(services: Services, intervalMs = DEFAULT_OUTBOX_INTERVAL_MS): { stop(): void } {
  if (!services.persistent) return { stop() {} };
  const timer = setInterval(() => {
    void services.drainOutbox();
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
