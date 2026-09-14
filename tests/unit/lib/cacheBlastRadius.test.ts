// @vitest-environment node
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

/**
 * Encodes the rule that has no other enforcement anywhere in the codebase:
 * an unstable_cache loader's `revalidate` value doesn't just bound the one
 * page that "owns" it — it becomes the ISR interval of every segment that
 * reads it, all the way up to whichever layout is the highest reader. A
 * numeric `revalidate` on getJobPostings (read from the (site) layout, so
 * every public page) was exactly this mistake: it turned every static page
 * on the site into an hourly rewrite instead of only /jobs.
 *
 * This test exists so the next time someone "helpfully" adds a fallback
 * expiry back onto one of these — the value looks harmless in isolation —
 * it fails here first, with the reason, instead of showing up as an ISR
 * Writes spike weeks later.
 */

const unstableCacheCalls: unknown[][] = [];

vi.mock("next/cache", () => ({
  unstable_cache: (...args: unknown[]) => {
    unstableCacheCalls.push(args);
    // Never actually invoked in this test — the point is to inspect how
    // each loader is wrapped, not to exercise the wrapped function.
    return () => Promise.resolve([]);
  },
}));

function optionsFor(cacheKey: string): { revalidate?: unknown; tags?: unknown } {
  const call = unstableCacheCalls.find((args) => {
    const keyParts = args[1] as string[];
    return keyParts?.[0] === cacheKey;
  });
  if (!call) {
    throw new Error(`No unstable_cache call found with cache key "${cacheKey}"`);
  }
  return call[2] as { revalidate?: unknown; tags?: unknown };
}

describe("cache blast radius", () => {
  it("getJobPostings has no numeric revalidate — it is read from the (site) layout, so every public page inherits it", async () => {
    await import("@/lib/jobPostings");
    expect(optionsFor("job-postings").revalidate).toBe(false);
  });

  it("getProjectAreas has no numeric revalidate — it has no time-based reason to go stale, the tag covers every mutation", async () => {
    await import("@/lib/projectAreas");
    expect(optionsFor("project-areas").revalidate).toBe(false);
  });

  it("getDepartments has no numeric revalidate — same reasoning as getProjectAreas", async () => {
    await import("@/lib/departments");
    expect(optionsFor("departments").revalidate).toBe(false);
  });

  it("recruitingWindows loaders keep a numeric revalidate — a window opens and closes by date, with no admin mutation to hang a tag invalidation on", async () => {
    await import("@/lib/recruitingWindows");
    expect(optionsFor("recruiting-windows").revalidate).toBe(3600);
    expect(optionsFor("recruiting-windows-interview-grid").revalidate).toBe(3600);
  });

  it("getCalendarEvents keeps a numeric revalidate — getServerNowMs() freezes into the prerender, and /termine and /ideathon rely on the periodic regeneration to keep it from going stale indefinitely", async () => {
    await import("@/lib/calendarEvents");
    expect(optionsFor("calendar-events").revalidate).toBe(3600);
  });
});
