import { timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  deleteExpiredApplications,
  deleteExpiredContactMessages,
  deleteExpiredIdeathonSignups,
  deleteExpiredJobPostings,
  deleteExpiredReminderSignups,
  finishCronRun,
  findRecruitingWindowsNeedingReminderMail,
  findReferencedCvPathnames,
  pruneRateLimitHits,
  startCronRun,
} from "@/lib/db";
import { JOB_POSTINGS_REVALIDATE, JOB_POSTINGS_TAG } from "@/lib/jobPostings";
import {
  contactMessageRetentionCutoff,
  ideathonSignupRetentionCutoff,
  jobPostingRetentionCutoff,
  reminderSignupRetentionCutoff,
  rateLimitHitRetentionCutoff,
} from "@/lib/retentionCutoff";
import { sendReminderWindowMailsForWindow } from "@/lib/reminderWindowMail";
import { deleteCvBlobs, listCvBlobs } from "@/lib/cvBlob";

/**
 * Three independently-logged jobs behind one route, because Vercel Cron on
 * this project fires once a day and all three need that same daily slot —
 * deliberately not a second cron entry (the plan considered one; Hobby
 * allows only two daily-granularity jobs total, and the second slot stays
 * free rather than being spent here):
 *
 * 1. **cleanup** — enforces content/retention.ts, deleting whatever
 *    lib/retentionCutoff.ts says has expired. Reachable manually via
 *    `npm run db:cleanup` for a deployment where Cron isn't available.
 * 2. **cv-blobs** — deletes the CV blobs belonging to applications the
 *    cleanup pass just removed, then sweeps Vercel Blob for orphaned
 *    uploads (a file whose upload succeeded but whose application was
 *    never submitted) older than 24 hours. Runs in the middle, not last:
 *    it's the one pass enforcing an actual retention deadline on personal
 *    data, where a reminder mail arriving a day late is comparatively
 *    harmless. Batched (at most CV_BLOBS_MAX_ORPHANS_PER_RUN orphans per
 *    run) and budget-aware (skipped outright if CV_BLOBS_TIME_BUDGET_MS of
 *    the shared CRON_TIME_BUDGET_MS is already gone) so it can never turn
 *    one slow run into a function timeout — the rest is picked up the
 *    next day, and a skip is recorded as exactly that, not as a failure.
 * 3. **reminder-window** — mails everyone confirmed on the reminder list
 *    once an application window has opened (lib/reminderWindowMail.ts),
 *    at most once per (signup, window) pair, enforced by the database.
 *
 * Each runs in its own try/catch with its own startCronRun/finishCronRun
 * pair: a thrown error in one — including a failure to even record the
 * run's start — is caught and logged, then the handler proceeds to the
 * next regardless. No job's failure can suppress another's work or its own
 * cron_runs row, which matters most on exactly the days more than one job
 * actually has something to do.
 *
 * Auth is a single shared secret compared with a constant-time comparison
 * — not `===`, which leaks timing information about how many leading
 * bytes matched. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
 * automatically once CRON_SECRET is set as a project env var; with no
 * secret configured, every request is rejected rather than left open.
 */
const CRON_TIME_BUDGET_MS = 9000;
const CV_BLOBS_TIME_BUDGET_MS = 3000;
const CV_BLOBS_MAX_ORPHANS_PER_RUN = 50;
const CV_BLOB_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  if (!header || header.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

async function runCleanupJob(now: Date) {
  // Recorded before the work starts, so a run that dies partway through
  // still leaves evidence it was attempted (cron_runs, migrations/0005).
  // Wrapped because the audit trail must never be the thing that stops the
  // cleanup from happening: if this insert fails, the deletes still run,
  // just unrecorded.
  const runId = await startCronRun("cleanup").catch((error: unknown) => {
    console.error("Failed to record the start of the cleanup run", error);
    return null;
  });

  const [applications, contactMessages, reminderSignups, jobPostings, rateLimitHits, ideathonSignups] =
    await Promise.allSettled([
      deleteExpiredApplications(now),
      deleteExpiredContactMessages(contactMessageRetentionCutoff(now)),
      deleteExpiredReminderSignups(reminderSignupRetentionCutoff(now)),
      deleteExpiredJobPostings(jobPostingRetentionCutoff(now)),
      pruneRateLimitHits(rateLimitHitRetentionCutoff(now)),
      deleteExpiredIdeathonSignups(ideathonSignupRetentionCutoff(now)),
    ]);

  // deleteExpiredApplications also returns the cv_pathname of every row it
  // removed — handed to the cv-blobs pass below (not deleted here) so that
  // pass's own counters and time budget cover this work too, not just the
  // orphan sweep.
  const cvPathnamesFromExpiredApplications =
    applications.status === "fulfilled" ? applications.value.cvPathnames : [];

  // jobPostings and ideathonSignups aren't part of the counts object below:
  // cron_runs (migrations/0005_cron_runs.sql) has no deleted_job_postings or
  // deleted_ideathon_signups column, and both tables are purely additive —
  // so these deletions run and are reported in the response body, but don't
  // get a persisted per-run count the way the other four do.
  const summary = {
    applications: applications.status === "fulfilled" ? applications.value.count : null,
    contactMessages: contactMessages.status === "fulfilled" ? contactMessages.value : null,
    reminderSignups: reminderSignups.status === "fulfilled" ? reminderSignups.value : null,
    rateLimitHits: rateLimitHits.status === "fulfilled" ? rateLimitHits.value : null,
  };
  const jobPostingsDeleted = jobPostings.status === "fulfilled" ? jobPostings.value : null;
  const ideathonSignupsDeleted = ideathonSignups.status === "fulfilled" ? ideathonSignups.value : null;

  // Every admin route that touches this table invalidates the tag right
  // after its write (see jobPostings.ts); this sweep deletes rows too, and
  // without this it would be the one write path that doesn't, leaving an
  // expired posting on /jobs and in the nav until something else happens to
  // invalidate the tag. Gated on an actual delete: an unconditional call
  // here would turn a no-op nightly run into a site-wide cache write of its
  // own, which is the exact failure mode this whole fix exists to remove.
  if (jobPostingsDeleted !== null && jobPostingsDeleted > 0) {
    revalidateTag(JOB_POSTINGS_TAG, JOB_POSTINGS_REVALIDATE);
  }

  const failures: string[] = [];
  for (const [name, result] of Object.entries({
    applications,
    contactMessages,
    reminderSignups,
    jobPostings,
    rateLimitHits,
    ideathonSignups,
  })) {
    if (result.status === "rejected") {
      console.error(`Cleanup step "${name}" failed`, result.reason);
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(`${name}: ${reason}`);
    }
  }

  if (runId) {
    await finishCronRun(runId, summary, failures.length > 0 ? failures.join("; ") : null).catch(
      (error: unknown) => {
        console.error("Failed to record the end of the cleanup run", error);
      },
    );
  }

  return {
    ...summary,
    jobPostings: jobPostingsDeleted,
    ideathonSignups: ideathonSignupsDeleted,
    cvPathnamesFromExpiredApplications,
  };
}

// deadlineMs is a wall-clock Date.now() value, not a duration: computed
// once at the top of GET and threaded through, so "how much budget is
// left" reflects the whole request's elapsed time, not just this job's own.
async function runCvBlobsJob(cvPathnamesFromExpiredApplications: string[], deadlineMs: number) {
  const runId = await startCronRun("cv-blobs").catch((error: unknown) => {
    console.error("Failed to record the start of the cv-blobs run", error);
    return null;
  });

  let deletedCvBlobs = 0;
  let deletedOrphanBlobs = 0;
  let remainingCvBlobs = 0;
  let error: string | null = null;
  let skipped = false;

  if (Date.now() + CV_BLOBS_TIME_BUDGET_MS > deadlineMs) {
    // Not a failure — the other two jobs already used the shared budget,
    // most likely because there was genuinely more to clean up than usual.
    // Nothing here is lost: every check below re-runs in full tomorrow,
    // against whatever is still due by then.
    skipped = true;
    console.warn("cv-blobs run skipped: shared cron time budget already spent");
  } else {
    try {
      if (cvPathnamesFromExpiredApplications.length > 0) {
        await deleteCvBlobs(cvPathnamesFromExpiredApplications);
        deletedCvBlobs = cvPathnamesFromExpiredApplications.length;
      }

      // Orphan sweep: a blob under bewerbungen/ that either never got
      // attached to a submitted application (the visitor uploaded a CV,
      // then abandoned the form) or belonged to one already deleted by an
      // earlier, unrelated path (the admin's per-row delete, a GDPR
      // erasure) before this pass ever saw it. Bounded to one page and a
      // fixed per-run cap — the rest, if any, is exactly what
      // remainingCvBlobs reports and picks up again tomorrow.
      const blobs = await listCvBlobs(100);
      if (blobs.length > 0) {
        const referenced = new Set(await findReferencedCvPathnames(blobs.map((blob) => blob.pathname)));
        const orphanCutoff = Date.now() - CV_BLOB_ORPHAN_MIN_AGE_MS;
        const orphans = blobs.filter(
          (blob) => !referenced.has(blob.pathname) && blob.uploadedAt.getTime() < orphanCutoff,
        );
        const toDelete = orphans.slice(0, CV_BLOBS_MAX_ORPHANS_PER_RUN);
        if (toDelete.length > 0) {
          await deleteCvBlobs(toDelete.map((blob) => blob.pathname));
          deletedOrphanBlobs = toDelete.length;
        }
        remainingCvBlobs = orphans.length - toDelete.length;
      }
    } catch (caught) {
      console.error("cv-blobs job failed", caught);
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  if (runId) {
    await finishCronRun(runId, { deletedCvBlobs, deletedOrphanBlobs, remainingCvBlobs }, error).catch(
      (finishError: unknown) => {
        console.error("Failed to record the end of the cv-blobs run", finishError);
      },
    );
  }

  return { deletedCvBlobs, deletedOrphanBlobs, remainingCvBlobs, skipped, error };
}

async function runReminderWindowJob(now: Date) {
  const runId = await startCronRun("reminder-window").catch((error: unknown) => {
    console.error("Failed to record the start of the reminder-window run", error);
    return null;
  });

  let sent = 0;
  let failed = 0;
  let error: string | null = null;

  try {
    const windows = await findRecruitingWindowsNeedingReminderMail(now);
    for (const window of windows) {
      const result = await sendReminderWindowMailsForWindow(window);
      sent += result.sent;
      failed += result.failed;
    }
  } catch (caught) {
    console.error("Reminder-window job failed", caught);
    error = caught instanceof Error ? caught.message : String(caught);
  }

  if (runId) {
    await finishCronRun(runId, { sentReminderWindowMails: sent, failedReminderWindowMails: failed }, error).catch(
      (finishError: unknown) => {
        console.error("Failed to record the end of the reminder-window run", finishError);
      },
    );
  }

  return { sent, failed, error };
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const deadlineMs = Date.now() + CRON_TIME_BUDGET_MS;

  // All three jobs already record their own failures internally (every DB
  // call above is wrapped) and so never throw in practice — these
  // try/catches are the explicit guarantee, not a hope: whatever happens
  // inside one job, the next still runs.
  let deleted: Awaited<ReturnType<typeof runCleanupJob>> | null = null;
  try {
    deleted = await runCleanupJob(now);
  } catch (error) {
    console.error("Cleanup job threw outside its own error handling", error);
  }

  let cvBlobs: Awaited<ReturnType<typeof runCvBlobsJob>> | null = null;
  try {
    cvBlobs = await runCvBlobsJob(deleted?.cvPathnamesFromExpiredApplications ?? [], deadlineMs);
  } catch (error) {
    console.error("cv-blobs job threw outside its own error handling", error);
  }

  let reminderWindowMails: Awaited<ReturnType<typeof runReminderWindowJob>> | null = null;
  try {
    reminderWindowMails = await runReminderWindowJob(now);
  } catch (error) {
    console.error("Reminder-window job threw outside its own error handling", error);
  }

  return NextResponse.json({ ok: true, deleted, cvBlobs, reminderWindowMails });
}
