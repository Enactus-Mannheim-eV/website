// Writes one throwaway row to each table, reads it back, checks the values
// round-tripped, then deletes it — against the real Neon database, not a
// mock. This is the check to run before trusting any schema change: proof
// the schema and the driver actually work together, not just that the SQL
// parses.
//
// Usage: `node --env-file=.env.local scripts/db-verify.mjs`
// (`npm run db:verify` wires that up.) Run `npm run db:migrate` first.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run with `node --env-file=.env.local scripts/db-verify.mjs`.");
  process.exit(1);
}

const sql = neon(connectionString);
const MARKER = `db-verify-${Date.now()}`;
let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures += 1;
}

async function verifyApplications() {
  console.log("\napplications");
  const email = `${MARKER}@example.invalid`;
  const retainUntil = new Date(Date.now() - 1000); // already due, for the cleanup-query check below
  const interviewSlot = "2026-09-15T08:00:00.000Z";
  const [inserted] = await sql`
    insert into applications (
      first_name, last_name, email, study_program, semester, university,
      motivation, desired_areas, availability_hours, consent_at, locale, recruiting_semester,
      cv_blob_url, cv_pathname, cv_original_filename, cv_size_bytes, cv_uploaded_at, retain_until,
      interview_slots
    ) values (
      'Verify', 'Script', ${email}, 'Testfach', 3, 'Testuniversität',
      'Verification run, not a real application.', ${["SmileGreen", "Team-Lead"]}, 5, now(), 'de', 'HWS26',
      'https://example-store.public.blob.vercel-storage.com/bewerbungen/verify-abc123.pdf',
      ${`bewerbungen/${MARKER}.pdf`}, 'lebenslauf.pdf', 12345, now(), ${retainUntil.toISOString()},
      ${[interviewSlot]}::timestamptz[]
    )
    returning *
  `;
  check("insert returns an id", typeof inserted.id, "string");

  const [read] = await sql`select * from applications where id = ${inserted.id}`;
  check("email round-trips", read.email, email);
  check("desired_areas round-trips as an array", read.desired_areas, ["SmileGreen", "Team-Lead"]);
  check("mail_status defaults to pending", read.mail_status, "pending");
  check("recruiting_semester round-trips", read.recruiting_semester, "HWS26");
  check("cv_pathname round-trips", read.cv_pathname, `bewerbungen/${MARKER}.pdf`);
  check("cv_original_filename round-trips", read.cv_original_filename, "lebenslauf.pdf");
  check("cv_size_bytes round-trips", read.cv_size_bytes, 12345);
  check(
    "interview_slots round-trips as the same instant",
    new Date(read.interview_slots[0]).toISOString(),
    interviewSlot,
  );

  const [withoutInterviewSlots] = await sql`
    insert into applications (
      first_name, last_name, email, study_program, semester,
      motivation, availability_hours, consent_at, locale, recruiting_semester, retain_until
    ) values (
      'Verify', 'NoSlots', ${`${MARKER}-noslots@example.invalid`}, 'Testfach', 3,
      'Verification run, not a real application.', 5, now(), 'de', 'HWS26', now()
    )
    returning id, interview_slots
  `;
  check(
    "interview_slots is NULL, not [], when the application doesn't set it",
    withoutInterviewSlots.interview_slots,
    null,
  );
  await sql`delete from applications where id = ${withoutInterviewSlots.id}`;

  // The exact query the cron cleanup route's CV-blob pass runs (see
  // app/api/cron/cleanup/route.ts) — this row must be a hit, since its
  // retain_until is already in the past and it has a cv_pathname.
  const dueForCleanup = await sql`
    select id from applications where cv_pathname is not null and retain_until <= now() and id = ${inserted.id}
  `;
  check("a row past its retain_until with a CV is selected by the cleanup query", dueForCleanup.length, 1);

  await sql`
    update applications
    set cv_blob_url = null, cv_pathname = null, cv_original_filename = null, cv_size_bytes = null, cv_uploaded_at = null
    where id = ${inserted.id}
  `;
  const [afterCvCleared] = await sql`select cv_pathname from applications where id = ${inserted.id}`;
  check("cv columns clear to null after the cleanup pass would run", afterCvCleared.cv_pathname, null);

  await sql`update applications set mail_status = 'sent', mailed_at = now() where id = ${inserted.id}`;
  const [afterUpdate] = await sql`select mail_status from applications where id = ${inserted.id}`;
  check("mail_status updates", afterUpdate.mail_status, "sent");

  const deleted = await sql`delete from applications where id = ${inserted.id} returning id`;
  check("delete removes exactly one row", deleted.length, 1);
  const afterDelete = await sql`select id from applications where id = ${inserted.id}`;
  check("row is gone after delete", afterDelete.length, 0);
}

async function verifyApplicationAreaChoices() {
  console.log("\napplication_area_choices");
  const email = `${MARKER}-areas@example.invalid`;
  const [application] = await sql`
    insert into applications (
      first_name, last_name, email, study_program, semester, university,
      motivation, availability_hours, consent_at, locale, recruiting_semester, retain_until
    ) values (
      'Verify', 'Areas', ${email}, 'Testfach', 3, 'Testuniversität',
      'Verification run, not a real application.', 5, now(), 'de', 'HWS26', now()
    )
    returning id
  `;

  const [firstChoice] = await sql`
    insert into application_area_choices (application_id, priority, area_label, reason)
    values (${application.id}, 1, 'SmileGreen', 'Weil ich dort am meisten bewirken kann.')
    returning *
  `;
  check("insert returns an id", typeof firstChoice.id, "string");

  let priorityOutOfRangeRejected = false;
  try {
    await sql`
      insert into application_area_choices (application_id, priority, area_label, reason)
      values (${application.id}, 4, 'Mealyo', 'Zu hohe Priorität.')
    `;
  } catch {
    priorityOutOfRangeRejected = true;
  }
  check("priority range check rejects a value outside 1-3", priorityOutOfRangeRejected, true);

  let reasonTooLongRejected = false;
  try {
    await sql`
      insert into application_area_choices (application_id, priority, area_label, reason)
      values (${application.id}, 2, 'Mealyo', ${"x".repeat(301)})
    `;
  } catch {
    reasonTooLongRejected = true;
  }
  check("reason length check rejects more than 300 characters", reasonTooLongRejected, true);

  let duplicatePriorityRejected = false;
  try {
    await sql`
      insert into application_area_choices (application_id, priority, area_label, reason)
      values (${application.id}, 1, 'Mealyo', 'Zweite Begründung für dieselbe Priorität.')
    `;
  } catch {
    duplicatePriorityRejected = true;
  }
  check("unique constraint rejects a second choice with the same priority", duplicatePriorityRejected, true);

  let duplicateAreaRejected = false;
  try {
    await sql`
      insert into application_area_choices (application_id, priority, area_label, reason)
      values (${application.id}, 2, 'SmileGreen', 'Zweite Begründung für denselben Bereich.')
    `;
  } catch {
    duplicateAreaRejected = true;
  }
  check("unique constraint rejects the same area twice on one application", duplicateAreaRejected, true);

  const [secondChoice] = await sql`
    insert into application_area_choices (application_id, priority, area_label, reason)
    values (${application.id}, 2, 'Mealyo', 'Zweitwahl, weil ich auch dort mitwirken möchte.')
    returning *
  `;
  check("a second, distinct choice on the same application is accepted", typeof secondChoice.id, "string");

  const ordered = await sql`
    select priority, area_label from application_area_choices
    where application_id = ${application.id} order by priority
  `;
  check("reads come back in priority order", ordered.map((row) => row.priority), [1, 2]);

  const deletedApplication = await sql`delete from applications where id = ${application.id} returning id`;
  check("deleting the application removes exactly one row", deletedApplication.length, 1);

  const orphanedChoices = await sql`
    select id from application_area_choices where application_id = ${application.id}
  `;
  check("on delete cascade removes the application's area choices too", orphanedChoices.length, 0);
}

async function verifyReminderSignups() {
  console.log("\nreminder_signups");
  const email = `${MARKER}-reminder@example.invalid`;
  const [inserted] = await sql`
    insert into reminder_signups (email, confirm_token, unsubscribe_token, locale)
    values (${email}, ${`${MARKER}-confirm`}, ${`${MARKER}-unsub`}, 'de')
    returning *
  `;
  check("confirmed defaults to false", inserted.confirmed, false);

  const [confirmed] = await sql`
    update reminder_signups set confirmed = true, confirmed_at = now(), confirmation_ip = '203.0.113.1'
    where id = ${inserted.id} and confirmed = false
    returning confirmed, confirmation_ip
  `;
  check("confirmation updates confirmed and stores the IP", confirmed?.confirmation_ip, "203.0.113.1");

  const repeatConfirm = await sql`
    update reminder_signups set confirmed = true where id = ${inserted.id} and confirmed = false returning id
  `;
  check("re-confirming an already-confirmed row matches zero rows", repeatConfirm.length, 0);

  check("mail_status defaults to pending", inserted.mail_status, "pending");

  await sql`update reminder_signups set mail_status = 'failed', mail_error = 'Resend is down' where id = ${inserted.id}`;
  const [failed] = await sql`
    select source, id, email, label, mail_error from (
      select 'reminder_signups' as source, id, created_at, email, '' as label, mail_error
      from reminder_signups where mail_status = 'failed'
    ) t where id = ${inserted.id}
  `;
  check("a failed reminder send is findable with its error", failed?.mail_error, "Resend is down");

  const deleted = await sql`delete from reminder_signups where id = ${inserted.id} returning id`;
  check("delete removes exactly one row", deleted.length, 1);
}

// This is the check that matters most in this file: it runs the exact
// query lib/db.ts's findConfirmedReminderSignups uses (confirmed = true
// and unsubscribed_at is null) against three real rows in three real
// states, and asserts only the one that should be mailed comes back. A
// mocked test can only assert "the function returns what I told it to" —
// this is the one place the actual filtering logic, running on the actual
// database, gets checked.
async function verifyReminderFiltering() {
  console.log("\nreminder_signups filtering (findConfirmedReminderSignups)");
  const unconfirmedEmail = `${MARKER}-unconfirmed@example.invalid`;
  const confirmedEmail = `${MARKER}-confirmed@example.invalid`;
  const unsubscribedEmail = `${MARKER}-unsubscribed@example.invalid`;

  await sql`
    insert into reminder_signups (email, confirm_token, unsubscribe_token, locale)
    values (${unconfirmedEmail}, ${`${MARKER}-t1`}, ${`${MARKER}-u1`}, 'de')
  `;
  await sql`
    insert into reminder_signups (email, confirm_token, unsubscribe_token, confirmed, confirmed_at, locale)
    values (${confirmedEmail}, ${`${MARKER}-t2`}, ${`${MARKER}-u2`}, true, now(), 'de')
  `;
  await sql`
    insert into reminder_signups (
      email, confirm_token, unsubscribe_token, confirmed, confirmed_at, unsubscribed_at, locale
    )
    values (${unsubscribedEmail}, ${`${MARKER}-t3`}, ${`${MARKER}-u3`}, true, now(), now(), 'de')
  `;

  const mailable = await sql`
    select email from reminder_signups
    where confirmed = true and unsubscribed_at is null and email like ${`${MARKER}-%@example.invalid`}
    order by email
  `;
  check("only the confirmed, still-subscribed row is returned", mailable.map((row) => row.email), [
    confirmedEmail,
  ]);

  const deleted = await sql`
    delete from reminder_signups where email like ${`${MARKER}-%@example.invalid`} returning id
  `;
  check("cleans up all three rows", deleted.length, 3);
}

async function verifyRecruitingWindows() {
  console.log("\nrecruiting_windows");
  const semester = `ZZ${String(Date.now()).slice(-2)}`; // doesn't match HWS/FSS on purpose, see below
  const startsAt = "2099-01-01T00:00:00+01:00";
  const endsAt = "2099-01-14T00:00:00+01:00";

  let rejected = false;
  try {
    await sql`
      insert into recruiting_windows (semester, starts_at, ends_at)
      values (${semester}, ${startsAt}, ${endsAt})
    `;
  } catch {
    rejected = true;
  }
  check("semester format check rejects a non-HWS/FSS label", rejected, true);

  const validSemester = `HWS${String(Date.now()).slice(-2)}`;
  const [inserted] = await sql`
    insert into recruiting_windows (semester, starts_at, ends_at, interview_days, interview_start_time, interview_end_time, interview_slot_minutes)
    values (${validSemester}, ${startsAt}, ${endsAt}, ${["2026-09-15", "2026-09-16"]}::date[], '10:00'::time, '19:00'::time, 60)
    returning id, interview_days::text[] as interview_days, interview_start_time::text as interview_start_time,
      interview_end_time::text as interview_end_time, interview_slot_minutes
  `;
  check("insert returns an id", typeof inserted.id, "string");
  check("interview_days round-trips", inserted.interview_days, ["2026-09-15", "2026-09-16"]);
  check("interview_start_time round-trips", inserted.interview_start_time.slice(0, 5), "10:00");
  check("interview_end_time round-trips", inserted.interview_end_time.slice(0, 5), "19:00");
  check("interview_slot_minutes round-trips", inserted.interview_slot_minutes, 60);

  let endBeforeStartRejected = false;
  try {
    await sql`
      insert into recruiting_windows (semester, starts_at, ends_at)
      values (${`FSS${String(Date.now()).slice(-2)}`}, ${endsAt}, ${startsAt})
    `;
  } catch {
    endBeforeStartRejected = true;
  }
  check("end-after-start check rejects an inverted window", endBeforeStartRejected, true);

  let interviewRangeRejected = false;
  try {
    await sql`
      insert into recruiting_windows (semester, starts_at, ends_at, interview_start_time, interview_end_time)
      values (${`FSS${String(Date.now()).slice(-2)}`}, ${startsAt}, ${endsAt}, '19:00'::time, '10:00'::time)
    `;
  } catch {
    interviewRangeRejected = true;
  }
  check("interview end-after-start check rejects an inverted interview range", interviewRangeRejected, true);

  const [withoutGrid] = await sql`
    insert into recruiting_windows (semester, starts_at, ends_at)
    values (${`FSS${String(Date.now() + 1).slice(-2)}`}, ${startsAt}, ${endsAt})
    returning id, interview_days::text[] as interview_days, interview_start_time::text as interview_start_time
  `;
  check("a window created without an interview grid defaults to no days, not NULL", withoutGrid.interview_days, []);
  check("a window created without an interview grid defaults to 10:00", withoutGrid.interview_start_time.slice(0, 5), "10:00");
  await sql`delete from recruiting_windows where id = ${withoutGrid.id}`;

  const deleted = await sql`delete from recruiting_windows where id = ${inserted.id} returning id`;
  check("delete removes exactly one row", deleted.length, 1);
}

// No project_areas check existed before this — added specifically to prove
// migration 0022's ideathon_hint column actually reached production, not
// just that its .sql file sits in the repo. Same round-trip shape as every
// other check here: insert with the flag on, read it back, insert again
// with it off (the column's own default), read that back too, then clean up.
async function verifyProjectAreas() {
  console.log("\nproject_areas");
  const flaggedLabel = `${MARKER}-innolab`;
  const [flagged] = await sql`
    insert into project_areas (label_de, label_en, sort_order, ideathon_hint)
    values (${flaggedLabel}, ${flaggedLabel}, 999, true)
    returning *
  `;
  check("ideathon_hint round-trips true", flagged.ideathon_hint, true);

  const [unflagged] = await sql`
    insert into project_areas (label_de, label_en, sort_order)
    values (${`${MARKER}-plain`}, ${`${MARKER}-plain`}, 999)
    returning *
  `;
  check("ideathon_hint defaults to false when not set", unflagged.ideathon_hint, false);

  const active = await sql`
    select label_de from project_areas where ideathon_hint = true and label_de = ${flaggedLabel}
  `;
  check("an active, flagged area is findable by the flag", active.length, 1);

  const deleted = await sql`
    delete from project_areas where id in (${flagged.id}, ${unflagged.id}) returning id
  `;
  check("delete removes both rows", deleted.length, 2);
}

async function verifyContactMessages() {
  console.log("\ncontact_messages");
  const email = `${MARKER}-contact@example.invalid`;
  const [inserted] = await sql`
    insert into contact_messages (name, email, subject, message, locale)
    values ('Verify Script', ${email}, 'DB verify', 'Verification run, not a real message.', 'de')
    returning *
  `;
  check("mail_status defaults to pending", inserted.mail_status, "pending");
  check("spam defaults to false", inserted.spam, false);
  check("spam_reasons defaults to empty", inserted.spam_reasons, []);

  const [flagged] = await sql`
    insert into contact_messages (name, email, subject, message, locale, spam, spam_reasons)
    values ('Verify Script', ${email}, 'DB verify', 'Verification run, not a real message.', 'de',
            true, ${["random_name", "too_fast"]}::text[])
    returning *
  `;
  check("spam round-trips as true", flagged.spam, true);
  check("spam_reasons round-trips as an array", flagged.spam_reasons, ["random_name", "too_fast"]);

  const deleted = await sql`
    delete from contact_messages where id in (${inserted.id}, ${flagged.id}) returning id
  `;
  check("delete removes both rows", deleted.length, 2);
}

async function verifyCronRuns() {
  console.log("\ncron_runs");
  const [started] = await sql`insert into cron_runs (job) values (${MARKER}) returning *`;
  check("a new run starts as not-ok", started.ok, false);
  check("a new run has no finished_at yet", started.finished_at, null);

  await sql`
    update cron_runs set finished_at = now(), ok = true, deleted_applications = 2,
      pruned_rate_limit_hits = 7, deleted_cv_blobs = 3, deleted_orphan_blobs = 1,
      remaining_cv_blobs = 5, error = null
    where id = ${started.id}
  `;
  const [finished] = await sql`select * from cron_runs where id = ${started.id}`;
  check("finishing a run records ok and the counts", [finished.ok, finished.deleted_applications], [true, 2]);
  check("pruned counter round-trips", finished.pruned_rate_limit_hits, 7);
  check(
    "cv-blobs counters round-trip",
    [finished.deleted_cv_blobs, finished.deleted_orphan_blobs, finished.remaining_cv_blobs],
    [3, 1, 5],
  );

  const recent = await sql`select id from cron_runs where job = ${MARKER} order by started_at desc limit 1`;
  check("most-recent-first ordering finds the run", recent.length, 1);

  const deleted = await sql`delete from cron_runs where job = ${MARKER} returning id`;
  check("delete removes exactly one row", deleted.length, 1);
}

async function verifyCalendarEvents() {
  console.log("\ncalendar_events");

  let categoryRejected = false;
  try {
    await sql`
      insert into calendar_events (title, category, start_date)
      values (${MARKER}, 'not-a-real-category', '2099-01-01')
    `;
  } catch {
    categoryRejected = true;
  }
  check("category check rejects an unknown category", categoryRejected, true);

  let blankTitleRejected = false;
  try {
    await sql`insert into calendar_events (title, category, start_date) values ('   ', 'socials', '2099-01-01')`;
  } catch {
    blankTitleRejected = true;
  }
  check("title check rejects a blank title", blankTitleRejected, true);

  let endBeforeStartRejected = false;
  try {
    await sql`
      insert into calendar_events (title, category, start_date, end_date)
      values (${MARKER}, 'socials', '2099-01-10', '2099-01-01')
    `;
  } catch {
    endBeforeStartRejected = true;
  }
  check("end-date check rejects an end date before the start date", endBeforeStartRejected, true);

  let endTimeWithoutStartRejected = false;
  try {
    await sql`
      insert into calendar_events (title, category, start_date, end_time)
      values (${MARKER}, 'socials', '2099-01-01', '18:00')
    `;
  } catch {
    endTimeWithoutStartRejected = true;
  }
  check("end-time check rejects an end time with no start time", endTimeWithoutStartRejected, true);

  let sameDayEndBeforeStartRejected = false;
  try {
    await sql`
      insert into calendar_events (title, category, start_date, start_time, end_time)
      values (${MARKER}, 'socials', '2099-01-01', '18:00', '09:00')
    `;
  } catch {
    sameDayEndBeforeStartRejected = true;
  }
  check(
    "end-time check rejects an earlier end time on the same day",
    sameDayEndBeforeStartRejected,
    true,
  );

  // The one case the same-day rule must NOT reject: a multi-day event whose
  // end time is earlier in the clock than its start time is still valid,
  // because the two times fall on different calendar days.
  const [multiDay] = await sql`
    insert into calendar_events (title, category, start_date, end_date, start_time, end_time)
    values (${MARKER}, 'socials', '2099-01-01', '2099-01-02', '18:00', '09:00')
    returning id
  `;
  check("a multi-day event may end earlier in the clock than it started", typeof multiDay.id, "string");
  await sql`delete from calendar_events where id = ${multiDay.id}`;

  const [inserted] = await sql`
    insert into calendar_events (title, title_en, category, start_date, description_en, tentative)
    values (${MARKER}, ${`${MARKER}-en`}, 'innolab', '2099-01-01', ${`${MARKER}-desc-en`}, true)
    returning *
  `;
  check("insert returns an id", typeof inserted.id, "string");
  check("english columns round-trip", [inserted.title_en, inserted.tentative], [`${MARKER}-en`, true]);

  const deleted = await sql`delete from calendar_events where id = ${inserted.id} returning id`;
  check("delete removes exactly one row", deleted.length, 1);
}

// The exact table that broke silently from 2026-08-26 to 2026-08-30:
// migration 0015 was committed and the application code was updated to
// match it, but the migration itself was never run against the production
// database — every insert here has failed since, and the admin list threw
// on a missing column. This function inserts every post-0015 column so a
// future column rename/drop against a database still missing it fails here
// first, not in production.
async function verifyIdeathonSignups() {
  console.log("\nideathon_signups");
  const email = `${MARKER}-ideathon@example.invalid`;
  const [inserted] = await sql`
    insert into ideathon_signups (
      first_name, last_name, email, study_program, semester, has_idea,
      idea_description, registering_as_team, team_size, team_members,
      motivation_experience, dietary_preference, heard_about_us, locale, consent_at
    ) values (
      'Verify', 'Script', ${email}, 'Testfach', 3, true,
      'Verification run, not a real idea.', true, 4, 'Verify One, Verify Two',
      'Verification run, not real experience.', 'vegetarian', 'db-verify', 'de', now()
    )
    returning *
  `;
  check("insert returns an id", typeof inserted.id, "string");
  check("dietary_preference round-trips", inserted.dietary_preference, "vegetarian");
  check("team_members round-trips", inserted.team_members, "Verify One, Verify Two");
  check(
    "motivation_experience round-trips",
    inserted.motivation_experience,
    "Verification run, not real experience.",
  );
  check("mail_status defaults to pending", inserted.mail_status, "pending");
  check("university column no longer exists (dropped in 0015)", "university" in inserted, false);

  const deleted = await sql`delete from ideathon_signups where id = ${inserted.id} returning id`;
  check("delete removes exactly one row", deleted.length, 1);
}

// The check that would have caught the 0015 gap directly, rather than via
// one of its symptoms: every migration file on disk must have a matching
// row in schema_migrations. Reads migrations/ from the filesystem, which is
// safe here — this script runs under plain Node against a local checkout or
// in CI, never bundled into the Vercel serverless build the way
// lib/migrations.ts's LATEST_MIGRATION constant deliberately avoids doing.
async function verifyMigrationsApplied() {
  console.log("\nmigrations");
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const appliedRows = await sql`select name from schema_migrations`;
  const applied = new Set(appliedRows.map((row) => row.name));
  const missing = files.filter((file) => !applied.has(file));
  check("every migration file on disk has been applied to this database", missing, []);
}

async function verifyRateLimitHits() {
  console.log("\nrate_limit_hits");
  const bucket = MARKER;
  const windowStart = new Date(0).toISOString();

  const beforeAnyHit = await sql`
    select count from rate_limit_hits where bucket = ${bucket} and window_start = ${windowStart}
  `;
  check("peek finds no row before the first hit", beforeAnyHit.length, 0);

  const [first] = await sql`
    insert into rate_limit_hits (bucket, window_start, count)
    values (${bucket}, ${windowStart}, 1)
    on conflict (bucket, window_start) do update set count = rate_limit_hits.count + 1
    returning count
  `;
  check("first hit has count 1", first.count, 1);

  const [peeked] = await sql`
    select count from rate_limit_hits where bucket = ${bucket} and window_start = ${windowStart}
  `;
  check("peek reads the count without incrementing it", peeked.count, 1);

  const [second] = await sql`
    insert into rate_limit_hits (bucket, window_start, count)
    values (${bucket}, ${windowStart}, 1)
    on conflict (bucket, window_start) do update set count = rate_limit_hits.count + 1
    returning count
  `;
  check("second hit increments to count 2", second.count, 2);

  const deleted = await sql`delete from rate_limit_hits where bucket = ${bucket} returning bucket`;
  check("delete removes exactly one row", deleted.length, 1);
}

await verifyApplications();
await verifyApplicationAreaChoices();
await verifyReminderSignups();
await verifyReminderFiltering();
await verifyRecruitingWindows();
await verifyProjectAreas();
await verifyCalendarEvents();
await verifyContactMessages();
await verifyCronRuns();
await verifyIdeathonSignups();
await verifyMigrationsApplied();
await verifyRateLimitHits();

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
