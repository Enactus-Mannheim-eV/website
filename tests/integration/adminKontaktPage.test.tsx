import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { renderWithIntl } from "../fixtures/intl";

const listContactMessages = vi.fn();
const countContactMessages = vi.fn();
const cookieGet = vi.fn();

vi.mock("@/lib/db", () => ({
  listContactMessages: (...args: unknown[]) => listContactMessages(...args),
  countContactMessages: (...args: unknown[]) => countContactMessages(...args),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => cookieGet(name) }),
}));

vi.mock("next-intl/server", async () => (await import("../fixtures/nextIntlServer")).nextIntlServerMock);

vi.mock("@/i18n/requireLocale", () => ({
  requireLocale: async () => "de",
  resolveLocale: (locale: string) => (locale === "en" ? "en" : "de"),
}));

// NotSpamButton is a client component and calls useRouter.
vi.mock("next/navigation", async () => (await import("../fixtures/navigation")).nextNavigationMock);

const ORIGINAL_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;

const INBOX_MESSAGE = {
  id: "11111111-1111-1111-1111-111111111111",
  createdAt: new Date("2026-10-04T10:00:00Z"),
  name: "Jane Doe",
  email: "jane@example.com",
  subject: "Partnerschaft",
  mailStatus: "sent" as const,
  spamReasons: [],
};

const SPAM_MESSAGE = {
  id: "22222222-2222-2222-2222-222222222222",
  createdAt: new Date("2026-10-04T11:00:00Z"),
  name: "aUubpMfPxUvNtpHEEaTgU",
  email: "bot@example.invalid",
  subject: "HBBPNQHYMRjYrUrUBKsXccV",
  mailStatus: "pending" as const,
  spamReasons: ["random_name", "random_subject", "a_code_from_a_future_rule"],
};

function props(view?: string) {
  return { params: Promise.resolve({ locale: "de" }), searchParams: Promise.resolve(view ? { view } : {}) };
}

async function validSessionCookie() {
  const { createSessionCookieValue } = await import("@/lib/adminAuth");
  return createSessionCookieValue()!;
}

beforeEach(() => {
  process.env.ADMIN_SESSION_SECRET = "a-signing-secret-for-kontakt-page-tests";
  countContactMessages.mockResolvedValue({ inbox: 1, spam: 1 });
});

afterEach(() => {
  vi.resetAllMocks();
  if (ORIGINAL_SESSION_SECRET === undefined) delete process.env.ADMIN_SESSION_SECRET;
  else process.env.ADMIN_SESSION_SECRET = ORIGINAL_SESSION_SECRET;
});

describe("/admin/kontakt (page)", () => {
  it("never reads messages from the database without a session", async () => {
    cookieGet.mockReturnValue(undefined);

    const { default: Page } = await import("@/app/[locale]/admin/kontakt/page");
    await Page(props("spam"));

    expect(listContactMessages).not.toHaveBeenCalled();
    expect(countContactMessages).not.toHaveBeenCalled();
  });

  it("shows the inbox by default, with the mail status and no release button", async () => {
    cookieGet.mockReturnValue({ value: await validSessionCookie() });
    listContactMessages.mockResolvedValue([INBOX_MESSAGE]);

    const { default: Page } = await import("@/app/[locale]/admin/kontakt/page");
    renderWithIntl(await Page(props()));

    expect(listContactMessages).toHaveBeenCalledWith("inbox");
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Mailstatus" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kein Spam" })).not.toBeInTheDocument();
  });

  it("falls back to the inbox for an unknown view", async () => {
    cookieGet.mockReturnValue({ value: await validSessionCookie() });
    listContactMessages.mockResolvedValue([]);

    const { default: Page } = await import("@/app/[locale]/admin/kontakt/page");
    await Page(props("everything"));

    expect(listContactMessages).toHaveBeenCalledWith("inbox");
  });

  it("shows held-back messages with their reasons and a release button on the spam tab", async () => {
    cookieGet.mockReturnValue({ value: await validSessionCookie() });
    listContactMessages.mockResolvedValue([SPAM_MESSAGE]);

    const { default: Page } = await import("@/app/[locale]/admin/kontakt/page");
    renderWithIntl(await Page(props("spam")));

    expect(listContactMessages).toHaveBeenCalledWith("spam");
    expect(screen.getByText("Name wie Zufallszeichen")).toBeInTheDocument();
    expect(screen.getByText("Betreff wie Zufallszeichen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kein Spam" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Mailstatus" })).not.toBeInTheDocument();
  });

  it("falls back to the raw code for a reason it has no label for", async () => {
    cookieGet.mockReturnValue({ value: await validSessionCookie() });
    listContactMessages.mockResolvedValue([SPAM_MESSAGE]);

    const { default: Page } = await import("@/app/[locale]/admin/kontakt/page");
    renderWithIntl(await Page(props("spam")));

    expect(screen.getByText("a_code_from_a_future_rule")).toBeInTheDocument();
  });

  it("offers both tabs with their counts and marks the current one", async () => {
    cookieGet.mockReturnValue({ value: await validSessionCookie() });
    listContactMessages.mockResolvedValue([]);
    countContactMessages.mockResolvedValue({ inbox: 4, spam: 7 });

    const { default: Page } = await import("@/app/[locale]/admin/kontakt/page");
    renderWithIntl(await Page(props("spam")));

    const spamTab = screen.getByRole("link", { name: "Spam (7)" });
    expect(spamTab).toHaveAttribute("aria-current", "page");
    expect(spamTab).toHaveAttribute("href", "/admin/kontakt?view=spam");
    const inboxTab = screen.getByRole("link", { name: "Posteingang (4)" });
    expect(inboxTab).not.toHaveAttribute("aria-current");
    expect(inboxTab).toHaveAttribute("href", "/admin/kontakt");
  });

  it("says so when there is nothing in the spam tab", async () => {
    cookieGet.mockReturnValue({ value: await validSessionCookie() });
    listContactMessages.mockResolvedValue([]);

    const { default: Page } = await import("@/app/[locale]/admin/kontakt/page");
    renderWithIntl(await Page(props("spam")));

    expect(screen.getByText("Keine als Spam erkannten Nachrichten.")).toBeInTheDocument();
  });

  it("has no accessibility violations on the spam tab", async () => {
    cookieGet.mockReturnValue({ value: await validSessionCookie() });
    listContactMessages.mockResolvedValue([SPAM_MESSAGE]);

    const { default: Page } = await import("@/app/[locale]/admin/kontakt/page");
    const { container } = renderWithIntl(await Page(props("spam")));

    expect(await axe(container)).toHaveNoViolations();
  });
});
