import { z } from "zod";
import { applicationFormSchema, refineApplicationForm } from "./applicationFormSchema";
import { contactFormSchema } from "./contactFormSchema";
import { reminderSignupSchema } from "./reminderSignupSchema";
import { ideathonSignupFormSchema } from "./ideathonSignupFormSchema";

/**
 * The three client form schemas extended with `locale` — the one field a
 * client submission needs but a browser form doesn't collect itself (it's
 * read from the page's own route, not typed by the visitor). The base
 * schemas in applicationFormSchema.ts / contactFormSchema.ts /
 * reminderSignupSchema.ts stay untouched so the client resolvers and their
 * existing unit tests are unaffected — this file only adds what's specific
 * to validating a request body server-side.
 */

const localeSchema = z.enum(["de", "en"]);

// `formToken` is the one field with no equivalent in the client schema:
// it's not something react-hook-form manages, just an opaque, signed
// timing token ApplicationForm.tsx fetches on mount (GET
// /api/bewerbung/token) and attaches at submit time, so /api/bewerbung can
// verify the real elapsed fill time server-side (lib/formToken.ts) — a
// client-supplied timestamp is trivial to fake by calling the route
// directly with any value at all.
// .extend() first, while applicationFormSchema is still a plain ZodObject,
// then the same cross-field refinement applicationFormSchema.ts's own
// client resolver runs — see that file's comment on why the refinement
// can't live on the exported base schema itself.
export const applicationRequestSchema = applicationFormSchema
  .extend({
    locale: localeSchema,
    formToken: z.string(),
  })
  .superRefine(refineApplicationForm);
export type ApplicationRequest = z.infer<typeof applicationRequestSchema>;

export const reminderRequestSchema = reminderSignupSchema.extend({ locale: localeSchema });
export type ReminderRequest = z.infer<typeof reminderRequestSchema>;

// Both extra fields are optional on purpose, unlike the application forms'
// required `formToken`: a request without them is not rejected with a 400
// (which would lose a real message whose token fetch failed) but stored and
// held back as suspected spam, see lib/contactSpam.ts.
export const contactRequestSchema = contactFormSchema.extend({
  locale: localeSchema,
  formToken: z.string().optional(),
  website: z.string().optional(),
});
export type ContactRequest = z.infer<typeof contactRequestSchema>;

export const ideathonSignupRequestSchema = ideathonSignupFormSchema.extend({
  locale: localeSchema,
  formToken: z.string(),
});
export type IdeathonSignupRequest = z.infer<typeof ideathonSignupRequestSchema>;
