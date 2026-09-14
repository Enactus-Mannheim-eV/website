import { NextResponse } from "next/server";
import { getProjectAreas } from "@/lib/projectAreas";

/**
 * Lets ApplicationForm.tsx (the /mitmachen application form) refresh its
 * "Wunschbereich" checkbox list after hydration — the same mockable-seam
 * reasoning as /api/recruiting-windows (a value baked into the static page
 * at build time has no hook Playwright's page.route() can intercept; this
 * route restores one). Unlike that route, there's no periodic-staleness
 * case here: getProjectAreas() has no time-based expiry (see
 * projectAreas.ts), an admin edit invalidates it immediately.
 *
 * No auth, no rate limit: this returns exactly the same public data
 * already embedded in the page's own HTML source.
 */
export async function GET() {
  const areas = await getProjectAreas();
  return NextResponse.json({ areas });
}
