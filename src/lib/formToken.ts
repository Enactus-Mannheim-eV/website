import { createHmac, timingSafeEqual } from "node:crypto";
import { FORM_TOKEN_MAX_AGE_MS, MIN_FILL_MS } from "@/lib/antiSpam";

/**
 * Replaces the old client-supplied `formRenderedAt: z.number()` field
 * (REVIEW.md finding 1): that timestamp came straight from the request
 * body, so a script calling /api/bewerbung directly could just send
 * `formRenderedAt: 0` and pass the minimum-fill-time check trivially — the
 * check existed in name only.
 *
 * A signed, server-issued token closes that: `GET /api/bewerbung/token`
 * (called once when ApplicationForm mounts) stamps the real issue time and
 * signs it with FORM_TOKEN_SECRET, so a forged or missing timestamp is
 * detectable, not just implausible. The timestamp itself stays plaintext,
 * same pattern as the admin session cookie (lib/adminAuth.ts) — it's not
 * secret, only the ability to mint or alter one is.
 *
 * FORM_TOKEN_SECRET is its own variable, not derived from
 * ADMIN_SESSION_SECRET: this token is issued to anyone who loads a public,
 * unauthenticated page, and deriving it from the admin secret would tie a
 * credential that gates applicant data to a value handed out on every
 * /mitmachen page load — exactly the kind of purpose-mixing REVIEW.md's
 * finding 4 flags for ADMIN_PASSWORD.
 */

const MAX_AGE_MS = FORM_TOKEN_MAX_AGE_MS; // generous: a real applicant might leave the tab open for a while

export type FormTokenStatus = "valid" | "too_fast" | "expired" | "invalid";

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createFormToken(now: Date = new Date()): string | null {
  const secret = process.env.FORM_TOKEN_SECRET;
  if (!secret) return null;
  const issuedAt = now.getTime();
  return `${issuedAt}.${sign(String(issuedAt), secret)}`;
}

// Three failure states, not one boolean, because two of them deserve
// different treatment by the caller: "too_fast" and "invalid" (missing,
// malformed, or tampered) are anti-spam signals and should fail the same
// silent way the honeypot does — a bot gets no way to tell "you were
// flagged" from "it worked". "expired" is not a spam signal — it's what
// happens when a genuine applicant leaves the tab open past MAX_AGE_MS —
// so it's the one case worth telling the applicant about.
export function checkFormToken(token: string | undefined | null, now: Date = new Date()): FormTokenStatus {
  if (!token) return "invalid";
  const secret = process.env.FORM_TOKEN_SECRET;
  if (!secret) return "invalid";

  const separatorIndex = token.indexOf(".");
  if (separatorIndex < 0) return "invalid";
  const issuedAtRaw = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return "invalid";
  if (!safeEqual(signature, sign(issuedAtRaw, secret))) return "invalid";

  const age = now.getTime() - issuedAt;
  if (age < MIN_FILL_MS) return "too_fast";
  if (age > MAX_AGE_MS) return "expired";
  return "valid";
}
