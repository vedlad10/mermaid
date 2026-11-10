/**
 * Output gating (risk §3): LLM output is validated before anything is allowed to use it.
 *
 * ── WHY VALIDATION IS A REFUSAL AND NOT A REPAIR ───────────────────────────────────────────────
 * The tempting behaviour is to coerce: the model returned `"1,250.00"` where a number was asked
 * for, so parse it; it returned an extra field, so drop it; it wrapped the JSON in prose, so grab
 * the braces. Two of those three are quiet guesses about what the model MEANT, and this validator
 * makes exactly one of them.
 *
 * It DOES strip the prose wrapper and the code fence, because that is a transport artefact — the
 * model's answer is still whatever is inside, unaltered. It does NOT coerce types, invent missing
 * fields, or keep unknown ones. A model that answered in the wrong shape did not answer, and the
 * caller degrades to its deterministic path, which is always strictly safer than acting on a guess.
 *
 * Nothing here throws. Every failure is a list of human-readable reasons the caller can log.
 */
import type { FieldSpec, ObjectSchema } from "./adapter.ts";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in ```json fences and in "Here is the result:" preamble no matter how firmly the
 * prompt says not to. That is a formatting habit, not a wrong answer, so it is unwrapped rather than
 * rejected. Anything beyond unwrapping is the caller's problem, not this function's.
 */
export function parseJsonObject(raw: string): ValidationResult<Record<string, unknown>> {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, errors: ["the provider returned an empty response"] };

  // Strip a fenced block if present, then fall back to the outermost braces.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1]?.trim(), trimmed, sliceBraces(trimmed)].filter(
    (c): c is string => typeof c === "string" && c !== ""
  );

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, errors: ["the provider's response was not a JSON object"] };
}

function sliceBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Validate a parsed object against a schema.
 *
 * Unknown keys are DROPPED, not rejected — a model volunteering `"notes"` alongside the six fields
 * asked for has still answered the question, and the six are what the caller reads. Missing or
 * wrongly-typed required keys are fatal.
 */
export function validate<T>(schemaSpec: ObjectSchema<T>, input: Record<string, unknown>): ValidationResult<T> {
  const errors: string[] = [];
  const out: Record<string, unknown> = {};

  for (const [name, spec] of Object.entries(schemaSpec.fields)) {
    const present = Object.hasOwn(input, name);
    const raw = present ? input[name] : undefined;

    if (!present) {
      errors.push(`"${name}" is missing`);
      continue;
    }
    const checked = checkField(name, spec, raw);
    if (checked.ok) out[name] = checked.value;
    else errors.push(...checked.errors);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out as T };
}

function checkField(name: string, spec: FieldSpec, raw: unknown): ValidationResult<unknown> {
  const nullable = "nullable" in spec ? spec.nullable === true : false;
  if (raw === null || raw === undefined) {
    // Models write "null", "N/A" and "" interchangeably for "not on the card". All mean absent.
    if (nullable) return { ok: true, value: null };
    return { ok: false, errors: [`"${name}" was null, but is required`] };
  }

  switch (spec.kind) {
    case "string": {
      if (typeof raw !== "string") return { ok: false, errors: [`"${name}" must be a string`] };
      const value = raw.trim();
      if (value === "" || isAbsentMarker(value)) {
        if (nullable) return { ok: true, value: null };
        return { ok: false, errors: [`"${name}" was empty, but is required`] };
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        return { ok: false, errors: [`"${name}" is longer than ${spec.maxLength} characters`] };
      }
      if (spec.pattern !== undefined && !spec.pattern.test(value)) {
        return { ok: false, errors: [`"${name}" does not match the expected format`] };
      }
      return { ok: true, value };
    }
    case "number": {
      // Deliberately NOT parsing "1,250.00" — see the header. A model that answered in a string
      // where a number was asked for is a model whose output we do not trust to be about money.
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { ok: false, errors: [`"${name}" must be a finite number`] };
      }
      if (spec.min !== undefined && raw < spec.min) return { ok: false, errors: [`"${name}" is below ${spec.min}`] };
      if (spec.max !== undefined && raw > spec.max) return { ok: false, errors: [`"${name}" is above ${spec.max}`] };
      return { ok: true, value: raw };
    }
    case "boolean": {
      if (typeof raw !== "boolean") return { ok: false, errors: [`"${name}" must be a boolean`] };
      return { ok: true, value: raw };
    }
    case "enum": {
      if (typeof raw !== "string") return { ok: false, errors: [`"${name}" must be a string`] };
      const value = raw.trim();
      if (!spec.values.includes(value)) {
        return { ok: false, errors: [`"${name}" must be one of: ${spec.values.join(", ")}`] };
      }
      return { ok: true, value };
    }
    case "stringArray": {
      if (!Array.isArray(raw)) return { ok: false, errors: [`"${name}" must be an array`] };
      if (spec.maxItems !== undefined && raw.length > spec.maxItems) {
        return { ok: false, errors: [`"${name}" has more than ${spec.maxItems} items`] };
      }
      const values: string[] = [];
      for (const item of raw) {
        if (typeof item !== "string") return { ok: false, errors: [`"${name}" must contain only strings`] };
        const value = item.trim();
        if (value === "") continue;
        if (spec.maxLength !== undefined && value.length > spec.maxLength) {
          return { ok: false, errors: [`an item of "${name}" is longer than ${spec.maxLength} characters`] };
        }
        values.push(value);
      }
      return { ok: true, value: values };
    }
  }
}

/** The strings models write when they mean "not present". Treated as absent, not as a value. */
const ABSENT = new Set(["n/a", "na", "none", "null", "unknown", "not found", "not visible", "-", "--"]);
const isAbsentMarker = (value: string): boolean => ABSENT.has(value.toLowerCase());

/**
 * Describe a schema to the model, in the prompt, in the same words the validator uses.
 *
 * Generated from the schema rather than written by hand next to it, because a prompt that has
 * drifted from its validator is a permanent `invalid_output` degrade that looks like a provider
 * outage.
 */
export function describeSchema<T>(schemaSpec: ObjectSchema<T>): string {
  const lines = Object.entries(schemaSpec.fields).map(([name, spec]) => {
    const nullable = "nullable" in spec && spec.nullable === true;
    const suffix = nullable ? " — use null if it is not present" : "";
    switch (spec.kind) {
      case "string":
        return `  "${name}": string${nullable ? " | null" : ""}${spec.maxLength ? ` (max ${spec.maxLength} chars)` : ""}${suffix}`;
      case "number":
        return `  "${name}": number${nullable ? " | null" : ""}${suffix}`;
      case "boolean":
        return `  "${name}": true or false${suffix}`;
      case "enum":
        return `  "${name}": one of ${spec.values.map((v) => `"${v}"`).join(", ")}${nullable ? " or null" : ""}${suffix}`;
      case "stringArray":
        return `  "${name}": array of strings${spec.maxItems ? ` (at most ${spec.maxItems})` : ""}`;
    }
  });
  return `Reply with a single JSON object and nothing else:\n{\n${lines.join(",\n")}\n}`;
}
