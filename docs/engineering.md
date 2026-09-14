# Engineering reference

Forms, data, privacy, performance, SEO, and testing detail.

## Application form (`/mitmachen`)

1. Validate with the shared Zod schema, client and server.
2. **Write to Postgres first**, before anything else in the request.
3. Render a formatted PDF with `@react-pdf/renderer`.
4. Email it via Resend to `info@unimannheim.enactus.team`.
5. If the mail fails, the application is already persisted — log the error and
   still report success to the applicant, because their data is safe.
6. Honeypot field plus a submission timing check, enforced server-side
   against a signed token (`GET /api/bewerbung/token`, `lib/formToken.ts`) —
   not a client-supplied timestamp, which a script could set to anything.
   No CAPTCHA: it is an accessibility and privacy problem.
7. The CV upload goes directly from the browser to Vercel Blob
   (`upload()` from `@vercel/blob/client`, store `enactus-bewerbungen`,
   region `fra1`, access private) — never through this server. The token
   route (`/api/bewerbung/cv-upload`) only issues the short-lived upload
   token, gated by the same signed form-token as the timing check above
   plus its own rate limit (`lib/rateLimit.ts`'s `bewerbung-cv` bucket).
   Only `application/pdf`, capped at 4 MB. Up to three prioritized
   Wunschbereich choices, each with its own required reason
   (`application_area_choices`, migration `0017`), replace the old
   checkbox list — validated for gaps and duplicates by one refinement
   shared between the client resolver and the API request schema
   (`lib/applicationFormSchema.ts`'s `refineApplicationForm`).
8. The route rejects with 409 when no recruiting window is currently open —
   the form only renders while one is, but the route itself is public and
   reachable regardless of what a page already open in some tab still shows.
9. **Ressorts** are a separate, optional, unranked category from the
   Wunschbereich choices above — up to `MAX_DEPARTMENTS` (currently 3,
   `lib/applicationFormSchema.ts`) checkboxes with no priority and no
   reason, added because positions like Team-Lead sat in the same
   prioritized list as real project areas and let an applicant spend all
   three priorities on positions, landing in no project. Same
   admin-managed, label-snapshot pattern as Wunschbereich (own table,
   `departments`, migration `0020`; own admin page, `/admin/ressorts`;
   `applications.departments` stores the chosen labels directly, never a
   foreign key, so renaming or deactivating a Ressort can't change a
   historic application). Shown as their own block — never merged into the
   Wunschbereich cell or Fact — in the admin table, the CSV export, and the
   application PDF.
10. Two free-text fields were widened at the board's request, each via one
    exported constant read by the Zod schema, the field's own `maxLength`,
    and the hint/error copy's `{max}` placeholder, so the number exists
    once: **Motivation** 1500 → `MOTIVATION_MAX` (2000), which also gained
    a live character counter and a visible "your pasted text was cut"
    notice it never had before — a paste over the new cap used to have
    nowhere to go but a length limit it now hits silently unless told
    about it (`Field.tsx`'s `truncatedMessage`). **"Was möchtest du
    mitnehmen"** 400 → `WANT_TO_GAIN_MAX` (800), already had a counter.
11. The board notification carries the uploaded CV as a **second, separate
   attachment** (`lebenslauf-<id>.pdf`) alongside the existing application
   PDF (`bewerbung-<id>.pdf`) — never merged into the PDF itself
   (`lib/mailDispatch.ts`'s `dispatchApplicationMails`, `lib/cvBlob.ts`'s
   `fetchCvBlobBuffer`). Fetching the CV is best-effort and cannot fail the
   send: if the blob is unreachable (already deleted past `retain_until`, or
   a transient Vercel Blob error), the mail still goes out with the PDF
   alone and a note that the CV remains available under
   `/admin/bewerbungen`. The rendered PDF is a few tens of KB and the CV is
   capped at 4 MB (`CV_MAX_SIZE_BYTES`); Base64 inflates that by roughly a
   third, well under Resend's 40 MB per-email limit even with both
   attachments present.

   **This mailbox copy sits outside the deletion concept.** `retain_until`
   deletes the Vercel Blob object and the `applications` row — it does not,
   and cannot, reach into `RESEND_REPLY_TO_EMAIL`'s inbox. The notification
   mail's own text says so and asks the board to delete the attachment from
   the mailbox by hand once the retention period has passed;
   `src/content/privacy.ts`'s CV section and `Datenschutz.email.body.0`/
   `.application.access` describe the same fact to visitors.

12. **Interview-availability preferences**, not a booking system: an
    optional, unranked checkbox set of time slots (`interviewSlots`,
    `lib/interviewSlots.ts`), grouped by day in the UI
    (`InterviewAvailabilityField.tsx`, one `CheckboxGroup` per day). No cap
    — unlike Ressorts, several interviews run in parallel, so checking every
    offered slot is a genuinely useful answer. The days, the daily time
    range, and the slot length all live on `recruiting_windows` (migration
    `0023`), board-managed at `/admin/bewerbungsfenster` — never hardcoded,
    so a new semester needs no deploy. `/api/bewerbung`, not the client,
    decides NULL vs `[]` on the stored `applications.interview_slots`
    column: NULL means the window had no interview grid configured at
    submission time, `[]` means slots were offered and none were chosen —
    the same distinction `departments` already draws, for the same reason.
    The board's own overview lives at `/admin/gespraechsplanung`: a
    Bewerber-by-Zeitfenster matrix with a totals row, a CSV export, and
    columns for a value an applicant chose under a configuration the board
    has since changed (marked, not dropped).

**Hochgeladene PDFs werden nicht auf Schadsoftware geprüft.** Es läuft kein
Virenscanner über den Store, und der Vorstand öffnet die Dateien. Das ist ein
bewusst akzeptiertes Restrisiko: ein Scanner wäre ein weiterer
Auftragsverarbeiter für genau die sensibelste Datenkategorie dieser Seite.
Was stattdessen greift: nur `application/pdf` wird angenommen, die ersten
Bytes werden serverseitig gegen `%PDF-` geprüft (`lib/cvBlob.ts`'s
`hasPdfMagicBytes`, in `onUploadCompleted` und noch einmal in
`/api/bewerbung` — die zweite Prüfung ist die, die überall läuft,
`onUploadCompleted` feuert nie gegen `localhost`), die Datei ist auf 4 MB
begrenzt, der Store ist privat, und die Auslieferung erfolgt ausschließlich
als `Content-Disposition: attachment` mit `X-Content-Type-Options: nosniff`
— nie gerendert, immer heruntergeladen. Der Vorstand sollte
Bewerbungs-PDFs im Browser-Viewer öffnen, nicht in einem Desktop-Reader mit
aktiviertem JavaScript.

CV retention is a fixed deadline on the row itself
(`applications.retain_until`, migration `0016`), computed once at insert
time from whichever recruiting window is open then — never recomputed, so
it can't silently freeze the way an earlier, live-recomputed version did
(see `lib/retentionCutoff.ts`'s own comment). The cleanup cron's `cv-blobs`
pass deletes the blob for every application the retention pass removes,
then sweeps Vercel Blob for orphaned uploads (a CV whose upload succeeded
but whose form was never submitted) older than 24 hours — batched and
skipped outright, recorded as a skip rather than a failure, if the shared
cron time budget is already spent.

Open/closed state comes from the `recruiting_windows` table (see
`docs/content-guide.md`), read through a short-lived cache
(`lib/recruitingWindows.ts`) so the page stays static rather than querying
Neon on every visit. Closed → countdown plus reminder signup. Open → the
form.

## Ideathon signup form (`/ideathon`)

A second, independent form using the exact same plumbing as `/mitmachen`'s
application form (shared Zod schema, honeypot, signed timing token, rate
limit, DB-before-mail, `mail_status` trio) but its own table
(`ideathon_signups`, migration `0014`), route (`/api/ideathon`), and
dispatch functions — the two forms are deliberately not variants of one
another and can change independently.

1. The route rejects with 409 when no upcoming `calendar_events` row has its
   "Interner Link" field pointed at `/ideathon` (`lib/ideathonEvent.ts`) —
   the same row the page's own countdown and facts read from, so both can
   never disagree about whether signup is still open.
2. No PDF: the board notification is a plain-text email to
   `APPLICATION_RECIPIENT_EMAIL`, the same recipient the membership
   application uses.
3. The countdown (`IdeathonCountdown.tsx`) shows whole days only when the
   matched row has no `start_time`, and the full days/hours/minutes/seconds
   ticker once one is set — never more precision than the board has actually
   entered.
4. `idea_description` is capped at 1000 characters, in the Zod schema and
   again as a DB `check` constraint: the field can hold a visitor's
   unpublished business idea over a public form and mail pipeline.
5. Retention is 6 months from each row's own `created_at` (same rolling-window
   shape as `applications`), enforced by the same daily `/api/cron/cleanup`
   route as everything else in `content/retention.ts`.
6. `/admin/ideathon-anmeldungen` can delete a single signup, same pattern as
   `/admin/bewerbungen` and `/admin/erinnerungen` (2026-08-30).

Migration `0015_ideathon_signup_fields.sql` (`university` dropped,
`team_members`/`motivation_experience`/`dietary_preference` added) shipped
2026-08-26 but wasn't applied to production until 2026-08-30 — the code and
the schema drifted apart for four days, breaking the admin view and every
new signup silently (the insert failed, the visitor saw a real error, but
nobody who could fix it ever found out). `npm run db:verify` now includes a
check that every file in `migrations/` has a matching row in
`schema_migrations`, and `/admin/system` shows the same comparison as a
live status indicator (`lib/migrations.ts`'s `LATEST_MIGRATION`,
`lib/serviceHealth.ts`'s `checkMigrations`) — both catch this exact failure
mode directly rather than waiting for one of its symptoms. A failed insert
on `/api/bewerbung` or `/api/ideathon` also now emails
`APPLICATION_RECIPIENT_EMAIL` a rate-limited alert
(`lib/insertFailureAlert.ts`), so the board hears about a broken form even
if nobody happens to be looking at `/admin/system`.

## Application-start notification ("reminder list" in code and routes)

User-facing copy calls this the "Benachrichtigung zum Bewerbungsstart" /
"application-start notification" (sharpened from the generic "reminder"
wording, 2026-08-30) — but the code, the table (`reminder_signups`), the
routes (`/api/reminder/*`), and the status page (`/erinnerung-status`) all
keep their original names, deliberately: renaming those would break the
confirm and unsubscribe links already sitting in mail inboxes.

Notifying people when applications open is marketing email under German law and
requires **double opt-in**. This is also explicitly on the Enactus Germany data
protection checklist.

1. Submission writes a row with `confirmed: false` and a random token. The
   email is trimmed and lowercased before the uniqueness check
   (`lib/reminderSignupSchema.ts`) — `reminder_signups.email` has a unique
   constraint on the raw column, so without normalizing, two different
   capitalizations of the same address used to create two rows.
2. Confirmation email links to `/api/reminder/bestaetigen?token=...`.
3. Only confirmed rows are ever mailed the "window just opened" notice. An
   address that submits again after already confirming gets a distinct
   "you're already registered" mail instead (`dispatchReminderAlreadyRegistered`,
   added 2026-08-30) — the UI's own response stays the same neutral success
   either way, so this can't be used to probe who's signed up.
4. Store confirmation timestamp and IP as proof of consent.
5. Every mail carries a working one-click unsubscribe.
6. Whether a mail actually went out is recorded on the row (`mail_status`,
   `mail_error`), same as the other forms — otherwise a subscriber whose
   link never arrived is indistinguishable from one who chose not to click.
   `/admin/mails` lists the failures and can resend either mail, depending
   on whether the row has since confirmed.
7. Both the confirm and unsubscribe links land on `/erinnerung-status`, a
   real confirmation page with five states (confirmed, already confirmed,
   unsubscribed, invalid/expired, rate-limited) — noindex and excluded from
   the sitemap, same as `/secret`. The rate-limited state is its own,
   distinct from invalid (added 2026-08-30): a request arriving while its
   route's own rate limit was exceeded redirected to "invalid" before,
   telling a visitor with a perfectly working link that it was broken — a
   real scenario when many applicants share one Uni-WLAN egress IP.
8. Rate-limited per IP (`lib/rateLimit.ts`'s per-route ceilings) **and** per
   address (`reminder-address` bucket, keyed on the normalized email) — the
   per-IP limit alone doesn't stop a flood of requests naming the same
   victim address from many different IPs.

`/admin/erinnerungen` shows the list with confirmed, unconfirmed, and
unsubscribed counted separately; only the confirmed figure is the number of
people who may be mailed. Its CSV export deliberately carries no tokens. A
board member can delete a single entry directly from this page.

## Data protection

- All regions EU: Vercel `fra1` (also where uploaded CVs live, in the private
  Vercel Blob store `enactus-bewerbungen`), Neon `eu-central-1`, Resend EU.
- Collect the minimum. A field not used in selection does not belong on the form.
- Data processing agreements required with Vercel, Neon, and Resend. Track their
  status in `ASSETS-TODO.md`.
- Access and erasure requests (GDPR Art. 15 and 17) are served by
  `/admin/loeschanfragen`: search one address across all three tables, see
  every stored field, delete after confirming the address twice — this also
  best-effort deletes that person's CV blob, synchronously, rather than
  waiting for the cleanup cron's next run.
- Enactus Germany provides a data protection officer who advises student teams
  free of charge. The privacy policy draft goes to him before launch, clearly
  marked as a draft until then.
- Analytics is cookieless, so the site carries no consent banner. Adding any
  cookie-setting service would change that — ask first.

## Performance

**Budget:** LCP under 2.0s on throttled 4G, CLS under 0.05, initial JS under
150kB gzipped. Verify against `next build` output before calling a page done.

- `next/image` everywhere with explicit dimensions. `priority` only on the hero.
- Hero video: `muted playsinline preload="metadata"` with a poster frame, static
  image fallback on mobile.
- Route-level code splitting; no barrel imports that pull in unused components.

## Caching

Every public read that hits Neon goes through `unstable_cache` (`src/lib/
jobPostings.ts`, `projectAreas.ts`, `departments.ts`, `recruitingWindows.ts`,
`calendarEvents.ts`), tagged so an admin mutation can invalidate it
immediately via `revalidateTag(TAG, { expire: 0 })`.

**The `revalidate` option is not a property of the data — it's a property of
the largest segment that reads it.** `unstable_cache`'s `revalidate` value
propagates up to the ISR interval of whichever page or layout calls the
loader; a numeric value there doesn't just bound one page, it becomes the
regeneration interval for every segment along the way. `getJobPostings()` is
read once, in `(site)/layout.tsx`, so it's read by *every* page under it —
`revalidate: 3600` on that loader alone turned every static page on the site
(Impressum, Partner, every project page, …) into an hourly rewrite instead
of leaving them static. That's what exhausted the Vercel Hobby ISR-write
quota (200k/month) on a low-traffic site.

The rule this project follows now:

| Situation | `revalidate` |
|---|---|
| Data only changes via an admin mutation, no time-based reason to expire | `false` — the tag is the only invalidation path |
| Data is itself date-driven (a recruiting window opening/closing, a `Date.now()` frozen into the prerender at build time) without a corresponding mutation to hang a tag on | a number, sized to how stale that's acceptable |

Concretely: `jobPostings.ts`, `projectAreas.ts`, and `departments.ts` are
`revalidate: false` — read only from `(site)/layout.tsx` and `/mitmachen`,
with a tag covering every write. `recruitingWindows.ts` and
`calendarEvents.ts` keep `revalidate: 3600`, deliberately — a recruiting
window's open/closed state and `calendarEvents.ts`'s `getServerNowMs()` both
change with the clock, not with an admin action.

`tests/unit/lib/cacheBlastRadius.test.ts` encodes this table as an executable
test: it inspects the actual `unstable_cache` options each loader is wrapped
with, so a numeric `revalidate` added back to a site-wide loader fails there,
not as an ISR-writes spike weeks later. Before giving any loader read from a
shared layout a numeric `revalidate`, check what else lives under that
segment — a value that looks harmless for one page may not be.

The `/[locale]/(site)/[...rest]` and `/[locale]/admin/[...rest]` catch-all
pages are `force-dynamic` for a related reason: without it, every guessed
path a scanner or a stale bookmark hits gets written into the full route
cache on first render, since a 404 page with no `generateStaticParams`
otherwise still gets cached like any other dynamic-params page. An unbounded
number of guessed paths is an unbounded number of ISR writes; a 404 costs
nothing to regenerate per request instead.

## SEO

- `generateMetadata` per route and locale, with OG images, a real
  per-page/per-locale description, and a canonical URL — all three via the
  shared `pageAlternates()` helper (`src/lib/seo.ts`) plus each page's own
  `Seo.<key>` message, so a route can't end up with a canonical or hreflang
  pair that doesn't match what it actually renders.
- `hreflang` alternates between locales, reciprocal in both directions plus
  `x-default` pointing at German (`pageAlternates()` again).
- Organization structured data (JSON-LD, `components/OrganizationJsonLd.tsx`)
  on the homepage only, sourced entirely from `content/org.ts` /
  `content/navigation.ts` — never a fact invented for the schema alone.
- **301 redirects from the old Webflow URLs** in `next.config.ts`: `/team`
  (→ `/`, since there's no dedicated team route on this site — the Vorstand
  only appears on the homepage), `/faq`, and the individual project pages.
  Losing these throws away years of ranking. `/innolab` was on this list
  too (→ `/prozess`, from when the old site folded its InnoLab content into
  the process timeline) until /innolab became a real page again — removed
  rather than left in place, since a redirect whose source is a route this
  app actually serves is a loop Next.js rejects outright.
- `sitemap.ts` and `robots.ts` generated from the route tree.
- **Only the confirmed production domain gets indexed.** `robots.ts` checks
  the request's Host header and `VERCEL_ENV` (via
  `lib/productionDeployment.ts`) and disallows everything unless both the
  environment is `production` *and* the host is `enactus-mannheim.com` or
  `www.enactus-mannheim.com` — this catches Vercel preview builds, the
  auto-generated `*.vercel.app` alias, and local development alike.
  `proxy.ts` backs this up with an `X-Robots-Tag: noindex` response header
  in the same non-production cases, since a URL that's `disallow`ed in
  `robots.txt` can still appear in search results (without a snippet) if
  something else links to it. Both checks run server-side, where Vercel
  populates `VERCEL_ENV` automatically — no project setting to remember to
  turn on, unlike the `NEXT_PUBLIC_` variant.

## i18n

German is the default locale with **no** URL prefix. Existing rankings sit on
German URLs and must not break. English lives at `/en`.

No German string literals inside components — everything through `next-intl`.
Build German first; English is a dedicated final pass. Until then `en.json` may
mirror German values, but every fallback is logged in `ASSETS-TODO.md`.

Honest content requirement: club and project work happen in German. The English
FAQ and application page must say so plainly rather than hide it.

## Testing

### What each layer covers

**Unit (Vitest).** Zod content schemas — a malformed `projects.ts` must fail
loudly. Form validation rules. PDF data mapping. Token generation and expiry for
double opt-in.

**Component (Testing Library).** Every `ui/` primitive in all states. Query by
role and accessible name, never by test id or class. Assert keyboard behaviour:
Enter and Space on buttons, Escape closing dialogs, focus trapped in the mobile
menu and returned on close.

**Integration (Vitest, mocked Resend and Neon).** API routes. The load-bearing
test: *an application is persisted even when the mail provider throws.* Also:
double opt-in cannot be bypassed, an unconfirmed row is never mailed, rate
limiting rejects a flood.

**E2E (Playwright).** Application submission end to end. Locale switch preserving
the current route. Mobile navigation open, navigate, close. Full keyboard
traversal of the homepage without a mouse.

**Accessibility.** `axe-core` assertions in component tests and on every page in
e2e. Zero violations is the passing bar.

### Conventions

- `tests/unit`, `tests/integration`, `tests/e2e`.
- Test names read as sentences: `persists the application when email delivery fails`.
- No snapshot tests of rendered markup — they break on every refactor and assert
  nothing meaningful.
- Fixtures live in `tests/fixtures`, never inline in a dozen files.

### CI

GitHub Actions on every push: typecheck → lint → unit → integration → build →
e2e. Red build does not merge. Keep the whole run under five minutes; if it grows
past that, parallelise rather than cutting coverage.

The very first step, before any of that, rejects the push outright if any
commit it introduces carries an attribution trailer or footer this project's
"No AI traces" rule (see CLAUDE.md's Non-negotiables) forbids. This is the
second of two layers — see below.

### Commit-message safeguard

The commit-message rule in CLAUDE.md's Non-negotiables is enforced by two
independent, redundant checks, because the rule alone was violated once
despite being written down:

1. **`.githooks/commit-msg`**, a tracked hook, rejects the commit locally
   before it's ever made. Not active by default — hooks aren't versioned by
   git itself, only their *contents* are — so it needs one command per
   clone:

   ```
   git config core.hooksPath .githooks
   ```

   Cheap, immediate, but skippable (a fresh clone that hasn't run the
   command above, or a commit made with `--no-verify`).

2. **A CI step** (`.github/workflows/ci.yml`, first step in the job) walks
   every commit the push introduced (`git log
   github.event.before..github.event.after`) and fails the run if any
   commit message matches. This is the layer that actually holds — it runs
   regardless of local configuration and can't be bypassed by a commit flag.

Both read the same pattern list, kept in sync by hand (there's no file a
POSIX shell script and a GitHub Actions step can both source):

- the `Co-Authored-By:` trailer, outright, regardless of what name or email
  is on it
- `Anthropic`, `Copilot`, `ChatGPT`, `noreply@anthropic.com`
- `Claude` directly adjacent to a model qualifier — `Claude Code`, `Claude
  Opus`, `Claude Sonnet`, `Claude Haiku`
- a `Generated with` / `Generated by` footer, and the 🤖 emoji

Deliberately **not** a bare-word ban on "Claude" or "AI": `CLAUDE.md` is
this repo's own governing file and gets named in commit messages constantly,
and "Claude" is also a legitimate on-site content reference (a tool-orbit
logo, alongside Notion and Canva). A substring match on the bare word would
reject both of those. The patterns above target the shapes an actual
attribution trailer or footer takes instead — check
`.githooks/commit-msg`'s own comment before tightening this list.
