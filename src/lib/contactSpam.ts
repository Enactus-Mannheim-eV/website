import { checkFormToken } from "@/lib/formToken";
import { assessContactContent, type ContactContent, type ContentSpamReason } from "@/lib/spamHeuristics";

/**
 * Combines the two things /api/kontakt can know about a submission: how the
 * form was filled in (honeypot, signed timing token) and what was written
 * (lib/spamHeuristics.ts). Any form-level signal is enough on its own: a
 * browser that loaded the page always has a token at least three seconds old
 * and never fills the hidden field.
 */

export type FormSpamReason = "honeypot" | "token_missing" | "token_invalid" | "too_fast" | "token_expired";

export type ContactSpamReason = FormSpamReason | ContentSpamReason;

// Every code that can be stored in contact_messages.spam_reasons, in the
// order the admin lists them. Each one needs a label in the admin messages.
export const CONTACT_SPAM_REASONS: readonly ContactSpamReason[] = [
  "honeypot",
  "token_missing",
  "token_invalid",
  "too_fast",
  "token_expired",
  "random_name",
  "random_subject",
  "no_vowel",
  "long_single_name",
  "wordless_message",
  "dotted_email",
];

export type ContactSubmission = ContactContent & {
  website?: string;
  formToken?: string;
};

export type ContactSpamVerdict = {
  spam: boolean;
  reasons: ContactSpamReason[];
};

function tokenReason(formToken: string | undefined, now: Date): FormSpamReason | null {
  // Without the secret no token can be verified at all. Treating that as
  // spam would hold back every real message after a misconfiguration, with
  // nobody looking at the spam tab; failing open leaves only the honeypot
  // and the content check, which is the lesser harm. The deployment docs
  // already require FORM_TOKEN_SECRET, so this is logged loudly.
  if (!process.env.FORM_TOKEN_SECRET) {
    console.error("FORM_TOKEN_SECRET is not set: the contact form's timing check is off");
    return null;
  }
  if (!formToken) return "token_missing";
  const status = checkFormToken(formToken, now);
  if (status === "valid") return null;
  if (status === "too_fast") return "too_fast";
  if (status === "expired") return "token_expired";
  return "token_invalid";
}

export function assessContactSubmission(submission: ContactSubmission, now: Date = new Date()): ContactSpamVerdict {
  const formReasons: ContactSpamReason[] = [];

  if (submission.website && submission.website.trim().length > 0) formReasons.push("honeypot");
  const token = tokenReason(submission.formToken, now);
  if (token) formReasons.push(token);

  const content = assessContactContent(submission);

  // Reasons are recorded only for a message that was actually held back. A
  // single weak content signal on an ordinary message is noise, and keeping
  // it would put a "reason" on rows nobody ever looks at.
  const spam = formReasons.length > 0 || content.spam;
  return { spam, reasons: spam ? [...formReasons, ...content.reasons] : [] };
}
