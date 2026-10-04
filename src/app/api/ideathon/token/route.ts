import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createFormToken } from "@/lib/formToken";
import { checkRateLimit } from "@/lib/rateLimit";
import { clientIp } from "@/lib/requestIp";

/**
 * Issues the signed timing token IdeathonSignupForm.tsx fetches once on
 * mount — same mechanism as /api/bewerbung/token (lib/formToken.ts is
 * route-agnostic, so this is a thin, form-specific issuing endpoint rather
 * than a second implementation).
 *
 * Rate-limited since 2026-10-04. It used to carry no limit, on the reasoning
 * that a token reveals nothing beyond "issued at time X". But tokens aren't
 * bound to a form, so one fetched here is just as good for /api/bewerbung
 * and its CV upload, which made this the unthrottled way around that
 * route's own token limit. Generous, same as the others: one call per page
 * load, and a campus WLAN can share one egress IP.
 */
export async function GET(request: NextRequest) {
  const rateLimit = await checkRateLimit("ideathon-token", clientIp(request));
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const token = createFormToken();
  if (!token) {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  return NextResponse.json({ token });
}
