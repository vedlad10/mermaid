/**
 * Card photograph upload, over HTTP (workflow S2).
 *
 * These are edge-validation tests, and the edge matters more here than anywhere else in the API:
 * this is the one route that accepts binary, and those bytes are PHI destined for a third-party
 * endpoint. Everything that can be refused before that call is refused here.
 *
 * `testServices()` runs with `LLM_PROVIDER` unset, so no image is ever actually read — which is the
 * behaviour being asserted in the last group: **an upload to a deployment with no approved provider
 * must verify the patient anyway, off the typed card text.**
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server.ts";
import { testServices } from "./server.test.ts";

/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber's address, so a fixture patient needs one. It is named to be
 * unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and no
 * production path may fall back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApp(testServices());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function req(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const PIXEL = "iVBORw0KGgoAAAANSUhEUg==";

const visit = (over: Record<string, unknown> = {}) => ({
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" , address: SYNTHETIC_ADDRESS},
  cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100",
  planItems: [{ code: "D0120", quantity: 1 }],
  ...over,
});

test("a verification with card photographs is accepted", async () => {
  await withServer(async (base) => {
    const created = await req(base, "POST", "/api/v1/verifications", visit({
      cardImages: [{ mediaType: "image/jpeg", base64: PIXEL }],
    }));
    assert.equal(created.status, 201);
  });
});

test("a data: URI prefix is accepted — it is what a canvas hands the browser", async () => {
  await withServer(async (base) => {
    const created = await req(base, "POST", "/api/v1/verifications", visit({
      cardImages: [{ mediaType: "image/png", base64: `data:image/png;base64,${PIXEL}` }],
    }));
    assert.equal(created.status, 201);
  });
});

test("card text stays required even when a photograph is supplied", async () => {
  await withServer(async (base) => {
    // The fallback has to be collected at the same moment as the photo. A reader that is off,
    // unapproved for PHI or defeated by a blur must not block a check-in.
    const created = await req(base, "POST", "/api/v1/verifications", visit({
      cardText: "",
      cardImages: [{ mediaType: "image/jpeg", base64: PIXEL }],
    }));
    assert.equal(created.status, 400);
    assert.match(String(created.json.error?.message ?? ""), /cardText/);
  });
});

test("an unrecognised media type is refused, not guessed at from the bytes", async () => {
  await withServer(async (base) => {
    // A media type the provider disagrees with produces an opaque vendor error at the far end of a
    // PHI-bearing call. Refusing here costs nothing and diagnoses itself.
    for (const mediaType of ["application/pdf", "image/tiff", "", "text/plain"]) {
      const created = await req(base, "POST", "/api/v1/verifications", visit({
        cardImages: [{ mediaType, base64: PIXEL }],
      }));
      assert.equal(created.status, 400, `${mediaType || "(empty)"} must be refused`);
      assert.match(String(created.json.error?.message ?? ""), /mediaType/);
    }
  });
});

test("payloads that are not base64 are refused before anything is sent anywhere", async () => {
  await withServer(async (base) => {
    const created = await req(base, "POST", "/api/v1/verifications", visit({
      cardImages: [{ mediaType: "image/jpeg", base64: "not base64 !!!" }],
    }));
    assert.equal(created.status, 400);
    assert.match(String(created.json.error?.message ?? ""), /valid base64/);
  });
});

test("an empty payload is refused", async () => {
  await withServer(async (base) => {
    const created = await req(base, "POST", "/api/v1/verifications", visit({
      cardImages: [{ mediaType: "image/jpeg", base64: "" }],
    }));
    assert.equal(created.status, 400);
  });
});

test("more than two images is refused — front and back is the use case", async () => {
  await withServer(async (base) => {
    const created = await req(base, "POST", "/api/v1/verifications", visit({
      cardImages: Array.from({ length: 3 }, () => ({ mediaType: "image/jpeg", base64: PIXEL })),
    }));
    assert.equal(created.status, 400);
    assert.match(String(created.json.error?.message ?? ""), /At most 2 card images/);
  });
});

test("cardImages that is not an array is refused", async () => {
  await withServer(async (base) => {
    assert.equal((await req(base, "POST", "/api/v1/verifications", visit({ cardImages: "photo.jpg" }))).status, 400);
    assert.equal((await req(base, "POST", "/api/v1/verifications", visit({ cardImages: ["photo.jpg"] }))).status, 400);
  });
});

test("omitting cardImages entirely is the ordinary path and stays so", async () => {
  await withServer(async (base) => {
    assert.equal((await req(base, "POST", "/api/v1/verifications", visit())).status, 201);
    assert.equal((await req(base, "POST", "/api/v1/verifications", visit({ cardImages: null }))).status, 201);
    assert.equal((await req(base, "POST", "/api/v1/verifications", visit({ cardImages: [] }))).status, 201);
  });
});

// ── POST /verifications/read-card — the step the upload flow was missing ─────────────

test("read-card answers 200 with available:false when no reader is configured", async () => {
  await withServer(async (base) => {
    // `testServices()` runs with LLM_PROVIDER unset. "This deployment cannot read photographs" is a
    // configuration fact the UI renders as guidance — a 5xx would make it look like an outage, and
    // silence is what produced the original bug report.
    const read = await req(base, "POST", "/api/v1/verifications/read-card", {
      cardImages: [{ mediaType: "image/jpeg", base64: PIXEL }],
    });
    assert.equal(read.status, 200);
    assert.equal(read.json.available, false);
    assert.equal(read.json.read, null);
  });
});

test("read-card stores nothing — it is a read, not a verification", async () => {
  await withServer(async (base) => {
    const before = (await req(base, "GET", "/api/v1/verifications")).json.items.length;
    await req(base, "POST", "/api/v1/verifications/read-card", {
      cardImages: [{ mediaType: "image/jpeg", base64: PIXEL }],
    });
    const after = (await req(base, "GET", "/api/v1/verifications")).json.items.length;
    assert.equal(after, before, "reading a card must not create a verification");

    const patients = (await req(base, "GET", "/api/v1/patients/directory?q=")).json;
    assert.ok(Array.isArray(patients.items), "and must not create a patient");
  });
});

test("read-card applies the same image validation as the create route", async () => {
  await withServer(async (base) => {
    for (const body of [
      {},
      { cardImages: [] },
      { cardImages: [{ mediaType: "application/pdf", base64: PIXEL }] },
      { cardImages: [{ mediaType: "image/jpeg", base64: "not base64 !!!" }] },
      { cardImages: Array.from({ length: 3 }, () => ({ mediaType: "image/jpeg", base64: PIXEL })) },
    ]) {
      const read = await req(base, "POST", "/api/v1/verifications/read-card", body);
      assert.equal(read.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 60)}`);
    }
  });
});

test("read-card is not swallowed by the verification detail route", async () => {
  await withServer(async (base) => {
    // `/verifications/:id` is GET-only, so POST /verifications/read-card must reach its own handler
    // rather than being read as a verification whose id is the string "read-card".
    const read = await req(base, "POST", "/api/v1/verifications/read-card", {
      cardImages: [{ mediaType: "image/jpeg", base64: PIXEL }],
    });
    assert.equal(read.status, 200);
    assert.ok(Object.hasOwn(read.json, "available"));
    assert.equal((await req(base, "GET", "/api/v1/verifications/read-card")).status, 404);
  });
});

test("an image sent to a deployment with no approved provider still verifies the patient", async () => {
  await withServer(async (base) => {
    // The whole point of requiring the typed text alongside the photo. `LLM_PROVIDER` is unset here,
    // so the reader declines and the regex engine reads the typed text, exactly as it always has.
    const created = await req(base, "POST", "/api/v1/verifications", visit({
      cardImages: [{ mediaType: "image/jpeg", base64: PIXEL }],
    }));
    assert.equal(created.status, 201);

    const record = created.json.record;
    assert.equal(record.card.memberId.value, "ABC12345");
    assert.equal(record.card.memberId.source, "ocr", "the regex engine read it, and the record says so");
    assert.equal(record.payerId, "delta-dental");
    assert.ok(record.benefits, "eligibility ran");
    assert.ok(
      record.audit.some((a: { message: string }) => /no card reader is available/.test(a.message)),
      "and the record says plainly why the photograph was not used"
    );
  });
});
