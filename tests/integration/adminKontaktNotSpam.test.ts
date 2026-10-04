// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const clearContactMessageSpam = vi.fn();
const markContactMessageMailed = vi.fn();
const markContactMessageMailFailed = vi.fn();
const dispatchContactNotification = vi.fn();

vi.mock("@/lib/db", () => ({
  clearContactMessageSpam: (...a: unknown[]) => clearContactMessageSpam(...a),
  markContactMessageMailed: (...a: unknown[]) => markContactMessageMailed(...a),
  markContactMessageMailFailed: (...a: unknown[]) => markContactMessageMailFailed(...a),
}));

vi.mock("@/lib/mailDispatch", () => ({
  dispatchContactNotification: (...a: unknown[]) => dispatchContactNotification(...a),
}));

const ORIGINAL_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;
const ID = "11111111-1111-1111-1111-111111111111";
const RELEASED = {
  id: ID,
  createdAt: new Date("2026-10-04T10:00:00Z"),
  name: "Jane Doe",
  email: "jane@example.com",
  subject: "Frage",
  message: "Wir würden gerne mit euch sprechen.",
  locale: "de" as const,
};

beforeEach(() => {
  process.env.ADMIN_SESSION_SECRET = "a-signing-secret-for-not-spam-tests";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  if (ORIGINAL_SESSION_SECRET === undefined) delete process.env.ADMIN_SESSION_SECRET;
  else process.env.ADMIN_SESSION_SECRET = ORIGINAL_SESSION_SECRET;
});

async function post(id: string, withSession = true) {
  const headers: Record<string, string> = {};
  if (withSession) {
    const { createSessionCookieValue } = await import("@/lib/adminAuth");
    headers.cookie = `admin_session=${createSessionCookieValue()!}`;
  }
  const { POST } = await import("@/app/api/admin/kontakt/[id]/not-spam/route");
  return POST(new NextRequest(`http://localhost/api/admin/kontakt/${id}/not-spam`, { method: "POST", headers }), {
    params: Promise.resolve({ id }),
  });
}

describe("POST /api/admin/kontakt/[id]/not-spam", () => {
  it("rejects a request without a session before touching the database or sending anything", async () => {
    const response = await post(ID, false);

    expect(response.status).toBe(401);
    expect(clearContactMessageSpam).not.toHaveBeenCalled();
    expect(dispatchContactNotification).not.toHaveBeenCalled();
  });

  it("rejects an id that isn't a uuid", async () => {
    const response = await post("not-a-uuid");

    expect(response.status).toBe(400);
    expect(clearContactMessageSpam).not.toHaveBeenCalled();
  });

  it("releases the message, forwards it to the inbox, and marks it mailed", async () => {
    clearContactMessageSpam.mockResolvedValue(RELEASED);
    dispatchContactNotification.mockResolvedValue(undefined);

    const response = await post(ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(clearContactMessageSpam).toHaveBeenCalledWith(ID);
    expect(dispatchContactNotification).toHaveBeenCalledWith(RELEASED);
    expect(markContactMessageMailed).toHaveBeenCalledWith(ID);
  });

  it("answers 404 and forwards nothing when the message is not flagged, so a double click can't mail twice", async () => {
    clearContactMessageSpam.mockResolvedValue(null);

    const response = await post(ID);

    expect(response.status).toBe(404);
    expect(dispatchContactNotification).not.toHaveBeenCalled();
    expect(markContactMessageMailed).not.toHaveBeenCalled();
  });

  it("reports a failed forward as 502, records it on the row, and leaves the message released", async () => {
    clearContactMessageSpam.mockResolvedValue(RELEASED);
    dispatchContactNotification.mockRejectedValue(new Error("Resend is down"));
    markContactMessageMailFailed.mockResolvedValue(undefined);

    const response = await post(ID);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "released_mail_failed", message: "Resend is down" });
    expect(markContactMessageMailFailed).toHaveBeenCalledWith(ID, "Resend is down");
    expect(markContactMessageMailed).not.toHaveBeenCalled();
  });

  it("still reports the failed forward when recording it on the row fails too", async () => {
    clearContactMessageSpam.mockResolvedValue(RELEASED);
    dispatchContactNotification.mockRejectedValue(new Error("Resend is down"));
    markContactMessageMailFailed.mockRejectedValue(new Error("connection reset"));

    const response = await post(ID);

    expect(response.status).toBe(502);
  });

  it("answers 500 when the database write fails, without sending anything", async () => {
    clearContactMessageSpam.mockRejectedValue(new Error("connection reset"));

    const response = await post(ID);

    expect(response.status).toBe(500);
    expect(dispatchContactNotification).not.toHaveBeenCalled();
  });
});
