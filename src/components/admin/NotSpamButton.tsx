"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";

type State = "idle" | "pending" | "error" | "mailFailed";

// The row is not removed optimistically: router.refresh() re-runs the page's
// query, so it leaves the spam tab because the database says it is no longer
// flagged. One exception on purpose: when the message was released but the
// forward failed, no refresh happens, so this notice stays on screen. A
// refresh would drop the row, and with it the only place that tells the
// board the mail did not go out.
export function NotSpamButton({ id }: { id: string }) {
  const t = useTranslations("Admin.contactMessages");
  const router = useRouter();
  const [state, setState] = useState<State>("idle");

  async function handleClick() {
    setState("pending");
    try {
      const response = await fetch(`/api/admin/kontakt/${id}/not-spam`, { method: "POST" });
      if (response.ok) {
        router.refresh();
        return;
      }

      const body: unknown = await response.json().catch(() => null);
      const code = body && typeof body === "object" && "error" in body ? body.error : null;

      // Already released from another tab or by a double click: the page is
      // simply out of date.
      if (code === "not_found") {
        router.refresh();
        return;
      }
      setState(code === "released_mail_failed" ? "mailFailed" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <Button variant="secondary" size="sm" loading={state === "pending"} onClick={handleClick}>
        {t("notSpam")}
      </Button>
      {state === "error" && (
        <span role="alert" className="text-body-s text-oxblood">
          {t("notSpamFailed")}
        </span>
      )}
      {state === "mailFailed" && (
        <span role="alert" className="text-body-s text-oxblood">
          {t("releasedMailFailed")}
        </span>
      )}
    </span>
  );
}
