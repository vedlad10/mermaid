/**
 * Structured JSON logging with automatic PHI redaction (HIPAA BAA compliance, risk §3).
 * One line of JSON per event, with a channel and optional trace id.
 *
 * PHI rule (risk §3): callers pass ids and metadata, never patient/claim content.
 * The logger automatically intercepts and sanitizes any accidental PHI leaks (names, SSNs,
 * DOBs, member IDs, addresses, card images, and raw X12 payloads) before writing to sink.
 */

/**
 * `alert` is deliberately its own channel rather than a severity of `error`.
 *
 * An error is something that went wrong during a request and has a stack trace. An alert is a
 * SUSTAINED CONDITION nobody is looking at — a stalled outbox, money that does not reconcile — and
 * the two want different destinations: errors go to whoever is debugging, alerts go to whoever is
 * on call. Keeping them apart is what lets an operator route one channel to a pager without
 * drowning in the other.
 */
export type Channel = "app" | "security" | "error" | "audit" | "alert";
export type Level = "debug" | "info" | "warn" | "error";

export interface LogFields {
  channel?: Channel;
  traceId?: string;
  [key: string]: unknown;
}

export type Sink = (line: string) => void;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const PHI_KEY_PATTERN = /^(patient|subscriber|memberid|ssn|socialsecurity|dob|dateofbirth|birthdate|firstname|lastname|fullname|chartid|phone|phonenumber|address|street|cardimage|cardimages|cardtext|raw835|raw837|raw271|x12|prescription|diagnosis|clinicalnotes)$/i;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;

/** Sanitize known identifier shapes from log messages */
export function redactPhiString(str: string): string {
  if (!str || typeof str !== "string") return str;
  return str
    .replace(SSN_REGEX, "***-**-****")
    .replace(/(member(?:\s+id)?[:\s=]+)[A-Za-z0-9_-]{4,}/gi, "$1[MASKED_ID]");
}

/** Recursively redact PHI values from metadata fields */
export function redactPhiValue(key: string, val: unknown, depth = 0): unknown {
  if (depth > 6) return "[DEPTH_LIMIT]";
  if (val === null || val === undefined) return val;
  if (PHI_KEY_PATTERN.test(key)) {
    return "[REDACTED_PHI]";
  }
  if (typeof val === "string") {
    return redactPhiString(val);
  }
  if (Array.isArray(val)) {
    return val.map((item) => redactPhiValue(key, item, depth + 1));
  }
  if (typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (PHI_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED_PHI]";
      } else {
        out[k] = redactPhiValue(k, v, depth + 1);
      }
    }
    return out;
  }
  return val;
}

/** Sanitize an entire LogFields dictionary */
export function redactPhiFields(fields: LogFields): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (PHI_KEY_PATTERN.test(key)) {
      result[key] = "[REDACTED_PHI]";
    } else {
      result[key] = redactPhiValue(key, value, 0);
    }
  }
  return result;
}

const defaultSink: Sink = (line: string): void => {
  process.stdout.write(line + "\n");
};

/** Create a logger writing to `sink` (default: stdout). Automatically sanitizes PHI before serialization. */
export function createLogger(sink: Sink = defaultSink, now: () => string = () => new Date().toISOString()): Logger {
  const emit = (level: Level, message: string, fields: LogFields = {}): void => {
    const { channel = "app", ...rest } = fields;
    const safeRest = redactPhiFields(rest);
    const safeMessage = redactPhiString(message);
    sink(JSON.stringify({ ts: now(), level, channel, message: safeMessage, ...safeRest }));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const logger: Logger = createLogger();
