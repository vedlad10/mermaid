/**
 * Secret resolution.
 *
 * The value here today is not the indirection — it is the inventory and the guard. A Security Risk
 * Assessment has to enumerate every secret a system holds, and a codebase full of ad-hoc
 * `process.env` reads cannot answer that question without a human reading all of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_SECRETS,
  getSecret,
  requireSecret,
  resetSecretResolver,
  secretInventory,
  setSecretResolver,
} from "../secrets.ts";

test("a secret resolves from the environment by default", () => {
  resetSecretResolver();
  process.env.PHI_ENCRYPTION_KEY = "a-test-key";
  assert.equal(getSecret("PHI_ENCRYPTION_KEY"), "a-test-key");
  delete process.env.PHI_ENCRYPTION_KEY;
});

test("an empty or whitespace value counts as NOT configured", () => {
  resetSecretResolver();
  // A blank env var is the classic half-configured deploy: present enough to pass a truthiness
  // check, useless as a credential. It must read as absent.
  process.env.PHI_ENCRYPTION_KEY = "   ";
  assert.equal(getSecret("PHI_ENCRYPTION_KEY"), undefined);
  delete process.env.PHI_ENCRYPTION_KEY;
});

test("requireSecret names what is missing and what it was for, and never a value", () => {
  resetSecretResolver();
  // STEDI_API_KEY, not EDI_API_KEY: the latter was in the inventory and read by nothing, while the
  // credential PHI actually leaves the system under was absent from it (NEW-09).
  const original = process.env.STEDI_API_KEY;
  delete process.env.STEDI_API_KEY;

  try {
    assert.throws(
      () => requireSecret("STEDI_API_KEY"),
      (err: Error) => {
        assert.match(err.message, /STEDI_API_KEY/, "the name is what an operator needs");
        assert.match(err.message, /Clearinghouse credential/, "and what it is for");
        return true;
      }
    );
  } finally {
    if (original !== undefined) process.env.STEDI_API_KEY = original;
  }
});

test("the resolver is swappable — the seam a managed secrets manager slots into", () => {
  setSecretResolver({ get: (name) => (name === "LLM_API_KEY" ? "from-the-vault" : undefined) });
  assert.equal(getSecret("LLM_API_KEY"), "from-the-vault");
  assert.equal(getSecret("PHI_ENCRYPTION_KEY"), undefined, "the swapped resolver is the only source");
  resetSecretResolver();
});

test("the inventory reports presence and NEVER a value", () => {
  setSecretResolver({ get: (name) => (name === "DATABASE_URL" ? "postgres://user:hunter2@host/db" : undefined) });

  const inventory = secretInventory();
  assert.equal(inventory.length, Object.keys(KNOWN_SECRETS).length, "every known secret is listed");

  const db = inventory.find((s) => s.name === "DATABASE_URL")!;
  assert.equal(db.configured, true);
  assert.ok(db.purpose.length > 0);

  // The whole point: this is safe to render on a readiness screen or hand to an auditor.
  const serialised = JSON.stringify(inventory);
  assert.ok(!serialised.includes("hunter2"), "a secret value must never appear in the inventory");
  assert.ok(!serialised.includes("postgres://"), "nor any fragment of one");

  resetSecretResolver();
});

test("every known secret documents its purpose — the list IS the compliance answer", () => {
  for (const [name, purpose] of Object.entries(KNOWN_SECRETS)) {
    assert.ok(purpose.length > 20, `${name} needs a purpose an assessor can read, not a label`);
  }
});
