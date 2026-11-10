import type { PracticeId, UserId } from "@mermaid/shared";
import type { Role } from "@mermaid/shared";

/** The authenticated principal attached to a request context. */
export interface AuthUser {
  id: UserId;
  practiceId: PracticeId;
  email: string;
  name: string;
  role: Role;
}

/** A resolved session (from the session cookie) plus its practice + user. */
export interface ResolvedSession {
  tokenHash: string;
  csrf: string;
  user: AuthUser;
  /**
   * The password was right and the second factor has not been given yet (0038). Such a session may
   * reach the MFA step and sign out — `authorizeRequest` refuses it everywhere else.
   */
  mfaPending: boolean;
}

/** Typed auth error carrying an HTTP status + machine code, for the API error envelope.
 *  Fields are declared explicitly (no constructor parameter properties) so the source runs under
 *  Node's native type-stripping, which only erases types and cannot synthesize field assignments. */
export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}
