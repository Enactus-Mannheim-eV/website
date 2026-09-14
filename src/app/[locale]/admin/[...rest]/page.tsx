import { notFound } from "next/navigation";

// Without this, an unmatched /admin/* URL falls through to the (site) route
// group's own catch-all ((site)/[...rest]/page.tsx) instead of triggering
// admin/not-found.tsx — route groups add no URL segment, so that sibling
// catch-all matches anything under /admin/ that isn't a real admin route,
// and a static segment losing to a catch-all one directory over is a real
// Next.js routing quirk, not a hypothetical. This file gives /admin/* its
// own catch-all so Next matches it first and resolves the admin-styled
// not-found.tsx instead.
//
// force-dynamic here is belt-and-braces, not the load-bearing fix: the
// admin layout's cookies() read already forces this subtree dynamic. Stated
// explicitly so it doesn't quietly start caching guessed /admin/* paths if
// that layout check is ever refactored — see (site)/[...rest]/page.tsx for
// the case where this export is the only thing preventing that.
export const dynamic = "force-dynamic";

export default function AdminCatchAllPage(): never {
  notFound();
}
