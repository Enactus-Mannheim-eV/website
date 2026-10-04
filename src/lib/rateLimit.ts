import { createHash } from "node:crypto";
import { consumeRateLimit, peekRateLimit } from "./db";

/**
 * Shared across every form route (/api/bewerbung, /api/reminder,
 * /api/kontakt, /api/ideathon, and the reminder confirm/unsubscribe links) —
 * a fixed 10-minute window, with a per-route ceiling below. Backed by
 * rate_limit_hits in Postgres rather than an in-memory counter: a Vercel
 * deployment can serve one request from a different serverless instance
 * than the next, so a counter living in process memory would simply not see
 * most of a real flood. The IP itself is never stored, only its SHA-256
 * hash — see content/retention.ts and the Datenschutzerklärung for how long
 * a bucket lives before pruneRateLimitHits removes it.
 *
 * Peeks before writing: a request already over the limit is already over
 * it, and incrementing the counter for it anyway means the rate limiter
 * spends exactly the database write it exists to protect. This trades a
 * small, accepted race (two requests arriving in the same instant can both
 * peek under the limit and both then increment, briefly landing one over)
 * for the much larger win of a request that's clearly over the limit never
 * touching the database at all.
 */

const WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PER_WINDOW = 5;

// Per-route ceilings, staggered 2026-08-30 ahead of the HWS26 recruiting
// release. Until then every route shared one flat limit of 5 per IP per 10
// minutes — fine for a low-traffic link like the reminder unsubscribe, but
// applied identically to /api/bewerbung and /api/ideathon, which a whole
// university WLAN's worth of applicants can hit from behind one shared
// egress IP. A flat 5 would have meant "five applications campus-wide per
// ten minutes" on launch morning. Raising these doesn't weaken spam
// defense: the honeypot and the signed, timed form-token
// (lib/formToken.ts) do that job and never depended on this number.
// admin-login stays at the original 5 on purpose — it's the one route this
// limit genuinely defends against a deliberate attack, not a crowd of real
// visitors. Anything not listed keeps the original default.
const MAX_PER_WINDOW: Record<string, number> = {
  "admin-login": 5,
  bewerbung: 20,
  ideathon: 20,
  kontakt: 10,
  reminder: 10,
  "reminder-bestaetigen": 30,
  "reminder-abmelden": 30,
  // GET /api/bewerbung/token used to carry no limit at all — reasonable
  // while it only issued a timing token, but it's now also the front door
  // to the CV upload (its client token is required by
  // onBeforeGenerateToken, /api/bewerbung/cv-upload), so a real ceiling
  // belongs here too. Kept generous: it's called once per page load, and
  // a whole campus WLAN can sit behind one shared egress IP (same
  // reasoning as bewerbung/ideathon above).
  "bewerbung-token": 60,
  // Same reasoning for the contact form's token: one call per page load, so
  // generous, but not unlimited.
  "kontakt-token": 60,
  // The actual upload route — tighter than the token route on purpose,
  // since a successful call here writes a file to the store, not just
  // issues a token.
  "bewerbung-cv": 10,
  // Per-address throttle for /api/reminder (lib/reminderSignupSchema.ts's
  // normalized email is the "ip" this bucket hashes), not per-IP — see
  // /api/reminder/route.ts's own comment.
  "reminder-address": 3,
  // lib/insertFailureAlert.ts's own de-duplication window: at most one
  // board alert per route per 10 minutes, deliberately far stricter than
  // any visitor-facing bucket.
  "insert-failure-alert:bewerbung": 1,
  "insert-failure-alert:ideathon": 1,
};

function maxPerWindow(route: string): number {
  return MAX_PER_WINDOW[route] ?? DEFAULT_MAX_PER_WINDOW;
}

export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
};

export async function checkRateLimit(route: string, ip: string): Promise<RateLimitResult> {
  const limit = maxPerWindow(route);
  const windowStart = new Date(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS);
  const bucket = `${route}:${hashIp(ip)}`;

  const currentCount = await peekRateLimit(bucket, windowStart);
  if (currentCount >= limit) {
    return { allowed: false, remaining: 0 };
  }

  const count = await consumeRateLimit(bucket, windowStart);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}
