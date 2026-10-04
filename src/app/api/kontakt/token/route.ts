import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createFormToken } from "@/lib/formToken";
import { checkRateLimit } from "@/lib/rateLimit";
import { clientIp } from "@/lib/requestIp";

/**
 * Issues the signed timing token ContactForm.tsx fetches on mount and sends
 * back with the message (same mechanism as /api/bewerbung/token, see
 * lib/formToken.ts). Unlike the application forms, a failure here is not
 * fatal for the visitor: the form submits without a token and the server
 * holds that message back as suspected spam instead of losing it.
 */
export async function GET(request: NextRequest) {
  const rateLimit = await checkRateLimit("kontakt-token", clientIp(request));
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const token = createFormToken();
  if (!token) {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  return NextResponse.json({ token });
}
