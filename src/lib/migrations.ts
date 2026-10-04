/**
 * The filename of the most recently added file in migrations/. Kept in sync
 * by hand — the same discipline as ADMIN_SECTIONS (components/admin/
 * adminSections.ts): whoever adds migrations/00XX_something.sql bumps this
 * one line in the same commit.
 *
 * /admin/system compares this against the database's own schema_migrations
 * table (lib/db.ts's latestAppliedMigrationName) to catch exactly the
 * failure mode that silently broke Ideathon signups from 2026-08-26 to
 * 2026-08-30: migration 0015 was committed and the application code was
 * updated to match it, but the migration itself was never run against the
 * production database.
 *
 * Deliberately not read from migrations/*.sql on disk at request time:
 * Vercel's serverless build packages only files reachable from the import
 * graph, and migrations/ sits outside src/ specifically because
 * scripts/migrate.mjs is the only thing that should ever execute its
 * contents — a runtime fs.readdirSync here would depend on bundler behavior
 * this project has no test for, on the one page whose job is to be
 * trustworthy when something else has already gone wrong.
 */
export const LATEST_MIGRATION = "0024_contact_messages_spam.sql";
