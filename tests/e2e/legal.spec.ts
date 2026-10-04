import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("/impressum", () => {
  test("has no automatically detectable accessibility violations", async ({ page }) => {
    await page.goto("/impressum");
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("has no automatically detectable accessibility violations on the English route", async ({
    page,
  }) => {
    await page.goto("/en/impressum");
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("renders the real operator facts, not a placeholder page", async ({ page }) => {
    await page.goto("/impressum");
    await expect(page.getByRole("heading", { level: 1, name: "Impressum" })).toBeVisible();
    await expect(page.getByText("L1, 1 Postfach 31, 68161 Mannheim")).toBeVisible();
    await expect(page.getByText("Amtsgericht Mannheim, Vereinsregister VR 700965")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "teamvorstand@unimannheim.enactus.team" }),
    ).toHaveAttribute("href", "mailto:teamvorstand@unimannheim.enactus.team");
  });

  test("keeps the legal text in German on the English route, with an English notice above it", async ({
    page,
  }) => {
    await page.goto("/en/impressum");
    await expect(page.getByText(/This legal notice \(Impressum\) is required under German law/)).toBeVisible();
    await expect(page.getByText("Vertreten durch", { exact: true })).toBeVisible();
  });

  test("credits design and development, separate from the responsible persons", async ({ page }) => {
    await page.goto("/impressum");
    await expect(page.getByRole("heading", { level: 2, name: "Gestaltung und Entwicklung" })).toBeVisible();
    await expect(page.getByText("Milan Koncz")).toBeVisible();
  });
});

test.describe("/datenschutz", () => {
  test("has no automatically detectable accessibility violations", async ({ page }) => {
    await page.goto("/datenschutz");
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("has no automatically detectable accessibility violations on the English route", async ({
    page,
  }) => {
    await page.goto("/en/datenschutz");
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("renders the real policy, not the coming-soon placeholder", async ({ page }) => {
    await page.goto("/datenschutz");
    await expect(page.getByRole("heading", { level: 1, name: "Datenschutzerklärung" })).toBeVisible();
    await expect(page.getByText("Stand: Oktober 2026")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Bewerbungsformular" })).toBeVisible();
    await expect(page.getByText(/Der Lebenslauf ist als PDF-Datei hochzuladen, maximal 4 MB/)).toBeVisible();
  });

  test("renders all 19 sections, including the two retention and processor tables", async ({ page }) => {
    await page.goto("/datenschutz");
    await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveCount(19);
    await expect(page.getByRole("heading", { level: 2, name: "Speicherdauer" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Auftragsverarbeiter und Empfänger" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Vercel Inc., USA");
  });

  test("renders a real English translation", async ({ page }) => {
    await page.goto("/en/datenschutz");
    await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Application form" })).toBeVisible();
  });
});
