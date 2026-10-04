import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthenticatedRequest } from "@/lib/adminSession";
import { clearContactMessageSpam, markContactMessageMailed, markContactMessageMailFailed } from "@/lib/db";
import { dispatchContactNotification } from "@/lib/mailDispatch";

// See the recruiting-windows/calendar-events routes' own comment on
// z.guid() vs z.uuid(): the stricter one requires RFC 9562 version/variant
// bits the Postgres uuid column doesn't guarantee.
const idSchema = z.guid();

type RouteContext = { params: Promise<{ id: string }> };

/**
 * "Kein Spam" on /admin/kontakt: un-flags a held-back message and forwards
 * it to the board's inbox right away. The inbox is the only place the
 * message text ever appears (the admin list deliberately doesn't show it),
 * so releasing without forwarding would make the message disappear for good.
 *
 * Un-flagging comes first and is committed on its own: if the forward then
 * fails, the message is no longer hidden as spam, it is a normal failed
 * mail the board finds under /admin/mails and can resend. The response says
 * so with a 502, because whoever pressed the button is owed the truth about
 * whether the mail went out (same stance as /api/admin/mails/resend).
 *
 * A second request for the same id finds nothing flagged and gets a 404, so
 * a double click can't forward the message twice.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!isAuthenticatedRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { id: rawId } = await params;
  const id = idSchema.safeParse(rawId);
  if (!id.success) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  let message;
  try {
    message = await clearContactMessageSpam(id.data);
  } catch (error) {
    console.error("Failed to release contact message from spam", error);
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
  if (!message) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  try {
    await dispatchContactNotification(message);
    await markContactMessageMailed(message.id);
  } catch (error) {
    console.error("Failed to forward a released contact message", error);
    const detail = error instanceof Error ? error.message : String(error);
    await markContactMessageMailFailed(message.id, detail).catch((markError: unknown) => {
      console.error("Failed to record the mail failure itself", markError);
    });
    return NextResponse.json({ ok: false, error: "released_mail_failed", message: detail }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
