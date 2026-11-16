import { z } from "zod";
import { socialLinks } from "./navigation";

/**
 * Legal and contact facts about the association itself: founding year,
 * registered office, contact addresses. Copy (mission statements, about-page
 * prose) lives in messages/; this file holds only structure and facts, so a
 * typo in a legal detail fails the build instead of shipping quietly.
 * Social profile links are the exact ones navigation.ts renders in the
 * footer — re-exported here rather than duplicated, so there's exactly one
 * place that can go stale.
 */

const emailSchema = z.email().nullable();

// The people legally representing the association (Impressum "Vertreten
// durch" and, identically here, § 18 Abs. 2 MStV's content-responsible
// person). Kept separate from content/board.ts's five-seat public "Vorstand"
// roster on purpose: the legally representing board (Vorstand im Sinne des
// Vereinsrechts) is a subset of the five-seat public-facing roster, and the
// two lists can diverge — see ASSETS-TODO.md. Thorben Ossig and Anton
// Osuhovskiy confirmed 2026-08-15.
const legalRepresentativesSchema = z.object({
  names: z.array(z.string()),
  verified: z.boolean(),
});

const orgSchema = z.object({
  legalName: z.string(),
  shortName: z.string(),
  foundingYear: z.object({
    year: z.number().int().min(1900).max(new Date().getFullYear()),
    verified: z.boolean(),
  }),
  registeredOffice: z.string().nullable(),
  registerEntry: z.string().nullable(),
  legalRepresentatives: legalRepresentativesSchema,
  contactEmails: z.object({
    general: emailSchema,
    // Non-nullable, unlike `general`: three components (ApplicationForm,
    // ContactForm, PartnerContact) render this as their fallback contact
    // address, and a null here would need a fallback path duplicated in
    // all three instead of one guarantee here. If the address is ever
    // withdrawn without a replacement, that should fail the build loudly,
    // not silently ship a broken mailto: link.
    board: z.email(),
  }),
});
export type Org = z.infer<typeof orgSchema>;

export const org: Org = orgSchema.parse({
  legalName: "Enactus Mannheim e.V.",
  shortName: "Enactus Mannheim",
  // Shown "seit {year}" in the footer rather than as a KPI. Board-confirmed
  // 2026-08-19.
  foundingYear: { year: 2003, verified: true },
  registeredOffice: "L1, 1 Postfach 31, 68161 Mannheim",
  registerEntry: "Amtsgericht Mannheim, Vereinsregister VR 700965",
  // Board-confirmed — see the field comment above for the two confirmation
  // dates.
  legalRepresentatives: {
    names: ["Thorben Ossig", "Anton Osuhovskiy"],
    verified: true,
  },
  contactEmails: {
    general: null,
    // "teamvorstand" — given specifically as the Impressum/legal contact
    // address, not confirmed as the general public inbox Footer/Kontakt
    // still need (content/navigation.ts, ASSETS-TODO.md).
    board: "teamvorstand@unimannheim.enactus.team",
  },
});

export { orgSchema, socialLinks };
