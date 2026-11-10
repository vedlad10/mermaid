/**
 * Bootstrap seeding — and specifically the property that no credential material ever reaches a log.
 *
 * ── WHAT THESE TESTS EXIST TO STOP (F-3) ───────────────────────────────────────────────────────
 * `ensureSeeded` used to write every generated password to the log whenever `!config.isProd`. A
 * hosted deployment is not a developer laptop: its stdout is retained by the platform and
 * readable by anyone with dashboard access, and the seeded accounts include `owner`.
 *
 * So the tests below are deliberately structural rather than incidental. It is not enough to assert
 * that today's log line happens to omit passwords — the next person to add "one more helpful field"
 * would sail past that. They pin three things instead:
 *
 *   1. The announcement's FIELD SET is a closed whitelist, so any new field fails the test.
 *   2. Real sentinel passwords are placed in the environment and the entire captured stdout is
 *      scanned for them, so a leak through any path is caught rather than just the known one.
 *   3. Production cannot reach a seeding branch at all, and says so loudly rather than silently
 *      downgrading — a silent downgrade is how an operator concludes the setting works.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSeedMode,
  collectSuppliedPasswords,
  announceSeeded,
  SEED_PASSWORD_ENV_KEYS,
} from "../service.ts";

/**
 * Capture everything the real logger writes. `defaultSink` in the observability package writes to
 * `process.stdout.write`, so stubbing it exercises the ACTUAL production path rather than a test
 * double that could drift from it.
 */
function captureStdout(run: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    run();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = original;
  }
  return chunks.join("");
}

/** A password nobody would produce by accident, so finding it anywhere is unambiguous. */
const SENTINEL = (key: string): string => `SENTINEL-LEAK-CANARY-${key}-9f3a7c`;

const suppliedEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(SEED_PASSWORD_ENV_KEYS.map((k) => [k, SENTINEL(k)]));

/**
 * Put the sentinels into the REAL `process.env` for the duration of `run`, and restore it after.
 *
 * ── WHY THIS IS NOT OPTIONAL, AND HOW WE KNOW ──────────────────────────────────────────────────
 * The first version of these tests passed a synthetic `env` object to `collectSuppliedPasswords`
 * and left `process.env` untouched. A mutation that reintroduced the original defect verbatim —
 * reading `process.env` inside the announcement and logging `email / password` — passed all
 * fifteen tests, because the real environment held no passwords for it to leak.
 *
 * A leak reads whatever source it likes. The only way to catch one is for the real source to
 * actually contain something worth leaking while the output is watched, so the sentinels go where
 * production code would look for them.
 */
function withSeedEnv<T>(run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of SEED_PASSWORD_ENV_KEYS) {
    saved.set(key, process.env[key]);
    process.env[key] = SENTINEL(key);
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── Mode resolution ───────────────────────────────────────────────────────────────────────────

test("production defaults to off, so a deployment that says nothing seeds nothing", () => {
  assert.equal(resolveSeedMode({}, true), "off");
});

test("production refuses an explicit request to seed rather than downgrading in silence", () => {
  for (const mode of ["random", "explicit"]) {
    assert.throws(
      () => resolveSeedMode({ AUTH_SEED_MODE: mode }, true),
      /refused in production/,
      `AUTH_SEED_MODE=${mode} must be refused, not ignored`
    );
  }
});

test('production accepts "off" as the no-op it already is', () => {
  assert.equal(resolveSeedMode({ AUTH_SEED_MODE: "off" }, true), "off");
});

test("a non-production deployment that says nothing gets random passwords, not logged ones", () => {
  assert.equal(resolveSeedMode({}, false), "random");
});

test("every documented mode is accepted outside production", () => {
  for (const mode of ["off", "random", "explicit"] as const) {
    assert.equal(resolveSeedMode({ AUTH_SEED_MODE: mode }, false), mode);
  }
});

test("an unrecognised mode is refused rather than guessed at", () => {
  assert.throws(() => resolveSeedMode({ AUTH_SEED_MODE: "yes-please" }, false), /must be one of/);
});

test("whitespace around a mode does not change its meaning", () => {
  assert.equal(resolveSeedMode({ AUTH_SEED_MODE: "  explicit  " }, false), "explicit");
});

// ── Supplied passwords ────────────────────────────────────────────────────────────────────────

test("an empty environment reports every seed key as missing", () => {
  const { supplied, missing } = collectSuppliedPasswords({});
  assert.equal(supplied.length, 0);
  assert.deepEqual([...missing].sort(), [...SEED_PASSWORD_ENV_KEYS].sort());
});

test("a fully supplied environment reports nothing missing", () => {
  const { supplied, missing } = collectSuppliedPasswords(suppliedEnv());
  assert.equal(supplied.length, SEED_PASSWORD_ENV_KEYS.length);
  assert.deepEqual(missing, []);
});

/**
 * The partial case is what separates the two modes: `random` uses what it was given, `explicit`
 * refuses. Both need the same read to report both halves.
 */
test("a partly supplied environment reports both halves", () => {
  const [first, ...rest] = SEED_PASSWORD_ENV_KEYS as string[];
  const { supplied, missing } = collectSuppliedPasswords({ [first!]: "only-this-one" });
  assert.equal(supplied.length, 1);
  assert.deepEqual([...missing].sort(), [...rest].sort());
});

test("a blank string is not a supplied password", () => {
  const { supplied, missing } = collectSuppliedPasswords({ [SEED_PASSWORD_ENV_KEYS[0]!]: "   " });
  assert.equal(supplied.length, 0);
  assert.equal(missing.length, SEED_PASSWORD_ENV_KEYS.length);
});

// ── The property that matters: nothing leaks ──────────────────────────────────────────────────

test("no supplied password reaches stdout, on either announcement path", () => {
  withSeedEnv(() => {
    const { supplied } = collectSuppliedPasswords(process.env);
    assert.equal(
      supplied.length,
      SEED_PASSWORD_ENV_KEYS.length,
      "the environment must actually hold passwords, or this test proves nothing"
    );

    for (const mode of ["random", "explicit"] as const) {
      const out = captureStdout(() =>
        announceSeeded(
          mode,
          supplied.map((s) => s.email)
        )
      );
      assert.ok(out.length > 0, "the announcement must actually emit something");
      for (const s of supplied) {
        assert.ok(
          !out.includes(s.password),
          `mode "${mode}" leaked the password for ${s.email} into stdout`
        );
      }
      assert.ok(!out.includes("SENTINEL-LEAK-CANARY"), `mode "${mode}" leaked credential material`);
    }
  });
});

/**
 * The same watch, held over the whole announcement rather than one call — a leak emitted from a
 * helper, a lazy logger flush, or a second log line would still land in this capture.
 */
test("nothing resembling credential material is emitted while the environment is loaded", () => {
  const out = withSeedEnv(() =>
    captureStdout(() => {
      announceSeeded("random", ["owner@clinic.example"]);
      announceSeeded("explicit", ["owner@clinic.example"]);
    })
  );
  assert.ok(!/SENTINEL-LEAK-CANARY/.test(out), "credential material reached stdout");
  for (const key of SEED_PASSWORD_ENV_KEYS) {
    assert.ok(!out.includes(SENTINEL(key)), `the value of ${key} reached stdout`);
  }
});

/**
 * The whitelist. This is the test that catches the reintroduction, because the failure mode is
 * someone ADDING a field rather than changing an existing one.
 */
test("the announcement emits a closed set of fields and no others", () => {
  const expected: Record<"random" | "explicit", string[]> = {
    random: ["ts", "level", "channel", "message", "emails", "howToGetIn"],
    explicit: ["ts", "level", "channel", "message", "emails"],
  };
  for (const mode of ["random", "explicit"] as const) {
    const out = captureStdout(() => announceSeeded(mode, ["owner@clinic.example"]));
    const lines = out.trim().split("\n").filter(Boolean);
    /**
     * Exactly one line, and every line checked — not just the last. A mutation that ADDED a leaking
     * log line ahead of the safe one slipped past an earlier version of this test that read only
     * `.at(-1)`, so the count is asserted first and the whitelist is applied to all of them.
     */
    assert.equal(lines.length, 1, `mode "${mode}" emitted ${lines.length} log lines, expected 1`);
    for (const raw of lines) {
      const line = JSON.parse(raw);
      assert.deepEqual(
        Object.keys(line).sort(),
        expected[mode].sort(),
        `mode "${mode}" changed its field set — if the new field is safe, widen this list deliberately`
      );
      assert.equal(line.channel, "security");
    }
  }
});

test("the announcement reports emails, which are not secret, and reports all of them", () => {
  const emails = ["owner@clinic.example", "biller@clinic.example"];
  const out = captureStdout(() => announceSeeded("random", emails));
  const line = JSON.parse(out.trim().split("\n").at(-1)!);
  assert.deepEqual(line.emails, emails);
});

/**
 * `announceSeeded` takes emails and nothing else, so it CANNOT be handed a password. This asserts
 * the runtime consequence of that signature: passing the supplied pairs by mistake would surface
 * as an object in the output, not as a bare string, and the whitelist above would already fail.
 * Kept as its own test because the structural guarantee is the point of the design.
 */
test("the random-mode announcement points at the reset flow rather than at a password", () => {
  const out = captureStdout(() => announceSeeded("random", ["owner@clinic.example"]));
  const line = JSON.parse(out.trim().split("\n").at(-1)!);
  assert.match(line.howToGetIn, /auth:issue-reset/);
  assert.match(line.message, /Nobody knows them/);
});
