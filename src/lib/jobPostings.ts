import { unstable_cache as nextCache } from "next/cache";
import { listActiveJobPostings } from "@/lib/db";
import type { JobPosting } from "@/content/jobs";

/**
 * The public-facing view of the postings the board manages at /admin/jobs
 * (lib/db.ts's listActiveJobPostings — already filtered to non-expired rows
 * server-side). Cached and revalidated on a tag, not read fresh on every
 * request — same shape and reasoning as lib/calendarEvents.ts: the nav/
 * footer's "does Jobs show at all" check runs on every public page, and
 * hitting Neon on every visitor would turn that into a database load test.
 *
 * Fail-soft on purpose: a database hiccup here shows the jobs page's own
 * empty state (and drops "Jobs" from the nav), not a broken page. It's also
 * what keeps `next build` green without DATABASE_URL — the underlying call
 * fails once during prerendering, this catches it, and the page prerenders
 * with an empty list.
 */
export const JOB_POSTINGS_TAG = "job-postings";

// See calendarEvents.ts's identical comment on `{ expire: 0 }`: an admin
// edit at /admin/jobs needs to be visible on the next page load, without
// waiting for the entry below to expire on its own.
export const JOB_POSTINGS_REVALIDATE = { expire: 0 } as const;

async function loadJobPostings(): Promise<JobPosting[]> {
  try {
    const rows = await listActiveJobPostings();
    return rows.map((row) => ({
      id: row.id,
      company: row.company,
      title: row.title,
      employmentType: row.employmentType,
      location: row.location,
      remote: row.remote,
      description: row.description,
      applyUrl: row.applyUrl,
      expiresAt: row.expiresAt,
      partnerSlug: row.partnerSlug,
    }));
  } catch (error) {
    console.error("Failed to load job postings", error);
    return [];
  }
}

// revalidate: false, not a number — this loader is read from the (site)
// layout, so it runs on every public page, not just /jobs. A numeric
// revalidate here doesn't just bound this one page; it becomes the ISR
// interval for the entire site (unstable_cache's revalidate propagates to
// the smallest value any reader's segment has seen), which is what quietly
// turned every static page into an hourly rewrite. Freshness for a mutation
// comes from the tag above, not from an expiry — there is no time-based
// reason for this list to go stale on its own.
export const getJobPostings: () => Promise<JobPosting[]> = nextCache(
  loadJobPostings,
  ["job-postings"],
  { tags: [JOB_POSTINGS_TAG], revalidate: false },
);
