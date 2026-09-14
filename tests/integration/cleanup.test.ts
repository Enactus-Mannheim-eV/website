// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const revalidateTag = vi.fn();
vi.mock("next/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/cache")>();
  return { ...actual, revalidateTag: (...a: unknown[]) => revalidateTag(...a) };
});

const deleteExpiredApplications = vi.fn();
const deleteExpiredContactMessages = vi.fn();
const deleteExpiredReminderSignups = vi.fn();
const deleteExpiredJobPostings = vi.fn();
const deleteExpiredIdeathonSignups = vi.fn();
const pruneRateLimitHits = vi.fn();
const startCronRun = vi.fn();
const finishCronRun = vi.fn();
const findRecruitingWindowsNeedingReminderMail = vi.fn();
const findReferencedCvPathnames = vi.fn();

const sendReminderWindowMailsForWindow = vi.fn();

vi.mock("@/lib/db", () => ({
  deleteExpiredApplications: (...args: unknown[]) => deleteExpiredApplications(...args),
  deleteExpiredContactMessages: (...args: unknown[]) => deleteExpiredContactMessages(...args),
  deleteExpiredReminderSignups: (...args: unknown[]) => deleteExpiredReminderSignups(...args),
  deleteExpiredJobPostings: (...args: unknown[]) => deleteExpiredJobPostings(...args),
  deleteExpiredIdeathonSignups: (...args: unknown[]) => deleteExpiredIdeathonSignups(...args),
  pruneRateLimitHits: (...args: unknown[]) => pruneRateLimitHits(...args),
  startCronRun: (...args: unknown[]) => startCronRun(...args),
  finishCronRun: (...args: unknown[]) => finishCronRun(...args),
  findRecruitingWindowsNeedingReminderMail: (...args: unknown[]) => findRecruitingWindowsNeedingReminderMail(...args),
  findReferencedCvPathnames: (...args: unknown[]) => findReferencedCvPathnames(...args),
}));

// The reminder-window job's own send/claim logic (idempotency, batching) is
// covered by tests/unit/lib/reminderWindowMail.test.ts — this file only
// needs to prove the route wires the jobs together correctly and
// independently, so sendReminderWindowMailsForWindow is a plain stub here.
vi.mock("@/lib/reminderWindowMail", () => ({
  sendReminderWindowMailsForWindow: (...args: unknown[]) => sendReminderWindowMailsForWindow(...args),
}));

const deleteCvBlobs = vi.fn();
const listCvBlobs = vi.fn();
vi.mock("@/lib/cvBlob", () => ({
  deleteCvBlobs: (...args: unknown[]) => deleteCvBlobs(...args),
  listCvBlobs: (...args: unknown[]) => listCvBlobs(...args),
}));

// The cv-blobs job's own default response shape when there's nothing to
// delete and nothing orphaned — matches most tests below, which aren't
// testing that job specifically.
const EMPTY_CV_BLOBS = { deletedCvBlobs: 0, deletedOrphanBlobs: 0, remainingCvBlobs: 0, skipped: false, error: null };

function request(authHeader?: string) {
  return new NextRequest("http://localhost/api/cron/cleanup", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

describe("GET /api/cron/cleanup", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    startCronRun.mockResolvedValue("run-1");
    finishCronRun.mockResolvedValue(undefined);
    // Nothing due by default — most tests care about cleanup or about job
    // independence, not about what a window actually sends.
    findRecruitingWindowsNeedingReminderMail.mockResolvedValue([]);
    deleteCvBlobs.mockResolvedValue(undefined);
    listCvBlobs.mockResolvedValue([]);
    findReferencedCvPathnames.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.resetAllMocks();
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
    vi.resetModules();
  });

  it("rejects a request with no Authorization header and deletes nothing", async () => {
    process.env.CRON_SECRET = "test-secret";
    vi.resetModules();
    const { GET } = await import("@/app/api/cron/cleanup/route");

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(deleteExpiredApplications).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong secret and deletes nothing", async () => {
    process.env.CRON_SECRET = "test-secret";
    vi.resetModules();
    const { GET } = await import("@/app/api/cron/cleanup/route");

    const response = await GET(request("Bearer wrong-secret"));

    expect(response.status).toBe(401);
    expect(deleteExpiredApplications).not.toHaveBeenCalled();
  });

  it("rejects every request when CRON_SECRET itself is unset", async () => {
    delete process.env.CRON_SECRET;
    vi.resetModules();
    const { GET } = await import("@/app/api/cron/cleanup/route");

    const response = await GET(request("Bearer anything"));

    expect(response.status).toBe(401);
    expect(deleteExpiredApplications).not.toHaveBeenCalled();
  });

  it("runs every cleanup step and reports how many rows each deleted, given the right secret", async () => {
    process.env.CRON_SECRET = "test-secret";
    vi.resetModules();
    deleteExpiredApplications.mockResolvedValue({ count: 2, cvPathnames: [] });
    deleteExpiredContactMessages.mockResolvedValue(1);
    deleteExpiredReminderSignups.mockResolvedValue(3);
    deleteExpiredJobPostings.mockResolvedValue(4);
    pruneRateLimitHits.mockResolvedValue(10);
    deleteExpiredIdeathonSignups.mockResolvedValue(5);

    const { GET } = await import("@/app/api/cron/cleanup/route");
    const response = await GET(request("Bearer test-secret"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      deleted: {
        applications: 2,
        contactMessages: 1,
        reminderSignups: 3,
        jobPostings: 4,
        rateLimitHits: 10,
        ideathonSignups: 5,
        cvPathnamesFromExpiredApplications: [],
      },
      cvBlobs: EMPTY_CV_BLOBS,
      reminderWindowMails: { sent: 0, failed: 0, error: null },
    });
  });

  describe("the cv-blobs job", () => {
    beforeEach(() => {
      process.env.CRON_SECRET = "test-secret";
      vi.resetModules();
      deleteExpiredContactMessages.mockResolvedValue(0);
      deleteExpiredReminderSignups.mockResolvedValue(0);
      pruneRateLimitHits.mockResolvedValue(0);
    });

    it("deletes the CV blobs for every expired application the cleanup pass just removed", async () => {
      deleteExpiredApplications.mockResolvedValue({
        count: 2,
        cvPathnames: ["bewerbungen/a.pdf", "bewerbungen/b.pdf"],
      });

      const { GET } = await import("@/app/api/cron/cleanup/route");
      const response = await GET(request("Bearer test-secret"));

      expect(response.status).toBe(200);
      expect(deleteCvBlobs).toHaveBeenCalledWith(["bewerbungen/a.pdf", "bewerbungen/b.pdf"]);
      const body = await response.json();
      expect(body.cvBlobs).toEqual({ ...EMPTY_CV_BLOBS, deletedCvBlobs: 2 });
      expect(startCronRun).toHaveBeenCalledWith("cv-blobs");
    });

    it("still answers 200, and still runs the reminder-window job, when the blob delete itself fails", async () => {
      deleteExpiredApplications.mockResolvedValue({ count: 1, cvPathnames: ["bewerbungen/a.pdf"] });
      deleteCvBlobs.mockRejectedValue(new Error("blob store unreachable"));

      const { GET } = await import("@/app/api/cron/cleanup/route");
      const response = await GET(request("Bearer test-secret"));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.cvBlobs.error).toContain("blob store unreachable");
      expect(startCronRun).toHaveBeenCalledWith("reminder-window");
    });

    it("sweeps orphaned blobs older than 24 hours that no application references", async () => {
      deleteExpiredApplications.mockResolvedValue({ count: 0, cvPathnames: [] });
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const recent = new Date(Date.now() - 60 * 60 * 1000);
      listCvBlobs.mockResolvedValue([
        { pathname: "bewerbungen/orphan-old.pdf", uploadedAt: old },
        { pathname: "bewerbungen/orphan-recent.pdf", uploadedAt: recent },
        { pathname: "bewerbungen/referenced.pdf", uploadedAt: old },
      ]);
      findReferencedCvPathnames.mockResolvedValue(["bewerbungen/referenced.pdf"]);

      const { GET } = await import("@/app/api/cron/cleanup/route");
      const response = await GET(request("Bearer test-secret"));

      // Only the old, unreferenced blob qualifies — not the recent one
      // (still inside the 24h grace period an in-progress upload gets)
      // and not the referenced one (a real application still points to it).
      expect(deleteCvBlobs).toHaveBeenCalledWith(["bewerbungen/orphan-old.pdf"]);
      const body = await response.json();
      expect(body.cvBlobs).toEqual({ ...EMPTY_CV_BLOBS, deletedOrphanBlobs: 1 });
    });

    it("reports the orphans left over once the per-run cap is hit", async () => {
      deleteExpiredApplications.mockResolvedValue({ count: 0, cvPathnames: [] });
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      // One more than the per-run cap (50) — see the route's own
      // CV_BLOBS_MAX_ORPHANS_PER_RUN.
      listCvBlobs.mockResolvedValue(
        Array.from({ length: 51 }, (_, i) => ({ pathname: `bewerbungen/orphan-${i}.pdf`, uploadedAt: old })),
      );
      findReferencedCvPathnames.mockResolvedValue([]);

      const { GET } = await import("@/app/api/cron/cleanup/route");
      const response = await GET(request("Bearer test-secret"));

      const body = await response.json();
      expect(body.cvBlobs.deletedOrphanBlobs).toBe(50);
      expect(body.cvBlobs.remainingCvBlobs).toBe(1);
    });

    it("skips the pass entirely, without error, when the shared time budget is already spent", async () => {
      deleteExpiredApplications.mockResolvedValue({ count: 1, cvPathnames: ["bewerbungen/a.pdf"] });
      const realNow = Date.now;
      let callCount = 0;
      vi.spyOn(Date, "now").mockImplementation(() => {
        callCount += 1;
        // First call computes the deadline; by the time the cv-blobs job
        // checks its own remaining budget, the clock has "moved" past it.
        return callCount === 1 ? realNow() : realNow() + 60_000;
      });

      const { GET } = await import("@/app/api/cron/cleanup/route");
      const response = await GET(request("Bearer test-secret"));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.cvBlobs).toEqual({ ...EMPTY_CV_BLOBS, skipped: true });
      // Skipped, not failed — the row still exists tomorrow's run can pick
      // up, and this run's own status must not read as a failure.
      expect(deleteCvBlobs).not.toHaveBeenCalled();
      expect(listCvBlobs).not.toHaveBeenCalled();
    });
  });

  describe("job-postings cache invalidation", () => {
    // getJobPostings() (lib/jobPostings.ts) has no time-based expiry — every
    // other write path invalidates its tag immediately, and this sweep is
    // the one write path that used to skip that, leaving an expired posting
    // visible on /jobs and in the nav until the next unrelated mutation.
    beforeEach(() => {
      process.env.CRON_SECRET = "test-secret";
      vi.resetModules();
      deleteExpiredApplications.mockResolvedValue({ count: 0, cvPathnames: [] });
      deleteExpiredContactMessages.mockResolvedValue(0);
      deleteExpiredReminderSignups.mockResolvedValue(0);
      pruneRateLimitHits.mockResolvedValue(0);
      deleteExpiredIdeathonSignups.mockResolvedValue(0);
    });

    it("invalidates the job-postings tag when the sweep actually deletes a posting", async () => {
      deleteExpiredJobPostings.mockResolvedValue(2);

      const { GET } = await import("@/app/api/cron/cleanup/route");
      await GET(request("Bearer test-secret"));

      expect(revalidateTag).toHaveBeenCalledWith("job-postings", { expire: 0 });
    });

    it("does not touch the cache on a run with nothing expired", async () => {
      deleteExpiredJobPostings.mockResolvedValue(0);

      const { GET } = await import("@/app/api/cron/cleanup/route");
      await GET(request("Bearer test-secret"));

      expect(revalidateTag).not.toHaveBeenCalled();
    });

    it("does not invalidate when the job-postings delete itself fails", async () => {
      deleteExpiredJobPostings.mockRejectedValue(new Error("db unreachable"));

      const { GET } = await import("@/app/api/cron/cleanup/route");
      await GET(request("Bearer test-secret"));

      expect(revalidateTag).not.toHaveBeenCalled();
    });
  });

  it("deletes expired ideathon signups alongside the other tables", async () => {
    process.env.CRON_SECRET = "test-secret";
    vi.resetModules();
    deleteExpiredApplications.mockResolvedValue({ count: 0, cvPathnames: [] });
    deleteExpiredContactMessages.mockResolvedValue(0);
    deleteExpiredReminderSignups.mockResolvedValue(0);
    pruneRateLimitHits.mockResolvedValue(0);
    deleteExpiredIdeathonSignups.mockResolvedValue(7);

    const { GET } = await import("@/app/api/cron/cleanup/route");
    const response = await GET(request("Bearer test-secret"));

    expect(deleteExpiredIdeathonSignups).toHaveBeenCalled();
    const body = await response.json();
    expect(body.deleted.ideathonSignups).toBe(7);
  });

  it("still reports the steps that succeeded when one cleanup step throws", async () => {
    process.env.CRON_SECRET = "test-secret";
    vi.resetModules();
    deleteExpiredApplications.mockRejectedValue(new Error("db unreachable"));
    deleteExpiredContactMessages.mockResolvedValue(1);
    deleteExpiredReminderSignups.mockResolvedValue(0);
    pruneRateLimitHits.mockResolvedValue(0);

    const { GET } = await import("@/app/api/cron/cleanup/route");
    const response = await GET(request("Bearer test-secret"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deleted.applications).toBeNull();
    expect(body.deleted.contactMessages).toBe(1);
  });

  it("records the run before deleting, so a crash still leaves evidence it was attempted", async () => {
    process.env.CRON_SECRET = "test-secret";
    vi.resetModules();
    deleteExpiredApplications.mockResolvedValue({ count: 0, cvPathnames: [] });
    deleteExpiredContactMessages.mockResolvedValue(0);
    deleteExpiredReminderSignups.mockResolvedValue(0);
    pruneRateLimitHits.mockResolvedValue(0);

    const { GET } = await import("@/app/api/cron/cleanup/route");
    await GET(request("Bearer test-secret"));

    expect(startCronRun).toHaveBeenCalledWith("cleanup");
    expect(startCronRun.mock.invocationCallOrder[0]).toBeLessThan(
      deleteExpiredApplications.mock.invocationCallOrder[0],
    );
  });

  it("does not record a run for an unauthorized request", async () => {
    process.env.CRON_SECRET = "test-secret";
    vi.resetModules();
    const { GET } = await import("@/app/api/cron/cleanup/route");
    await GET(request("Bearer wrong"));

    expect(startCronRun).not.toHaveBeenCalled();
  });

  it("closes the cleanup run with the counts and no error on a clean sweep", async () => {
    process.env.CRON_SECRET = "test-secret";
    vi.resetModules();
    deleteExpiredApplications.mockResolvedValue({ count: 2, cvPathnames: [] });
    deleteExpiredContactMessages.mockResolvedValue(1);
    deleteExpiredReminderSignups.mockResolvedValue(3);
    pruneRateLimitHits.mockResolvedValue(10);

    const { GET } = await import("@/app/api/cron/cleanup/route");
    await GET(request("Bearer test-secret"));

    expect(finishCronRun).toHaveBeenCalledWith(
      "run-1",
      { applications: 2, contactMessages: 1, reminderSignups: 3, rateLimitHits: 10 },
      null,
    );
  });

  it("closes the cleanup run with the failing step's reason when one throws", async () => {
    process.env.CRON_SECRET = "test-secret";
    vi.resetModules();
    deleteExpiredApplications.mockRejectedValue(new Error("db unreachable"));
    deleteExpiredContactMessages.mockResolvedValue(1);
    deleteExpiredReminderSignups.mockResolvedValue(0);
    pruneRateLimitHits.mockResolvedValue(0);

    const { GET } = await import("@/app/api/cron/cleanup/route");
    await GET(request("Bearer test-secret"));

    const cleanupCall = finishCronRun.mock.calls.find((call) => "applications" in (call[1] as object));
    const [, , error] = cleanupCall as [string, unknown, string | null];
    expect(error).toContain("applications");
    expect(error).toContain("db unreachable");
  });

  // The audit trail must never be the thing that stops the cleanup from
  // happening.
  it("still runs the cleanup when recording the run fails", async () => {
    process.env.CRON_SECRET = "test-secret";
    vi.resetModules();
    startCronRun.mockRejectedValue(new Error("cron_runs unreachable"));
    deleteExpiredApplications.mockResolvedValue({ count: 2, cvPathnames: [] });
    deleteExpiredContactMessages.mockResolvedValue(0);
    deleteExpiredReminderSignups.mockResolvedValue(0);
    pruneRateLimitHits.mockResolvedValue(0);

    const { GET } = await import("@/app/api/cron/cleanup/route");
    const response = await GET(request("Bearer test-secret"));

    expect(response.status).toBe(200);
    expect(deleteExpiredApplications).toHaveBeenCalled();
    expect(finishCronRun).not.toHaveBeenCalled();
  });

  describe("the reminder-window job", () => {
    beforeEach(() => {
      process.env.CRON_SECRET = "test-secret";
      vi.resetModules();
      deleteExpiredApplications.mockResolvedValue({ count: 0, cvPathnames: [] });
      deleteExpiredContactMessages.mockResolvedValue(0);
      deleteExpiredReminderSignups.mockResolvedValue(0);
      deleteExpiredJobPostings.mockResolvedValue(0);
      pruneRateLimitHits.mockResolvedValue(0);
    });

    it("sends for every window that needs it and logs its own cron_runs row", async () => {
      const windowA = { id: "window-a", semester: "HWS26", start: "2026-09-01T00:00:00+02:00", end: "2026-09-13T23:59:00+02:00" };
      const windowB = { id: "window-b", semester: "FSS27", start: "2027-03-01T00:00:00+01:00", end: "2027-03-13T23:59:00+01:00" };
      findRecruitingWindowsNeedingReminderMail.mockResolvedValue([windowA, windowB]);
      sendReminderWindowMailsForWindow.mockResolvedValueOnce({ sent: 3, failed: 1 }).mockResolvedValueOnce({ sent: 2, failed: 0 });

      const { GET } = await import("@/app/api/cron/cleanup/route");
      const response = await GET(request("Bearer test-secret"));

      expect(sendReminderWindowMailsForWindow).toHaveBeenCalledWith(windowA);
      expect(sendReminderWindowMailsForWindow).toHaveBeenCalledWith(windowB);
      const body = await response.json();
      expect(body.reminderWindowMails).toEqual({ sent: 5, failed: 1, error: null });

      expect(startCronRun).toHaveBeenCalledWith("reminder-window");
      expect(finishCronRun).toHaveBeenCalledWith("run-1", { sentReminderWindowMails: 5, failedReminderWindowMails: 1 }, null);
    });

    it("records the failure and still answers 200 when finding due windows itself throws", async () => {
      findRecruitingWindowsNeedingReminderMail.mockRejectedValue(new Error("db unreachable"));

      const { GET } = await import("@/app/api/cron/cleanup/route");
      const response = await GET(request("Bearer test-secret"));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.reminderWindowMails.error).toContain("db unreachable");
      expect(finishCronRun).toHaveBeenCalledWith(
        "run-1",
        { sentReminderWindowMails: 0, failedReminderWindowMails: 0 },
        expect.stringContaining("db unreachable"),
      );
    });

    // The amendment this whole describe block exists for: neither job's
    // failure may suppress the other's work or its own cron_runs row.
    it("still runs when every cleanup step fails outright", async () => {
      deleteExpiredApplications.mockRejectedValue(new Error("db unreachable"));
      deleteExpiredContactMessages.mockRejectedValue(new Error("db unreachable"));
      deleteExpiredReminderSignups.mockRejectedValue(new Error("db unreachable"));
      deleteExpiredJobPostings.mockRejectedValue(new Error("db unreachable"));
      pruneRateLimitHits.mockRejectedValue(new Error("db unreachable"));
      findRecruitingWindowsNeedingReminderMail.mockResolvedValue([{ id: "w", semester: "HWS26", end: "2026-09-13T23:59:00+02:00" }]);
      sendReminderWindowMailsForWindow.mockResolvedValue({ sent: 1, failed: 0 });

      const { GET } = await import("@/app/api/cron/cleanup/route");
      const response = await GET(request("Bearer test-secret"));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.reminderWindowMails).toEqual({ sent: 1, failed: 0, error: null });
      expect(startCronRun).toHaveBeenCalledWith("reminder-window");
    });

    it("still runs cleanup when the reminder-window job fails outright", async () => {
      deleteExpiredApplications.mockResolvedValue({ count: 2, cvPathnames: [] });
      deleteExpiredContactMessages.mockResolvedValue(1);
      deleteExpiredReminderSignups.mockResolvedValue(0);
      deleteExpiredJobPostings.mockResolvedValue(0);
      pruneRateLimitHits.mockResolvedValue(0);
      findRecruitingWindowsNeedingReminderMail.mockRejectedValue(new Error("db unreachable"));

      const { GET } = await import("@/app/api/cron/cleanup/route");
      const response = await GET(request("Bearer test-secret"));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toEqual({
        applications: 2,
        contactMessages: 1,
        reminderSignups: 0,
        jobPostings: 0,
        rateLimitHits: 0,
        cvPathnamesFromExpiredApplications: [],
      });
      expect(startCronRun).toHaveBeenCalledWith("cleanup");
    });
  });
});
