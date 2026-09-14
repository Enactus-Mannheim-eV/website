import { unstable_cache as nextCache } from "next/cache";
import { listActiveProjectAreas } from "@/lib/db";

/**
 * The public-facing view of the "Wunschbereich" list the board manages at
 * /admin/wunschbereiche (lib/db.ts's listActiveProjectAreas). Cached and
 * revalidated on a tag, same shape and reasoning as
 * lib/recruitingWindows.ts and lib/calendarEvents.ts: /mitmachen is a
 * conversion page, not somewhere every visitor should trigger a database
 * round trip.
 *
 * Fail-soft on purpose: a database hiccup here shows an empty checkbox
 * list rather than breaking the form, and keeps `next build` green without
 * DATABASE_URL — the underlying call fails once during prerendering, this
 * catches it, and the page prerenders with nothing to check.
 */
export const PROJECT_AREAS_TAG = "project-areas";

// { expire: 0 }: an admin edit needs to be visible on the next /mitmachen
// load, not after the hour-long fallback below expires — same as every
// other admin-managed list on this site.
export const PROJECT_AREAS_REVALIDATE = { expire: 0 } as const;

export type PublicProjectArea = {
  id: string;
  labelDe: string;
  labelEn: string;
  ideathonHint: boolean;
};

async function loadProjectAreas(): Promise<PublicProjectArea[]> {
  try {
    const rows = await listActiveProjectAreas();
    return rows.map((row) => ({
      id: row.id,
      labelDe: row.labelDe,
      labelEn: row.labelEn,
      ideathonHint: row.ideathonHint,
    }));
  } catch (error) {
    console.error("Failed to load project areas", error);
    return [];
  }
}

// revalidate: false, not a number — see jobPostings.ts's comment on the
// same choice. This list has no time-based reason to go stale on its own
// (unlike recruitingWindows.ts, whose windows open and close by date without
// any admin action); the tag above is the only invalidation this needs.
export const getProjectAreas: () => Promise<PublicProjectArea[]> = nextCache(
  loadProjectAreas,
  ["project-areas"],
  { tags: [PROJECT_AREAS_TAG], revalidate: false },
);
