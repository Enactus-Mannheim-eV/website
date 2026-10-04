import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { renderWithIntl } from "../../fixtures/intl";
import { mockMatchMedia } from "../../fixtures/matchMedia";
import { ContactForm } from "@/components/sections/ContactForm";
import { FORM_TOKEN_REFRESH_AFTER_MS, MIN_FILL_MS } from "@/lib/antiSpam";

// Routes by URL, with a fresh Response per call: a Response body can only be
// read once, and the form now makes a token request before the send.
type Responder = () => Response;

const tokenOk: Responder = () => new Response(JSON.stringify({ token: "1.signature" }), { status: 200 });
const tokenDown: Responder = () => new Response(null, { status: 500 });
const contactOk: Responder = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

function mockFetch(contact: Responder, token: Responder = tokenOk) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (url === "/api/kontakt/token" ? token() : contact())),
  );
}

function mockFetchOk() {
  mockFetch(contactOk);
}

function mockFetchFailure() {
  mockFetch(() => new Response(null, { status: 500 }));
}

function contactCalls() {
  return vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/kontakt");
}

function tokenCalls() {
  return vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/kontakt/token");
}

function sentBody() {
  return JSON.parse(contactCalls()[0]?.[1]?.body as string);
}

// The form waits out MIN_FILL_MS after its token arrived before it sends.
// Timers are faked (and also advance with real time, so Testing Library's
// own polling keeps working), and each submit moves the clock past that wait.
async function passMinimumFillTime() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MIN_FILL_MS);
  });
}

function setupUser() {
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
}

// Scoped to a given render's own container rather than the global `screen`
// — the confetti test below renders ContactForm three times in a row
// without unmounting in between, so an unscoped query would match the same
// label across all three instances at once.
async function submitValidForm(user: ReturnType<typeof userEvent.setup>, container: HTMLElement) {
  const form = within(container);
  await user.type(form.getByLabelText("Name"), "Jane Doe");
  await user.type(form.getByLabelText("E-Mail"), "jane@example.com");
  await user.type(form.getByLabelText("Betreff"), "Partnerschaft");
  await user.type(form.getByLabelText("Nachricht"), "Wir würden gerne mit euch sprechen.");
  await user.click(form.getByRole("button", { name: "Nachricht senden" }));
  await passMinimumFillTime();
}

describe("ContactForm", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders name, email, subject, and message fields plus a submit button", () => {
    mockMatchMedia(false);
    renderWithIntl(<ContactForm />);
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("E-Mail")).toBeInTheDocument();
    expect(screen.getByLabelText("Betreff")).toBeInTheDocument();
    expect(screen.getByLabelText("Nachricht")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nachricht senden" })).toBeInTheDocument();
  });

  it("blocks submission and shows errors when required fields are empty, including the subject", async () => {
    mockMatchMedia(false);
    const user = setupUser();
    renderWithIntl(<ContactForm />);

    await user.click(screen.getByRole("button", { name: "Nachricht senden" }));

    expect(await screen.findByText("Bitte gib deinen Namen ein (mindestens 2 Zeichen).")).toBeInTheDocument();
    expect(screen.getByText("Bitte gib eine gültige E-Mail-Adresse ein.")).toBeInTheDocument();
    expect(screen.getByText("Bitte gib einen Betreff ein (2 bis 150 Zeichen).")).toBeInTheDocument();
    expect(screen.getByText("Bitte schreib uns mindestens 10 Zeichen.")).toBeInTheDocument();
    // Nothing was sent — validation failed before any request went out.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("posts to /api/kontakt and shows a real success notice on a valid submit", async () => {
    mockMatchMedia(false);
    mockFetchOk();
    const user = setupUser();
    const { container } = renderWithIntl(<ContactForm />);

    await submitValidForm(user, container);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("Danke für deine Nachricht");
    expect(fetch).toHaveBeenCalledWith("/api/kontakt", expect.objectContaining({ method: "POST" }));
    expect(sentBody()).toMatchObject({
      name: "Jane Doe",
      email: "jane@example.com",
      subject: "Partnerschaft",
      locale: "de",
    });
  });

  describe("spam protection", () => {
    it("asks for a timing token when it loads", () => {
      mockMatchMedia(false);
      mockFetchOk();
      renderWithIntl(<ContactForm />);

      expect(tokenCalls()).toHaveLength(1);
    });

    it("sends the token and an empty honeypot with the message", async () => {
      mockMatchMedia(false);
      mockFetchOk();
      const user = setupUser();
      const { container } = renderWithIntl(<ContactForm />);

      await submitValidForm(user, container);
      await screen.findByRole("status");

      expect(sentBody()).toMatchObject({ formToken: "1.signature", website: "" });
    });

    it("does not send before the minimum fill time has passed since the token arrived", async () => {
      mockMatchMedia(false);
      mockFetchOk();
      const user = setupUser();
      const { container } = renderWithIntl(<ContactForm />);
      const tokenArrivedAt = Date.now();

      const form = within(container);
      await user.type(form.getByLabelText("Name"), "Jane Doe");
      await user.type(form.getByLabelText("E-Mail"), "jane@example.com");
      await user.type(form.getByLabelText("Betreff"), "Partnerschaft");
      await user.type(form.getByLabelText("Nachricht"), "Wir würden gerne mit euch sprechen.");
      await user.click(form.getByRole("button", { name: "Nachricht senden" }));

      expect(contactCalls()).toHaveLength(0);

      await passMinimumFillTime();
      await screen.findByRole("status");

      expect(contactCalls()).toHaveLength(1);
      expect(Date.now() - tokenArrivedAt).toBeGreaterThanOrEqual(MIN_FILL_MS);
    });

    it("sends the message anyway, without a token, when the token request fails", async () => {
      mockMatchMedia(false);
      mockFetch(contactOk, tokenDown);
      const user = setupUser();
      const { container } = renderWithIntl(<ContactForm />);

      await submitValidForm(user, container);

      expect(await screen.findByRole("status")).toHaveTextContent("Danke für deine Nachricht");
      expect(sentBody().formToken).toBeUndefined();
    });

    it("asks again for a token on submit when the first request failed", async () => {
      mockMatchMedia(false);
      let tokenRequests = 0;
      mockFetch(contactOk, () => (++tokenRequests === 1 ? tokenDown() : tokenOk()));
      const user = setupUser();
      const { container } = renderWithIntl(<ContactForm />);

      await submitValidForm(user, container);
      await screen.findByRole("status");

      expect(tokenCalls()).toHaveLength(2);
      expect(sentBody().formToken).toBe("1.signature");
    });

    it("gets a fresh token when the page has been open nearly as long as a token lasts", async () => {
      mockMatchMedia(false);
      mockFetchOk();
      const user = setupUser();
      const { container } = renderWithIntl(<ContactForm />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(FORM_TOKEN_REFRESH_AFTER_MS + 60_000);
      });
      await submitValidForm(user, container);
      await screen.findByRole("status");

      expect(tokenCalls()).toHaveLength(2);
    });

    it("keeps the honeypot out of the tab order and away from screen readers", () => {
      mockMatchMedia(false);
      mockFetchOk();
      const { container } = renderWithIntl(<ContactForm />);

      const honeypot = container.querySelector('input[name="website"]');
      expect(honeypot).toHaveAttribute("tabindex", "-1");
      expect(honeypot).toHaveAttribute("aria-hidden", "true");
    });

    it("passes on whatever a bot typed into the honeypot", async () => {
      mockMatchMedia(false);
      mockFetchOk();
      const user = setupUser();
      const { container } = renderWithIntl(<ContactForm />);
      const honeypot = container.querySelector('input[name="website"]') as HTMLInputElement;
      honeypot.value = "https://spam.example";

      await submitValidForm(user, container);
      await screen.findByRole("status");

      expect(sentBody().website).toBe("https://spam.example");
    });
  });

  it("shows an error and keeps the form filled in when the request fails", async () => {
    mockMatchMedia(false);
    mockFetchFailure();
    const user = setupUser();
    const { container } = renderWithIntl(<ContactForm />);

    await submitValidForm(user, container);

    expect(await screen.findByRole("alert")).toHaveTextContent("teamvorstand@unimannheim.enactus.team");
    expect(screen.getByLabelText("Name")).toHaveValue("Jane Doe");
  });

  /**
   * Easter egg 4/7 (docs/eastereggs.md). jsdom has no real Canvas 2D
   * context, so this stops at "does the burst mount", same limit
   * HeroLogoConfetti.test.tsx documents for the same reason — the actual
   * particle animation was verified by hand in a real browser.
   */
  it("bursts confetti on a real success submit", async () => {
    mockMatchMedia(false);
    mockFetchOk();
    const user = setupUser();
    const { container } = renderWithIntl(<ContactForm />);

    await submitValidForm(user, container);
    await screen.findByRole("status");

    expect(container.querySelector("canvas")).toBeInTheDocument();
  });

  it("never bursts confetti on a failed submit", async () => {
    mockMatchMedia(false);
    mockFetchFailure();
    const user = setupUser();
    const { container } = renderWithIntl(<ContactForm />);

    await submitValidForm(user, container);
    await screen.findByRole("alert");

    expect(container.querySelector("canvas")).not.toBeInTheDocument();
  });

  it("never bursts confetti on success under prefers-reduced-motion", async () => {
    mockMatchMedia(true);
    mockFetchOk();
    const user = setupUser();
    const { container } = renderWithIntl(<ContactForm />);

    await submitValidForm(user, container);
    await screen.findByRole("status");

    expect(container.querySelector("canvas")).not.toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    mockMatchMedia(false);
    const { container } = renderWithIntl(<ContactForm />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
