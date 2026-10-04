import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mocks at the Neon client, like dbContactRetention.test.ts, because the
 * things worth pinning here are inside the SQL itself: which rows each admin
 * tab selects, and that releasing a message is guarded by `and spam` so a
 * double click can't forward it twice.
 */
const queryMock = vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(
  async () => [],
);

vi.mock("@neondatabase/serverless", () => ({
  neon: () => queryMock,
}));

describe("contact message spam handling", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://test-connection-string";
    queryMock.mockReset();
    queryMock.mockResolvedValue([]);
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    vi.resetModules();
  });

  it("inserts a message as not spam with no reasons when the caller says nothing", async () => {
    queryMock.mockResolvedValueOnce([{ id: "abc", created_at: new Date() }]);
    const { insertContactMessage } = await import("@/lib/db");

    await insertContactMessage({ name: "Anna Müller", email: "anna@example.invalid", message: "Hallo zusammen", locale: "de" });

    const [strings, ...values] = queryMock.mock.calls[0];
    expect(strings.join("?")).toContain("spam_reasons");
    expect(values).toContain(false);
    expect(values).toContainEqual([]);
  });

  it("stores the spam flag and the reasons it was given", async () => {
    queryMock.mockResolvedValueOnce([{ id: "abc", created_at: new Date() }]);
    const { insertContactMessage } = await import("@/lib/db");

    const stored = await insertContactMessage({
      name: "x",
      email: "x@example.invalid",
      message: "0123456789",
      locale: "de",
      spam: true,
      spamReasons: ["random_name", "too_fast"],
    });

    const [, ...values] = queryMock.mock.calls[0];
    expect(values).toContain(true);
    expect(values).toContainEqual(["random_name", "too_fast"]);
    expect(stored.spam).toBe(true);
  });

  it("selects the inbox tab by spam = false and the spam tab by spam = true", async () => {
    const { listContactMessages } = await import("@/lib/db");

    await listContactMessages("inbox");
    await listContactMessages("spam");
    await listContactMessages();

    expect(queryMock.mock.calls.map(([, ...values]) => values)).toEqual([[false], [true], [false]]);
  });

  it("falls back to an empty reason list when the column comes back null", async () => {
    queryMock.mockResolvedValueOnce([
      { id: "1", created_at: new Date(), name: "n", email: "e", subject: null, mail_status: "pending", spam_reasons: null },
    ]);
    const { listContactMessages } = await import("@/lib/db");

    const [row] = await listContactMessages("spam");

    expect(row.spamReasons).toEqual([]);
  });

  it("counts both tabs in one query", async () => {
    queryMock.mockResolvedValueOnce([{ inbox: 4, spam: 7 }]);
    const { countContactMessages } = await import("@/lib/db");

    await expect(countContactMessages()).resolves.toEqual({ inbox: 4, spam: 7 });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("releases only a row that is still flagged, and returns it for forwarding", async () => {
    queryMock.mockResolvedValueOnce([
      { id: "1", created_at: new Date(), name: "n", email: "e", subject: "s", message: "m", locale: "de" },
    ]);
    const { clearContactMessageSpam } = await import("@/lib/db");

    const released = await clearContactMessageSpam("1");

    const [strings] = queryMock.mock.calls[0];
    expect(strings.join("?")).toMatch(/where id = \?\s+and spam\b/);
    expect(strings.join("?")).not.toContain("spam_reasons");
    expect(released?.message).toBe("m");
  });

  it("returns null when nothing was flagged, so a second click forwards nothing", async () => {
    const { clearContactMessageSpam } = await import("@/lib/db");

    await expect(clearContactMessageSpam("1")).resolves.toBeNull();
  });
});
