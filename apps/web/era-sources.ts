/**
 * Registering and inspecting a practice's ERA sources — the path that actually encrypts (NEW-11).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `era_sources.credential` holds a clearinghouse API key that fetches a practice's payment files.
 * `PgEraSourceRepository.upsert` runs it through `encryptPhi` before it lands — and nothing outside
 * a test ever called that method. The only way to register a source was hand-written SQL against
 * the table, and hand-written SQL writes exactly what it is handed: a live credential in the clear,
 * in a column whose entire design assumes it is not.
 *
 * That is the difference between an encryption control existing and being used, which is the same
 * distinction as between a control and a claim about one.
 *
 * ── WHY THIS IS A THIN LAYER AND NOT A SERVICE ───────────────────────────────────────────────────
 * There is no domain decision here — the repository already owns idempotency (upsert on practice +
 * vendor), the cursor rule (re-registering must not rewind polling) and the encryption. What this
 * adds is the one thing the HTTP boundary needs and the repository must not have: a view of a
 * source that CANNOT carry the credential, so no route can return one by accident.
 */
import type { EraSource, EraSourceRepository } from "@mermaid/remittance";

/**
 * An ERA source as an operator may see it.
 *
 * The credential is absent BY CONSTRUCTION rather than by remembering to omit it — not the value,
 * not a prefix, not a length. A registration response that confirmed the key by showing part of it
 * would put it in a browser history, a proxy log and a screenshot.
 */
export interface EraSourceSummary {
  id: string;
  vendor: string;
  payeeNpi: string | null;
  enabled: boolean;
  cursor: string | null;
  lastPolledAt: string | null;
  lastError: string | null;
  /** Whether a credential is stored at all. A source without one can never fetch a file. */
  credentialConfigured: boolean;
  /**
   * Whether the stored credential is ENCRYPTED — the `v1:` envelope `encryptPhi` produces.
   *
   * `false` means a row written by something other than this path, which in practice means the
   * hand-written SQL this route replaces. Reported rather than repaired: re-encrypting somebody
   * else's row silently would hide how it got there, and the operator needs to rotate the key
   * anyway — a credential that has sat in the clear in a database is a credential that has been
   * in every backup of it.
   */
  credentialEncrypted: boolean;
}

export interface EraSourceRegistration {
  vendor: string;
  credential: string;
  payeeNpi: string | null;
  enabled: boolean;
}

/** What the HTTP layer is given. Nothing here can hand back a credential. */
export interface EraSourceAdmin {
  list(): Promise<EraSourceSummary[]>;
  register(input: EraSourceRegistration): Promise<EraSourceSummary>;
}

/**
 * One source, plus how its credential is STORED.
 *
 * The storage answer has to come from `credentialStorage()` rather than from the source itself:
 * every repository read decrypts on the way out, so `EraSource.credential` is plaintext whether the
 * column held an encrypted value or not. Deriving "is it encrypted?" from the decrypted value would
 * report every source as plaintext — the check would fire constantly and mean nothing.
 */
export function summariseEraSource(
  source: EraSource,
  storage: { configured: boolean; encrypted: boolean } | undefined
): EraSourceSummary {
  return {
    id: source.id,
    vendor: source.vendor,
    payeeNpi: source.payeeNpi,
    enabled: source.enabled,
    cursor: source.cursor,
    lastPolledAt: source.lastPolledAt,
    lastError: source.lastError,
    credentialConfigured: storage?.configured ?? false,
    // A source the storage read did not return is treated as UNPROTECTED. Absence of evidence about
    // a credential is not evidence it is safe, and the failure direction that matters is the one
    // that reports a plaintext key as fine.
    credentialEncrypted: storage?.encrypted ?? false,
  };
}

/**
 * The real implementation, over the repository that encrypts.
 *
 * `list` reads through the repository too, so what an operator is shown and what the poller uses
 * come from one place — a second query shaped slightly differently is how a screen ends up
 * describing a row the worker never sees.
 */
export class RepositoryEraSourceAdmin implements EraSourceAdmin {
  #repo: EraSourceRepository;

  constructor(repo: EraSourceRepository) {
    this.#repo = repo;
  }

  async list(): Promise<EraSourceSummary[]> {
    const [sources, storage] = await Promise.all([this.#repo.list(), this.#repo.credentialStorage()]);
    const byId = new Map(storage.map((s) => [s.id, s]));
    return sources.map((s) => summariseEraSource(s, byId.get(s.id)));
  }

  async register(input: EraSourceRegistration): Promise<EraSourceSummary> {
    const saved = await this.#repo.upsert({
      practiceId: "",
      vendor: input.vendor,
      credential: input.credential,
      payeeNpi: input.payeeNpi,
      // NOT reset on re-registration. Rotating a key or correcting an NPI must not rewind polling
      // to the beginning of time and re-offer every artifact the practice has ever taken in — the
      // repository documents this too, and passing null here is what lets it apply the rule.
      cursor: null,
      enabled: input.enabled,
    });
    const storage = (await this.#repo.credentialStorage()).find((s) => s.id === saved.id);
    return summariseEraSource(saved, storage);
  }
}

/** No database, no sources. The demo has no clearinghouse to register one against. */
export const NoEraSources: EraSourceAdmin = {
  async list() {
    return [];
  },
  async register() {
    throw new Error("this deployment runs without a database, so an ERA source cannot be registered");
  },
};
