/**
 * Somewhere for an alert to actually go.
 *
 * ── THE GAP THIS CLOSES (audit A-4) ────────────────────────────────────────────────────────────
 * `alerts.ts` decides, carefully and well, when a human should be told: sustained for three checks,
 * at most one line per cooldown, and resolution announced once because "it cleared" is what tells
 * somebody to stop looking. `monitors.ts` then emitted the result with
 * `logger.error(message, { channel: "alert" })` — to stdout, and nowhere else.
 *
 * On a laptop that is right. On the staging deployment it means the two failures this platform is
 * least able to notice — a stalled outbox and money that will not reconcile — are announced into a
 * log stream on a free-plan container that nobody is watching and that is discarded on restart. The
 * gating logic was complete and had no destination, which is the same as having no alerting.
 *
 * ── WHY A WEBHOOK, AND ONLY A WEBHOOK ──────────────────────────────────────────────────────────
 * One POST of one JSON body is what Slack, Discord, PagerDuty Events v2, Opsgenie, a Zapier hook and
 * a fifteen-line script on somebody's own server all accept. Picking any single vendor would mean an
 * SDK, a dependency, a credential format and an integration to keep working — for a product whose
 * whole front end is served without a build step. A URL in the environment is the smallest thing
 * that turns "the alert exists" into "somebody hears it".
 *
 * ── WHAT IS AND IS NOT SENT ────────────────────────────────────────────────────────────────────
 * An alert body carries a check key, a state, a timestamp and a message. Never a patient, never a
 * member ID, never a claim number — the monitors do not measure anything patient-shaped, and
 * `redact` below is the guarantee rather than the assumption: a `detail` map is whitelisted to
 * numbers, booleans and short strings, so a future monitor that starts attaching a patient name
 * cannot leak one through here. A webhook URL is somebody else's server, and quite possibly
 * somebody else's chat history.
 *
 * ── AND WHY IT CANNOT BREAK ANYTHING ───────────────────────────────────────────────────────────
 * It never throws, never rejects, and never blocks a caller: a monitor tick that hangs because a
 * chat provider is slow is a monitor that has stopped monitoring. A delivery failure is logged once
 * and dropped — retrying an alert whose whole purpose is timeliness just produces a queue of stale
 * news, and the condition will be re-sampled on the next tick anyway.
 */
import type { Logger } from "./logger.ts";

export interface AlertPayload {
  /** The check's stable key, e.g. `outbox.lag`. */
  key: string;
  /** `firing` or `resolved`. */
  state: string;
  /** The human sentence the monitor wrote. */
  message: string;
  /** When the condition started, ISO 8601. */
  since: string;
  /** Numbers the check measured. Whitelisted before it leaves this process — see `redact`. */
  detail: Record<string, unknown>;
}

export interface NotifierOptions {
  /** Absent (the default) means alerts stay on the log channel, exactly as before. */
  url?: string | null;
  /** Injected so a test does not open a socket. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: Logger;
  /** Names this deployment in the message, so two environments' alerts are tellable apart. */
  environment?: string;
}

/** Longer than a health check and far shorter than a monitor interval. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * A slug or a short label: a check key, a vendor name, a status word. Nothing with a run of digits
 * in it, because that is what every identifier this system handles looks like — a member id, a claim
 * control number, an NPI, a trace number, a date.
 */
const LABEL = /^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/;
const DIGIT_RUN = /\d{3,}/;

/**
 * Everything a monitor measured, minus anything that could identify a person.
 *
 * ── AN ALLOW-LIST, NOT A DENY-LIST, AND THAT IS THE WHOLE DESIGN ───────────────────────────────
 * The first version of this refused strings containing six or more consecutive digits, which is the
 * obvious rule and is wrong in the ordinary case: `AETNA9WCSU00412` is a member id and its longest
 * digit run is five. Every deny-list for identifier shapes is a list of the shapes somebody thought
 * of, and the one that leaks is the one they did not.
 *
 * So numbers and booleans pass — they are the measurement, and are what an alert is for — and a
 * string passes only if it looks like a LABEL: begins with a letter, at most 64 characters, no run
 * of three digits. A check key, a vendor slug or a status word survives. A member id, a control
 * number, a date, an address and a sentence of free text do not.
 *
 * The cost is a slightly less detailed alert, which is recoverable by opening Ops. The cost the
 * other way is a patient identifier in a chat room that thirty people can scroll, which is not.
 *
 * ── WHAT THIS DOES NOT COVER, SAID PLAINLY ─────────────────────────────────────────────────────
 * `message` is not passed through here. It is a sentence a monitor AUTHOR composed — "the outbox is
 * draining normally again", "4 payment(s) agree across the remittance and the claim" — rather than
 * data lifted from a record, and redacting authored prose would leave an alert that says nothing.
 * A monitor that starts interpolating a patient or a claim number into its message is the one case
 * this cannot catch, and it is a code review rather than a runtime check.
 */
export function redact(detail: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (typeof v === "number" || typeof v === "boolean" || v === null) {
      safe[k] = v;
      continue;
    }
    if (typeof v === "string" && LABEL.test(v) && !DIGIT_RUN.test(v)) {
      safe[k] = v;
      continue;
    }
    // Present, and withheld — an omitted key reads as "the monitor did not measure this", which
    // sends an operator looking for a different problem than the one they have.
    safe[k] = "[withheld]";
  }
  return safe;
}

/**
 * A notifier for the configured destination, or one that does nothing.
 *
 * The no-op is returned rather than a null, so no caller has to remember a conditional — and the
 * absence is logged once at construction, because "alerting is not configured" is a fact an operator
 * should be able to find in the boot log rather than infer from silence.
 */
export function createAlertNotifier(options: NotifierOptions = {}): (payload: AlertPayload) => void {
  const url = options.url?.trim();
  if (!url) {
    options.logger?.info("alert webhook not configured — alerts stay on the log channel only", {
      channel: "app",
    });
    return () => {};
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    options.logger?.error("ALERT_WEBHOOK_URL is not a URL — alerts stay on the log channel only", {
      channel: "error",
    });
    return () => {};
  }
  if (parsed.protocol !== "https:") {
    /**
     * Refused rather than warned. An alert body says which practice's money will not reconcile and
     * carries the deployment's own name; over plain HTTP that is readable by anything between here
     * and the destination, and the mistake is invisible because the alert still arrives.
     */
    options.logger?.error(
      `ALERT_WEBHOOK_URL is ${parsed.protocol}// — refusing to send alerts unencrypted. Use https.`,
      { channel: "error" }
    );
    return () => {};
  }

  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const environment = options.environment ?? "unknown";
  const log = options.logger;

  options.logger?.info("alert webhook configured", { channel: "app", host: parsed.host });

  return (payload: AlertPayload): void => {
    /**
     * Fire and forget, deliberately. The caller is a monitor tick on a timer; making it await a
     * third-party HTTP round trip means one slow chat provider delays the next sample of every other
     * check. `void` on the promise plus a catch that cannot throw is the whole contract.
     */
    void (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(parsed.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            /*
             * `text` first and named `text` on purpose: Slack and Discord both render that field and
             * nothing else without a schema, so the commonest destination works with no mapping.
             * Everything structured travels alongside for anything that parses.
             */
            text: `[mermaid/${environment}] ${payload.state.toUpperCase()} ${payload.key} — ${payload.message}`,
            environment,
            alert: payload.key,
            state: payload.state,
            since: payload.since,
            detail: redact(payload.detail),
          }),
        });
        if (!res.ok) {
          log?.error("alert webhook rejected the notification", {
            channel: "error",
            status: res.status,
            alert: payload.key,
          });
        }
      } catch (err) {
        /* Logged once and dropped. The condition is re-sampled on the next tick; a retry queue of
           stale alerts is worse than a missed one. */
        log?.error("alert webhook delivery failed", {
          channel: "error",
          alert: payload.key,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timer);
      }
    })();
  };
}
