// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFormToken } from "@/lib/formToken";

const insertContactMessage = vi.fn();
const markContactMessageMailed = vi.fn();
const markContactMessageMailFailed = vi.fn();
const sendContactMessageNotification = vi.fn();
const checkRateLimit = vi.fn();

vi.mock("@/lib/db", () => ({
  insertContactMessage: (...args: unknown[]) => insertContactMessage(...args),
  markContactMessageMailed: (...args: unknown[]) => markContactMessageMailed(...args),
  markContactMessageMailFailed: (...args: unknown[]) => markContactMessageMailFailed(...args),
}));

vi.mock("@/lib/mail", () => ({
  sendContactMessageNotification: (...args: unknown[]) => sendContactMessageNotification(...args),
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
}));

vi.mock("next-intl/server", async () => (await import("../fixtures/nextIntlServer")).nextIntlServerMock);

const STORED_MESSAGE = {
  id: "22222222-2222-2222-2222-222222222222",
  createdAt: new Date("2026-08-16T10:00:00Z"),
  name: "Jane Doe",
  email: "jane@example.com",
  subject: "Frage zur Bewerbung",
  message: "Wir würden gerne mit euch sprechen.",
  locale: "de" as const,
};

// A token already ten seconds old, like a visitor who has been on the page
// for a moment, signed with the same secret the route verifies against.
function freshToken() {
  return createFormToken(new Date(Date.now() - 10_000));
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Jane Doe",
    email: "jane@example.com",
    subject: "Frage zur Bewerbung",
    message: "Wir würden gerne mit euch sprechen.",
    locale: "de",
    website: "",
    formToken: freshToken(),
    ...overrides,
  };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/kontakt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ORIGINAL_SECRET = process.env.FORM_TOKEN_SECRET;

describe("POST /api/kontakt", () => {
  beforeEach(() => {
    process.env.FORM_TOKEN_SECRET = "a-form-token-signing-secret";
  });

  afterEach(() => {
    vi.resetAllMocks();
    if (ORIGINAL_SECRET === undefined) delete process.env.FORM_TOKEN_SECRET;
    else process.env.FORM_TOKEN_SECRET = ORIGINAL_SECRET;
  });

  it("persists the message when forwarding it by email fails", async () => {
    checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    insertContactMessage.mockResolvedValue(STORED_MESSAGE);
    sendContactMessageNotification.mockRejectedValue(new Error("Resend is down"));
    markContactMessageMailFailed.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/kontakt/route");
    const response = await POST(postRequest(validPayload()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(insertContactMessage).toHaveBeenCalledTimes(1);
    expect(markContactMessageMailFailed).toHaveBeenCalledWith(STORED_MESSAGE.id, "Resend is down");
  });

  it("forwards the message and marks it mailed on success", async () => {
    checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    insertContactMessage.mockResolvedValue(STORED_MESSAGE);
    sendContactMessageNotification.mockResolvedValue("email-id");
    markContactMessageMailed.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/kontakt/route");
    const response = await POST(postRequest(validPayload()));

    expect(response.status).toBe(200);
    expect(sendContactMessageNotification).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Jane Doe", email: "jane@example.com" }),
    );
    expect(markContactMessageMailed).toHaveBeenCalledWith(STORED_MESSAGE.id);
  });

  it("reports a server error and never claims success when the database write fails", async () => {
    checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    insertContactMessage.mockRejectedValue(new Error("connection reset"));

    const { POST } = await import("@/app/api/kontakt/route");
    const response = await POST(postRequest(validPayload()));

    expect(response.status).toBe(500);
    expect(sendContactMessageNotification).not.toHaveBeenCalled();
  });

  it("rejects invalid input with 400 and never writes to the database", async () => {
    checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });

    const { POST } = await import("@/app/api/kontakt/route");
    const response = await POST(postRequest(validPayload({ message: "too short" })));

    expect(response.status).toBe(400);
    expect(insertContactMessage).not.toHaveBeenCalled();
  });

  it("rejects a flood with 429 before touching the database", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const { POST } = await import("@/app/api/kontakt/route");
    const response = await POST(postRequest(validPayload()));

    expect(response.status).toBe(429);
    expect(insertContactMessage).not.toHaveBeenCalled();
  });

  it("stores an ordinary message as not spam", async () => {
    checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    insertContactMessage.mockResolvedValue(STORED_MESSAGE);
    sendContactMessageNotification.mockResolvedValue("email-id");

    const { POST } = await import("@/app/api/kontakt/route");
    await POST(postRequest(validPayload()));

    expect(insertContactMessage).toHaveBeenCalledWith(expect.objectContaining({ spam: false, spamReasons: [] }));
  });

  describe("suspected spam", () => {
    async function submitSpam(overrides: Record<string, unknown>) {
      checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
      insertContactMessage.mockResolvedValue({ ...STORED_MESSAGE, spam: true });
      const { POST } = await import("@/app/api/kontakt/route");
      return POST(postRequest(validPayload(overrides)));
    }

    // Overrides are built inside each test: the token needs the secret that
    // beforeEach sets, which doesn't exist yet while this table is declared.
    it.each([
      [
        "a random name and subject",
        () => ({ name: "aUubpMfPxUvNtpHEEaTgU", subject: "HBBPNQHYMRjYrUrUBKsXccV" }),
        ["random_name", "random_subject", "long_single_name"],
      ],
      ["a filled honeypot", () => ({ website: "https://spam.example" }), ["honeypot"]],
      ["a missing token", () => ({ formToken: undefined }), ["token_missing"]],
      ["a forged token", () => ({ formToken: "1.forged" }), ["token_invalid"]],
      ["a token that is too young", () => ({ formToken: createFormToken() }), ["too_fast"]],
    ])("holds back %s: stored flagged, never mailed, answered like a success", async (_label, overrides, reasons) => {
      const response = await submitSpam(overrides());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(insertContactMessage).toHaveBeenCalledWith(expect.objectContaining({ spam: true, spamReasons: reasons }));
      expect(sendContactMessageNotification).not.toHaveBeenCalled();
      expect(markContactMessageMailed).not.toHaveBeenCalled();
      expect(markContactMessageMailFailed).not.toHaveBeenCalled();
    });

    it("answers a bot's flagged message exactly like a normal one", async () => {
      checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
      insertContactMessage.mockResolvedValue(STORED_MESSAGE);
      sendContactMessageNotification.mockResolvedValue("email-id");
      const { POST } = await import("@/app/api/kontakt/route");

      const normal = await POST(postRequest(validPayload()));
      const flagged = await POST(postRequest(validPayload({ website: "x" })));

      expect(flagged.status).toBe(normal.status);
      expect(await flagged.json()).toEqual(await normal.json());
    });

    it("still reports a server error when a flagged message cannot be stored", async () => {
      checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
      insertContactMessage.mockRejectedValue(new Error("connection reset"));
      const { POST } = await import("@/app/api/kontakt/route");

      const response = await POST(postRequest(validPayload({ website: "x" })));

      expect(response.status).toBe(500);
    });
  });
});
