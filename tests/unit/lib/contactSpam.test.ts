import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORM_TOKEN_MAX_AGE_MS, FORM_TOKEN_REFRESH_AFTER_MS, MIN_FILL_MS, remainingFillMs } from "@/lib/antiSpam";
import { assessContactSubmission, CONTACT_SPAM_REASONS, type ContactSubmission } from "@/lib/contactSpam";
import { createFormToken } from "@/lib/formToken";

const ORIGINAL_SECRET = process.env.FORM_TOKEN_SECRET;
const NOW = new Date("2026-10-04T10:00:00Z");

const ordinary: ContactSubmission = {
  name: "Anna Müller",
  email: "anna.mueller@example.invalid",
  subject: "Frage zur Mitgliedschaft",
  message: "Hallo zusammen, ich würde gern mehr über eure Projekte erfahren.",
};

function tokenAged(ms: number): string {
  return createFormToken(new Date(NOW.getTime() - ms))!;
}

function assess(overrides: Partial<ContactSubmission> = {}) {
  return assessContactSubmission({ ...ordinary, formToken: tokenAged(MIN_FILL_MS + 5000), ...overrides }, NOW);
}

beforeEach(() => {
  process.env.FORM_TOKEN_SECRET = "a-form-token-signing-secret";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_SECRET === undefined) delete process.env.FORM_TOKEN_SECRET;
  else process.env.FORM_TOKEN_SECRET = ORIGINAL_SECRET;
});

describe("assessContactSubmission", () => {
  it("accepts an ordinary message with a valid token", () => {
    expect(assess()).toEqual({ spam: false, reasons: [] });
  });

  it("accepts an empty honeypot", () => {
    expect(assess({ website: "" }).spam).toBe(false);
  });

  it("flags a filled honeypot", () => {
    expect(assess({ website: "https://spam.example" })).toEqual({ spam: true, reasons: ["honeypot"] });
  });

  it("ignores a whitespace-only honeypot", () => {
    expect(assess({ website: "   " }).spam).toBe(false);
  });

  it("flags a missing token", () => {
    expect(assess({ formToken: undefined })).toEqual({ spam: true, reasons: ["token_missing"] });
  });

  it("flags an empty token as missing", () => {
    expect(assess({ formToken: "" }).reasons).toEqual(["token_missing"]);
  });

  it("flags a forged token", () => {
    expect(assess({ formToken: `${NOW.getTime() - 60_000}.not-the-signature` }).reasons).toEqual(["token_invalid"]);
  });

  it("flags a token that is not shaped like one", () => {
    expect(assess({ formToken: "whatever" }).reasons).toEqual(["token_invalid"]);
  });

  it("flags a submit within the minimum fill time", () => {
    expect(assess({ formToken: tokenAged(MIN_FILL_MS - 1) }).reasons).toEqual(["too_fast"]);
  });

  it("accepts a submit exactly at the minimum fill time", () => {
    expect(assess({ formToken: tokenAged(MIN_FILL_MS) }).spam).toBe(false);
  });

  it("flags an expired token", () => {
    expect(assess({ formToken: tokenAged(FORM_TOKEN_MAX_AGE_MS + 1000) }).reasons).toEqual(["token_expired"]);
  });

  it("flags random strings in name and subject even with a perfect token", () => {
    const result = assess({ name: "aUubpMfPxUvNtpHEEaTgU", subject: "HBBPNQHYMRjYrUrUBKsXccV" });
    expect(result).toEqual({ spam: true, reasons: ["random_name", "random_subject", "long_single_name"] });
  });

  it("lists form signals before content signals when both fire", () => {
    const result = assess({ formToken: undefined, name: "YBRzweYDPeVzKrZNQPWtF", website: "x" });
    expect(result.reasons).toEqual(["honeypot", "token_missing", "random_name", "long_single_name"]);
  });

  it("records no reasons for a message that is not held back, even with one weak signal", () => {
    const result = assess({ email: "x.y.z.ab.c.d@example.invalid" });
    expect(result).toEqual({ spam: false, reasons: [] });
  });

  it("does not hold back real messages when the token secret is missing", () => {
    delete process.env.FORM_TOKEN_SECRET;
    expect(assess({ formToken: undefined })).toEqual({ spam: false, reasons: [] });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("FORM_TOKEN_SECRET"));
  });

  it("still applies the content check when the token secret is missing", () => {
    delete process.env.FORM_TOKEN_SECRET;
    expect(assess({ name: "aUubpMfPxUvNtpHEEaTgU" }).reasons).toEqual(["random_name", "long_single_name"]);
  });
});

describe("CONTACT_SPAM_REASONS", () => {
  it("lists every code once", () => {
    expect(new Set(CONTACT_SPAM_REASONS).size).toBe(CONTACT_SPAM_REASONS.length);
  });
});

describe("remainingFillMs", () => {
  it("asks for the full minimum right after the token arrived", () => {
    expect(remainingFillMs(1000, 1000)).toBe(MIN_FILL_MS);
  });

  it("counts down as time passes", () => {
    expect(remainingFillMs(1000, 1000 + 1200)).toBe(MIN_FILL_MS - 1200);
  });

  it("is zero once the minimum has passed, never negative", () => {
    expect(remainingFillMs(1000, 1000 + MIN_FILL_MS)).toBe(0);
    expect(remainingFillMs(1000, 1000 + MIN_FILL_MS + 60_000)).toBe(0);
  });

  it("refreshes a token before the server would call it expired", () => {
    expect(FORM_TOKEN_REFRESH_AFTER_MS).toBeLessThan(FORM_TOKEN_MAX_AGE_MS);
  });
});
