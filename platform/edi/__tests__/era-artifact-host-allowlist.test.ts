/**
 * The second hop of an ERA retrieval fetches only from hosts this deployment agreed to (NEW-24).
 *
 * ── WHY THIS HOP IS DIFFERENT FROM EVERY OTHER ONE ───────────────────────────────────────────────
 * Retrieving an ERA is two requests. The first is authenticated and goes to a URL this code builds.
 * The second follows `documentDownloadUrl` — whatever the first response said — and carries NO
 * credential, because that is what makes a pre-signed URL work.
 *
 * That combination is a server-side request forgery primitive. Anything that can influence that
 * field gets this process to issue a GET from inside the deployment's network, and whatever comes
 * back is handed to the 835 parser as a payer's payment file. The realistic route in is not "the
 * vendor is malicious" — it is a compromised vendor account, a response served through something in
 * the middle, or a future adapter pointed at a host nobody audited. A pre-signed URL is exactly the
 * shape of thing nobody looks at twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StediClient } from "../vendors/stedi/client.ts";

const EXECUTION = "exec-1";

/**
 * A client whose first hop returns `downloadUrl`, and whose second hop records what it was asked
 * for. The recorder is the assertion: a refused URL must produce NO second request at all.
 */
function clientReturning(downloadUrl: string, extraHosts?: readonly string[]) {
  const fetched: string[] = [];
  const client = new StediClient({
    apiKey: "test-key",
    baseUrl: "https://healthcare.us.stedi.com",
    timeoutMs: 1_000,
    ...(extraHosts ? { artifactHosts: extraHosts } : {}),
    fetchImpl: (async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href.includes(EXECUTION)) {
        return new Response(JSON.stringify({ documentDownloadUrl: downloadUrl }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      fetched.push(href);
      return new Response("ISA*00*...~", { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch,
  });
  return { client, fetched };
}

test("an artifact on an allowed host is fetched", async () => {
  const { client, fetched } = clientReturning("https://mermaid-era.s3.us-east-2.amazonaws.com/abc?sig=x");
  const result = await client.fetchExecutionInput(EXECUTION);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fetched.length, 1, "the second hop happened");
});

test("an artifact on an UNLISTED host is refused, and never requested", async () => {
  /**
   * `169.254.169.254` is the cloud instance metadata service — the classic SSRF target, and one
   * that would hand back credentials rather than an 835. It is refused by the same code path as a
   * typo, which is the point: the check is about the host, not about recognising an attack.
   */
  for (const url of [
    "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "https://internal-admin.corp.example/secrets",
    // The two a naive `includes()` — or a suffix match without the leading dot — would let through.
    // This is the difference between an allowlist and a rhyme.
    "https://evil-amazonaws.com/artifact",
    "https://amazonaws.com.attacker.net/artifact",
  ]) {
    const { client, fetched } = clientReturning(url);
    const result = await client.fetchExecutionInput(EXECUTION);

    assert.equal(result.ok, false, `should have been refused: ${url}`);
    assert.match(result.error!.message, /not an allowed artifact host/i);
    assert.equal(
      result.error!.retryable,
      false,
      "retrying an SSRF attempt on a schedule is worse than not retrying it"
    );
    assert.deepEqual(fetched, [], `no request may be issued to ${url}`);
  }
});

test("plain HTTP is refused even on an allowed host", async () => {
  /**
   * An 835 names every patient on the advice and what they were paid for. Over HTTP it is readable
   * by anything on the path — and this hop carries no credential, so an attacker's substitute
   * response would not be obviously wrong either.
   */
  const { client, fetched } = clientReturning("http://mermaid-era.s3.amazonaws.com/abc");
  const result = await client.fetchExecutionInput(EXECUTION);

  assert.equal(result.ok, false);
  assert.match(result.error!.message, /unauthenticated|PHI/i);
  assert.deepEqual(fetched, []);
});

test("a deployment can ADD a host, and cannot remove the defaults", async () => {
  /**
   * An allowlist that cannot be extended is one somebody works around by deleting the check. An
   * allowlist that can be REPLACED is one a single environment variable can empty by accident.
   */
  const custom = clientReturning("https://files.my-clearinghouse.example/abc", ["my-clearinghouse.example"]);
  assert.equal((await custom.client.fetchExecutionInput(EXECUTION)).ok, true);
  assert.equal(custom.fetched.length, 1);

  const stillDefault = clientReturning("https://x.s3.amazonaws.com/abc", ["my-clearinghouse.example"]);
  assert.equal(
    (await stillDefault.client.fetchExecutionInput(EXECUTION)).ok,
    true,
    "naming an extra host must not disable the built-in ones"
  );
});

test("a download URL that is not a URL at all is refused, not thrown", async () => {
  const { client, fetched } = clientReturning("not a url");
  const result = await client.fetchExecutionInput(EXECUTION);

  assert.equal(result.ok, false);
  assert.match(result.error!.message, /not a URL/i);
  assert.deepEqual(fetched, []);
});
