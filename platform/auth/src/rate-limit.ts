/**
 * Token-bucket rate limiting for the authentication endpoints (blueprint doc 08).
 *
 * ── WHAT THIS IS ACTUALLY DEFENDING ────────────────────────────────────────────────────────────
 * Login is the one endpoint an unauthenticated stranger may call as often as they like, and every
 * call is a guess at a password that protects patient health information. Everything else in this
 * system is behind a session; this is the door.
 *
 * The threat is not a clever attacker — it is an ordinary credential-stuffing script working a
 * breached password list at a few hundred attempts a second. `scrypt` at N=16384 already makes each
 * guess expensive, which is most of the defence, but it makes each guess expensive FOR US TOO: an
 * unthrottled flood is also a denial of service against the practice trying to log in and see a
 * patient's benefits.
 *
 * ── WHY A TOKEN BUCKET RATHER THAN A COUNTER ───────────────────────────────────────────────────
 * A fixed window ("5 attempts per minute") has two failure modes that matter here. It allows a burst
 * of 2× the limit across a window boundary, and — worse for a dental practice — it locks a
 * receptionist who fat-fingers a password five times out for the remainder of the minute with no
 * partial recovery. A bucket refills continuously, so a legitimate user who waits a few seconds gets
 * an attempt back, while a script hammering the endpoint stays pinned at the refill rate.
 *
 * Deliberately NOT lockout-on-N-failures. Account lockout triggered by a stranger's failed guesses
 * is a denial-of-service primitive aimed at the practice, not a defence: anyone who knows a staff
 * email can lock them out of the system on a day they need it.
 *
 * ── SCOPE, STATED HONESTLY ─────────────────────────────────────────────────────────────────────
 * Per-process and in memory, which is correct for the single web node this deployment runs and
 * is what doc 08 specifies ("single-instance now; shared store before horizontal scale"). Two web
 * instances would each hold their own bucket and the effective limit would double. That is a real
 * limit, recorded here rather than discovered later, and the seam for fixing it is this file: the
 * store is an interface, so Redis or Postgres slots in behind it without touching a caller.
 *
 * Pure and clock-injected, so every property below is testable without waiting in real time.
 */

export interface RateLimitPolicy {
  /** Attempts available in a burst, once the bucket is full. */
  capacity: number;
  /** Sustained rate the bucket refills at, in attempts per minute. */
  refillPerMinute: number;
}

/**
 * Ten attempts, refilling at two a minute.
 *
 * Chosen from what the two populations actually do. A receptionist who has genuinely forgotten which
 * of their passwords this is will use three or four attempts and then reach for the reset link;
 * ten is comfortably clear of that even on a bad morning. A credential-stuffing script gets ten
 * guesses and is then pinned to two a minute — roughly 2,900 a day, against a password list that
 * needs millions to be worth running. The point is not to make guessing impossible; it is to make
 * this endpoint a uselessly slow way to try.
 */
export const DEFAULT_AUTH_RATE_LIMIT: RateLimitPolicy = { capacity: 10, refillPerMinute: 2 };

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole attempts left after this one. */
  remaining: number;
  /** Seconds until at least one attempt is available. Zero when allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Tracks one bucket per key (an IP, in practice).
 *
 * Keys are evicted once their bucket is full and idle, so a long-running process does not accumulate
 * an entry for every address that has ever visited — which would itself be a slow memory leak an
 * attacker could drive.
 */
/**
 * Tracked keys above which a sweep runs before the next insert.
 *
 * A sweep is O(tracked), so it must not run per request; it must also not wait so long that the map
 * is the leak it is meant to prevent. A few thousand entries is far more distinct addresses than a
 * dental practice's sign-in page sees in a day, and trivial to walk.
 */
export const SWEEP_THRESHOLD = 2_048;

export class RateLimiter {
  #policy: RateLimitPolicy;
  #buckets = new Map<string, Bucket>();

  constructor(policy: RateLimitPolicy = DEFAULT_AUTH_RATE_LIMIT) {
    this.#policy = policy;
  }

  /**
   * Drop every bucket that would have refilled to full by now.
   *
   * A full bucket is indistinguishable from one that has never been seen, so forgetting it loses no
   * information and bounds the map. Without this, a key touched exactly once is retained forever —
   * the eviction on `take()` only fires for a key that comes BACK after refilling, which a scanner
   * cycling through addresses never does. That is a slow memory leak an attacker can drive, and it
   * is exactly what the bounded-map test caught.
   */
  #sweep(nowMs: number): void {
    const { capacity, refillPerMinute } = this.#policy;
    const msToFull = (capacity / refillPerMinute) * 60_000;
    for (const [key, bucket] of this.#buckets) {
      if (nowMs - bucket.lastRefillMs >= msToFull) this.#buckets.delete(key);
    }
  }

  /** Take one token for `key`. The decision and the side effect are the same call, deliberately. */
  take(key: string, now: Date = new Date()): RateLimitDecision {
    const nowMs = now.getTime();
    const { capacity, refillPerMinute } = this.#policy;
    const bucket = this.#buckets.get(key) ?? { tokens: capacity, lastRefillMs: nowMs };

    const elapsedMinutes = Math.max(0, nowMs - bucket.lastRefillMs) / 60_000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedMinutes * refillPerMinute);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens < 1) {
      const secondsPerToken = 60 / refillPerMinute;
      const retryAfterSeconds = Math.ceil((1 - bucket.tokens) * secondsPerToken);
      this.#buckets.set(key, bucket);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    bucket.tokens -= 1;

    // A full, untouched bucket carries no information — forgetting it is the same as remembering it,
    // and forgetting bounds the map.
    if (bucket.tokens >= capacity) {
      this.#buckets.delete(key);
    } else {
      if (this.#buckets.size >= SWEEP_THRESHOLD && !this.#buckets.has(key)) this.#sweep(nowMs);
      this.#buckets.set(key, bucket);
    }

    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
  }

  /** Give a key its full allowance back. Called after a SUCCESSFUL login — see the route. */
  reset(key: string): void {
    this.#buckets.delete(key);
  }

  /** How many keys are currently being tracked. Exposed so a test can assert the map stays bounded. */
  get tracked(): number {
    return this.#buckets.size;
  }
}
