import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireLocale, resolveLocale } from "@/i18n/requireLocale";
import { Container } from "@/components/ui/Container";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { AdminLogin } from "@/components/admin/AdminLogin";
import { AdminTable } from "@/components/admin/AdminTable";
import { NotSpamButton } from "@/components/admin/NotSpamButton";
import { MailStatusIndicator } from "@/components/admin/StatusIndicator";
import { isAdminAuthenticated } from "@/lib/adminSession";
import { CONTACT_SPAM_REASONS, type ContactSpamReason } from "@/lib/contactSpam";
import { cn } from "@/lib/cn";
import { countContactMessages, listContactMessages, type ContactMessageView } from "@/lib/db";
import { siteDateTimeFormatter } from "@/lib/formatSiteDateTime";
import { RawLink } from "@/lib/navigation";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ view?: string | string[] }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = resolveLocale(rawLocale);
  const t = await getTranslations({ locale, namespace: "Admin.contactMessages" });
  return { title: t("title"), robots: { index: false, follow: false } };
}

const VIEWS: readonly ContactMessageView[] = ["inbox", "spam"];

function parseView(raw: string | string[] | undefined): ContactMessageView {
  return raw === "spam" ? "spam" : "inbox";
}

function isKnownReason(code: string): code is ContactSpamReason {
  return (CONTACT_SPAM_REASONS as readonly string[]).includes(code);
}

// The inbox is read-only on purpose: the enquiry itself lives in the mailbox
// it was forwarded to, and this tab answers the question that mailbox can't,
// whether the forward actually happened. The message body is deliberately
// not selected (see listContactMessages). The spam tab is where a held-back
// message can be released: nothing was ever mailed for it, so "Kein Spam"
// forwards it at the same moment.
export default async function AdminContactMessagesPage({ params, searchParams }: PageProps) {
  await requireLocale(params);
  if (!(await isAdminAuthenticated())) return <AdminLogin />;

  const view = parseView((await searchParams).view);
  const t = await getTranslations("Admin");
  const [messages, counts] = await Promise.all([listContactMessages(view), countContactMessages()]);
  // Pinned to Europe/Berlin — a server component runs on Vercel's own UTC.
  const dateFormatter = siteDateTimeFormatter("de-DE", { dateStyle: "medium", timeStyle: "short" });

  const senderCell = (message: (typeof messages)[number]) => (
    <span key="sender" className="flex flex-col">
      <span>{message.name}</span>
      <span className="opacity-60">{message.email}</span>
    </span>
  );

  return (
    <Container className="flex max-w-4xl flex-col gap-8 py-16">
      <SectionHeading
        as="h1"
        eyebrow={t("eyebrow")}
        title={t("contactMessages.title")}
        lead={view === "spam" ? t("contactMessages.spamLead") : t("contactMessages.lead")}
      />

      <nav aria-label={t("contactMessages.tabsLabel")} className="flex gap-6 border-b border-ink/10">
        {VIEWS.map((tab) => (
          <RawLink
            key={tab}
            href={tab === "inbox" ? "/admin/kontakt" : `/admin/kontakt?view=${tab}`}
            aria-current={tab === view ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 pb-2 text-body-s transition-colors duration-[var(--duration-fast)] focus-visible:outline-2 focus-visible:outline-offset-2",
              tab === view ? "border-gold font-medium" : "border-transparent opacity-60 hover:opacity-100",
            )}
          >
            {t(`contactMessages.tabs.${tab}`, { count: counts[tab] })}
          </RawLink>
        ))}
      </nav>

      {view === "spam" ? (
        <AdminTable
          columns={[
            t("contactMessages.columns.createdAt"),
            t("contactMessages.columns.sender"),
            t("contactMessages.columns.subject"),
            t("contactMessages.columns.reasons"),
            t("contactMessages.columns.actions"),
          ]}
          empty={t("contactMessages.spamEmpty")}
          rows={messages.map((message) => ({
            key: message.id,
            cells: [
              dateFormatter.format(message.createdAt),
              senderCell(message),
              message.subject ?? "—",
              <ul key="reasons" className="flex flex-col gap-1">
                {message.spamReasons.map((code) => (
                  <li key={code}>{isKnownReason(code) ? t(`contactMessages.reasons.${code}`) : code}</li>
                ))}
              </ul>,
              <NotSpamButton key="actions" id={message.id} />,
            ],
          }))}
        />
      ) : (
        <AdminTable
          columns={[
            t("contactMessages.columns.createdAt"),
            t("contactMessages.columns.sender"),
            t("contactMessages.columns.subject"),
            t("contactMessages.columns.mailStatus"),
          ]}
          empty={t("contactMessages.empty")}
          rows={messages.map((message) => ({
            key: message.id,
            cells: [
              dateFormatter.format(message.createdAt),
              senderCell(message),
              message.subject ?? "—",
              <MailStatusIndicator
                key="mailStatus"
                status={message.mailStatus}
                label={t(`mailStatus.${message.mailStatus}`)}
              />,
            ],
          }))}
        />
      )}
    </Container>
  );
}
