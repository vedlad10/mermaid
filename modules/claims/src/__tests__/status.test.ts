/**
 * Status-machine tests. The negatives are the point: these are the transitions that, if allowed,
 * produce duplicate submissions or edits to money a payer has already settled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADJUDICATED_STATUSES,
  InvalidClaimTransitionError,
  OPEN_STATUSES,
  SCRUBBABLE_STATUSES,
  assertTransition,
  canTransition,
  isTerminal,
} from "../engine/status.ts";
import { TERMINAL_STATUSES, type ClaimStatus } from "../types.ts";

const ALL: ClaimStatus[] = ["draft", "ready", "submitted", "rejected", "partially_paid", "denied", "paid", "void"];

test("the happy path is legal end to end", () => {
  assert.ok(canTransition("draft", "ready"));
  assert.ok(canTransition("ready", "submitted"));
  assert.ok(canTransition("submitted", "paid"));
});

test("a re-scrub may demote a ready claim back to draft", () => {
  assert.ok(canTransition("ready", "draft"));
});

test("a submitted claim can never be resubmitted or edited back into draft", () => {
  assert.equal(canTransition("submitted", "submitted"), false);
  assert.equal(canTransition("submitted", "ready"), false);
  assert.equal(canTransition("submitted", "draft"), false);
});

test("a rejected claim can be fixed and refiled", () => {
  assert.ok(canTransition("rejected", "draft"));
  assert.ok(canTransition("rejected", "ready"));
  assert.equal(canTransition("rejected", "submitted"), false, "it must be re-scrubbed first");
});

test("paid and void are terminal — nothing leaves them", () => {
  for (const to of ALL) {
    assert.equal(canTransition("paid", to), false, `paid → ${to} must be refused`);
    assert.equal(canTransition("void", to), false, `void → ${to} must be refused`);
  }
  assert.deepEqual([...TERMINAL_STATUSES], ["paid", "void"]);
  assert.ok(isTerminal("paid") && isTerminal("void"));
  assert.equal(isTerminal("draft"), false);
});

test("anything still open can be voided", () => {
  for (const from of ["draft", "ready", "submitted", "rejected"] as ClaimStatus[]) {
    assert.ok(canTransition(from, "void"), `${from} → void must be allowed`);
  }
});

test("this module never marks a claim paid from draft — only a remittance does that", () => {
  assert.equal(canTransition("draft", "paid"), false);
  assert.equal(canTransition("ready", "paid"), false);
});

test("assertTransition throws a typed error naming both ends", () => {
  assert.throws(
    () => assertTransition("paid", "draft"),
    (err: unknown) => {
      assert.ok(err instanceof InvalidClaimTransitionError);
      assert.equal(err.from, "paid");
      assert.equal(err.to, "draft");
      assert.match(err.message, /cannot move from "paid" to "draft"/);
      return true;
    }
  );
  assert.doesNotThrow(() => assertTransition("draft", "ready"));
});

test("the open-status list is what the working queue shows", () => {
  // A partially-paid or denied claim is money already earned and not received — it stays open.
  assert.deepEqual([...OPEN_STATUSES], ["draft", "ready", "rejected", "partially_paid", "denied"]);
});

test("only pre-adjudication claims are re-scrubbed", () => {
  // The scrubber may report on an adjudicated claim, but must never reset its state.
  assert.deepEqual([...SCRUBBABLE_STATUSES], ["draft", "ready", "rejected"]);
  assert.equal(SCRUBBABLE_STATUSES.includes("partially_paid"), false);
  assert.equal(SCRUBBABLE_STATUSES.includes("denied"), false);
});

test("the three post-adjudication states are reachable only from submitted", () => {
  for (const to of ADJUDICATED_STATUSES) {
    assert.ok(canTransition("submitted", to), `submitted → ${to} must be allowed`);
    assert.equal(canTransition("draft", to), false, `draft → ${to} must be refused`);
    assert.equal(canTransition("ready", to), false, `ready → ${to} must be refused`);
  }
});

test("a partially-paid claim can later be completed, denied, corrected or voided", () => {
  assert.ok(canTransition("partially_paid", "paid"), "a secondary payer or won appeal completes it");
  assert.ok(canTransition("partially_paid", "denied"));
  assert.ok(canTransition("partially_paid", "draft"), "correct and refile");
  assert.ok(canTransition("partially_paid", "void"));
  assert.equal(canTransition("partially_paid", "submitted"), false, "it must be re-scrubbed first");
});

test("a denied claim can be corrected, refiled, or eventually paid on appeal", () => {
  assert.ok(canTransition("denied", "draft"));
  assert.ok(canTransition("denied", "ready"));
  assert.ok(canTransition("denied", "paid"), "an appeal that succeeds pays the claim");
  assert.ok(canTransition("denied", "void"), "or it is written off");
});

test("a rejection and a denial are different states, not synonyms", () => {
  // Rejected never reached adjudication: fix the file and resend, no appeal rights.
  assert.equal(canTransition("rejected", "paid"), false, "an intake rejection was never adjudicated");
  // Denied was adjudicated: an appeal can pay it without a resubmission.
  assert.ok(canTransition("denied", "paid"));
});
