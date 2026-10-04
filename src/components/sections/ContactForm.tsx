"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { FormStatusMessage } from "@/components/ui/FormStatusMessage";
import { ConfettiBurst } from "@/components/motion/ConfettiBurst";
import { FORM_TOKEN_REFRESH_AFTER_MS, remainingFillMs } from "@/lib/antiSpam";
import { contactFormSchema, type ContactFormValues } from "@/lib/contactFormSchema";
import { postJson } from "@/lib/submitForm";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { org } from "@/content/org";

type SubmitState = "idle" | "pending" | "success" | "error";

type IssuedToken = { token: string; receivedAt: number };

// Every field is validated for real via contactFormSchema, client-side, and
// the exact same schema is re-run server-side in /api/kontakt. On success
// the form resets and shows a plain confirmation; on failure it stays
// filled in and shows an error with a direct mailto fallback, so nothing
// typed is lost.
//
// Spam protection mirrors the application forms (signed timing token from
// GET /api/kontakt/token, hidden honeypot field) with one deliberate
// difference: a missing token never blocks the send. The message goes out
// anyway and the server holds it back as suspected spam, so a visitor whose
// token request failed loses nothing.
export function ContactForm() {
  const t = useTranslations("KontaktPage.form");
  const locale = useLocale();
  const reducedMotion = usePrefersReducedMotion();
  const [state, setState] = useState<SubmitState>("idle");
  const successRef = useRef<HTMLDivElement>(null);
  const [burst, setBurst] = useState<{ x: number; y: number } | null>(null);
  const honeypotRef = useRef<HTMLInputElement>(null);
  const issuedToken = useRef<IssuedToken | null>(null);
  const tokenRequest = useRef<Promise<void> | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
  });

  const requestToken = useCallback(() => {
    const request = fetch("/api/kontakt/token")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { token?: string } | null) => {
        issuedToken.current = body?.token ? { token: body.token, receivedAt: Date.now() } : null;
      })
      .catch(() => {
        issuedToken.current = null;
      });
    tokenRequest.current = request;
    return request;
  }, []);

  useEffect(() => {
    void requestToken();
  }, [requestToken]);

  // Resolves with a token the server will accept as "not too fast" and "not
  // expired", or null if none could be had. Waits out the minimum fill time
  // itself, so a quick or autofilled submit is simply a moment slower rather
  // than being held back as spam.
  async function tokenForSubmit(): Promise<string | null> {
    await tokenRequest.current;
    const current = issuedToken.current;
    if (!current || Date.now() - current.receivedAt > FORM_TOKEN_REFRESH_AFTER_MS) {
      await requestToken();
    }
    const fresh = issuedToken.current;
    if (!fresh) return null;

    const wait = remainingFillMs(fresh.receivedAt, Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return fresh.token;
  }

  async function onSubmit(data: ContactFormValues) {
    setState("pending");
    const formToken = await tokenForSubmit();
    const result = await postJson("/api/kontakt", {
      ...data,
      locale,
      formToken: formToken ?? undefined,
      website: honeypotRef.current?.value ?? "",
    });
    if (result.ok) {
      setState("success");
      reset();
    } else {
      setState("error");
    }
  }

  // Easter egg 4/7 (docs/eastereggs.md): the same confetti burst the hero
  // logo's triple-click uses (ConfettiBurst), reused rather than a second
  // effect — origin is the success message's own rendered position, read
  // right after it mounts. Only on a genuine successful submit — never on
  // error, never while pending, and never under reduced motion — and the
  // announced confirmation text (FormStatusMessage below) is unaffected
  // either way; the burst is purely decorative and aria-hidden.
  useEffect(() => {
    if (state !== "success" || reducedMotion) return;
    const rect = successRef.current?.getBoundingClientRect();
    if (rect) setBurst({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [state, reducedMotion]);

  const handleBurstDone = useCallback(() => setBurst(null), []);

  // Deferred into a handler rather than passing handleSubmit(onSubmit)
  // straight to the form, because onSubmit reads the clock; same
  // react-hooks/purity reasoning as ApplicationForm.tsx's own comment.
  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    void handleSubmit(onSubmit)(event);
  }

  if (state === "success") {
    return (
      <div ref={successRef}>
        <FormStatusMessage variant="success">{t("submitSuccess")}</FormStatusMessage>
        {burst && <ConfettiBurst originX={burst.x} originY={burst.y} onDone={handleBurstDone} />}
      </div>
    );
  }

  return (
    <form onSubmit={handleFormSubmit} noValidate className="flex flex-col gap-6">
      <input
        ref={honeypotRef}
        type="text"
        name="website"
        tabIndex={-1}
        aria-hidden="true"
        autoComplete="off"
        className="absolute -left-[9999px] h-0 w-0 opacity-0"
      />
      <Field
        label={t("nameLabel")}
        autoComplete="name"
        error={errors.name && t("nameError")}
        {...register("name")}
      />
      <Field
        label={t("emailLabel")}
        type="email"
        autoComplete="email"
        error={errors.email && t("emailError")}
        {...register("email")}
      />
      <Field
        label={t("subjectLabel")}
        error={errors.subject && t("subjectError")}
        {...register("subject")}
      />
      <Field
        as="textarea"
        label={t("messageLabel")}
        error={errors.message && t("messageError")}
        {...register("message")}
      />
      {state === "error" && (
        <FormStatusMessage variant="error">
          {t("submitError", { email: org.contactEmails.board })}
        </FormStatusMessage>
      )}
      <Button type="submit" className="self-start" loading={state === "pending"}>
        {state === "pending" ? t("submitPending") : t("submitLabel")}
      </Button>
    </form>
  );
}
