import { notFound } from "next/navigation";

// Catches any path under (site) that doesn't match a real route, so it
// renders the localized not-found.tsx (inside the Header/Footer chrome)
// instead of Next's unstyled default 404.
//
// force-dynamic on purpose: this page has no generateStaticParams, so every
// distinct guessed path (a scanner, an old bookmark, a typo) is a path Next
// has never seen before. Without this, a page that touches no request-time
// API still gets its render written into the full route cache on first hit
// — an unbounded number of guessed paths becomes an unbounded number of ISR
// writes. A 404 costs nothing to regenerate; there is no reason to cache it.
export const dynamic = "force-dynamic";

export default function CatchAllPage(): never {
  notFound();
}
