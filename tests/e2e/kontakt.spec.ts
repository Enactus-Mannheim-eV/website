import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The form holds its send until three seconds after its token arrived (the
// server's minimum fill time), whatever the token's own timestamp says, so a
// successful submit is expected to take that long.
const SUBMIT_TIMEOUT = 10_000;

function mockFormToken(page: Page) {
  return page.route("**/api/kontakt/token", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: `${Date.now() - 10_000}.e2e-test-signature` }),
    }),
  );
}

test.describe("/kontakt", () => {
  test("has no automatically detectable accessibility violations", async ({ page }) => {
    await page.goto("/kontakt");
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("never introduces a horizontal scrollbar at any of the standard breakpoints", async ({
    page,
  }) => {
    await page.goto("/kontakt");
    for (const width of [360, 768, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `width=${width}`).toBeLessThanOrEqual(clientWidth);
    }
  });

  test("desktop: the FAQ sits to the left of the contact form", async ({ page, isMobile }) => {
    test.skip(isMobile, "left/right placement is a desktop-width claim");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/kontakt");

    const faqBox = await page.getByRole("heading", { level: 2, name: "Häufige Fragen" }).boundingBox();
    const formBox = await page
      .getByRole("heading", { level: 2, name: "Nachricht schreiben" })
      .boundingBox();
    expect(faqBox!.x).toBeLessThan(formBox!.x);
  });

  test("mobile: the FAQ appears before the contact form", async ({ page, isMobile }) => {
    test.skip(!isMobile, "stacked order is the narrow-width claim");
    await page.goto("/kontakt");

    const faqBox = await page.getByRole("heading", { level: 2, name: "Häufige Fragen" }).boundingBox();
    const formBox = await page
      .getByRole("heading", { level: 2, name: "Nachricht schreiben" })
      .boundingBox();
    expect(faqBox!.y).toBeLessThan(formBox!.y);
  });

  test("opens an FAQ answer on tap or click", async ({ page }) => {
    await page.goto("/kontakt");
    const button = page.getByRole("button", { name: /Was ist Enactus Mannheim e\.V\./ });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(/eingetragener Verein von Student\*innen/)).toBeVisible();
  });

  // Grouping and category order are asserted against the real content in
  // tests/unit/sections/Faq.test.tsx; "Projekte" is also a nav link, so
  // matching it by text on the whole page belongs in the unit test, not here.
  test("lists every board-approved question", async ({ page }) => {
    await page.goto("/kontakt");
    await expect(page.getByRole("button", { name: /Muss ich eine bestimmte Sprache sprechen/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Kann ich mein Projekt bei Enactus Mannheim ausgründen/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /In welchem Zeitraum kann ich mich bewerben/ })).toBeVisible();
  });

  test("submits the contact form and shows a real success notice", async ({ page }) => {
    // /api/kontakt itself is exercised by the Vitest integration suite
    // against a mocked db/mail layer — this only proves the form actually
    // calls the route and reacts to its response, without needing a real
    // database or Resend key in the e2e environment.
    await mockFormToken(page);
    await page.route("**/api/kontakt", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
    );
    await page.goto("/kontakt");
    await page.getByLabel("Name").fill("Jane Doe");
    await page.getByLabel("E-Mail").fill("jane@example.com");
    await page.getByLabel("Betreff").fill("Partnerschaft");
    await page.getByLabel("Nachricht").fill("Wir würden gerne mit euch sprechen.");
    await page.getByRole("button", { name: "Nachricht senden" }).click();

    await expect(page.getByRole("status")).toContainText("Danke für deine Nachricht", {
      timeout: SUBMIT_TIMEOUT,
    });
  });

  test("sends the timing token and an empty honeypot along with the message", async ({ page }) => {
    await mockFormToken(page);
    let sent: Record<string, unknown> | null = null;
    await page.route("**/api/kontakt", (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.goto("/kontakt");
    await page.getByLabel("Name").fill("Jane Doe");
    await page.getByLabel("E-Mail").fill("jane@example.com");
    await page.getByLabel("Betreff").fill("Partnerschaft");
    await page.getByLabel("Nachricht").fill("Wir würden gerne mit euch sprechen.");
    await page.getByRole("button", { name: "Nachricht senden" }).click();
    await expect(page.getByRole("status")).toContainText("Danke für deine Nachricht", {
      timeout: SUBMIT_TIMEOUT,
    });

    expect(sent).toMatchObject({ website: "", formToken: expect.stringMatching(/^\d+\.e2e-test-signature$/) });
  });

  test("still sends the message when no token could be issued", async ({ page }) => {
    await page.route("**/api/kontakt/token", (route) => route.fulfill({ status: 500 }));
    await page.route("**/api/kontakt", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
    );
    await page.goto("/kontakt");
    await page.getByLabel("Name").fill("Jane Doe");
    await page.getByLabel("E-Mail").fill("jane@example.com");
    await page.getByLabel("Betreff").fill("Partnerschaft");
    await page.getByLabel("Nachricht").fill("Wir würden gerne mit euch sprechen.");
    await page.getByRole("button", { name: "Nachricht senden" }).click();

    await expect(page.getByRole("status")).toContainText("Danke für deine Nachricht");
  });

  test("shows an error with a mailto fallback when the request fails", async ({ page }) => {
    await mockFormToken(page);
    await page.route("**/api/kontakt", (route) => route.fulfill({ status: 500 }));
    await page.goto("/kontakt");
    await page.getByLabel("Name").fill("Jane Doe");
    await page.getByLabel("E-Mail").fill("jane@example.com");
    await page.getByLabel("Betreff").fill("Partnerschaft");
    await page.getByLabel("Nachricht").fill("Wir würden gerne mit euch sprechen.");
    await page.getByRole("button", { name: "Nachricht senden" }).click();

    // Filtered by text, not just role: Next's own route announcer
    // (`__next-route-announcer__`) also carries role="alert" on every page,
    // so an unscoped getByRole("alert") matches two elements here. A bare
    // role="alert" element doesn't get an accessible *name* computed from
    // its content the way a button or link would, so matching by name
    // (rather than by visible text) finds nothing.
    await expect(
      page.getByRole("alert").filter({ hasText: "teamvorstand@unimannheim.enactus.team" }),
    ).toBeVisible({ timeout: SUBMIT_TIMEOUT });
  });

  test("blocks submission with visible errors when the form is empty", async ({ page }) => {
    await page.goto("/kontakt");
    await page.getByRole("button", { name: "Nachricht senden" }).click();
    await expect(page.getByText("Bitte gib deinen Namen ein (mindestens 2 Zeichen).")).toBeVisible();
  });
});
