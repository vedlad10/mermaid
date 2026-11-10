/**
 * `@mermaid/webhook` — authentication for inbound webhooks.
 *
 * The route that uses this does not exist yet, and that ordering is the point: M15 requires the
 * gate to be built and tested before anything can knock on it, because the alternative is shipping
 * an open endpoint and adding the lock in the follow-up commit.
 */
export {
  DEFAULT_TOLERANCE_SECONDS,
  MIN_SECRET_BYTES,
  WebhookConfigurationError,
  defineWebhookAuth,
  generateWebhookSecret,
  verifyWebhookRequest,
} from "./verify.ts";
export type {
  BearerAuthConfig,
  HmacAuthConfig,
  WebhookAuthConfig,
  WebhookAuthScheme,
  WebhookHeaders,
  WebhookRejection,
  WebhookRequest,
  WebhookVerdict,
} from "./verify.ts";
