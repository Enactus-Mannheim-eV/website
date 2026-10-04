import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { contactRequestSchema } from "@/lib/apiSchemas";
import { assessContactSubmission } from "@/lib/contactSpam";
import { insertContactMessage, markContactMessageMailed, markContactMessageMailFailed } from "@/lib/db";
import { dispatchContactNotification } from "@/lib/mailDispatch";
import { checkRateLimit } from "@/lib/rateLimit";
import { clientIp } from "@/lib/requestIp";

/**
 * Same ordering guarantee as /api/bewerbung: the message is written to
 * Postgres before any mail is attempted, and a failed forward to the
 * board's inbox doesn't lose it — it's logged and the sender still hears
 * back that their message went through, because it did.
 *
 * A message judged to be spam (honeypot, form token, content check — see
 * lib/contactSpam.ts) is stored the same way, flagged, and not mailed. The
 * response is identical to a normal success, so a bot can't tell it was
 * caught, and nothing a real visitor wrote is ever thrown away: the board
 * sees held-back messages on /admin/kontakt and can release one.
 */
export async function POST(request: NextRequest) {
  const rateLimit = await checkRateLimit("kontakt", clientIp(request));
  if (!rateLimit.allowed) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const parsed = contactRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  const data = parsed.data;
  const verdict = assessContactSubmission(data);

  let message;
  try {
    message = await insertContactMessage({
      name: data.name,
      email: data.email,
      subject: data.subject,
      message: data.message,
      locale: data.locale,
      spam: verdict.spam,
      spamReasons: verdict.reasons,
    });
  } catch (error) {
    console.error("Failed to persist contact message", error);
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }

  if (verdict.spam) {
    // Reason codes only, never anything the sender typed.
    console.info("Contact message held back as suspected spam", verdict.reasons);
    return NextResponse.json({ ok: true });
  }

  try {
    await dispatchContactNotification(message);
    await markContactMessageMailed(message.id);
  } catch (error) {
    console.error("Failed to forward contact message", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    await markContactMessageMailFailed(message.id, errorMessage).catch((markError) => {
      console.error("Failed to record the mail failure itself", markError);
    });
  }

  return NextResponse.json({ ok: true });
}
