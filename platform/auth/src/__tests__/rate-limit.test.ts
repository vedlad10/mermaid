/**
 * Auth rate limiting.
 *
 * Two populations use this endpoint and the tests are organised around not confusing them: a
 * receptionist who has forgotten which password this is, and a script working a breached list. The
 * limiter has to be nearly invisible to the first and useless to the second.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AUTH_RATE_LIMIT, RateLimiter, SWEEP_THRESHOLD } from "../rate-limit.ts";

const at = (ms: number): Date => new Date(1_700_000_000_000 + ms);
const MINUTE = 60_000;

test("a burst up to capacity is allowed — a bad morning is not an attack", () => {
  const limiter = new RateLimiter({ capacity: 10, refillPerMinute: 2 });
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.take("1.2.3.4", at(0)).allowed, true, `attempt ${i + 1} must be allowed`);
  }
});

test("the attempt past capacity is refused, and says when to come back", () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerMinute: 2 });
  for (let i = 0; i < 3; i++) limiter.take("1.2.3.4", at(0));

  const refused = limiter.take("1.2.3.4", at(0));
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
  // Two per minute → one token every 30 seconds.
  assert.equal(refused.retryAfterSeconds, 30);
});

test("the bucket refills continuously — waiting earns an attempt back", () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerMinute: 2 });
  for (let i = 0; i < 3; i++) limiter.take("1.2.3.4", at(0));
  assert.equal(limiter.take("1.2.3.4", at(0)).allowed, false);

  // 30s later exactly one token has accrued. This is the property a fixed window lacks: a
  // receptionist who waits half a minute gets an attempt, rather than being locked to a boundary.
  assert.equal(limiter.take("1.2.3.4", at(30_000)).allowed, true);
  assert.equal(limiter.take("1.2.3.4", at(30_000)).allowed, false, "…but only the one");
});

test("refill is capped at capacity — idling does not bank unlimited attempts", () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerMinute: 2 });
  limiter.take("1.2.3.4", at(0));

  // An hour of silence would be 120 tokens if uncapped.
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.take("1.2.3.4", at(60 * MINUTE)).allowed, true, `attempt ${i + 1}`);
  }
  assert.equal(limiter.take("1.2.3.4", at(60 * MINUTE)).allowed, false, "capacity is the ceiling");
});

test("a sustained attacker is pinned to the refill rate, not the capacity", () => {
  const limiter = new RateLimiter({ capacity: 10, refillPerMinute: 2 });
  let allowed = 0;

  // Hammering once a second for ten minutes.
  for (let second = 0; second < 600; second++) {
    if (limiter.take("attacker", at(second * 1_000)).allowed) allowed += 1;
  }

  // The initial burst plus the refill over the window — roughly 10 + 2×10. The point is not the
  // exact number, it is that 600 attempts bought about 30.
  assert.ok(allowed <= 31, `600 attempts must not yield more than ~30 (got ${allowed})`);
  assert.ok(allowed >= 25, `…and the honest user's allowance must still be there (got ${allowed})`);
});

test("buckets are per key — one attacker cannot lock everyone else out", () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerMinute: 2 });
  limiter.take("attacker", at(0));
  limiter.take("attacker", at(0));
  assert.equal(limiter.take("attacker", at(0)).allowed, false);

  assert.equal(limiter.take("the.practice", at(0)).allowed, true, "a stranger must not throttle the clinic");
});

test("succeeding gives the allowance back", () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerMinute: 2 });
  limiter.take("1.2.3.4", at(0));
  limiter.take("1.2.3.4", at(0));

  // The route calls reset() after a successful login: someone who just proved they know the
  // password is not guessing, and staying throttled after getting it right is pure friction.
  limiter.reset("1.2.3.4");

  for (let i = 0; i < 3; i++) assert.equal(limiter.take("1.2.3.4", at(0)).allowed, true);
});

test("the tracked-key map stays bounded — it must not become a slow memory leak", () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerMinute: 2 });

  // A scanner cycling through addresses, one attempt each, a minute apart. This is the shape that
  // defeats eviction-on-touch: no key ever comes BACK, so nothing is ever re-examined. Without the
  // sweep the map grows without limit, which is a slow leak an attacker can drive at will.
  const attempts = SWEEP_THRESHOLD * 3;
  for (let i = 0; i < attempts; i++) limiter.take(`10.0.${Math.floor(i / 256)}.${i % 256}`, at(i * MINUTE));

  assert.ok(
    limiter.tracked <= SWEEP_THRESHOLD,
    `${attempts} distinct addresses must not leave ${limiter.tracked} buckets behind`
  );
});

test("the shipped policy leaves room for a forgetful human and none for a list", () => {
  const { capacity, refillPerMinute } = DEFAULT_AUTH_RATE_LIMIT;
  assert.ok(capacity >= 5, "fewer than five attempts would throttle an ordinary bad morning");
  assert.ok(refillPerMinute <= 5, "a fast refill would make the throttle decorative");

  // Roughly what a script gets in a day, against a list that needs millions to be worth running.
  assert.ok(capacity + refillPerMinute * 60 * 24 < 10_000);
});
