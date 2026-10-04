import { neon } from "@neondatabase/serverless";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { DietaryPreference } from "./ideathonSignupFormSchema";
import type { ApplicationAreaChoice } from "./applicationFormSchema";

/**
 * The only file in this codebase that writes SQL. Every route in app/api/
 * goes through the typed functions below, never through a raw `sql`
 * handle — that boundary is what keeps a future column rename or query
 * change a one-file diff.
 *
 * No multi-statement transactions anywhere here, on purpose: every
 * function below is exactly one atomic SQL statement (an INSERT, a
 * conditional UPDATE, or an upsert with RETURNING), so there is nothing
 * for a transaction to coordinate. See migrations/0001_init.sql and
 * docs/deployment.md for why that's sufficient — the short version is that
 * every race this schema cares about (double-clicking a confirmation link,
 * a concurrent rate-limit hit) is resolved by a single statement's own
 * WHERE clause or ON CONFLICT clause, not by wrapping several statements
 * together.
 *
 * The Neon client is created lazily, on first use, not at module load —
 * `next build` collects route metadata for every API route without
 * running any request handler, so a client built at import time would
 * make DATABASE_URL a build-time requirement instead of a runtime one.
 */

let cachedSql: NeonQueryFunction<false, false> | null = null;

function sql(): NeonQueryFunction<false, false> {
  if (cachedSql) return cachedSql;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — see .env.example and docs/deployment.md.");
  }
  cachedSql = neon(connectionString);
  return cachedSql;
}

export type Locale = "de" | "en";
export type MailStatus = "pending" | "sent" | "failed";

export type ApplicationInput = {
  firstName: string;
  lastName: string;
  email: string;
  studyProgram: string;
  semester: number;
  // Dropped from the form (field-audit decision: almost every answer was
  // "Universität Mannheim", no selection relevance — same reasoning that
  // already removed it from the Ideathon signup). Optional only so a
  // historic row still reads one back; every new insert leaves this
  // undefined, which migrations/0018's relaxed constraint now allows.
  university?: string;
  priorInvolvement?: string;
  // Relabeled "Relevante Skills" in the UI, capped at 200 characters
  // (down from 300) — see applicationFormSchema.ts's own comment. Same
  // column, same optional field, just a shorter, more targeted answer.
  languagesSkills?: string;
  motivation: string;
  // New: forward-looking, distinct from motivation — see
  // applicationFormSchema.ts's own comment.
  wantToGain?: string;
  // Legacy-only: pre-migration rows still read this back
  // (migrations/0017's own comment on why there's no backfill). Every new
  // insert leaves this undefined and writes to areaChoices below instead.
  desiredAreas?: string[];
  // Up to three prioritized Wunschbereich choices, each with its own
  // required reason — replaces the flat desiredAreas checkbox list.
  // Always has at least one entry for a new insert (area1 is required by
  // applicationFormSchema.ts); insertApplication writes these to the
  // application_area_choices child table (migrations/0017), not a column.
  areaChoices: ApplicationAreaChoice[];
  // Up to MAX_DEPARTMENTS (applicationFormSchema.ts) plain labels, unranked
  // and unreasoned — a separate category from areaChoices above, not a
  // fourth priority. Undefined/omitted on a pre-migration insert path is
  // never produced by this codebase (every new insert passes an array, even
  // an empty one); reading one back as undefined only happens for a row from
  // before migrations/0020, via toApplication below.
  departments?: string[];
  // ISO 8601 instants, one per chosen interview slot — see
  // applicationFormSchema.ts and /api/bewerbung's own comments for how this
  // differs from departments above: undefined means the recruiting window
  // this application belongs to had no interview days configured at
  // submission time (there was nothing to choose from), an empty array
  // means slots were offered and none were chosen. Both are real,
  // server-decided states — never left to the client to distinguish, see
  // /api/bewerbung's own comment.
  interviewSlots?: string[];
  availabilityHours: number;
  heardAboutUs?: string;
  locale: Locale;
  // The recruiting cycle (content/recruiting.ts) this application belongs
  // to — see lib/recruitingSemester.ts. Distinct from `semester` above,
  // which is the applicant's own semester of study.
  recruitingSemester: string;
  // Computed once by the caller (lib/retentionCutoff.ts's
  // applicationRetainUntil) and stored as-is — never recomputed after
  // insert. See migrations/0016's own comment on why this is a fixed
  // deadline, not a live calculation.
  retainUntil: Date;
  // Populated together, from a single successful client upload
  // (upload() from @vercel/blob/client, ApplicationForm.tsx) — never
  // assembled field by field. See applicationFormSchema.ts's
  // refineApplicationForm for the "all four or none" rule this relies on.
  cvBlobUrl?: string;
  cvPathname?: string;
  cvOriginalFilename?: string;
  cvSizeBytes?: number;
  cvUploadedAt?: Date;
};

export type Application = ApplicationInput & {
  id: string;
  createdAt: Date;
  consentAt: Date;
  mailStatus: MailStatus;
  mailError: string | null;
  mailedAt: Date | null;
};

// application_area_choices comes back as a `json_agg(...)` column
// (area_choices) from every query that joins it — but not from
// findPersonalDataByEmail's plain `select *`, which never joins that
// table. Defaulting to [] here, rather than requiring every caller to
// join, keeps that one GDPR-search query simple at the cost of it not
// showing area choices in its result — an acceptable gap, since the board
// already has the full admin view and PDF for that.
function parseAreaChoices(value: unknown): ApplicationAreaChoice[] {
  if (!value) return [];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as ApplicationAreaChoice[]) : [];
}

// interview_slots is a timestamptz[] — read back as either Date objects or
// strings depending on the driver's own array parsing, so this accepts
// both rather than assuming one. Always re-expressed as ISO strings, the
// same shape /api/bewerbung wrote, so nothing downstream has to care which
// form the row arrived in.
function parseInterviewSlots(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => (entry instanceof Date ? entry.toISOString() : new Date(entry as string).toISOString()));
}

function toApplication(row: Record<string, unknown>): Application {
  return {
    id: row.id as string,
    createdAt: row.created_at as Date,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    email: row.email as string,
    studyProgram: row.study_program as string,
    semester: row.semester as number,
    university: (row.university as string | null) ?? undefined,
    priorInvolvement: (row.prior_involvement as string | null) ?? undefined,
    languagesSkills: (row.languages_skills as string | null) ?? undefined,
    motivation: row.motivation as string,
    wantToGain: (row.want_to_gain as string | null) ?? undefined,
    desiredAreas: (row.desired_areas as string[] | null) ?? undefined,
    areaChoices: parseAreaChoices(row.area_choices),
    departments: (row.departments as string[] | null) ?? undefined,
    interviewSlots: parseInterviewSlots(row.interview_slots),
    availabilityHours: row.availability_hours as number,
    heardAboutUs: (row.heard_about_us as string | null) ?? undefined,
    consentAt: row.consent_at as Date,
    locale: row.locale as Locale,
    mailStatus: row.mail_status as MailStatus,
    mailError: (row.mail_error as string | null) ?? null,
    mailedAt: (row.mailed_at as Date | null) ?? null,
    recruitingSemester: row.recruiting_semester as string,
    retainUntil: row.retain_until as Date,
    cvBlobUrl: (row.cv_blob_url as string | null) ?? undefined,
    cvPathname: (row.cv_pathname as string | null) ?? undefined,
    cvOriginalFilename: (row.cv_original_filename as string | null) ?? undefined,
    cvSizeBytes: (row.cv_size_bytes as number | null) ?? undefined,
    cvUploadedAt: (row.cv_uploaded_at as Date | null) ?? undefined,
  };
}

// The one query in this file that writes to two tables — still a single
// atomic statement (a CTE, not a transaction block), matching this file's
// own no-multi-statement-transactions rule: either both inserts happen or
// neither does. consent_at is set from the database's own clock (now()),
// not a client-supplied timestamp — it's the proof of consent, so it has
// to be the moment the server actually received and stored the request.
//
// The three area_choices columns are passed as parallel arrays to
// unnest(...) rather than issued as separate insert statements — one round
// trip for however many choices (1 to 3) an application has, and it stays
// inside the same CTE as the applications insert.
export async function insertApplication(input: ApplicationInput): Promise<Application> {
  const priorities = input.areaChoices.map((choice) => choice.priority);
  const areaLabels = input.areaChoices.map((choice) => choice.areaLabel);
  const reasons = input.areaChoices.map((choice) => choice.reason);

  const rows = await sql()`
    with new_application as (
      insert into applications (
        first_name, last_name, email, study_program, semester, university,
        prior_involvement, languages_skills, motivation, want_to_gain, desired_areas, departments,
        interview_slots,
        availability_hours, heard_about_us, consent_at, locale, recruiting_semester,
        retain_until, cv_blob_url, cv_pathname, cv_original_filename, cv_size_bytes, cv_uploaded_at
      ) values (
        ${input.firstName}, ${input.lastName}, ${input.email}, ${input.studyProgram},
        ${input.semester}, ${input.university ?? null}, ${input.priorInvolvement ?? null},
        ${input.languagesSkills ?? null}, ${input.motivation}, ${input.wantToGain ?? null},
        ${input.desiredAreas ?? null}, ${input.departments ?? []},
        ${input.interviewSlots ?? null}::timestamptz[],
        ${input.availabilityHours}, ${input.heardAboutUs ?? null},
        now(), ${input.locale}, ${input.recruitingSemester}, ${input.retainUntil.toISOString()},
        ${input.cvBlobUrl ?? null}, ${input.cvPathname ?? null}, ${input.cvOriginalFilename ?? null},
        ${input.cvSizeBytes ?? null}, ${input.cvUploadedAt ? input.cvUploadedAt.toISOString() : null}
      )
      returning *
    ), inserted_choices as (
      insert into application_area_choices (application_id, priority, area_label, reason)
      select new_application.id, choice.priority, choice.area_label, choice.reason
      from new_application, unnest(${priorities}::int[], ${areaLabels}::text[], ${reasons}::text[])
        as choice(priority, area_label, reason)
      returning priority, area_label, reason
    )
    select
      new_application.*,
      coalesce(
        (
          select json_agg(
            json_build_object('priority', priority, 'areaLabel', area_label, 'reason', reason)
            order by priority
          )
          from inserted_choices
        ),
        '[]'::json
      ) as area_choices
    from new_application
  `;
  return toApplication(rows[0] as Record<string, unknown>);
}

export async function markApplicationMailed(id: string): Promise<void> {
  await sql()`
    update applications set mail_status = 'sent', mailed_at = now(), mail_error = null
    where id = ${id}
  `;
}

export async function markApplicationMailFailed(id: string, error: string): Promise<void> {
  await sql()`
    update applications set mail_status = 'failed', mail_error = ${error}
    where id = ${id}
  `;
}

// The lateral join below (also in listApplications, listApplicationsBySemester,
// and insertApplication's own CTE) is repeated rather than shared: Neon's
// tagged-template `sql` has no fragment-composition helper that keeps
// parameter binding safe, so each query spells it out in full. Same
// json_agg shape everywhere, so the four can't quietly drift into
// different orderings or field names.
//
// Powers /admin/mails's resend. Reads the whole row, unlike
// ApplicationSummary below: re-rendering the PDF and re-sending the
// notification needs every field the original send had, so this is the one
// query allowed to return an application in full — and it's never used to
// populate a list, only to act on a single record the board picked.
export async function findApplicationById(id: string): Promise<Application | null> {
  const rows = await sql()`
    select a.*, coalesce(choices.area_choices, '[]'::json) as area_choices
    from applications a
    left join lateral (
      select json_agg(
        json_build_object('priority', priority, 'areaLabel', area_label, 'reason', reason)
        order by priority
      ) as area_choices
      from application_area_choices where application_id = a.id
    ) choices on true
    where a.id = ${id}
  `;
  return rows.length > 0 ? toApplication(rows[0] as Record<string, unknown>) : null;
}

// Powers /admin/bewerbungen and its CSV export. Every field either one
// needs, including areaChoices, languagesSkills ("Skills"), and cvPathname
// — all three were added once the board pointed out the CSV is how
// applications actually get sorted onto projects and filtered by whether a
// CV came in. motivation and the other free-text fields stay out; those
// were never asked for. desiredAreas is the pre-migration fallback: a row
// with no application_area_choices (migrations/0017 added no backfill)
// still needs something to show.
export type ApplicationSummary = {
  id: string;
  createdAt: Date;
  firstName: string;
  lastName: string;
  email: string;
  studyProgram: string;
  semester: number;
  availabilityHours: number;
  desiredAreas: string[] | null;
  areaChoices: ApplicationAreaChoice[];
  departments: string[] | null;
  interviewSlots: string[] | null;
  languagesSkills: string | null;
  cvPathname: string | null;
  mailStatus: MailStatus;
  recruitingSemester: string;
};

function toApplicationSummary(row: Record<string, unknown>): ApplicationSummary {
  return {
    id: row.id as string,
    createdAt: row.created_at as Date,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    email: row.email as string,
    studyProgram: row.study_program as string,
    semester: row.semester as number,
    availabilityHours: row.availability_hours as number,
    desiredAreas: (row.desired_areas as string[] | null) ?? null,
    areaChoices: parseAreaChoices(row.area_choices),
    departments: (row.departments as string[] | null) ?? null,
    interviewSlots: parseInterviewSlots(row.interview_slots) ?? null,
    languagesSkills: (row.languages_skills as string | null) ?? null,
    cvPathname: (row.cv_pathname as string | null) ?? null,
    mailStatus: row.mail_status as MailStatus,
    recruitingSemester: row.recruiting_semester as string,
  };
}

export async function listApplications(): Promise<ApplicationSummary[]> {
  const rows = await sql()`
    select
      a.id, a.created_at, a.first_name, a.last_name, a.email, a.study_program,
      a.semester, a.availability_hours, a.desired_areas, a.departments, a.interview_slots, a.languages_skills, a.cv_pathname,
      a.mail_status, a.recruiting_semester,
      coalesce(choices.area_choices, '[]'::json) as area_choices
    from applications a
    left join lateral (
      select json_agg(
        json_build_object('priority', priority, 'areaLabel', area_label, 'reason', reason)
        order by priority
      ) as area_choices
      from application_area_choices where application_id = a.id
    ) choices on true
    order by a.created_at desc
  `;
  return (rows as Record<string, unknown>[]).map(toApplicationSummary);
}

export async function listApplicationsBySemester(recruitingSemester: string): Promise<ApplicationSummary[]> {
  const rows = await sql()`
    select
      a.id, a.created_at, a.first_name, a.last_name, a.email, a.study_program,
      a.semester, a.availability_hours, a.desired_areas, a.departments, a.interview_slots, a.languages_skills, a.cv_pathname,
      a.mail_status, a.recruiting_semester,
      coalesce(choices.area_choices, '[]'::json) as area_choices
    from applications a
    left join lateral (
      select json_agg(
        json_build_object('priority', priority, 'areaLabel', area_label, 'reason', reason)
        order by priority
      ) as area_choices
      from application_area_choices where application_id = a.id
    ) choices on true
    where a.recruiting_semester = ${recruitingSemester}
    order by a.created_at desc
  `;
  return (rows as Record<string, unknown>[]).map(toApplicationSummary);
}

// Compared against each row's own retain_until (migrations/0016), not a
// cutoff derived from created_at — that value was computed once, at
// insert time, from whichever recruiting window was open then (see
// lib/retentionCutoff.ts's applicationRetainUntil). The caller just passes
// the current instant. Returns the cv_pathname of every deleted row (never
// null-filtered away here, just skipped) so the cron route's CV-blob pass
// can best-effort delete them from the store — a row without a CV simply
// contributes nothing to that list.
export async function deleteExpiredApplications(now: Date): Promise<{ count: number; cvPathnames: string[] }> {
  const rows = await sql()`
    delete from applications where retain_until <= ${now.toISOString()} returning cv_pathname
  `;
  const cvPathnames = (rows as { cv_pathname: string | null }[])
    .map((row) => row.cv_pathname)
    .filter((pathname): pathname is string => pathname !== null);
  return { count: rows.length, cvPathnames };
}

// The board's own manual delete, from /admin/bewerbungen — distinct from
// deleteExpiredApplications above (retention, cron-driven, by cutoff date)
// and from /api/admin/loeschanfragen (GDPR erasure, by email address across
// every table at once). Returns the deleted row's cv_pathname (if any) so
// the route can best-effort delete the blob alongside the row.
export async function deleteApplication(id: string): Promise<{ deleted: boolean; cvPathname: string | null }> {
  const rows = await sql()`delete from applications where id = ${id} returning cv_pathname`;
  if (rows.length === 0) return { deleted: false, cvPathname: null };
  return { deleted: true, cvPathname: (rows[0] as { cv_pathname: string | null }).cv_pathname };
}

// Powers the admin "CV jetzt löschen" button (/admin/bewerbungen) — clears
// the five cv_* columns without touching the application itself. The `previous`
// CTE looks like it would race with the UPDATE below, but it doesn't: every
// part of one statement, CTEs included, reads the same pre-statement
// snapshot in Postgres's MVCC, so `previous.cv_pathname` is always the value
// from *before* this statement's own SET clause ran, letting the route
// still best-effort delete the actual blob after the column is already
// null. Returns null when the application doesn't exist at all, or existed
// but had no CV to begin with — both mean nothing left to delete.
export async function clearApplicationCv(id: string): Promise<{ cvPathname: string } | null> {
  const rows = await sql()`
    with previous as (
      select cv_pathname from applications where id = ${id}
    )
    update applications set
      cv_blob_url = null, cv_pathname = null, cv_original_filename = null,
      cv_size_bytes = null, cv_uploaded_at = null
    where id = ${id}
    returning (select cv_pathname from previous) as previous_cv_pathname
  `;
  if (rows.length === 0) return null;
  const previousCvPathname = (rows[0] as { previous_cv_pathname: string | null }).previous_cv_pathname;
  return previousCvPathname ? { cvPathname: previousCvPathname } : null;
}

export type RecruitingWindowRow = {
  id: string;
  semester: string;
  start: string;
  end: string;
  createdAt: Date;
  // The interview-availability grid this window's applicants are offered —
  // see migrations/0023's own comment on why these live on this row rather
  // than a table of their own. A window with no days configured yet reads
  // back an empty array, not null: the column itself has a not-null
  // default (unlike departments/desired_areas, there is no "predates the
  // feature" state to preserve here, since every recruiting_windows row
  // either has this configured or genuinely has no interview days yet).
  interviewDays: string[];
  interviewStartTime: string;
  interviewEndTime: string;
  interviewSlotMinutes: number;
};

function toRecruitingWindowRow(row: Record<string, unknown>): RecruitingWindowRow {
  return {
    id: row.id as string,
    semester: row.semester as string,
    // Kept as ISO strings, not Date objects: content/recruiting.ts's
    // RecruitingWindow type (still the shared shape every pure function in
    // lib/recruitingStatus.ts and lib/recruitingSemester.ts expects) stores
    // start/end as ISO datetime strings with an explicit UTC offset.
    start: (row.starts_at as Date).toISOString(),
    end: (row.ends_at as Date).toISOString(),
    createdAt: row.created_at as Date,
    interviewDays: (row.interview_days as string[] | null) ?? [],
    // ::text cast above strips any trailing seconds Postgres would
    // otherwise add to a `time` column's default text output — same
    // reasoning as calendarFormat.ts's start_date::text cast for `date`.
    interviewStartTime: ((row.interview_start_time as string | null) ?? "10:00").slice(0, 5),
    interviewEndTime: ((row.interview_end_time as string | null) ?? "19:00").slice(0, 5),
    interviewSlotMinutes: row.interview_slot_minutes as number,
  };
}

// The five-column select below (id, semester, starts_at, ends_at,
// created_at, plus the four interview_* columns) is repeated rather than
// shared across every query in this section, for the same reason
// insertApplication's own comment gives for area_choices: Neon's tagged
// template has no safe fragment-composition helper, so each query spells
// it out in full.
export async function listRecruitingWindows(): Promise<RecruitingWindowRow[]> {
  const rows = await sql()`
    select
      id, semester, starts_at, ends_at, created_at,
      interview_days::text[] as interview_days,
      interview_start_time::text as interview_start_time,
      interview_end_time::text as interview_end_time,
      interview_slot_minutes
    from recruiting_windows
    order by starts_at asc
  `;
  return (rows as Record<string, unknown>[]).map(toRecruitingWindowRow);
}

// Answered by Postgres rather than by comparing dates in the page: reading
// the clock during a server component's render is impure (the
// react-hooks/purity rule rejects it, rightly), and the database's `now()`
// is the same clock /api/cron/cleanup and the window checks already compare
// against — so there's one authoritative answer to "is anything still
// ahead?" instead of one per process.
export async function countFutureRecruitingWindows(): Promise<number> {
  const rows = await sql()`
    select count(*)::int as count from recruiting_windows where ends_at > now()
  `;
  return (rows[0] as Record<string, unknown>).count as number;
}

export async function findOverlappingRecruitingWindows(
  startsAt: Date,
  endsAt: Date,
  excludeId?: string,
): Promise<RecruitingWindowRow[]> {
  const rows = await sql()`
    select
      id, semester, starts_at, ends_at, created_at,
      interview_days::text[] as interview_days,
      interview_start_time::text as interview_start_time,
      interview_end_time::text as interview_end_time,
      interview_slot_minutes
    from recruiting_windows
    where tstzrange(starts_at, ends_at, '[]') && tstzrange(${startsAt.toISOString()}, ${endsAt.toISOString()}, '[]')
      and (${excludeId ?? null}::uuid is null or id != ${excludeId ?? null}::uuid)
  `;
  return (rows as Record<string, unknown>[]).map(toRecruitingWindowRow);
}

// The interview grid a create/edit submits alongside semester/start/end —
// pulled out as its own type since insertRecruitingWindow and
// updateRecruitingWindow both take it, and recruitingWindowFormSchema.ts's
// parsed output is exactly this shape.
export type InterviewGridInput = {
  interviewDays: string[];
  interviewStartTime: string;
  interviewEndTime: string;
  interviewSlotMinutes: number;
};

export async function insertRecruitingWindow(
  semester: string,
  startsAt: Date,
  endsAt: Date,
  grid: InterviewGridInput,
): Promise<RecruitingWindowRow> {
  const rows = await sql()`
    insert into recruiting_windows (
      semester, starts_at, ends_at, interview_days, interview_start_time, interview_end_time, interview_slot_minutes
    )
    values (
      ${semester}, ${startsAt.toISOString()}, ${endsAt.toISOString()}, ${grid.interviewDays}::date[],
      ${grid.interviewStartTime}::time, ${grid.interviewEndTime}::time, ${grid.interviewSlotMinutes}
    )
    returning
      id, semester, starts_at, ends_at, created_at,
      interview_days::text[] as interview_days,
      interview_start_time::text as interview_start_time,
      interview_end_time::text as interview_end_time,
      interview_slot_minutes
  `;
  return toRecruitingWindowRow(rows[0] as Record<string, unknown>);
}

export async function updateRecruitingWindow(
  id: string,
  semester: string,
  startsAt: Date,
  endsAt: Date,
  grid: InterviewGridInput,
): Promise<RecruitingWindowRow | null> {
  const rows = await sql()`
    update recruiting_windows
    set semester = ${semester}, starts_at = ${startsAt.toISOString()}, ends_at = ${endsAt.toISOString()},
      interview_days = ${grid.interviewDays}::date[],
      interview_start_time = ${grid.interviewStartTime}::time,
      interview_end_time = ${grid.interviewEndTime}::time,
      interview_slot_minutes = ${grid.interviewSlotMinutes}
    where id = ${id}
    returning
      id, semester, starts_at, ends_at, created_at,
      interview_days::text[] as interview_days,
      interview_start_time::text as interview_start_time,
      interview_end_time::text as interview_end_time,
      interview_slot_minutes
  `;
  return rows.length > 0 ? toRecruitingWindowRow(rows[0] as Record<string, unknown>) : null;
}

/**
 * Everything stored about one email address, across all three form tables —
 * the query behind /admin/loeschanfragen, which exists to answer GDPR
 * Art. 15 (what do you have on me) and Art. 17 (delete it).
 *
 * Unlike every other admin list, this one returns the *full* rows: an
 * access request is precisely a request for all of it, so narrowing the
 * select here would make the answer incomplete. That's also why it's keyed
 * by an exact address the board was given rather than a search — this is a
 * lookup for a named person, not a way to browse applicants.
 *
 * Case-insensitive: addresses are compared with lower(), because someone
 * writing in from Jane@Example.com about the data they submitted as
 * jane@example.com is the same person and would otherwise be told nothing
 * is stored.
 */
export type PersonalDataMatches = {
  applications: Application[];
  contactMessages: ContactMessage[];
  reminderSignups: ReminderSignupSummary[];
  ideathonSignups: IdeathonSignup[];
};

export async function findPersonalDataByEmail(email: string): Promise<PersonalDataMatches> {
  const needle = email.trim().toLowerCase();

  const applicationRows = await sql()`select * from applications where lower(email) = ${needle}`;
  const contactRows = await sql()`
    select id, created_at, name, email, subject, message, locale from contact_messages
    where lower(email) = ${needle}
  `;
  const reminderRows = await sql()`
    select id, created_at, email, confirmed, confirmed_at, unsubscribed_at, mail_status
    from reminder_signups where lower(email) = ${needle}
  `;
  const ideathonRows = await sql()`select * from ideathon_signups where lower(email) = ${needle}`;

  return {
    applications: (applicationRows as Record<string, unknown>[]).map(toApplication),
    contactMessages: (contactRows as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      createdAt: row.created_at as Date,
      name: row.name as string,
      email: row.email as string,
      subject: (row.subject as string | null) ?? undefined,
      message: row.message as string,
      locale: row.locale as Locale,
    })),
    reminderSignups: (reminderRows as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      createdAt: row.created_at as Date,
      email: row.email as string,
      confirmed: row.confirmed as boolean,
      confirmedAt: (row.confirmed_at as Date | null) ?? null,
      unsubscribedAt: (row.unsubscribed_at as Date | null) ?? null,
      mailStatus: row.mail_status as MailStatus,
    })),
    ideathonSignups: (ideathonRows as Record<string, unknown>[]).map(toIdeathonSignup),
  };
}

export type DeletedCounts = {
  applications: number;
  contactMessages: number;
  reminderSignups: number;
  ideathonSignups: number;
  // Every cv_pathname from a deleted application, so the route can
  // best-effort delete those blobs alongside an Art. 17 erasure — this is
  // the one deletion path where "the cron picks it up within 24 hours" is
  // not an acceptable answer.
  cvPathnames: string[];
};

// Four statements rather than one, because they're four tables — but note
// there is no transaction: if a later one fails, the earlier ones have
// already happened. That's the right failure mode for a deletion request,
// where having deleted *more* than the caller saw confirmed is the safe
// direction and a partial delete can simply be repeated.
export async function deletePersonalDataByEmail(email: string): Promise<DeletedCounts> {
  const needle = email.trim().toLowerCase();

  const applications = await sql()`
    delete from applications where lower(email) = ${needle} returning cv_pathname
  `;
  const contactMessages = await sql()`
    delete from contact_messages where lower(email) = ${needle} returning id
  `;
  const reminderSignups = await sql()`
    delete from reminder_signups where lower(email) = ${needle} returning id
  `;
  const ideathonSignups = await sql()`
    delete from ideathon_signups where lower(email) = ${needle} returning id
  `;

  const cvPathnames = (applications as { cv_pathname: string | null }[])
    .map((row) => row.cv_pathname)
    .filter((pathname): pathname is string => pathname !== null);

  return {
    applications: applications.length,
    contactMessages: contactMessages.length,
    reminderSignups: reminderSignups.length,
    ideathonSignups: ideathonSignups.length,
    cvPathnames,
  };
}

// Postgres 23505 = unique_violation. Recognised here rather than in a route
// so callers don't have to know the driver's error shape: entering the same
// semester label twice is an ordinary mistake that deserves a clear
// conflict, not a 500 that reads like the site is broken.
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export async function deleteRecruitingWindow(id: string): Promise<boolean> {
  const rows = await sql()`
    delete from recruiting_windows where id = ${id} returning id
  `;
  return rows.length > 0;
}

// Single-record lookup for the admin manual-trigger button
// (reminderWindowMail.ts) — picks one window by id regardless of whether
// it's open, past, or future, unlike findRecruitingWindowsNeedingReminderMail
// below.
export async function findRecruitingWindowById(id: string): Promise<RecruitingWindowRow | null> {
  const rows = await sql()`
    select
      id, semester, starts_at, ends_at, created_at,
      interview_days::text[] as interview_days,
      interview_start_time::text as interview_start_time,
      interview_end_time::text as interview_end_time,
      interview_slot_minutes
    from recruiting_windows where id = ${id}
  `;
  return rows.length > 0 ? toRecruitingWindowRow(rows[0] as Record<string, unknown>) : null;
}

/**
 * Self-healing detection for the cron's reminder-window job: a window
 * qualifies once it has opened (starts_at <= now()) AND at least one
 * confirmed, still-subscribed signup has no reminder_window_mails row for
 * it yet. No "since the last run" timestamp anywhere — a missed cron slot,
 * a slow deploy, or clock drift all correct themselves on the very next
 * run instead of needing separately-tracked state, and a window
 * automatically stops being returned once every confirmed signup has a row
 * (sent or failed) for it.
 */
export async function findRecruitingWindowsNeedingReminderMail(now: Date): Promise<RecruitingWindowRow[]> {
  const rows = await sql()`
    select
      id, semester, starts_at, ends_at, created_at,
      interview_days::text[] as interview_days,
      interview_start_time::text as interview_start_time,
      interview_end_time::text as interview_end_time,
      interview_slot_minutes
    from recruiting_windows w
    where w.starts_at <= ${now.toISOString()}
      and exists (
        select 1 from reminder_signups rs
        where rs.confirmed = true and rs.unsubscribed_at is null
          and not exists (
            select 1 from reminder_window_mails rwm
            where rwm.reminder_signup_id = rs.id and rwm.recruiting_window_id = w.id
          )
      )
    order by w.starts_at asc
  `;
  return (rows as Record<string, unknown>[]).map(toRecruitingWindowRow);
}

export type CalendarCategory =
  | "innolab"
  | "projekte"
  | "journeys"
  | "wettkaempfe"
  | "socials"
  | "workshops"
  | "bewerbung";

export type CalendarEventRow = {
  id: string;
  title: string;
  titleEn: string | null;
  category: CalendarCategory;
  startDate: string;
  endDate: string | null;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  description: string | null;
  descriptionEn: string | null;
  tentative: boolean;
  internalLink: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CalendarEventInput = {
  title: string;
  titleEn?: string;
  category: CalendarCategory;
  startDate: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  description?: string;
  descriptionEn?: string;
  tentative: boolean;
  internalLink?: string;
};

// date/time columns are cast to text in every select below rather than left
// as the driver's own Date/string parsing: `date` and `time` have no
// timezone component in Postgres, but a JS Date object always carries one,
// and letting the driver round-trip through Date risks silently shifting a
// value by the server process's own timezone offset. Casting to text keeps
// the exact "YYYY-MM-DD" / "HH:MM:SS" Postgres already stores.
const CALENDAR_EVENT_COLUMNS = `
  id, title, title_en, category, start_date::text as start_date,
  end_date::text as end_date, start_time::text as start_time, end_time::text as end_time,
  location, description, description_en, tentative, internal_link, created_at, updated_at
`;

function toCalendarEventRow(row: Record<string, unknown>): CalendarEventRow {
  return {
    id: row.id as string,
    title: row.title as string,
    titleEn: (row.title_en as string | null) ?? null,
    category: row.category as CalendarCategory,
    startDate: row.start_date as string,
    endDate: (row.end_date as string | null) ?? null,
    // Postgres's text cast of `time` keeps seconds ("14:30:00"); trimmed to
    // the "HH:MM" shape calendarEventSchema and the admin form both use.
    startTime: row.start_time ? (row.start_time as string).slice(0, 5) : null,
    endTime: row.end_time ? (row.end_time as string).slice(0, 5) : null,
    location: (row.location as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    descriptionEn: (row.description_en as string | null) ?? null,
    tentative: row.tentative as boolean,
    internalLink: (row.internal_link as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function listCalendarEvents(): Promise<CalendarEventRow[]> {
  const rows = await sql().query(
    `select ${CALENDAR_EVENT_COLUMNS} from calendar_events order by start_date asc, start_time asc nulls first`,
  );
  return (rows as Record<string, unknown>[]).map(toCalendarEventRow);
}

export async function findCalendarEventById(id: string): Promise<CalendarEventRow | null> {
  const rows = await sql().query(`select ${CALENDAR_EVENT_COLUMNS} from calendar_events where id = $1`, [id]);
  return rows.length > 0 ? toCalendarEventRow(rows[0] as Record<string, unknown>) : null;
}

export async function insertCalendarEvent(input: CalendarEventInput): Promise<CalendarEventRow> {
  const rows = await sql()`
    insert into calendar_events (
      title, title_en, category, start_date, end_date, start_time, end_time,
      location, description, description_en, tentative, internal_link
    ) values (
      ${input.title}, ${input.titleEn ?? null}, ${input.category}, ${input.startDate},
      ${input.endDate ?? null}, ${input.startTime ?? null}, ${input.endTime ?? null},
      ${input.location ?? null}, ${input.description ?? null}, ${input.descriptionEn ?? null},
      ${input.tentative}, ${input.internalLink ?? null}
    )
    returning id
  `;
  // Re-read through the text-cast select rather than adding a second
  // `returning` clause with the same casts spelled out again — one place
  // defines how a row is shaped coming out of this table.
  const created = await findCalendarEventById((rows[0] as Record<string, unknown>).id as string);
  if (!created) throw new Error("Inserted calendar event could not be re-read");
  return created;
}

export async function updateCalendarEvent(
  id: string,
  input: CalendarEventInput,
): Promise<CalendarEventRow | null> {
  const rows = await sql()`
    update calendar_events
    set
      title = ${input.title},
      title_en = ${input.titleEn ?? null},
      category = ${input.category},
      start_date = ${input.startDate},
      end_date = ${input.endDate ?? null},
      start_time = ${input.startTime ?? null},
      end_time = ${input.endTime ?? null},
      location = ${input.location ?? null},
      description = ${input.description ?? null},
      description_en = ${input.descriptionEn ?? null},
      tentative = ${input.tentative},
      internal_link = ${input.internalLink ?? null},
      updated_at = now()
    where id = ${id}
    returning id
  `;
  if (rows.length === 0) return null;
  return findCalendarEventById(id);
}

export async function deleteCalendarEvent(id: string): Promise<boolean> {
  const rows = await sql()`
    delete from calendar_events where id = ${id} returning id
  `;
  return rows.length > 0;
}

/**
 * The "Wunschbereich" checkbox list on the /mitmachen application form
 * (/admin/wunschbereiche), migrations/0010. Unlike calendar_events this
 * table has both `active` and `sort_order` — new to this codebase, needed
 * because the list changes every semester and the board has to be able to
 * retire an area without touching the applications that already reference
 * it. applications.desired_areas stores the chosen labels as plain
 * strings, not a foreign key to this table, so nothing here can ever break
 * a historic application.
 */
export type ProjectAreaRow = {
  id: string;
  labelDe: string;
  labelEn: string;
  sortOrder: number;
  active: boolean;
  // Whether choosing this area on /mitmachen shows the Ideathon hint
  // (ApplicationForm.tsx) — a board-set flag, migrations/0022, deliberately
  // not derived from the label: labelDe/labelEn are free text the board can
  // rename at any time, so keying the hint off a string match would break
  // the moment someone renamed "InnoLab" to anything else.
  ideathonHint: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectAreaInput = {
  labelDe: string;
  labelEn: string;
  sortOrder: number;
  active: boolean;
  ideathonHint: boolean;
};

const PROJECT_AREA_COLUMNS =
  "id, label_de, label_en, sort_order, active, ideathon_hint, created_at, updated_at";

function toProjectAreaRow(row: Record<string, unknown>): ProjectAreaRow {
  return {
    id: row.id as string,
    labelDe: row.label_de as string,
    labelEn: row.label_en as string,
    sortOrder: row.sort_order as number,
    active: row.active as boolean,
    ideathonHint: row.ideathon_hint as boolean,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

// Powers /admin/wunschbereiche — every area, active or not, in the board's
// own order.
export async function listProjectAreas(): Promise<ProjectAreaRow[]> {
  const rows = await sql().query(`select ${PROJECT_AREA_COLUMNS} from project_areas order by sort_order asc`);
  return (rows as Record<string, unknown>[]).map(toProjectAreaRow);
}

// Powers /mitmachen's checkbox list — only what the board has switched on,
// in their chosen order. The one query that actually reaches an applicant.
export async function listActiveProjectAreas(): Promise<ProjectAreaRow[]> {
  const rows = await sql().query(
    `select ${PROJECT_AREA_COLUMNS} from project_areas where active = true order by sort_order asc`,
  );
  return (rows as Record<string, unknown>[]).map(toProjectAreaRow);
}

export async function insertProjectArea(input: ProjectAreaInput): Promise<ProjectAreaRow> {
  const rows = await sql()`
    insert into project_areas (label_de, label_en, sort_order, active, ideathon_hint)
    values (${input.labelDe}, ${input.labelEn}, ${input.sortOrder}, ${input.active}, ${input.ideathonHint})
    returning id, label_de, label_en, sort_order, active, ideathon_hint, created_at, updated_at
  `;
  return toProjectAreaRow(rows[0] as Record<string, unknown>);
}

export async function updateProjectArea(id: string, input: ProjectAreaInput): Promise<ProjectAreaRow | null> {
  const rows = await sql()`
    update project_areas
    set label_de = ${input.labelDe}, label_en = ${input.labelEn}, sort_order = ${input.sortOrder},
        active = ${input.active}, ideathon_hint = ${input.ideathonHint}, updated_at = now()
    where id = ${id}
    returning id, label_de, label_en, sort_order, active, ideathon_hint, created_at, updated_at
  `;
  return rows.length > 0 ? toProjectAreaRow(rows[0] as Record<string, unknown>) : null;
}

export async function deleteProjectArea(id: string): Promise<boolean> {
  const rows = await sql()`delete from project_areas where id = ${id} returning id`;
  return rows.length > 0;
}

/**
 * The "Ressort" checkbox list on the /mitmachen application form
 * (/admin/ressorts), migrations/0020. Structurally identical to
 * project_areas above — same columns, same label-snapshot rule, same
 * deactivate-don't-delete lifecycle — because it is deliberately the same
 * concept applied to a second category, not a second design. What differs is
 * only how an application stores the choice: no priority, no reason, so a
 * plain applications.departments text[] rather than a child table.
 */
export type DepartmentRow = {
  id: string;
  labelDe: string;
  labelEn: string;
  sortOrder: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type DepartmentInput = {
  labelDe: string;
  labelEn: string;
  sortOrder: number;
  active: boolean;
};

const DEPARTMENT_COLUMNS = "id, label_de, label_en, sort_order, active, created_at, updated_at";

function toDepartmentRow(row: Record<string, unknown>): DepartmentRow {
  return {
    id: row.id as string,
    labelDe: row.label_de as string,
    labelEn: row.label_en as string,
    sortOrder: row.sort_order as number,
    active: row.active as boolean,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

// Powers /admin/ressorts — every department, active or not, in the board's
// own order.
export async function listDepartments(): Promise<DepartmentRow[]> {
  const rows = await sql().query(`select ${DEPARTMENT_COLUMNS} from departments order by sort_order asc`);
  return (rows as Record<string, unknown>[]).map(toDepartmentRow);
}

// Powers /mitmachen's Ressort checkboxes — only what the board has switched
// on. A deactivated department therefore never reaches an applicant, while
// staying readable in every application that already named it.
export async function listActiveDepartments(): Promise<DepartmentRow[]> {
  const rows = await sql().query(
    `select ${DEPARTMENT_COLUMNS} from departments where active = true order by sort_order asc`,
  );
  return (rows as Record<string, unknown>[]).map(toDepartmentRow);
}

export async function insertDepartment(input: DepartmentInput): Promise<DepartmentRow> {
  const rows = await sql()`
    insert into departments (label_de, label_en, sort_order, active)
    values (${input.labelDe}, ${input.labelEn}, ${input.sortOrder}, ${input.active})
    returning id, label_de, label_en, sort_order, active, created_at, updated_at
  `;
  return toDepartmentRow(rows[0] as Record<string, unknown>);
}

export async function updateDepartment(id: string, input: DepartmentInput): Promise<DepartmentRow | null> {
  const rows = await sql()`
    update departments
    set label_de = ${input.labelDe}, label_en = ${input.labelEn}, sort_order = ${input.sortOrder},
        active = ${input.active}, updated_at = now()
    where id = ${id}
    returning id, label_de, label_en, sort_order, active, created_at, updated_at
  `;
  return rows.length > 0 ? toDepartmentRow(rows[0] as Record<string, unknown>) : null;
}

export async function deleteDepartment(id: string): Promise<boolean> {
  const rows = await sql()`delete from departments where id = ${id} returning id`;
  return rows.length > 0;
}

export type EmploymentType = "praktikum" | "werkstudent" | "abschlussarbeit" | "einstieg";
export type RemoteOption = "vor_ort" | "hybrid" | "remote";

export type JobPostingRow = {
  id: string;
  company: string;
  title: string;
  employmentType: EmploymentType;
  location: string | null;
  remote: RemoteOption;
  description: string | null;
  applyUrl: string;
  expiresAt: string;
  partnerSlug: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type JobPostingInput = {
  company: string;
  title: string;
  employmentType: EmploymentType;
  location?: string;
  remote: RemoteOption;
  description?: string;
  applyUrl: string;
  expiresAt: string;
  partnerSlug?: string;
};

// expires_at cast to text, not left as the driver's own Date parsing — same
// reasoning as CALENDAR_EVENT_COLUMNS above: a plain `date` column has no
// timezone, and letting the driver round-trip through a JS Date risks
// silently shifting the value by the server process's own offset.
const JOB_POSTING_COLUMNS = `
  id, company, title, employment_type, location, remote, description,
  apply_url, expires_at::text as expires_at, partner_slug, created_at, updated_at
`;

function toJobPostingRow(row: Record<string, unknown>): JobPostingRow {
  return {
    id: row.id as string,
    company: row.company as string,
    title: row.title as string,
    employmentType: row.employment_type as EmploymentType,
    location: (row.location as string | null) ?? null,
    remote: row.remote as RemoteOption,
    description: (row.description as string | null) ?? null,
    applyUrl: row.apply_url as string,
    expiresAt: row.expires_at as string,
    partnerSlug: (row.partner_slug as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

// Powers /admin/jobs — every posting, expired ones included, so the board
// can still find and edit or delete one after it's lapsed.
export async function listJobPostings(): Promise<JobPostingRow[]> {
  const rows = await sql().query(
    `select ${JOB_POSTING_COLUMNS} from job_postings order by created_at desc`,
  );
  return (rows as Record<string, unknown>[]).map(toJobPostingRow);
}

// Powers /jobs and /api/job-postings — the server-side filter the brief asks
// for: an expired posting is excluded by this query, not merely hidden in
// the UI. current_date is Postgres's own clock, the same authority every
// other "is anything still ahead" question in this file already defers to.
export async function listActiveJobPostings(): Promise<JobPostingRow[]> {
  const rows = await sql().query(
    `select ${JOB_POSTING_COLUMNS} from job_postings where expires_at >= current_date order by created_at desc`,
  );
  return (rows as Record<string, unknown>[]).map(toJobPostingRow);
}

export async function findJobPostingById(id: string): Promise<JobPostingRow | null> {
  const rows = await sql().query(`select ${JOB_POSTING_COLUMNS} from job_postings where id = $1`, [id]);
  return rows.length > 0 ? toJobPostingRow(rows[0] as Record<string, unknown>) : null;
}

export async function insertJobPosting(input: JobPostingInput): Promise<JobPostingRow> {
  const rows = await sql()`
    insert into job_postings (
      company, title, employment_type, location, remote, description,
      apply_url, expires_at, partner_slug
    ) values (
      ${input.company}, ${input.title}, ${input.employmentType}, ${input.location ?? null},
      ${input.remote}, ${input.description ?? null}, ${input.applyUrl}, ${input.expiresAt},
      ${input.partnerSlug ?? null}
    )
    returning id
  `;
  const created = await findJobPostingById((rows[0] as Record<string, unknown>).id as string);
  if (!created) throw new Error("Inserted job posting could not be re-read");
  return created;
}

export async function updateJobPosting(id: string, input: JobPostingInput): Promise<JobPostingRow | null> {
  const rows = await sql()`
    update job_postings
    set
      company = ${input.company},
      title = ${input.title},
      employment_type = ${input.employmentType},
      location = ${input.location ?? null},
      remote = ${input.remote},
      description = ${input.description ?? null},
      apply_url = ${input.applyUrl},
      expires_at = ${input.expiresAt},
      partner_slug = ${input.partnerSlug ?? null},
      updated_at = now()
    where id = ${id}
    returning id
  `;
  if (rows.length === 0) return null;
  return findJobPostingById(id);
}

export async function deleteJobPosting(id: string): Promise<boolean> {
  const rows = await sql()`
    delete from job_postings where id = ${id} returning id
  `;
  return rows.length > 0;
}

// The retention rule is anchored to each row's own expires_at, not its
// created_at (content/retention.ts) — unlike every other deleteExpired*
// function in this file, so `cutoff` here is compared against expires_at.
export async function deleteExpiredJobPostings(cutoff: Date): Promise<number> {
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const rows = await sql()`
    delete from job_postings where expires_at <= ${cutoffDate} returning id
  `;
  return rows.length;
}

export type ReminderSignupResult = {
  id: string;
  confirmed: boolean;
  confirmToken: string;
  unsubscribeToken: string;
};

// A single upsert, not a read-then-write: on a repeat signup for an
// already-confirmed address, the CASE keeps the existing tokens instead of
// minting new ones, so a confirmed subscriber's unsubscribe link never
// changes underneath them just because they filled the form in twice.
export async function upsertReminderSignup(
  email: string,
  confirmToken: string,
  unsubscribeToken: string,
  locale: Locale,
): Promise<ReminderSignupResult> {
  const rows = await sql()`
    insert into reminder_signups (email, confirm_token, unsubscribe_token, locale)
    values (${email}, ${confirmToken}, ${unsubscribeToken}, ${locale})
    on conflict (email) do update set
      confirm_token = case
        when reminder_signups.confirmed then reminder_signups.confirm_token
        else excluded.confirm_token
      end,
      unsubscribe_token = case
        when reminder_signups.confirmed then reminder_signups.unsubscribe_token
        else excluded.unsubscribe_token
      end,
      locale = excluded.locale
    returning id, confirmed, confirm_token, unsubscribe_token
  `;
  const row = rows[0] as Record<string, unknown>;
  return {
    id: row.id as string,
    confirmed: row.confirmed as boolean,
    confirmToken: row.confirm_token as string,
    unsubscribeToken: row.unsubscribe_token as string,
  };
}

export type ConfirmedReminderSignup = {
  id: string;
  email: string;
  locale: Locale;
  unsubscribeToken: string;
};

// The same mail bookkeeping applications and contact_messages already had
// (migrations/0004). Without it a subscriber whose double-opt-in link never
// arrived was invisible: /api/reminder logged the failure and moved on, so
// nobody could tell "never confirmed because they chose not to" from
// "never confirmed because the mail never came".
export async function markReminderMailed(id: string): Promise<void> {
  await sql()`
    update reminder_signups set mail_status = 'sent', mailed_at = now(), mail_error = null
    where id = ${id}
  `;
}

export async function markReminderMailFailed(id: string, error: string): Promise<void> {
  await sql()`
    update reminder_signups set mail_status = 'failed', mail_error = ${error}
    where id = ${id}
  `;
}

export type ReminderSignupRecord = {
  id: string;
  createdAt: Date;
  email: string;
  confirmed: boolean;
  confirmedAt: Date | null;
  unsubscribedAt: Date | null;
  locale: Locale;
  confirmToken: string;
  unsubscribeToken: string;
  mailStatus: MailStatus;
};

function toReminderSignupRecord(row: Record<string, unknown>): ReminderSignupRecord {
  return {
    id: row.id as string,
    createdAt: row.created_at as Date,
    email: row.email as string,
    confirmed: row.confirmed as boolean,
    confirmedAt: (row.confirmed_at as Date | null) ?? null,
    unsubscribedAt: (row.unsubscribed_at as Date | null) ?? null,
    locale: row.locale as Locale,
    confirmToken: row.confirm_token as string,
    unsubscribeToken: row.unsubscribe_token as string,
    mailStatus: row.mail_status as MailStatus,
  };
}

/**
 * Powers /admin/erinnerungen and its CSV export. Deliberately narrower than
 * ReminderSignupRecord: the two tokens stay out, because a list rendered in
 * a browser (and exported to a file that gets emailed around) has no
 * business carrying live confirm and unsubscribe links for other people's
 * addresses — anyone holding the export could confirm or unsubscribe them.
 */
export type ReminderSignupSummary = {
  id: string;
  createdAt: Date;
  email: string;
  confirmed: boolean;
  confirmedAt: Date | null;
  unsubscribedAt: Date | null;
  mailStatus: MailStatus;
};

export async function listReminderSignups(): Promise<ReminderSignupSummary[]> {
  const rows = await sql()`
    select id, created_at, email, confirmed, confirmed_at, unsubscribed_at, mail_status
    from reminder_signups
    order by created_at desc
  `;
  return (rows as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    createdAt: row.created_at as Date,
    email: row.email as string,
    confirmed: row.confirmed as boolean,
    confirmedAt: (row.confirmed_at as Date | null) ?? null,
    unsubscribedAt: (row.unsubscribed_at as Date | null) ?? null,
    mailStatus: row.mail_status as MailStatus,
  }));
}

// Includes both tokens, unlike listReminderSignups above: resending a
// confirmation mail has to rebuild the very links the original contained,
// and those are the tokens. Single-record only, never used for a list.
export async function findReminderSignupById(id: string): Promise<ReminderSignupRecord | null> {
  const rows = await sql()`
    select id, created_at, email, confirmed, confirmed_at, unsubscribed_at, locale,
           confirm_token, unsubscribe_token, mail_status
    from reminder_signups where id = ${id}
  `;
  return rows.length > 0 ? toReminderSignupRecord(rows[0] as Record<string, unknown>) : null;
}

// The WHERE clause is the entire race guard: a second click on the same
// confirmation link (or two concurrent clicks) finds zero rows the second
// time, because `confirmed` is already true — no read-then-write gap to
// double-confirm through. The follow-up SELECT below (only reached when the
// UPDATE itself affected nothing) doesn't need that same atomicity: it runs
// purely to word the confirmation page correctly after the fact — "already
// confirmed" versus "never existed" — and a race between the two reads is
// harmless, worst case it shows the generic already-confirmed wording to
// whichever request lost a photo-finish.
export type ConfirmReminderResult =
  | { status: "confirmed"; id: string; email: string; locale: Locale }
  | { status: "already-confirmed"; locale: Locale }
  | { status: "invalid" };

export async function confirmReminderSignup(
  token: string,
  confirmationIp: string,
): Promise<ConfirmReminderResult> {
  const rows = await sql()`
    update reminder_signups
    set confirmed = true, confirmed_at = now(), confirmation_ip = ${confirmationIp}
    where confirm_token = ${token} and confirmed = false
    returning id, email, locale
  `;
  if (rows.length > 0) {
    const row = rows[0] as Record<string, unknown>;
    return { status: "confirmed", id: row.id as string, email: row.email as string, locale: row.locale as Locale };
  }

  const existing = await sql()`
    select locale from reminder_signups where confirm_token = ${token} and confirmed = true
  `;
  if (existing.length > 0) {
    return { status: "already-confirmed", locale: (existing[0] as Record<string, unknown>).locale as Locale };
  }
  return { status: "invalid" };
}

// Same "the UPDATE is the race guard, the fallback SELECT is just for
// wording" split as confirmReminderSignup above. Unlike confirmation,
// re-unsubscribing an already-unsubscribed token isn't an error to report —
// the visitor's actual goal ("stop emailing me") is already satisfied
// either way, so both cases resolve to the same "unsubscribed" status.
export type UnsubscribeReminderResult = { status: "unsubscribed"; locale: Locale } | { status: "invalid" };

export async function unsubscribeReminder(token: string): Promise<UnsubscribeReminderResult> {
  const rows = await sql()`
    update reminder_signups
    set unsubscribed_at = now()
    where unsubscribe_token = ${token} and unsubscribed_at is null
    returning id, locale
  `;
  if (rows.length > 0) {
    const row = rows[0] as Record<string, unknown>;
    return { status: "unsubscribed", locale: row.locale as Locale };
  }

  const existing = await sql()`
    select locale from reminder_signups where unsubscribe_token = ${token}
  `;
  if (existing.length > 0) {
    return { status: "unsubscribed", locale: (existing[0] as Record<string, unknown>).locale as Locale };
  }
  return { status: "invalid" };
}

// The query the "unconfirmed rows are never mailed" guarantee rests on:
// both conditions are enforced here, in the query itself, rather than left
// to a caller to remember to filter for. Includes unsubscribe_token (unlike
// most reminder_signups reads) because this list's one consumer,
// reminderWindowMail.ts, has to build a working unsubscribe link into every
// window-open mail it sends — reusing each signup's existing token, the
// same one dispatchReminderConfirmation already used, never reissued.
export async function findConfirmedReminderSignups(): Promise<ConfirmedReminderSignup[]> {
  const rows = await sql()`
    select id, email, locale, unsubscribe_token from reminder_signups
    where confirmed = true and unsubscribed_at is null
  `;
  return (rows as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    email: row.email as string,
    locale: row.locale as Locale,
    unsubscribeToken: row.unsubscribe_token as string,
  }));
}

// Deletes two disjoint groups in one statement: unconfirmed rows nobody
// ever completed the double opt-in for (once stale), and confirmed rows
// whose subscriber has since unsubscribed (kept only long enough for the
// unsubscribe itself to be recorded, then swept on the next run).
export async function deleteExpiredReminderSignups(unconfirmedCutoff: Date): Promise<number> {
  const rows = await sql()`
    delete from reminder_signups
    where (confirmed = false and created_at < ${unconfirmedCutoff.toISOString()})
       or unsubscribed_at is not null
    returning id
  `;
  return rows.length;
}

// The board's own manual delete, from /admin/erinnerungen — distinct from
// deleteExpiredReminderSignups above (retention, cron-driven). Deleting the
// row here also removes any reminder_window_mails referencing it, via that
// table's own `on delete cascade` foreign key (migrations/0009) — no
// separate cleanup needed.
export async function deleteReminderSignup(id: string): Promise<boolean> {
  const rows = await sql()`delete from reminder_signups where id = ${id} returning id`;
  return rows.length > 0;
}

/**
 * The "an application window just opened" mail (reminderWindowMail.ts),
 * migrations/0009. Sending is claim-then-send: this insert is the entire
 * once-per-(signup, window) guarantee, enforced by the table's own unique
 * constraint rather than by anything in application code. Zero rows back
 * means another cron run — or the admin's manual-trigger button, racing it
 * — already claimed this exact pair; the caller skips, no send attempted.
 * No caller ever needs an id back to *not* send, only to send, which is
 * why this returns null instead of throwing on a conflict.
 */
export async function claimReminderWindowMail(params: {
  reminderSignupId: string;
  recruitingWindowId: string;
  email: string;
  locale: Locale;
  semester: string;
  windowEndsAt: string;
}): Promise<string | null> {
  const rows = await sql()`
    insert into reminder_window_mails (
      reminder_signup_id, recruiting_window_id, email, locale, semester, window_ends_at
    ) values (
      ${params.reminderSignupId}, ${params.recruitingWindowId}, ${params.email}, ${params.locale},
      ${params.semester}, ${params.windowEndsAt}
    )
    on conflict (reminder_signup_id, recruiting_window_id) do nothing
    returning id
  `;
  return rows.length > 0 ? ((rows[0] as Record<string, unknown>).id as string) : null;
}

export async function markReminderWindowMailSent(id: string): Promise<void> {
  await sql()`
    update reminder_window_mails set mail_status = 'sent', mailed_at = now(), mail_error = null
    where id = ${id}
  `;
}

export async function markReminderWindowMailFailed(id: string, error: string): Promise<void> {
  await sql()`
    update reminder_window_mails set mail_status = 'failed', mail_error = ${error}
    where id = ${id}
  `;
}

export type ReminderWindowMailRecord = {
  id: string;
  email: string;
  locale: Locale;
  semester: string;
  windowEndsAt: string;
  unsubscribeToken: string;
};

// Powers /admin/mails's resend for this source. Reads semester/windowEndsAt
// back off the row itself, not a join to recruiting_windows — the row has
// to stay resendable even after its window has since been deleted, same
// reasoning as storing email redundantly (listFailedMails). The join to
// reminder_signups is safe unconditionally, unlike that one: reminder_signup_id
// is `references reminder_signups(id) on delete cascade`, so this row can
// never outlive the signup it points at — there is no case where the join
// finds nothing.
export async function findReminderWindowMailById(id: string): Promise<ReminderWindowMailRecord | null> {
  const rows = await sql()`
    select rwm.id, rwm.email, rwm.locale, rwm.semester, rwm.window_ends_at, rs.unsubscribe_token
    from reminder_window_mails rwm
    join reminder_signups rs on rs.id = rwm.reminder_signup_id
    where rwm.id = ${id}
  `;
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    id: row.id as string,
    email: row.email as string,
    locale: row.locale as Locale,
    semester: row.semester as string,
    windowEndsAt: (row.window_ends_at as Date).toISOString(),
    unsubscribeToken: row.unsubscribe_token as string,
  };
}

/**
 * The Ideathon signup form (/ideathon), entirely separate from
 * `applications` — same mail_status trio and DB-before-mail discipline, but
 * its own table (migrations/0014) and its own field list. No PDF, no
 * recruiting-semester-style bucket: a signup belongs to whichever
 * calendar_events row was upcoming when it was submitted
 * (lib/ideathonEvent.ts decides that at request time), not something stored
 * redundantly on the row itself.
 */
export type IdeathonSignupInput = {
  firstName: string;
  lastName: string;
  email: string;
  studyProgram: string;
  semester: number;
  hasIdea: boolean;
  ideaDescription?: string;
  motivationExperience?: string;
  registeringAsTeam: boolean;
  teamSize?: number;
  teamMembers?: string;
  dietaryPreference: DietaryPreference;
  heardAboutUs?: string;
  locale: Locale;
};

export type IdeathonSignup = IdeathonSignupInput & {
  id: string;
  createdAt: Date;
  consentAt: Date;
  mailStatus: MailStatus;
  mailError: string | null;
  mailedAt: Date | null;
};

function toIdeathonSignup(row: Record<string, unknown>): IdeathonSignup {
  return {
    id: row.id as string,
    createdAt: row.created_at as Date,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    email: row.email as string,
    studyProgram: row.study_program as string,
    semester: row.semester as number,
    hasIdea: row.has_idea as boolean,
    ideaDescription: (row.idea_description as string | null) ?? undefined,
    motivationExperience: (row.motivation_experience as string | null) ?? undefined,
    registeringAsTeam: row.registering_as_team as boolean,
    teamSize: (row.team_size as number | null) ?? undefined,
    teamMembers: (row.team_members as string | null) ?? undefined,
    dietaryPreference: row.dietary_preference as DietaryPreference,
    heardAboutUs: (row.heard_about_us as string | null) ?? undefined,
    locale: row.locale as Locale,
    consentAt: row.consent_at as Date,
    mailStatus: row.mail_status as MailStatus,
    mailError: (row.mail_error as string | null) ?? null,
    mailedAt: (row.mailed_at as Date | null) ?? null,
  };
}

// consent_at, same reasoning as insertApplication: the database's own
// clock, never a client-supplied timestamp — it's the proof of consent.
export async function insertIdeathonSignup(input: IdeathonSignupInput): Promise<IdeathonSignup> {
  const rows = await sql()`
    insert into ideathon_signups (
      first_name, last_name, email, study_program, semester,
      has_idea, idea_description, motivation_experience, registering_as_team, team_size,
      team_members, dietary_preference, heard_about_us, locale, consent_at
    ) values (
      ${input.firstName}, ${input.lastName}, ${input.email},
      ${input.studyProgram}, ${input.semester}, ${input.hasIdea}, ${input.ideaDescription ?? null},
      ${input.motivationExperience ?? null}, ${input.registeringAsTeam}, ${input.teamSize ?? null},
      ${input.teamMembers ?? null}, ${input.dietaryPreference}, ${input.heardAboutUs ?? null},
      ${input.locale}, now()
    )
    returning *
  `;
  return toIdeathonSignup(rows[0] as Record<string, unknown>);
}

export async function markIdeathonSignupMailed(id: string): Promise<void> {
  await sql()`
    update ideathon_signups set mail_status = 'sent', mailed_at = now(), mail_error = null
    where id = ${id}
  `;
}

export async function markIdeathonSignupMailFailed(id: string, error: string): Promise<void> {
  await sql()`
    update ideathon_signups set mail_status = 'failed', mail_error = ${error}
    where id = ${id}
  `;
}

// Powers /admin/mails's resend, same reasoning as findApplicationById: the
// only query allowed to return a signup in full.
export async function findIdeathonSignupById(id: string): Promise<IdeathonSignup | null> {
  const rows = await sql()`select * from ideathon_signups where id = ${id}`;
  return rows.length > 0 ? toIdeathonSignup(rows[0] as Record<string, unknown>) : null;
}

export type IdeathonSignupSummary = {
  id: string;
  createdAt: Date;
  firstName: string;
  lastName: string;
  email: string;
  studyProgram: string;
  hasIdea: boolean;
  registeringAsTeam: boolean;
  teamSize: number | undefined;
  teamMembers: string | undefined;
  motivationExperience: string | undefined;
  dietaryPreference: DietaryPreference;
  mailStatus: MailStatus;
};

export async function listIdeathonSignups(): Promise<IdeathonSignupSummary[]> {
  const rows = await sql()`
    select id, created_at, first_name, last_name, email, study_program,
           has_idea, registering_as_team, team_size, team_members,
           motivation_experience, dietary_preference, mail_status
    from ideathon_signups
    order by created_at desc
  `;
  return (rows as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    createdAt: row.created_at as Date,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    email: row.email as string,
    studyProgram: row.study_program as string,
    hasIdea: row.has_idea as boolean,
    registeringAsTeam: row.registering_as_team as boolean,
    teamSize: (row.team_size as number | null) ?? undefined,
    teamMembers: (row.team_members as string | null) ?? undefined,
    motivationExperience: (row.motivation_experience as string | null) ?? undefined,
    dietaryPreference: row.dietary_preference as DietaryPreference,
    mailStatus: row.mail_status as MailStatus,
  }));
}

export async function deleteExpiredIdeathonSignups(cutoff: Date): Promise<number> {
  const rows = await sql()`
    delete from ideathon_signups where created_at <= ${cutoff.toISOString()} returning id
  `;
  return rows.length;
}

// The board's own manual delete, from /admin/ideathon-anmeldungen —
// distinct from deleteExpiredIdeathonSignups above (retention, cron-driven).
export async function deleteIdeathonSignup(id: string): Promise<boolean> {
  const rows = await sql()`delete from ideathon_signups where id = ${id} returning id`;
  return rows.length > 0;
}

export type ContactMessageInput = {
  name: string;
  email: string;
  subject?: string;
  message: string;
  locale: Locale;
  // Optional so every caller that builds a message for a mail (the test
  // send, the resend route) stays valid without knowing about spam at all;
  // only /api/kontakt ever sets them.
  spam?: boolean;
  spamReasons?: string[];
};

export type ContactMessage = ContactMessageInput & { id: string; createdAt: Date };

export async function insertContactMessage(input: ContactMessageInput): Promise<ContactMessage> {
  const rows = await sql()`
    insert into contact_messages (name, email, subject, message, locale, spam, spam_reasons)
    values (${input.name}, ${input.email}, ${input.subject ?? null}, ${input.message}, ${input.locale},
            ${input.spam ?? false}, ${input.spamReasons ?? []}::text[])
    returning id, created_at
  `;
  const row = rows[0] as Record<string, unknown>;
  return { ...input, id: row.id as string, createdAt: row.created_at as Date };
}

export async function markContactMessageMailed(id: string): Promise<void> {
  await sql()`
    update contact_messages set mail_status = 'sent', mail_error = null where id = ${id}
  `;
}

export async function markContactMessageMailFailed(id: string, error: string): Promise<void> {
  await sql()`
    update contact_messages set mail_status = 'failed', mail_error = ${error} where id = ${id}
  `;
}

export async function deleteExpiredContactMessages(cutoff: Date): Promise<number> {
  const rows = await sql()`
    delete from contact_messages where created_at < ${cutoff.toISOString()} returning id
  `;
  return rows.length;
}

/**
 * Powers /admin/kontakt. Carries the subject but not the message body: the
 * board reads the actual enquiry in the mailbox it was forwarded to, so
 * rendering it a second time in a browser tab would copy personal
 * correspondence somewhere it isn't needed. What this page is for is
 * answering "did it arrive, and if not why" — which needs the status, not
 * the content.
 */
export type ContactMessageSummary = {
  id: string;
  createdAt: Date;
  name: string;
  email: string;
  subject: string | null;
  mailStatus: MailStatus;
  spamReasons: string[];
};

export type ContactMessageView = "inbox" | "spam";

export async function listContactMessages(view: ContactMessageView = "inbox"): Promise<ContactMessageSummary[]> {
  const spam = view === "spam";
  const rows = await sql()`
    select id, created_at, name, email, subject, mail_status, spam_reasons
    from contact_messages
    where spam = ${spam}
    order by created_at desc
  `;
  return (rows as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    createdAt: row.created_at as Date,
    name: row.name as string,
    email: row.email as string,
    subject: (row.subject as string | null) ?? null,
    mailStatus: row.mail_status as MailStatus,
    spamReasons: (row.spam_reasons as string[] | null) ?? [],
  }));
}

export async function countContactMessages(): Promise<Record<ContactMessageView, number>> {
  const rows = await sql()`
    select count(*) filter (where not spam)::int as inbox,
           count(*) filter (where spam)::int as spam
    from contact_messages
  `;
  const row = (rows as Record<string, unknown>[])[0];
  return { inbox: row.inbox as number, spam: row.spam as number };
}

/**
 * "Kein Spam" in the admin. Returns the released message so the caller can
 * forward it, or null when no flagged row matched — which is also what a
 * double click sees, so a second request neither errors nor mails twice.
 * `spam_reasons` is left in place on purpose: it is the record of which rule
 * got it wrong.
 */
export async function clearContactMessageSpam(id: string): Promise<ContactMessage | null> {
  const rows = await sql()`
    update contact_messages set spam = false
    where id = ${id} and spam
    returning id, created_at, name, email, subject, message, locale
  `;
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    id: row.id as string,
    createdAt: row.created_at as Date,
    name: row.name as string,
    email: row.email as string,
    subject: (row.subject as string | null) ?? undefined,
    message: row.message as string,
    locale: row.locale as Locale,
  };
}

export async function findContactMessageById(id: string): Promise<ContactMessage | null> {
  const rows = await sql()`
    select id, created_at, name, email, subject, message, locale from contact_messages where id = ${id}
  `;
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    id: row.id as string,
    createdAt: row.created_at as Date,
    name: row.name as string,
    email: row.email as string,
    subject: (row.subject as string | null) ?? undefined,
    message: row.message as string,
    locale: row.locale as Locale,
  };
}

/**
 * The three form tables share one question — "whose notification never went
 * out?" — so /admin/mails asks it once, as one UNION ALL, rather than three
 * round trips the page would then have to interleave by date itself.
 *
 * `label` is whatever identifies the record to a human reading the list: an
 * applicant's name, a contact message's subject, and nothing at all for a
 * reminder signup, where the address *is* the record. It's built in SQL so
 * all three branches come back the same shape and a single `order by` can
 * sort across them.
 *
 * Note this is the only place mail_error is read back out. It holds a
 * provider message, never anything a visitor typed, so showing it to the
 * board leaks nothing — and without it the board can only see *that* a send
 * failed, not why, which is the difference between a fixable problem and a
 * mystery.
 */
export type FailedMailSource =
  | "applications"
  | "contact_messages"
  | "reminder_signups"
  | "reminder_window_mails"
  | "ideathon_signups";

export type FailedMail = {
  source: FailedMailSource;
  id: string;
  createdAt: Date;
  email: string;
  label: string;
  mailError: string | null;
};

export async function listFailedMails(): Promise<FailedMail[]> {
  // Held-back spam keeps mail_status 'pending' (nothing was ever attempted),
  // so it never shows up here or in mailHealthSnapshot; a message released
  // with "Kein Spam" is mailed then and can fail like any other.
  const rows = await sql()`
    select 'applications' as source, id, created_at, email,
           first_name || ' ' || last_name as label, mail_error
    from applications where mail_status = 'failed'
    union all
    select 'contact_messages' as source, id, created_at, email,
           coalesce(subject, '') as label, mail_error
    from contact_messages where mail_status = 'failed'
    union all
    select 'reminder_signups' as source, id, created_at, email,
           '' as label, mail_error
    from reminder_signups where mail_status = 'failed'
    union all
    select 'reminder_window_mails' as source, id, created_at, email,
           semester as label, mail_error
    from reminder_window_mails where mail_status = 'failed'
    union all
    select 'ideathon_signups' as source, id, created_at, email,
           first_name || ' ' || last_name as label, mail_error
    from ideathon_signups where mail_status = 'failed'
    order by created_at desc
  `;
  return (rows as Record<string, unknown>[]).map((row) => ({
    source: row.source as FailedMailSource,
    id: row.id as string,
    createdAt: row.created_at as Date,
    email: row.email as string,
    label: row.label as string,
    mailError: (row.mail_error as string | null) ?? null,
  }));
}

export type MailHealthSnapshot = {
  lastAttempt: { source: FailedMailSource; status: MailStatus; at: Date } | null;
  failedLast30Days: number;
};

/**
 * The most recent real send attempt across every mail-tracking table, plus
 * how many failed in the last 30 days — the only signal /admin/system's
 * Resend card needs (lib/serviceHealth.ts). Answers "did the last real send
 * work," not "is this key allowed to do something it never does here,"
 * which is what a domain-list or key-scope check would actually be asking.
 */
export async function mailHealthSnapshot(): Promise<MailHealthSnapshot> {
  const rows = await sql()`
    with attempts as (
      select 'applications' as source, mail_status, created_at
      from applications where mail_status <> 'pending'
      union all
      select 'contact_messages' as source, mail_status, created_at
      from contact_messages where mail_status <> 'pending'
      union all
      select 'reminder_signups' as source, mail_status, created_at
      from reminder_signups where mail_status <> 'pending'
      union all
      select 'reminder_window_mails' as source, mail_status, created_at
      from reminder_window_mails where mail_status <> 'pending'
      union all
      select 'ideathon_signups' as source, mail_status, created_at
      from ideathon_signups where mail_status <> 'pending'
    )
    select
      (select source from attempts order by created_at desc limit 1) as last_source,
      (select mail_status from attempts order by created_at desc limit 1) as last_status,
      (select created_at from attempts order by created_at desc limit 1) as last_at,
      (select count(*)::int from attempts
        where mail_status = 'failed' and created_at >= now() - interval '30 days') as failed_last_30_days
  `;
  const row = (rows as Record<string, unknown>[])[0];
  const lastSource = (row.last_source as FailedMailSource | null) ?? null;
  return {
    lastAttempt: lastSource
      ? { source: lastSource, status: row.last_status as MailStatus, at: row.last_at as Date }
      : null,
    failedLast30Days: row.failed_last_30_days as number,
  };
}

/**
 * The cron audit trail (migrations/0005). Written by /api/cron/cleanup and
 * read by /admin/system, which is the only reason it exists: Vercel keeps
 * runtime logs for a day on this plan, so "has the retention routine run
 * lately?" was unanswerable after that — and the job has already missed a
 * scheduled slot once without anything noticing.
 */
export type CronRun = {
  id: string;
  job: string;
  startedAt: Date;
  finishedAt: Date | null;
  ok: boolean;
  deletedApplications: number;
  deletedContactMessages: number;
  deletedReminderSignups: number;
  prunedRateLimitHits: number;
  sentReminderWindowMails: number;
  failedReminderWindowMails: number;
  deletedCvBlobs: number;
  deletedOrphanBlobs: number;
  remainingCvBlobs: number;
  error: string | null;
};

function toCronRun(row: Record<string, unknown>): CronRun {
  return {
    id: row.id as string,
    job: row.job as string,
    startedAt: row.started_at as Date,
    finishedAt: (row.finished_at as Date | null) ?? null,
    ok: row.ok as boolean,
    deletedApplications: row.deleted_applications as number,
    deletedContactMessages: row.deleted_contact_messages as number,
    deletedReminderSignups: row.deleted_reminder_signups as number,
    prunedRateLimitHits: row.pruned_rate_limit_hits as number,
    sentReminderWindowMails: row.sent_reminder_window_mails as number,
    failedReminderWindowMails: row.failed_reminder_window_mails as number,
    deletedCvBlobs: row.deleted_cv_blobs as number,
    deletedOrphanBlobs: row.deleted_orphan_blobs as number,
    remainingCvBlobs: row.remaining_cv_blobs as number,
    error: (row.error as string | null) ?? null,
  };
}

// Written before the deletes run, not after: a run that dies partway through
// still leaves a row, with ok = false and no finished_at. Recording only
// completed runs would make a crash look exactly like a run that never
// started, which is the distinction this table exists to make.
export async function startCronRun(job: string): Promise<string> {
  const rows = await sql()`insert into cron_runs (job) values (${job}) returning id`;
  return (rows[0] as Record<string, unknown>).id as string;
}

// `counts` is a partial: the cleanup job only ever populates its four
// deleted/pruned fields, the reminder-window job only its two
// sent/failed fields, the cv-blobs job only its three blob counters, and
// each leaves the other jobs' columns at their default 0 — all three jobs
// share this table but never share a row.
export async function finishCronRun(
  id: string,
  counts: {
    applications?: number | null;
    contactMessages?: number | null;
    reminderSignups?: number | null;
    rateLimitHits?: number | null;
    sentReminderWindowMails?: number | null;
    failedReminderWindowMails?: number | null;
    deletedCvBlobs?: number | null;
    deletedOrphanBlobs?: number | null;
    remainingCvBlobs?: number | null;
  },
  error: string | null,
): Promise<void> {
  await sql()`
    update cron_runs set
      finished_at = now(),
      ok = ${error === null},
      deleted_applications = ${counts.applications ?? 0},
      deleted_contact_messages = ${counts.contactMessages ?? 0},
      deleted_reminder_signups = ${counts.reminderSignups ?? 0},
      pruned_rate_limit_hits = ${counts.rateLimitHits ?? 0},
      sent_reminder_window_mails = ${counts.sentReminderWindowMails ?? 0},
      failed_reminder_window_mails = ${counts.failedReminderWindowMails ?? 0},
      deleted_cv_blobs = ${counts.deletedCvBlobs ?? 0},
      deleted_orphan_blobs = ${counts.deletedOrphanBlobs ?? 0},
      remaining_cv_blobs = ${counts.remainingCvBlobs ?? 0},
      error = ${error}
    where id = ${id}
  `;
}

export async function listCronRuns(limit = 10): Promise<CronRun[]> {
  const rows = await sql()`
    select id, job, started_at, finished_at, ok, deleted_applications,
           deleted_contact_messages, deleted_reminder_signups,
           pruned_rate_limit_hits, sent_reminder_window_mails,
           failed_reminder_window_mails, deleted_cv_blobs,
           deleted_orphan_blobs, remaining_cv_blobs, error
    from cron_runs
    order by started_at desc
    limit ${limit}
  `;
  return (rows as Record<string, unknown>[]).map(toCronRun);
}

// Powers the cv-blobs cron pass's orphan sweep: given every pathname
// currently sitting in the Blob store's bewerbungen/ prefix, which of them
// are still referenced by an application. Anything not in the result is a
// candidate for deletion — either the upload was never completed by a
// submission, or the row it belonged to is already gone.
export async function findReferencedCvPathnames(pathnames: string[]): Promise<string[]> {
  if (pathnames.length === 0) return [];
  const rows = await sql()`
    select cv_pathname from applications where cv_pathname = any(${pathnames})
  `;
  return (rows as { cv_pathname: string }[]).map((row) => row.cv_pathname);
}

/**
 * Row counts per table, for /admin/system. `count(*)` on tables this size
 * is trivially cheap, and one query keeps it to a single round trip.
 * Doubles as the database reachability check: if this resolves, Neon is
 * answering — no separate ping needed.
 */
export type TableCounts = {
  applications: number;
  contactMessages: number;
  reminderSignups: number;
  recruitingWindows: number;
  calendarEvents: number;
  jobPostings: number;
  rateLimitHits: number;
  cronRuns: number;
  ideathonSignups: number;
};

export async function countRowsPerTable(): Promise<TableCounts> {
  const rows = await sql()`
    select
      (select count(*)::int from applications) as applications,
      (select count(*)::int from contact_messages) as contact_messages,
      (select count(*)::int from reminder_signups) as reminder_signups,
      (select count(*)::int from recruiting_windows) as recruiting_windows,
      (select count(*)::int from calendar_events) as calendar_events,
      (select count(*)::int from job_postings) as job_postings,
      (select count(*)::int from rate_limit_hits) as rate_limit_hits,
      (select count(*)::int from cron_runs) as cron_runs,
      (select count(*)::int from ideathon_signups) as ideathon_signups
  `;
  const row = rows[0] as Record<string, unknown>;
  return {
    applications: row.applications as number,
    contactMessages: row.contact_messages as number,
    reminderSignups: row.reminder_signups as number,
    recruitingWindows: row.recruiting_windows as number,
    calendarEvents: row.calendar_events as number,
    jobPostings: row.job_postings as number,
    rateLimitHits: row.rate_limit_hits as number,
    cronRuns: row.cron_runs as number,
    ideathonSignups: row.ideathon_signups as number,
  };
}

// The one read against schema_migrations from application code — every
// other touch of that table belongs to scripts/migrate.mjs, which uses its
// own neon() handle rather than this file's. Ordering by name works because
// every migration filename is a zero-padded four-digit prefix, so
// lexicographic order matches numeric order up to 9999 files.
export async function latestAppliedMigrationName(): Promise<string | null> {
  const rows = await sql()`select name from schema_migrations order by name desc limit 1`;
  return (rows[0] as { name: string } | undefined)?.name ?? null;
}

// A plain read, no write — checkRateLimit (rateLimit.ts) calls this first
// so a request that's already over the limit gets rejected without
// touching the database at all. Zero rows means no hit recorded yet this
// window, i.e. a count of 0.
export async function peekRateLimit(bucket: string, windowStart: Date): Promise<number> {
  const rows = await sql()`
    select count from rate_limit_hits where bucket = ${bucket} and window_start = ${windowStart.toISOString()}
  `;
  return rows.length > 0 ? ((rows[0] as Record<string, unknown>).count as number) : 0;
}

// One roundtrip, not a read followed by a write: ON CONFLICT DO UPDATE
// increments and returns the new count atomically, so two concurrent
// requests from the same bucket can't both read the same stale count and
// both decide they're still under the limit. Only called once
// peekRateLimit has already confirmed the request is under the limit —
// this is the write that actually counts the request, not the check.
export async function consumeRateLimit(bucket: string, windowStart: Date): Promise<number> {
  const rows = await sql()`
    insert into rate_limit_hits (bucket, window_start, count)
    values (${bucket}, ${windowStart.toISOString()}, 1)
    on conflict (bucket, window_start) do update set count = rate_limit_hits.count + 1
    returning count
  `;
  return (rows[0] as Record<string, unknown>).count as number;
}

export async function pruneRateLimitHits(olderThan: Date): Promise<number> {
  const rows = await sql()`
    delete from rate_limit_hits where window_start < ${olderThan.toISOString()} returning bucket
  `;
  return rows.length;
}
