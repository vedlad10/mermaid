// issue-password-reset.mjs — mint a password-reset token for one account, from the machine (NEW-27).
//
// ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────────────────────────
// `ensureSeeded` creates eight accounts, one per role, on the first boot against an empty database.
// Outside production it logs their generated passwords, which is fine for a laptop. In production it
// deliberately does NOT — a password in a log file is a password — and logs only the email
// addresses, with the advice to "use the reset flow to log in".
//
// That advice was not actionable. The reset flow needs a token to reach the person who asked for it,
// and no email provider is configured (it needs a hosting decision and a BAA — the M13 gate). In
// production the endpoint therefore writes the token to the user's row and returns `null`, saying
// plainly that delivery is unconfigured. So a fresh production deployment had eight accounts whose
// passwords nobody knew and no path to any of them: locked out of its own system, with no way in
// short of an engineer with a psql session and a scrypt implementation.
//
// This is that path, made real and made narrow. It is the "documented manual process" until a mail
// provider exists — and when one does, this stays useful for exactly the case it was written for: a
// deployment where nobody can receive mail yet.
//
// ── WHY IT IS SAFE TO HAVE ─────────────────────────────────────────────────────────────────────
// It grants nothing that shell access on the box does not already grant. Whoever can run this can
// read `DATABASE_ADMIN_URL` and write the `staff_users` table directly; the difference is that this
// goes through the SAME `requestPasswordReset` the HTTP endpoint uses, so the token format, its TTL
// and its single-use semantics are identical, and the act lands on the audit trail as
// `password_reset_requested` like any other (NEW-05).
//
// The token is printed to STDOUT and nowhere else — never logged, never written to a file. Piping
// this into a log is the one thing that would undo the reason it exists.
//
// ── USAGE ──────────────────────────────────────────────────────────────────────────────────────
//   node platform/db/issue-password-reset.mjs owner@clinic.example
//   npm run auth:issue-reset -- owner@clinic.example
//
// Then, from anywhere that can reach the deployment:
//   curl -X POST https://<host>/api/v1/auth/password-reset/confirm \
//     -H 'content-type: application/json' \
//     -d '{"email":"owner@clinic.example","token":"<token>","password":"<a new one>"}'
//
// Confirming revokes every session issued under the old credential, which is the correct outcome
// for an account whose password was never known to anybody.
import { requestPasswordReset } from '../auth/src/service.ts';
import { closePool } from './pool.ts';

const email = process.argv[2];

if (!email || email.startsWith('--')) {
  console.error('Usage: node platform/db/issue-password-reset.mjs <email>');
  console.error('');
  console.error('Mints a single-use password-reset token for one account and prints it once.');
  console.error('The token is printed to stdout and nowhere else — do not pipe this into a log.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set — there is no account database to issue against.');
  process.exit(1);
}

/**
 * The SAME function the HTTP endpoint calls.
 *
 * Deliberately not a hand-written UPDATE. The token's hash, its expiry and the single-use rule live
 * in one place, and a second implementation here would drift from it — silently, because the only
 * symptom would be a token that does not work, on the one day somebody desperately needs one to.
 */
const { token } = await requestPasswordReset(email);

if (!token) {
  /**
   * Identical to what the endpoint says, and for the same reason: the endpoint answers the same way
   * whether or not the address exists, because it is otherwise an account-enumeration oracle. There
   * is no such concern at a shell prompt, but there IS a second cause with the same shape — a
   * DISABLED account — and reporting "no such user" for it would send an operator looking for a
   * typo that is not there.
   */
  console.error(`No reset was issued for "${email}".`);
  console.error('Either no account has that address, or the account is disabled.');
  console.error('Check with: SELECT email, disabled FROM staff_users ORDER BY email;');
  await closePool();
  process.exit(1);
}

console.log('');
console.log(`Reset token for ${email}:`);
console.log('');
console.log(`  ${token}`);
console.log('');
console.log('Single use, and it expires — issue another if it lapses. Complete the reset with:');
console.log('');
console.log(`  curl -X POST https://<host>/api/v1/auth/password-reset/confirm \\`);
console.log(`    -H 'content-type: application/json' \\`);
console.log(`    -d '{"email":"${email}","token":"<the token above>","password":"<a new password>"}'`);
console.log('');
console.log('Confirming signs out every existing session for this account.');

await closePool();
