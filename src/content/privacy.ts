import { z } from "zod";

/**
 * The single fact that flips /datenschutz from draft to reviewed (see the
 * page brief: "Structure it so a single sentence can be flipped from draft
 * to reviewed once the Enactus Germany data protection officer has signed
 * off"). Everything else on that page is copy in messages/{locale}.json
 * under "Datenschutz"; this file holds only the one fact a board handover
 * could actually change. `reviewedAt` is required the moment `reviewed`
 * flips true, enforced below rather than left for a component to notice at
 * render time — same contract as process.ts's projectGuideSchema.
 */

const privacyReviewStatusSchema = z
  .object({
    reviewed: z.boolean(),
    reviewedAt: z.iso.date().nullable(),
    // Who actually signed off — not shown anywhere on the page (this
    // status has never been rendered, see Datenschutz.tsx's own comment),
    // but the record of *who* approved *what* is the whole point of
    // tracking this at all, not just *whether*.
    reviewedBy: z.string().nullable(),
    reviewerRole: z.string().nullable(),
  })
  .superRefine((status, ctx) => {
    if (status.reviewed && !status.reviewedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewedAt"],
        message: "reviewedAt is required once reviewed is true",
      });
    }
    if (status.reviewed && !status.reviewedBy) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewedBy"],
        message: "reviewedBy is required once reviewed is true",
      });
    }
    if (status.reviewed && !status.reviewerRole) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewerRole"],
        message: "reviewerRole is required once reviewed is true",
      });
    }
  });
export type PrivacyReviewStatus = z.infer<typeof privacyReviewStatusSchema>;

// Reviewed and confirmed 2026-09-10 by Marco Becker, Datenschutzbeauftragter
// Enactus Germany — covering everything this status had been sitting on
// since the previous sign-off (2026-08-31: the Ideathon signup section,
// Datenschutz.tsx, messages' "ideathonSignup" key, including the expanded
// field list from migration 0015 — team members, motivation/experience,
// dietary preference — the CV as its own data category, uploaded to Vercel
// Blob, and sending that CV as a mail attachment to the board), plus the
// new field this review covers: Gesprächsverfügbarkeit, the interview
// time slots an applicant may optionally select (migrations/0023,
// Datenschutz.application.fields' own new entry) — stored on the
// application row itself and deleted along with it, no separate retention
// period.
//
// Re-confirmed 2026-10-04 by the same reviewer for the automatic spam check on
// the contact form (Datenschutz.antiSpam.measures, last entry): a content
// check of name, subject, message and address, with suspected spam stored
// flagged together with the rules that fired, held back from the board's
// inbox until released by hand, and kept for the same 12 months as every
// contact message (migrations/0024). Flip back to `false` if any of those
// areas change again before the next sign-off.
export const privacyReviewStatus: PrivacyReviewStatus = privacyReviewStatusSchema.parse({
  reviewed: true,
  reviewedAt: "2026-10-04",
  reviewedBy: "Marco Becker",
  reviewerRole: "Datenschutzbeauftragter Enactus Germany",
});

export { privacyReviewStatusSchema };
