# Enactus Mannheim e.V. — Website

Public website for Enactus Mannheim e.V., a student initiative at the University
of Mannheim that builds social startups along the UN SDGs and spins them out as
real companies.

Read `CLAUDE.md` before working in this repository. It defines the
non-negotiables, the stack, and the architecture. Reference docs live in
`docs/design-system.md` and `docs/engineering.md`.

## Requirements

- Node.js 24.22.1 or newer, below 25 (see `.nvmrc`)
- npm
- A Neon Postgres connection string and a Resend API key for local form testing
  (see `.env.example`)

## Local development

```
npm install
cp .env.example .env.local   # fill in values
npm run dev
```

The app runs at `http://localhost:3000`. German is the default locale with no
URL prefix; English lives at `/en`.

## Tests

```
npm run typecheck   # TypeScript, no emit
npm run lint         # ESLint
npm run test         # Vitest: unit and integration
npm run test:watch   # Vitest in watch mode
npm run test:e2e     # Playwright end-to-end (requires a production build)
npm run check        # typecheck + lint + test, in that order
```

Playwright needs its browsers installed once per machine:

```
npx playwright install
```

## Content

All copy and structured data (project names, board members, statistics, form
copy) live in `src/content/*.ts`, validated with Zod. Nothing user-facing is
hardcoded in a component. UI strings for both locales live in
`src/messages/de.json` and `src/messages/en.json`.

Missing facts or assets are tracked in `ASSETS-TODO.md` rather than invented.
