import { NextResponse } from "next/server";
import { getDepartments } from "@/lib/departments";

/**
 * Lets ApplicationForm.tsx (the /mitmachen application form) refresh its
 * "Ressort" checkbox list after hydration — same mockable-seam reasoning as
 * /api/project-areas (a value baked into the static page at build time has
 * no hook Playwright's page.route() can intercept; this route restores
 * one). No periodic-staleness case either: getDepartments() has no
 * time-based expiry (see departments.ts), an admin edit invalidates it
 * immediately.
 *
 * No auth, no rate limit: this returns exactly the same public data
 * already embedded in the page's own HTML source.
 */
export async function GET() {
  const departments = await getDepartments();
  return NextResponse.json({ departments });
}
