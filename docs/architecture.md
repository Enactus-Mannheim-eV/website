# Architecture

Orientation for someone who has never opened this codebase. Read
`CLAUDE.md` first for the project's non-negotiables (no invented facts, no
AI traces in commits, the design system's rules) — this file is about how
the pieces fit together, not the rules for changing them.

For "how do I change fact X / photo Y" without touching code logic, see
`docs/content-guide.md` instead. For colors/type/motion, see
`docs/design-system.md`. For forms, the database, and privacy, see
`docs/engineering.md`. For environment variables and hosting, see
`docs/deployment.md`.

## Stack, in one line each

- **Next.js 15+ App Router, React 19, TypeScript strict.** Server components
  by default; `"use client"` only where interactivity needs it (forms,
  ticking countdowns, dialogs).
- **Tailwind CSS v4.** Tokens live in `@theme` inside `src/app/globals.css`
  — no `tailwind.config.js`.
- **next-intl.** German (no URL prefix) and English (`/en`). Every visible
  string goes through it — see "Copy vs. facts" below.
- **Neon Postgres**, via `@neondatabase/serverless`. `src/lib/db.ts` is the
  only file that writes SQL.
- **Resend** for outgoing mail (`src/lib/mail.ts`).
- **Radix UI primitives** (Dialog, Accordion, Tabs) — never full shadcn/ui.
- **motion** (Framer Motion) for the hero sequence and the handful of
  layout-animated lists (project cards). Everything else uses plain CSS
  transitions/scroll-driven animation.
- **Vitest** (unit + integration) and **Playwright** (e2e).

## Folder map

```
src/
  proxy.ts                # next-intl middleware (Next 16 naming, not middleware.ts)
  i18n/                    # routing.ts (locales), request.ts, requireLocale.ts
  app/
    [locale]/
      layout.tsx           # the ONE root layout — see its own comment on why
      (site)/              # every public page; adds Header/Footer chrome
      admin/                # board-only, password-gated, no Header/Footer
    api/                    # route handlers — bewerbung, kontakt, reminder, admin, cron
  content/                 # facts and structure, Zod-validated — see content-guide.md
  lib/                     # everything that isn't a component or a fact
  components/
    ui/                     # generic primitives: Button, Card, Field, Badge, Dialog wrappers
    layout/                 # Header, Footer, Nav, MobileMenu, LocaleSwitch
    sections/               # one file per page section — most of the actual UI lives here
    motion/                 # Reveal, Parallax, ProximityGroup, ThreadSegment
  messages/                # de.json, en.json — every UI string, see content-guide.md
migrations/                # numbered .sql files, applied by scripts/migrate.mjs
scripts/                   # db:migrate, db:verify, db:cleanup, mail:test, perf:home
tests/
  unit/, integration/       # Vitest — mirrors src/'s folder shape
  e2e/                      # Playwright, one file per route/flow
```

## Why `[locale]` has no `layout.tsx` at the app root

There is deliberately no `src/app/layout.tsx`. `src/app/[locale]/layout.tsx`
is the only root layout — it owns `<html>`/`<body>`, fonts, and the
`NextIntlClientProvider`. Every real page lives under `[locale]`, including
`admin`. **Never add a page directly under `src/app/` outside `[locale]`** —
Next's root-layout check would regenerate a bare `app/layout.tsx` to satisfy
itself, silently breaking this setup. If you need a new top-level section,
add it as a sibling of `(site)` and `admin` under `[locale]/`.

`(site)` is a route group, not a URL segment — it exists purely to attach
Header/Footer/SkipLink to every public page without repeating that in each
one. `admin` is a separate group precisely so it does *not* get that chrome.

## Copy vs. facts: `content/` vs `messages/`

This is the one boundary to internalize before changing anything:

- **`src/content/*.ts`** holds structure and facts that aren't prose: board
  roster, project list, KPIs, partner tiers, the calendar's category list.
  Every file is Zod-validated, so a typo during a board handover fails the
  build loudly instead of breaking a page silently. Data the board edits
  often — application windows, calendar events, job postings — has moved
  out of `content/` into the database instead, managed from the matching
  admin page rather than a code change; `docs/content-guide.md` says which
  is which per feature.
- **`src/messages/{de,en}.json`** holds every word a visitor reads:
  headlines, button labels, error messages, FAQ answers, even the bios and
  descriptions *for* the people/projects listed in `content/`.

A component usually reads both: `content/board.ts` says *who* the board
members are and in what order; `messages/de.json`'s `"Board.<slug>.bio"`
says what their bio *says*. This split exists so the data layer can move to
a CMS later without touching how components render — keep it that way; never
hardcode a name, statistic, or sentence directly inside a component.

Never invent a missing fact. A `Placeholder` (whole block, e.g. a missing
photo) or `PlaceholderMark` (inline, e.g. a missing sentence) renders
instead, and the gap gets a row in `ASSETS-TODO.md`. This is why several
pages currently show visible "missing" markers — that is working as
designed, not a bug to silently paper over.

## Request flow: the three forms

`/mitmachen` (application), `/kontakt` (contact), and the reminder sign-up
all follow the same shape, enforced by a shared Zod schema used on both the
client (`react-hook-form` + `zodResolver`) and the server (the API route):

1. Validate (honeypot + timing check for the application and Ideathon forms;
   the contact form adds a content check and holds a suspect message back
   instead of dropping it, see `docs/engineering.md` — no CAPTCHA).
2. **Write to Postgres first.** `src/lib/db.ts`'s `insert*` functions.
3. Only after that succeeds: render a PDF (application) or send mail
   (`src/lib/mail.ts`, via Resend).
4. If the mail step fails, the row already has `mail_status = 'failed'` and
   `mail_error` set — the visitor is still told it worked, because their
   data is safe. The board finds the failure by querying `mail_status`, not
   by a visitor complaint.

Full detail, including the double opt-in for the reminder list and rate
limiting, is in `docs/engineering.md`.

## The admin area

Twelve sections under `[locale]/admin` — applications, failed mails,
application windows, the Wunschbereich and Ressort lists, calendar events,
job postings, Ideathon signups, the reminder list, contact messages,
deletion requests, system status, plus an overview. Full list and what each
is for: `docs/deployment.md`'s "The admin area".

Gated by comparing a password (`ADMIN_PASSWORD`) against a signed, httpOnly
session cookie (`src/lib/adminAuth.ts`, signed with `ADMIN_SESSION_SECRET`)
— no user-account system. The gate is applied per page and per route via
`src/lib/adminSession.ts`, never only in the layout: a layout renders its
children regardless of what it returns, so the check has to sit ahead of
each page's own query. Excluded from `robots.ts` and `sitemap.ts`, with
`noindex` metadata besides, and `proxy.ts` 404s the `/en` variants.

`src/components/admin/` holds the pieces shared across sections
(`AdminNav`, `AdminTable`, `AdminLogin`, `StatusIndicator` for the
ok/warning/error/neutral color+icon+text vocabulary, and the client
components that perform mutations). `ADMIN_SECTIONS` in `adminSections.ts`
is the single list the nav and the overview both read — each entry also
carries its own lucide icon, so the two can't drift to different icons for
the same section.

## Testing layers

- **Unit** (`tests/unit`): content schemas (a malformed `content/*.ts` must
  fail loudly), pure functions in `lib/`, and component behavior via
  Testing Library — query by role/label, never by class or test id.
- **Integration** (`tests/integration`): API routes with a mocked
  DB/mail layer. The load-bearing case: an application is persisted even
  when the mail provider throws.
- **E2E** (`tests/e2e`): real browser flows against a real
  `next build && next start` — form submission, locale switch, mobile nav,
  keyboard traversal, redirects. `npm run test:e2e` builds and starts the
  server itself; it does not need a dev server already running.

`npm run check` runs typecheck + lint + the Vitest suite. CI additionally
runs `next build` and the full Playwright suite — a change isn't done until
both are green, not just `check`.

## Where to look next

- Swapping a photo, adding a board member, editing an FAQ answer, or any
  other content change with no logic involved → `docs/content-guide.md`.
- Colors, spacing, motion, the gate-marker motif → `docs/design-system.md`.
- Forms, the database schema, retention, SEO → `docs/engineering.md`.
- Environment variables, Vercel, cron, mail sending → `docs/deployment.md`.
- What's missing or unconfirmed right now → `ASSETS-TODO.md`.
