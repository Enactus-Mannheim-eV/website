// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const peekRateLimit = vi.fn();
const consumeRateLimit = vi.fn();

vi.mock("@/lib/db", () => ({
  peekRateLimit: (...args: unknown[]) => peekRateLimit(...args),
  consumeRateLimit: (...args: unknown[]) => consumeRateLimit(...args),
}));

describe("checkRateLimit", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("allows a request within the default limit", async () => {
    peekRateLimit.mockResolvedValue(0);
    consumeRateLimit.mockResolvedValue(1);
    const { checkRateLimit } = await import("@/lib/rateLimit");

    const result = await checkRateLimit("some-unlisted-route", "203.0.113.1");

    expect(result).toEqual({ allowed: true, remaining: 4 });
  });

  it("rejects a flood once the default limit is exceeded, without writing a row for the rejected request", async () => {
    peekRateLimit.mockResolvedValue(5);
    const { checkRateLimit } = await import("@/lib/rateLimit");

    const result = await checkRateLimit("some-unlisted-route", "203.0.113.1");

    expect(result).toEqual({ allowed: false, remaining: 0 });
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it("only increments the counter for a request that's still under the limit", async () => {
    peekRateLimit.mockResolvedValue(3);
    consumeRateLimit.mockResolvedValue(4);
    const { checkRateLimit } = await import("@/lib/rateLimit");

    const result = await checkRateLimit("some-unlisted-route", "203.0.113.1");

    expect(consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ allowed: true, remaining: 1 });
  });

  it("never passes the raw IP address to the database layer, only its hash", async () => {
    peekRateLimit.mockResolvedValue(0);
    consumeRateLimit.mockResolvedValue(1);
    const { checkRateLimit } = await import("@/lib/rateLimit");

    await checkRateLimit("bewerbung", "203.0.113.1");

    const [bucket] = peekRateLimit.mock.calls[0] as [string, Date];
    expect(bucket).not.toContain("203.0.113.1");
    expect(bucket).toMatch(/^bewerbung:[0-9a-f]{64}$/);
  });

  it("hashes the same IP identically across calls, so repeat hits land in the same bucket", async () => {
    peekRateLimit.mockResolvedValue(0);
    consumeRateLimit.mockResolvedValue(1);
    const { checkRateLimit } = await import("@/lib/rateLimit");

    await checkRateLimit("kontakt", "203.0.113.1");
    await checkRateLimit("kontakt", "203.0.113.1");

    const [firstBucket] = peekRateLimit.mock.calls[0] as [string, Date];
    const [secondBucket] = peekRateLimit.mock.calls[1] as [string, Date];
    expect(firstBucket).toBe(secondBucket);
  });

  it("keeps buckets for different routes separate, even for the same IP", async () => {
    peekRateLimit.mockResolvedValue(0);
    consumeRateLimit.mockResolvedValue(1);
    const { checkRateLimit } = await import("@/lib/rateLimit");

    await checkRateLimit("bewerbung", "203.0.113.1");
    await checkRateLimit("kontakt", "203.0.113.1");

    const [bewerbungBucket] = peekRateLimit.mock.calls[0] as [string, Date];
    const [kontaktBucket] = peekRateLimit.mock.calls[1] as [string, Date];
    expect(bewerbungBucket).not.toBe(kontaktBucket);
  });

  /**
   * The staggered limits added 2026-08-30 ahead of the HWS26 recruiting
   * release: a flat 5-per-IP-per-10-minutes, applied to /api/bewerbung
   * and /api/ideathon, would have meant "five applications campus-wide
   * per ten minutes" for applicants sharing a university WLAN's egress
   * IP. Each route's own ceiling is asserted directly rather than via a
   * shared "the default applies everywhere" test, since the whole point
   * is that it no longer does.
   */
  describe("per-route ceilings", () => {
    it.each([
      ["bewerbung", 20],
      ["ideathon", 20],
      ["kontakt", 10],
      ["kontakt-token", 60],
      ["ideathon-token", 60],
      ["reminder", 10],
      ["reminder-bestaetigen", 30],
      ["reminder-abmelden", 30],
      ["reminder-address", 3],
      ["admin-login", 5],
    ])("allows exactly %s requests for route %s before rejecting", async (route, limit) => {
      peekRateLimit.mockResolvedValue(limit - 1);
      consumeRateLimit.mockResolvedValue(limit);
      const { checkRateLimit } = await import("@/lib/rateLimit");

      const underLimit = await checkRateLimit(route, "203.0.113.1");
      expect(underLimit).toEqual({ allowed: true, remaining: 0 });

      peekRateLimit.mockResolvedValue(limit);
      const overLimit = await checkRateLimit(route, "203.0.113.1");
      expect(overLimit).toEqual({ allowed: false, remaining: 0 });
    });

    it("keeps admin-login at the original, tighter limit — the one route defending against a real brute-force attempt", async () => {
      peekRateLimit.mockResolvedValue(5);
      const { checkRateLimit } = await import("@/lib/rateLimit");

      const result = await checkRateLimit("admin-login", "203.0.113.1");

      expect(result).toEqual({ allowed: false, remaining: 0 });
    });
  });
});
