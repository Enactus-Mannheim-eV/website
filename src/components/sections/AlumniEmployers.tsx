import { useTranslations } from "next-intl";
import { Container } from "@/components/ui/Container";
import { Section } from "@/components/ui/Section";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { ThreadSegment } from "@/components/motion/ThreadSegment";
import { ProximityGroup } from "@/components/motion/ProximityGroup";
import { alumniEmployers } from "@/content/alumniEmployers";

// Where our alumni work today, run full-bleed as this section's own
// wallpaper (board brief, 2026-08-19) — see content/alumniEmployers.ts. Its
// own section since 2026-08-19: it used to be the background of the whole
// combined Alumni area (heading plus the quote/portrait track below), which
// is also why it used to visibly run on past that area's own bottom edge —
// its `inset-0` sized itself against that much taller combined box. Now
// scoped to this section alone, it can't extend past its own boundary; the
// bottom fade below is a deliberate, designed edge, not a fix for an actual
// overflow.
const LOGO_FIELD_REPEATS = 3;
const logoFieldItems = Array.from({ length: LOGO_FIELD_REPEATS }, (_, repeat) =>
  alumniEmployers.map((employer) => ({ ...employer, key: `${employer.slug}-${repeat}` })),
).flat();

// ProximityGroup (also driving the board portraits' lift) writes
// --proximity (0-1) onto each of its direct children from a single
// rAF-throttled pointermove listener, gated off entirely on touch and
// prefers-reduced-motion — reused as-is rather than a second hook, since it
// already is "one event on the container, throttled, cleaned up on
// unmount" (docs/design-system.md's motion rules). `.alumni-logo-cell` in
// globals.css maps that value to a transform/opacity-only scale — the cell
// itself never resizes, so neighbors never reflow, only the logo's own
// paint grows past its cell's edges into the gap around it.
//
// No pointer-events-none here, unlike most decorative aria-hidden layers on
// this site: ProximityGroup's own listener is attached to this exact
// element, and pointer-events: none makes an element (and its
// non-overriding descendants) invisible to hit-testing entirely — that was
// the actual cause of the dock effect never firing (2026-08-19 fix), not a
// missing transform or a stale hover-capability check (both were already
// correct). aria-hidden alone is enough to keep it out of the accessibility
// tree; nothing inside is a link or a button, so there is nothing this
// leaves clickable that shouldn't be.
function AlumniLogoField() {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
      <ProximityGroup className="grid h-full w-full auto-rows-[7rem] grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] content-start gap-4 p-4 sm:grid-cols-[repeat(auto-fill,minmax(7rem,1fr))]">
        {logoFieldItems.map((employer) => (
          <div key={employer.key} className="alumni-logo-cell flex items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- decorative,
                repeated background texture: next/image's optimization
                pipeline (blur placeholder, srcset) is pure overhead here,
                the source files are already small, and the browser caches
                every repeat of the same URL as one fetch. */}
            <img src={employer.logo} alt="" className="h-8 w-full object-contain sm:h-10" />
          </div>
        ))}
      </ProximityGroup>
      {/* A soft fade to the page background at the bottom edge, not a hard
          cutoff mid-row — board brief, 2026-08-19. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-paper"
      />
    </div>
  );
}

// Below md, AlumniLogoField's auto-fill grid clips against the section's own
// overflow-hidden well before it reaches the end of even one repeat of the
// 54 logos — a narrow column count times a height-capped section only ever
// shows the first handful of rows, with no way to reach the rest (board
// feedback: most of the 54 were simply never visible on a phone). This is a
// second, mobile-only layout, not a responsive tweak to AlumniLogoField:
// every logo, once, flowing into 5 fixed rows and scrolling sideways
// instead of wrapping into more rows than the section has height for.
//
// grid-flow-col with a fixed row count (not auto-fill/wrap) is what makes a
// grid scroll horizontally at all — a wrapping grid has no "sideways" axis
// to scroll along. overflow-x-auto alone isn't enough to keep the track
// from inflating the page's own scrollWidth on some layouts; contain-content
// (paint+layout containment) is the same fix the calendar's filter-chip row
// needed for the same reason (EventCalendar.tsx) — it stops this track's
// internal size from leaking out to the document. No scroll-snap: a logo
// wall has no "current item" the way a chip row or a card carousel does, so
// nothing here should feel like it's advancing through discrete pages.
//
// aria-hidden, same as AlumniLogoField: decorative texture, nothing
// interactive inside (content/alumniEmployers.ts's own comment: no logo
// here links out), so there's no focusable content whose focus ring
// contain-content could clip either.
function AlumniLogoStrip() {
  return (
    <div className="relative">
      <div aria-hidden="true" className="overflow-x-auto contain-content">
        <div className="grid w-max grid-flow-col grid-rows-5 gap-3 auto-cols-[5rem]">
          {alumniEmployers.map((employer) => (
            <div key={employer.slug} className="flex h-11 items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- see
                  AlumniLogoField's identical comment above. */}
              <img src={employer.logo} alt="" className="h-7 w-full object-contain" />
            </div>
          ))}
        </div>
      </div>
      {/* Visible overflow hint, not just the native scrollbar (often invisible
          on touch): a soft fade into the page background at each edge, the
          same to-paper treatment AlumniLogoField's own bottom fade uses.
          aria-hidden — a hint for sighted pointer/touch users, redundant
          with the strip's own aria-hidden state for anyone using a screen
          reader. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-paper to-transparent"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-paper to-transparent"
      />
    </div>
  );
}

// A deliberate minimum height from `md` up, not just "as tall as the
// heading": below that the logo wallpaper read as a cramped sliver rather
// than the section this content deserves — the same reasoning the old
// combined section got its height from the quote track that used to sit
// here too. Below `md`, AlumniLogoStrip is real, height-determining content
// now (not a background texture competing with the heading card for a
// fixed box height), so it no longer needs — or wants — a forced minimum:
// see that component's own comment for why the old 34rem was specific to
// the layout this replaces.
export function AlumniEmployers() {
  const t = useTranslations("AlumniEmployers");

  return (
    <Section className="relative isolate overflow-hidden md:min-h-[32rem]">
      <div className="hidden md:block">
        <AlumniLogoField />
      </div>
      {/* z-0, not ThreadSegment's own default -z-10: that default assumes it
          sits directly on the section's own background, but here
          AlumniLogoField is itself a full-bleed, z-index:auto layer between
          the two — at -z-10 the thread painted behind it, and specifically
          behind AlumniLogoField's own bottom fade-to-paper gradient, which
          reads as opaque paper right where the thread's path curves back
          toward center. z-0 (same stacking level, later in the DOM) puts the
          thread in front of the whole logo field instead, matching every
          other stop's rule that it's visible above its section's background
          and below the section's real (Container) content — Container still
          comes after this in the DOM, at the same level, so it keeps
          painting on top. */}
      <ThreadSegment stop="alumni-employers" className="z-0" />
      {/* pointer-events-none on the whole Container, not just the heading's
          own box: Container is `w-full max-w-content` — a real, positioned
          element the full width of the section, its height whatever its
          children need (here, just the heading row) — sitting in front of
          AlumniLogoField's ProximityGroup in paint order. Even with the
          heading's own div scoped tightly around the text, Container's box
          still spanned the entire row at the heading's height, so it alone
          was already catching every pointermove there before
          ProximityGroup's own listener saw it — the reason the zoom-on-hover
          effect died at that exact height across the *whole* row, not just
          behind the words (2026-09-14 fix). Safe here specifically because
          nothing inside this Container is interactive: SectionHeading is
          static text and AlumniLogoStrip is aria-hidden decoration (its own
          comment: no logo links out) — neither needs pointer events, so
          letting them all inherit none costs nothing. */}
      <Container className="relative flex flex-col gap-10 pointer-events-none">
        {/* A soft radial fade, not a flat bg-paper panel: the golden thread
            (ThreadSegment above) bows through this exact top-left region on
            its way from the top of the section back toward centre, and a
            hard-edged opaque box here cut it clean off. The gradient is
            opaque only where the text itself sits and fades to fully
            transparent well before the box's own edge, so the thread reads
            as continuous everywhere except directly behind the words —
            extra padding (vs. the old p-6/p-8) gives that fade room to
            happen without ever touching the text. Same element, same DOM
            position as before — no z-index change needed, it already paints
            above the thread exactly as the flat box did.

            `closest-side`, not the default farthest-corner: this box is much
            wider than it is tall, so a farthest-corner ellipse sizes itself
            off the diagonal and never actually reaches its own transparent
            stop before the box's top/bottom edge — the whole padded height
            painted opaque paper, which is what was cutting the thread off
            over a much taller band than the text itself (2026-09-14 fix).
            closest-side sizes each axis off its own nearest edge, so the
            fade completes within the box on every side, matching what the
            comment above already claimed it did. */}
        <div
          className="inline-flex flex-col gap-4 self-start p-8 md:p-12"
          style={{
            background: "radial-gradient(ellipse closest-side at center, var(--color-paper) 40%, transparent 60%)",
          }}
        >
          <SectionHeading eyebrow={t("eyebrow")} title={t("title")} />
        </div>
        <div className="md:hidden">
          <AlumniLogoStrip />
        </div>
      </Container>
    </Section>
  );
}
