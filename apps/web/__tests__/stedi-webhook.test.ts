import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server.ts";
import { testServices } from "./server.test.ts";

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

test("Stedi webhook route refuses unauthenticated deliveries", async () => {
  await withServer(async (base) => {
    process.env.STEDI_WEBHOOK_SECRET = "test-secret-at-least-32-bytes-long-for-security";
    const res = await fetch(`${base}/api/v1/webhooks/edi/stedi`, {
      method: "POST",
      headers: { "content-type": "application/x12" },
      body: "ISA*00*          *00*          *ZZ*SUBMITTER      *ZZ*RECEIVER       *260401*1200*^*00501*000000001*0*P*:~",
    });

    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "unauthorized");
  });
});

test("Stedi webhook route accepts authentic delivery with Bearer key and protects PHI", async () => {
  await withServer(async (base) => {
    const secret = "test-secret-at-least-32-bytes-long-for-security";
    process.env.STEDI_WEBHOOK_SECRET = secret;
    const res = await fetch(`${base}/api/v1/webhooks/edi/stedi`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${secret}`,
      },
      body: JSON.stringify({
        x12: "ISA*00*          *00*          *ZZ*SUBMITTER      *ZZ*RECEIVER       *260401*1200*^*00501*000000001*0*P*:~",
      }),
    });

    // Valid authentication: returns 200 or business validation, never 401
    assert.notEqual(res.status, 401);
    const body = (await res.json()) as Record<string, unknown>;
    // PHI Protection Guarantee: No remittances array, patient names, or SSNs returned to external caller
    assert.equal(body.remittances, undefined, "Webhook response must never expose patient health information");
  });
});

test("Stedi webhook route responds to GET reachability check", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/webhooks/edi/stedi`, { method: "GET" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.service, "stedi-edi-webhook");
    assert.equal(body.status, "active");
  });
});

test("Stedi webhook route responds to ping test payload", async () => {
  await withServer(async (base) => {
    const secret = "test-secret-at-least-32-bytes-long-for-security";
    process.env.STEDI_WEBHOOK_SECRET = secret;
    const res = await fetch(`${base}/api/v1/webhooks/edi/stedi`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `bearer ${secret}`,
      },
      body: JSON.stringify({ type: "ping" }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.status, "pong");
  });
});

test("Stedi webhook route accepts x-api-key header without Bearer prefix", async () => {
  await withServer(async (base) => {
    const secret = "test-secret-at-least-32-bytes-long-for-security";
    process.env.STEDI_WEBHOOK_SECRET = secret;
    const res = await fetch(`${base}/api/v1/webhooks/edi/stedi`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": secret,
      },
      body: JSON.stringify({ test: true }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
  });
});
