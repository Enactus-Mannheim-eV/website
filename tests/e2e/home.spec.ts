import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("homepage", () => {
  test("has no automatically detectable accessibility violations", async ({ page }) => {
    await page.goto("/");
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("never introduces a horizontal scrollbar", async ({ page }) => {
    await page.goto("/");
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test("keeps the five KPI figures in separate, non-overlapping columns at desktop width", async ({
    page,
    isMobile,
  }) => {
    // The regression this guards: at five equal grid columns, a wide figure
    // (">150.000 €") can render past its own column and visually merge with
    // its neighbour ("8") even though the grid itself is already even —
    // something only a real layout measurement catches, never a unit test
    // rendering in jsdom without layout.
    test.skip(isMobile, "the five-column layout only exists from the lg breakpoint up");
    await page.goto("/");

    const labels = [
      "Projektiterationen",
      "Eingeworbenes Funding",
      "Nationale Meistertitel",
      "Weltweit",
      "Gegründet/Übergeben",
    ];
    const boxes = [];
    for (const label of labels) {
      const tile = page.getByText(label, { exact: true }).locator("..");
      const box = await tile.boundingBox();
      expect(box).not.toBeNull();
      boxes.push(box!);
    }

    for (let i = 1; i < boxes.length; i++) {
      const previous = boxes[i - 1];
      const current = boxes[i];
      expect(current.x).toBeGreaterThanOrEqual(previous.x + previous.width - 1);
    }
  });

  test("is fully keyboard-traversable, and no element traps focus", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard-only traversal is a desktop interaction pattern");
    await page.goto("/");

    const count = await page.evaluate(() => {
      // offsetParent is null for display:none elements (and fixed-position
      // ones, which this page has none of among these candidates) — this is
      // what excludes the mobile-menu trigger, correctly display:none at
      // desktop width (lg:hidden) and covered instead by mobile-nav.spec.ts.
      //
      // button:not([disabled]):not([tabindex="-1"]) — the 8-bit easter
      // egg's peek button (EightBitEasterEgg.tsx, docs/eastereggs.md) is a
      // real, non-disabled <button> deliberately given tabindex="-1" so it
      // never joins the page's tab order; a plain button:not([disabled])
      // selector still matched it here (tabindex doesn't affect element
      // matching), counting it as a candidate the real Tab key then
      // correctly never focuses. Excluding tabindex="-1" explicitly keeps
      // this test asserting what "keyboard-traversable" actually means:
      // every element real Tab presses can reach.
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]',
        ),
      ).filter((el) => el.offsetParent !== null);
      candidates.forEach((el, index) => el.setAttribute("data-tab-order", String(index)));
      return candidates.length;
    });
    expect(count).toBeGreaterThan(0);

    const visited = new Set<number>();
    for (let i = 0; i < count + 10; i++) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        const order = el.getAttribute("data-tab-order");
        return {
          order: order === null ? null : Number(order),
          hasAccessibleName: Boolean(
            el.getAttribute("aria-label") || el.textContent?.trim() || el.getAttribute("title"),
          ),
        };
      });
      if (focused?.order !== null && focused?.order !== undefined) {
        visited.add(focused.order);
        expect(focused.hasAccessibleName).toBe(true);
      }
      if (visited.size === count) break;
    }

    expect(visited.size).toBe(count);
  });

  // 0.6, not 1 — DetailText's base state is muted (opacity-60, the same
  // "legible but secondary" treatment used throughout the site). What must
  // never happen again is the text starting at 0 anywhere: this ran on touch
  // only while the desktop state was hover-gated, and covers both now.
  test("shows the pillar detail text without any hover or focus interaction", async ({ page }) => {
    await page.goto("/");
    const detail = page
      .getByText("Dieser Impact Charakter stößt bei Firmen auf Begeisterung")
      .first();
    await detail.scrollIntoViewIfNeeded();
    await expect(detail).toHaveCSS("opacity", "0.6");
  });

  test("grows a benefit card on hover without moving anything around it", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "the grow is deliberately inert where a pointer cannot hover");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");

    const card = page.locator(".hover-grow").filter({ hasText: "Verantwortung" }).first();
    await card.scrollIntoViewIfNeeded();
    const neighbour = page.locator(".hover-grow").filter({ hasText: "Teamarbeit" }).first();

    await expect(card).toHaveCSS("transform", "none");
    const before = await neighbour.boundingBox();

    await card.hover();
    // matrix(1.02, 0, 0, 1.02, 0, 0) — a scale, not a translate.
    await expect(card).toHaveCSS("transform", /^matrix\(1\.02, 0, 0, 1\.02, 0, 0\)$/);

    // A transform never reflows: the neighbouring card has not moved.
    expect(await neighbour.boundingBox()).toEqual(before);
  });

  test("actually plays the hero video at desktop width", async ({ page, isMobile }) => {
    test.skip(isMobile, "the video is not rendered at all below md — see the narrow-viewport test");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    // The element is mounted client-side once the md query resolves, so it
    // is not in the initial HTML — wait for it rather than assuming.
    await page.locator("video").waitFor({ state: "attached" });

    const advanced = await page.evaluate(async () => {
      const video = document.querySelector("video")!;
      // Give play() a moment to be called and the file a moment to buffer.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const first = video.currentTime;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return { paused: video.paused, error: video.error?.code ?? null, first, second: video.currentTime };
    });

    expect(advanced.error).toBeNull();
    expect(advanced.paused).toBe(false);
    expect(advanced.second).toBeGreaterThan(advanced.first);
  });

  // Tens of megabytes of video plus a poster, for an element a phone can
  // never see, is the single biggest thing this page could waste. Hiding it with
  // CSS is not enough — `display: none` does not stop a <video> loading, and
  // WebKit ignores preload="none" — so nothing is rendered below md at all,
  // and this asserts it against every engine in the matrix.
  test("never downloads the hero video or its poster on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const videoRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/video/")) videoRequests.push(new URL(request.url()).pathname);
    });
    await page.goto("/");
    await page.waitForTimeout(2000);
    expect(videoRequests).toEqual([]);
    expect(await page.locator("video").count()).toBe(0);
  });

  // Read as raw HTML, never through a rendered page: the point is that the
  // header's surface is already settled before any JavaScript runs. The
  // German route used to prerender the dark-on-light wordmark and swap it
  // after hydration, because next/navigation reported the proxy's internal
  // "/de" rather than "/".
  for (const { path, label } of [
    { path: "/", label: "German" },
    { path: "/en", label: "English" },
  ]) {
    test(`prerenders the ${label} homepage header with the on-dark logo, before hydration`, async ({
      request,
      baseURL,
    }) => {
      const html = await (await request.get(`${baseURL}${path}`)).text();
      const header = html.slice(0, html.indexOf("</header>"));
      expect(header).toContain("enactus-mannheim-logo-full-on-dark.png");
      expect(header).not.toContain("enactus-mannheim-logo-full.png");
    });
  }

  test("never swaps the header logo after hydration", async ({ page }) => {
    await page.goto("/");
    const first = await page.locator("header img").first().getAttribute("src");
    await page.waitForTimeout(1000);
    expect(await page.locator("header img").first().getAttribute("src")).toBe(first);
  });

  test("names every board member's LinkedIn link, revealed on hover on a pointer that can hover", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "covered by the touch-always-visible check below instead");
    await page.goto("/");
    const link = page.getByRole("link", { name: /LinkedIn-Profil von Thorben Ossig/ });
    await link.scrollIntoViewIfNeeded();
    // Always reachable by its accessible name regardless of visual state —
    // BoardGrid.tsx's deliberate, scoped exception to "hover enhances,
    // hover never hides" hides the mark visually until hover on a pointer
    // that supports it (.linkedin-mark, globals.css), it never removes the
    // link itself.
    await expect(link).toBeAttached();
    await expect(link).toHaveCSS("opacity", "0");

    await link.hover();
    await expect(link).toHaveCSS("opacity", "1");
  });

  test("keeps the board member LinkedIn mark permanently visible on a touch device", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "this is specifically the touch/no-hover case");
    await page.goto("/");
    const link = page.getByRole("link", { name: /LinkedIn-Profil von Thorben Ossig/ });
    await link.scrollIntoViewIfNeeded();
    await expect(link).toHaveCSS("opacity", "1");
  });

  test("the golden thread is purely decorative: aria-hidden, and never a tab stop", async ({ page }) => {
    await page.goto("/");
    const segments = page.locator("svg[data-thread]");
    const count = await segments.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(segments.nth(i)).toHaveAttribute("aria-hidden", "true");
      await expect(segments.nth(i)).not.toHaveAttribute("tabindex");
    }
    // The full-page keyboard-traversal test above already proves nothing
    // new entered the tab order; this only needs to prove the thread itself
    // carries no tabindex.
  });

  test("keeps the board portraits in their normal state on a touch device, unaffected by pointer proximity", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "pointer-proximity is a hover-capable-desktop-only effect");
    await page.goto("/");
    const card = page.locator('[tabindex="0"]').filter({ hasText: "Thorben Ossig" }).first();
    await card.scrollIntoViewIfNeeded();
    await card.tap();
    await expect(card).toHaveCSS("transform", "none");
  });
});

test.describe("homepage under reduced motion", () => {
  // Scoped to its own describe block, kept separate from the default-state
  // checks above (axe/keyboard/overflow), which are specifically about the
  // no-preference state — running those under reduced motion too would stop
  // testing what actually ships to most visitors.
  //
  // page.emulateMedia(), not test.use({ reducedMotion: "reduce" }): the
  // latter is the documented API, but in this project's Playwright install
  // it silently fails to reach the fixture-provided page/context —
  // window.matchMedia("(prefers-reduced-motion: reduce)") still reports
  // false with it set. Confirmed with a minimal isolated repro (a single
  // top-level test.use() outside any describe, nothing else in the file);
  // calling browser.newContext({ reducedMotion }) directly, or
  // page.emulateMedia() as below, both work correctly. If a future
  // Playwright upgrade fixes the underlying issue, test.use() can replace
  // this again.
  test("never starts the hero video", async ({ page, isMobile }) => {
    test.skip(isMobile, "the video is not rendered at all below md, so there is nothing to start");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.locator("video").waitFor({ state: "attached" });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.querySelector("video")!.paused)).toBe(true);
  });

  test("shows the golden thread in full instead of revealing it on scroll", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const svg = page.locator(".thread-reveal").first();
    await expect(svg).toHaveCSS("clip-path", "none");
  });
});

test.describe("the golden thread", () => {
  // The reveal is a clip on the svg box; a dash on the path would resolve in
  // screen pixels under non-scaling-stroke and break every long segment into
  // fragments (see .thread-reveal in globals.css). Asserting the absence of
  // the dash is what stops that regressing.
  test("is one unbroken line, never a dashed one", async ({ page }) => {
    await page.goto("/");
    const paths = page.locator("svg[data-thread] path");
    const count = await paths.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(paths.nth(i)).toHaveCSS("stroke-dasharray", "none");
    }
  });

  test("appears on the homepage and on no other page", async ({ page }) => {
    await page.goto("/");
    expect(await page.locator("svg[data-thread]").count()).toBeGreaterThan(0);

    for (const path of ["/projekte", "/events", "/termine", "/partner", "/kontakt", "/prozess"]) {
      await page.goto(path);
      expect(await page.locator("svg[data-thread]").count(), `${path} still draws the thread`).toBe(
        0,
      );
    }
  });
});

test.describe("the alumni employer wall", () => {
  // Regression covering two symptoms of the same root cause (2026-09-14):
  // the heading's radial-gradient backdrop (AlumniEmployers.tsx) and the
  // Container it sits in were both real, pointer-events:auto boxes in front
  // of the logo grid's ProximityGroup — so the grid's zoom-on-hover never
  // fired at the heading's own height, even well past the visible text —
  // and the gradient's default farthest-corner sizing on this wide, short
  // box never reached its own transparent stop before the box's top/bottom
  // edge, so the golden thread behind it vanished for the box's whole
  // height rather than just behind the letters.
  test("keeps the logo grid hoverable at the heading's height, and the golden thread visible close around it", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "the logo grid and golden thread are desktop-only (hidden md:block)");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");

    const heading = page.getByRole("heading", { name: "Wo unsere Alumni heute arbeiten" });
    await heading.scrollIntoViewIfNeeded();

    const textStack = heading.locator("xpath=.."); // SectionHeading's own eyebrow+title div
    const wrapper = heading.locator("xpath=ancestor::div[contains(@style, 'gradient')]");
    const container = wrapper.locator("xpath=ancestor::div[contains(@class, 'max-w-content')]");

    const textBox = (await textStack.boundingBox())!;
    const wrapperBox = (await wrapper.boundingBox())!;
    expect(textBox).not.toBeNull();
    expect(wrapperBox).not.toBeNull();

    await expect(container).toHaveCSS("pointer-events", "none");

    // Neither the padded gradient box nor Container may catch a pointer
    // meant for the logos beneath: one point just inside the wrapper's own
    // padding (right of the text, still within its box), one well outside
    // the wrapper entirely but at the same height (where Container alone
    // used to still be the hit target).
    const rowY = wrapperBox.y + wrapperBox.height / 2;
    const pointsOverLogos = [
      { x: wrapperBox.x + wrapperBox.width - 10, y: rowY },
      { x: wrapperBox.x + wrapperBox.width + 150, y: rowY },
    ];
    for (const point of pointsOverLogos) {
      const tag = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null,
        point,
      );
      expect(tag, `elementFromPoint(${point.x}, ${point.y})`).toBe("IMG");
    }

    // The gradient must size itself off each axis's own nearest edge
    // (closest-side), not the box's diagonal (the farthest-corner default),
    // and must reach full transparency well before this short box's own
    // top/bottom edge — within a small margin of the actual text height,
    // not the padding around it.
    const background = await wrapper.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(background).toContain("closest-side");
    const transparentStop = background.match(/(\d+(?:\.\d+)?)%\)$/);
    expect(transparentStop).not.toBeNull();
    const transparentRadiusY = (Number(transparentStop![1]) / 100) * (wrapperBox.height / 2);
    expect(transparentRadiusY).toBeLessThan(textBox.height / 2 + 20);
  });
});
