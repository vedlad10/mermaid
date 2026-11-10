/**
 * A provider that answers from a script. **For tests and the laptop demo only.**
 *
 * It exists so that every path through the router — success, malformed output, rate limit, timeout,
 * image handling — is exercised by the suite without a network, a key, or a cent of spend, and so
 * that a demo can show what an AI-drafted appeal looks like on a machine with no provider at all.
 *
 * It is NOT registered by `LLM_PROVIDER` and cannot be selected by configuration. Selecting a fake
 * model from an environment variable is precisely the mistake `EDI_ADAPTER=mock` is careful about:
 * a mock reachable from production config eventually runs in production. Tests construct it
 * directly, which is the only way to get one.
 */
import { ProviderError, type LlmProvider, type ProviderRequest } from "../provider.ts";

export type ScriptedReply =
  | { kind: "text"; text: string }
  | { kind: "error"; code: ProviderError["code"]; message?: string; retryable?: boolean }
  /** Never resolves until aborted — the honest way to test the router's deadline. */
  | { kind: "hang" };

export interface ScriptedOptions {
  /** Consumed in order; the last reply repeats once the script runs out. */
  replies: ScriptedReply[];
  supportsImages?: boolean;
  model?: string;
}

export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly model: string;
  readonly supportsImages: boolean;
  /** Every request the router made, for asserting on prompts, image handling and retry counts. */
  readonly calls: ProviderRequest[] = [];
  #replies: ScriptedReply[];
  #index = 0;

  constructor(options: ScriptedOptions) {
    if (options.replies.length === 0) throw new Error("ScriptedProvider needs at least one reply");
    this.#replies = options.replies;
    this.supportsImages = options.supportsImages ?? true;
    this.model = options.model ?? "scripted-1";
  }

  async complete(req: ProviderRequest, signal: AbortSignal): Promise<string> {
    this.calls.push(req);
    const reply = this.#replies[Math.min(this.#index, this.#replies.length - 1)]!;
    this.#index += 1;

    switch (reply.kind) {
      case "text":
        return reply.text;
      case "error":
        throw new ProviderError(reply.code, reply.message ?? `scripted ${reply.code}`, reply.retryable);
      case "hang":
        return new Promise<string>((_resolve, reject) => {
          if (signal.aborted) {
            reject(abortError());
            return;
          }
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
    }
  }
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
