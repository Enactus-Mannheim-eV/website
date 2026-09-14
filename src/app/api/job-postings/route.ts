import { NextResponse } from "next/server";
import { getJobPostings } from "@/lib/jobPostings";

/**
 * Lets JobsSection.tsx (the one client component reading job postings)
 * refresh after hydration, on top of the value the /jobs page already
 * passes down as a prop from its own server-rendered call — same two
 * reasons as /api/calendar-events:
 *
 * 1. Testability. A value baked into a static page at build time has no
 *    seam Playwright's page.route() can intercept; routing it through a
 *    fetchable endpoint restores one, the same way every DB-backed form on
 *    this site already works.
 * 2. Freshness. getJobPostings() has no time-based expiry of its own (see
 *    that file's comment on why) — an admin edit invalidates it
 *    immediately via revalidateTag, so this route's freshness case is
 *    narrower than /api/recruiting-windows' and /api/calendar-events': it's
 *    the same cache entry the page already reads, checked again after
 *    hydration rather than only at the last render.
 *
 * No auth, no rate limit: this returns exactly the same public data that's
 * already embedded in the /jobs page's own HTML source.
 */
export async function GET() {
  const jobs = await getJobPostings();
  return NextResponse.json({ jobs });
}
