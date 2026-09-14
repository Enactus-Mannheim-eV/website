import { unstable_cache as nextCache } from "next/cache";
import { listActiveDepartments } from "@/lib/db";

/**
 * The public-facing view of the "Ressort" list the board manages at
 * /admin/ressorts (lib/db.ts's listActiveDepartments). Cached and
 * revalidated on a tag, same shape and reasoning as lib/projectAreas.ts:
 * /mitmachen is a conversion page, not somewhere every visitor should
 * trigger a database round trip.
 *
 * Fail-soft on purpose: a database hiccup here shows an empty checkbox
 * list rather than breaking the form, and keeps `next build` green without
 * DATABASE_URL — the underlying call fails once during prerendering, this
 * catches it, and the page prerenders with nothing to check.
 */
export const DEPARTMENTS_TAG = "departments";

// { expire: 0 }: an admin edit needs to be visible on the next /mitmachen
// load, not after the hour-long fallback below expires — same as every
// other admin-managed list on this site.
export const DEPARTMENTS_REVALIDATE = { expire: 0 } as const;

export type PublicDepartment = { id: string; labelDe: string; labelEn: string };

async function loadDepartments(): Promise<PublicDepartment[]> {
  try {
    const rows = await listActiveDepartments();
    return rows.map((row) => ({ id: row.id, labelDe: row.labelDe, labelEn: row.labelEn }));
  } catch (error) {
    console.error("Failed to load departments", error);
    return [];
  }
}

// revalidate: false, not a number — see jobPostings.ts's comment on the
// same choice. This list has no time-based reason to go stale on its own
// (unlike recruitingWindows.ts, whose windows open and close by date without
// any admin action); the tag above is the only invalidation this needs.
export const getDepartments: () => Promise<PublicDepartment[]> = nextCache(
  loadDepartments,
  ["departments"],
  { tags: [DEPARTMENTS_TAG], revalidate: false },
);
