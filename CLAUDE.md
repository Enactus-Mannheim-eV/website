# Enactus Mannheim e.V. — Website

Public website for a student initiative at the University of Mannheim that builds
social startups along the UN SDGs and spins them out as real companies.

**Audience, in priority order:** prospective student members, corporate partners,
the Enactus network.

**The job of this site:** make a student think "I want in," and make a partner
think "these people ship."

## Reference docs

Read the relevant file before working in that area. Do not guess.

- `docs/architecture.md` — stack, folder map, request flow, where to look next
- `docs/content-guide.md` — task-oriented: swap a photo, add a project, translate a string
- `docs/design-system.md` — tokens, typography, motion, the signature element
- `docs/engineering.md` — forms, database, privacy, SEO, testing detail
- `docs/deployment.md` — environment variables, hosting, cron, mail
- `ASSETS-TODO.md` — every missing asset and unverified fact

## Non-negotiables

**No AI traces.** Never add `Co-Authored-By`, tool attribution, or "generated"
notes to commits, PRs, or files. Never write a comment referencing an AI, a
prompt, or your own reasoning. Commit messages describe the change and nothing
else, in Conventional Commits format.

This rule was violated once by the exact tool this file is instructing, which
is why it is no longer enforced by this file alone: `.githooks/commit-msg` (a
tracked hook, see its own comment for enabling it — `git config
core.hooksPath .githooks`) rejects such a commit locally, and a CI step in
`.github/workflows/ci.yml` re-checks every commit a push introduces and fails
the run if any of them match, regardless of local setup. Full reasoning and
the exact pattern list: `docs/engineering.md`, "Commit-message safeguard".

**English in code, German and English in the UI.** All identifiers, comments, and
commit messages are English. User-facing strings live in `messages/`.

**Comments explain why, not what.** If a line needs a comment to say what it does,
rewrite the line.

**Never invent facts.** Missing name, number, date, or URL → use the `Placeholder`
component, add a row to `ASSETS-TODO.md`, and move on. Fabricated statistics on a
nonprofit's site are a real reputational risk.

**Quality floor, never announced.** Responsive to 360px, visible keyboard focus,
correct semantics, `prefers-reduced-motion` respected. Baseline, not an achievement.

**Ask when ambiguous.** Do not pick an interpretation and build a page on it.

**Push after every commit.** Unpushed work has been left behind twice already in
this project.

**Done means the CI run is green.** A task is finished when the GitHub Actions
run for the *pushed commit* has concluded successfully — not when it was green
locally. Local means Windows and Chromium; CI means Linux and additionally
WebKit, and that difference has produced a red build twice. Before reporting a
task complete, fetch the real run status for that exact commit SHA and state it
in the report. If the run is red or still in progress, say so rather than
reporting "green".

```
curl -s "https://api.github.com/repos/MilanKoncz/enactusWebsite/actions/runs?per_page=5"
```

`gh` is not installed here; the REST API works unauthenticated for run status.
Job logs need auth — reuse the stored git credential rather than asking for a
token:

```
GH_PW=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
curl -sL -H "Authorization: Bearer $GH_PW" ".../actions/jobs/<job-id>/logs"
```

Two traps this project has already hit, worth checking before pushing:
- **`next build` must never require a database.** `docs/deployment.md` promises
  it, and CI has no `DATABASE_URL`. Verify by actually removing it and building.
- **E2E needs a mockable seam for DB-backed state.** A value baked into a static
  page at build time cannot be mocked by Playwright; route it through an API
  endpoint `page.route()` can intercept, like every form on this site does.

**Ask in chat and wait.** On any real decision or ambiguity, ask directly in the
chat and wait for the answer — never guess, never work around it, never write a
`HANDOFF.md` instead. `HANDOFF.md` is only for explicitly unattended runs.

## Stack

Next.js 15+ App Router · React 19 · TypeScript strict · Tailwind CSS **v4** ·
next-intl · motion · lucide-react · react-hook-form + zod · Resend ·
@react-pdf/renderer · Neon Postgres · Radix primitives · Vitest + Testing Library ·
Playwright · Vercel (`fra1`) · Vercel Analytics

### Hard rules

- **Tailwind v4 only.** Tokens in `@theme` inside `src/app/globals.css`. No
  `tailwind.config.js`. No `theme.extend`.
- **No smooth-scroll libraries.** No Lenis, no scroll hijacking. Native scrolling.
  The competitor site lags because of this.
- **Fonts self-hosted** via `next/font`. Never reference `fonts.googleapis.com` —
  hotlinking Google Fonts is a ruled GDPR violation in Germany.
- **YouTube via `youtube-nocookie.com`, behind a click-to-load facade.** Eight
  autoloading embeds would cost megabytes and set cookies before consent.
- **No `localStorage`** for anything the user would mind losing. Server state goes
  to Postgres.
- **No new third-party scripts** without asking. Each one is a data processor we
  must document.
- **Radix primitives, not full shadcn/ui.** Its defaults are exactly the generic
  look this project is avoiding.

## Design in one paragraph

Light editorial body (`--color-paper`), punctuated by full-bleed dark sections
(`--color-ink`). Gold is the signature, used sparingly and precisely — never a
background wash, never a gradient blob, with two deliberate, named exceptions:
`.signature-gradient` (`globals.css`), a weighted navy-to-gold background
originally requested by the board for /events' Journeys section and
/projekte's active-projects section (2026-08-19) — real, unmixed tokens at
both ends, not a muted wash; a wide flat navy plateau carries the text and
gold only ramps in near the right edge — and, since 2026-08-25,
`.corner-glow` (`globals.css`), a soft radial gold glow over solid ink,
translated from the board's own idea.html draft, used on /ideathon's hero
and, replacing `.signature-gradient` there, /events' Journeys section.
Contained to these two named tokens, not a precedent for a third one without
the same kind of direct request. Lilita One for headlines only, Geist for
everything else, Geist Mono for eyebrows and figures. The recurring motif is
the **gate marker**: a thin vertical gold rule with a mono label, drawn from the
organisation's own stage-gate process. One motif, carried consistently.

**Text on gold is always `--color-ink`.** White on gold measures ~1.8:1 and fails
WCAG at every size. Full rules in `docs/design-system.md`.

**Hover enhances, hover never hides.** Content is readable without interaction.
Much of the traffic arrives from Instagram on mobile, where hover does not exist.
Two exceptions where expanding genuinely saves space: project cards and the
Ideation timeline.

## Architecture

```
src/
  proxy.ts                # next-intl middleware (Next 16 naming — not middleware.ts)
  i18n/                   # routing.ts, request.ts, requireLocale.ts
  app/[locale]/           # de has no prefix, en lives at /en — the only root layout,
                           # deliberately no src/app/layout.tsx (see its own comment)
  app/api/
  components/ui/          # Button, Card, Badge, Field, Placeholder, GateMarker
  components/layout/      # Header, Footer, Nav, MobileMenu, LocaleSwitch, SkipLink, Logo
  components/sections/    # one file per page section
  components/motion/      # Reveal, Parallax
  content/                # ALL copy and data, Zod-validated
  lib/
  messages/de.json, en.json
tests/                    # unit, integration, e2e
```

**All facts live in `src/content/*.ts`,** validated by Zod so a typo during a
board handover fails the build instead of breaking a page silently. Never hardcode
a project name, board member, or statistic inside a component. This boundary
exists so the data layer can later be swapped for a CMS without touching
components — keep it clean.

Project status vocabulary mirrors the Enactus Germany national database:
`active` · `spinoff` · `cancelled` · `paused`.

## Testing

Every feature ships with tests. Not optional, not a later phase.

- **Unit** (Vitest): Zod content schemas, form validation, PDF data mapping,
  double-opt-in token logic.
- **Component** (Testing Library): each `ui/` primitive in all states, including
  keyboard interaction and ARIA wiring.
- **Integration** (Vitest): API routes. The critical case is that an application
  is persisted to the database even when the mail provider fails.
- **E2E** (Playwright): application submission, locale switch, mobile navigation,
  full keyboard traversal.
- **Accessibility**: `axe-core` assertions in component and e2e tests.

Query by role and label, never by test id or class name — a test that survives a
refactor is worth ten that break on a class rename.

CI runs typecheck, lint, unit, and e2e on every push. A red build does not merge.

## Definition of done

- [ ] Renders at 360 / 768 / 1280 / 1920px
- [ ] Keyboard navigable, focus always visible
- [ ] Nothing important reachable only via hover
- [ ] Correct under `prefers-reduced-motion: reduce`
- [ ] `next build` clean: no type errors, no lint warnings
- [ ] Tests written and passing
- [ ] Copy from `messages/`, data from `content/`
- [ ] Placeholders logged in `ASSETS-TODO.md`
- [ ] No layout shift on load

## Working style

Small commits, one concern each. Build the shared primitive before the third
copy-paste. For anything touching more than two files, list the files and the
planned change before editing. When something in this file turns out to be wrong,
say so directly rather than working around it.
