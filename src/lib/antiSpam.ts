/**
 * Shared between ApplicationForm.tsx (which starts the clock and skips its
 * own "submitted" state before this much time has passed) and
 * /api/bewerbung's route handler (which re-checks the same threshold
 * server-side, since a client-only check is trivial to skip by calling the
 * API directly). One constant, so the two checks can't quietly drift apart.
 */
export const MIN_FILL_MS = 3000;

/**
 * How long a signed form token stays acceptable (lib/formToken.ts), and when
 * ContactForm.tsx asks for a fresh one instead of submitting an old one —
 * ten minutes before the server would call it expired, so a tab left open
 * overnight still sends a message the server can verify.
 */
export const FORM_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const FORM_TOKEN_REFRESH_AFTER_MS = FORM_TOKEN_MAX_AGE_MS - 10 * 60 * 1000;

/**
 * Time still to wait before a form that received its token at `receivedAt`
 * may submit. Measured on the client's own clock from the moment the token
 * arrived, not against the token's server timestamp, so a visitor whose
 * clock is minutes off is never submitted too early.
 */
export function remainingFillMs(receivedAt: number, now: number): number {
  return Math.max(0, MIN_FILL_MS - (now - receivedAt));
}
