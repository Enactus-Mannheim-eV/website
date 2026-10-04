import { describe, expect, it } from "vitest";
import { privacyReviewStatus, privacyReviewStatusSchema } from "@/content/privacy";

describe("content/privacy", () => {
  // Reviewed and confirmed 2026-09-10 by the Enactus Germany data
  // protection officer (content/privacy.ts's own comment) — covering the
  // Ideathon section's expanded field list (migration 0015), the CV data
  // category/mail attachment, and the interview-availability field
  // (migrations/0023) — and re-confirmed 2026-10-04 for the contact form's
  // automatic spam check (migrations/0024).
  it("is currently reviewed, with the reviewer on record", () => {
    expect(privacyReviewStatus).toEqual({
      reviewed: true,
      reviewedAt: "2026-10-04",
      reviewedBy: "Marco Becker",
      reviewerRole: "Datenschutzbeauftragter Enactus Germany",
    });
  });

  it("validates the exported status", () => {
    expect(() => privacyReviewStatusSchema.parse(privacyReviewStatus)).not.toThrow();
  });

  it("accepts a reviewed status with a date, reviewer, and role", () => {
    expect(() =>
      privacyReviewStatusSchema.parse({
        reviewed: true,
        reviewedAt: "2026-09-01",
        reviewedBy: "Someone",
        reviewerRole: "Some role",
      }),
    ).not.toThrow();
  });

  it("rejects a reviewed status without a review date", () => {
    expect(() =>
      privacyReviewStatusSchema.parse({
        reviewed: true,
        reviewedAt: null,
        reviewedBy: "Someone",
        reviewerRole: "Some role",
      }),
    ).toThrow();
  });

  it("rejects a reviewed status without a reviewer name", () => {
    expect(() =>
      privacyReviewStatusSchema.parse({
        reviewed: true,
        reviewedAt: "2026-09-01",
        reviewedBy: null,
        reviewerRole: "Some role",
      }),
    ).toThrow();
  });

  it("rejects a reviewed status without a reviewer role", () => {
    expect(() =>
      privacyReviewStatusSchema.parse({
        reviewed: true,
        reviewedAt: "2026-09-01",
        reviewedBy: "Someone",
        reviewerRole: null,
      }),
    ).toThrow();
  });

  it("accepts an unreviewed status with no date, reviewer, or role", () => {
    expect(() =>
      privacyReviewStatusSchema.parse({
        reviewed: false,
        reviewedAt: null,
        reviewedBy: null,
        reviewerRole: null,
      }),
    ).not.toThrow();
  });
});
