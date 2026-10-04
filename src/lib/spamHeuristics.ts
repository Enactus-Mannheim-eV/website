/**
 * Content check for the contact form. Built against one pattern: bots that
 * fill name and subject with a run of random letters of mixed case
 * ("aUubpMfPxUvNtpHEEaTgU"). A real visitor practically never types that,
 * so the strong rules are tuned to that shape and nothing broader.
 *
 * Two principles keep this from catching real people:
 *  - Case and vowel analysis only looks at Latin script. A name in Cyrillic,
 *    Greek, Arabic, Hebrew, CJK or Thai never matches any rule here, because
 *    "no vowels" and "mixed case" are not meaningful tests for those scripts.
 *  - The weak signals (an unusually long single-word name, a message that
 *    isn't words, a dotted-address trick) are common enough in real traffic
 *    that one alone proves nothing, so spam needs two different ones.
 *
 * A hit never discards a message (see /api/kontakt): it is stored flagged
 * and held back from the board's inbox until someone releases it, so a
 * misfire costs a click, not a lost enquiry.
 */

export type ContentSpamReason =
  | "random_name"
  | "random_subject"
  | "no_vowel"
  | "long_single_name"
  | "wordless_message"
  | "dotted_email";

const STRONG_REASONS: ReadonlySet<ContentSpamReason> = new Set(["random_name", "random_subject"]);

// Separators inside a name or word. Hyphen, apostrophe, dot and slash split
// "Mary-Kate" and "O'Neill" into their parts, so only a run with none of
// them can look like one long random string.
const TOKEN_SEPARATORS = /[\s\-'’./_]+/u;

// A random token needs both length and many case flips. Real mixed-case
// words (McDonald, DeShawn, iPhone, LinkedIn, GmbH, BlaBlaCar) flip once or
// twice; every bot string observed flips at least four times.
const RANDOM_MIN_LETTERS = 10;
const RANDOM_MIN_CASE_CHANGES = 4;

const NO_VOWEL_MIN_LETTERS = 6;
const LONG_SINGLE_NAME_MIN_LENGTH = 15;
const WORDLESS_MIN_LENGTH = 20;
const WORDLESS_MIN_TOKENS = 3;
const LATIN_DOMINANT_SHARE = 0.6;

// Dotted-address trick (gmail ignores dots): many dots and several one- or
// two-character segments, e.g. "x.y.z.ab.c.d". Ordinary "first.last" or
// "a.b.mueller" stays far below both thresholds.
const DOTTED_MIN_DOTS = 3;
const DOTTED_MIN_SHORT_SEGMENTS = 3;
const DOTTED_SHORT_SEGMENT_MAX = 2;

const URL_ONLY = /^(?:https?:\/\/|www\.)\S+$/i;
const VOWELS = /[aeiouyæøœı]/i;

function tokensOf(text: string): string[] {
  return text
    .normalize("NFC")
    .split(TOKEN_SEPARATORS)
    .filter((token) => /\p{L}/u.test(token));
}

function lettersOf(text: string): string[] {
  return Array.from(text).filter((char) => /\p{L}/u.test(char));
}

function isLatinToken(token: string): boolean {
  const letters = lettersOf(token);
  return letters.length > 0 && letters.every((char) => /\p{Script=Latin}/u.test(char));
}

function caseChanges(token: string): number {
  const chars = Array.from(token);
  let changes = 0;
  for (let i = 1; i < chars.length; i += 1) {
    if (/\p{Ll}/u.test(chars[i - 1]) && /\p{Lu}/u.test(chars[i])) changes += 1;
  }
  return changes;
}

function looksRandom(token: string): boolean {
  return (
    isLatinToken(token) &&
    lettersOf(token).length >= RANDOM_MIN_LETTERS &&
    caseChanges(token) >= RANDOM_MIN_CASE_CHANGES
  );
}

function lacksVowel(token: string): boolean {
  if (!isLatinToken(token)) return false;
  // Strip diacritics first so "é" and "ü" count as the vowels they are.
  const base = token.normalize("NFD").replace(/\p{M}/gu, "");
  const letters = lettersOf(base);
  if (letters.length < NO_VOWEL_MIN_LETTERS) return false;
  // All caps is an abbreviation (KPMG, BWL), not keyboard mash.
  if (base === base.toUpperCase()) return false;
  return !letters.some((char) => VOWELS.test(char));
}

function isMostlyLatin(text: string): boolean {
  const letters = lettersOf(text);
  if (letters.length === 0) return false;
  const latin = letters.filter((char) => /\p{Script=Latin}/u.test(char)).length;
  return latin / letters.length >= LATIN_DOMINANT_SHARE;
}

function isDottedAddress(email: string): boolean {
  const local = email.slice(0, email.lastIndexOf("@")).toLowerCase();
  const segments = local.split(".");
  if (segments.length - 1 < DOTTED_MIN_DOTS) return false;
  return segments.filter((segment) => segment.length <= DOTTED_SHORT_SEGMENT_MAX).length >= DOTTED_MIN_SHORT_SEGMENTS;
}

function isWordlessMessage(message: string): boolean {
  const text = message.trim();
  if (!isMostlyLatin(text)) return false;

  if (text.length >= WORDLESS_MIN_LENGTH && !/\s/.test(text) && !URL_ONLY.test(text)) return true;

  const tokens = tokensOf(text);
  if (tokens.length < WORDLESS_MIN_TOKENS) return false;
  const gibberish = tokens.filter((token) => looksRandom(token) || lacksVowel(token)).length;
  return gibberish * 2 > tokens.length;
}

export type ContactContent = {
  name: string;
  email: string;
  subject?: string;
  message: string;
};

export type ContentAssessment = {
  spam: boolean;
  /** Every rule that fired, in a stable order, for the admin and for tuning. */
  reasons: ContentSpamReason[];
};

export function assessContactContent(input: ContactContent): ContentAssessment {
  const reasons: ContentSpamReason[] = [];
  const nameTokens = tokensOf(input.name);
  const subjectTokens = tokensOf(input.subject ?? "");

  if (nameTokens.some(looksRandom)) reasons.push("random_name");
  if (subjectTokens.some(looksRandom)) reasons.push("random_subject");

  if ([...nameTokens, ...subjectTokens].some(lacksVowel)) reasons.push("no_vowel");

  const name = input.name.trim();
  if (
    name.length >= LONG_SINGLE_NAME_MIN_LENGTH &&
    !TOKEN_SEPARATORS.test(name) &&
    isMostlyLatin(name)
  ) {
    reasons.push("long_single_name");
  }

  if (isWordlessMessage(input.message)) reasons.push("wordless_message");
  if (isDottedAddress(input.email)) reasons.push("dotted_email");

  const weak = reasons.filter((reason) => !STRONG_REASONS.has(reason));
  const spam = reasons.some((reason) => STRONG_REASONS.has(reason)) || weak.length >= 2;
  return { spam, reasons };
}
