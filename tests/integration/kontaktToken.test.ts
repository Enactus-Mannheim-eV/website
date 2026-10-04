// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const checkRateLimit = vi.fn();
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
}));

const ORIGINAL_SECRET = process.env.FORM_TOKEN_SECRET;

function request() {
  return new NextRequest("http://localhost/api/kontakt/token");
}

beforeEach(() => {
  process.env.FORM_TOKEN_SECRET = "a-form-token-signing-secret";
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 59 });
});

afterEach(() => {
  vi.resetAllMocks();
  if (ORIGINAL_SECRET === undefined) delete process.env.FORM_TOKEN_SECRET;
  else process.env.FORM_TOKEN_SECRET = ORIGINAL_SECRET;
});

describe("GET /api/kontakt/token", () => {
  it("issues a signed token", async () => {
    const { GET } = await import("@/app/api/kontakt/token/route");
    const response = await GET(request());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.token).toMatch(/^\d+\.[0-9a-f]+$/);
  });

  it("returns a server error when FORM_TOKEN_SECRET is unset", async () => {
    delete process.env.FORM_TOKEN_SECRET;
    const { GET } = await import("@/app/api/kontakt/token/route");
    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "server_error" });
  });

  it("rejects a request over the limit without issuing a token", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const { GET } = await import("@/app/api/kontakt/token/route");
    const response = await GET(request());

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
  });

  it("counts against its own kontakt-token bucket, not the one for sending messages", async () => {
    const { GET } = await import("@/app/api/kontakt/token/route");
    await GET(request());

    expect(checkRateLimit).toHaveBeenCalledWith("kontakt-token", expect.any(String));
  });
});
