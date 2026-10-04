import { describe, expect, it } from "vitest";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import { CONTACT_SPAM_REASONS } from "@/lib/contactSpam";

/**
 * The spam tab renders one label per stored reason code. A code without a
 * label would show the board a raw identifier, so a new rule in
 * lib/spamHeuristics.ts or lib/contactSpam.ts cannot ship without its text
 * in both languages.
 */
describe.each([
  ["de", de],
  ["en", en],
] as const)("Admin.contactMessages.reasons (%s)", (_locale, catalog) => {
  const labels = catalog.Admin.contactMessages.reasons as Record<string, string>;

  it.each(CONTACT_SPAM_REASONS)("has a label for %s", (code) => {
    expect(labels[code]).toEqual(expect.any(String));
    expect(labels[code].length).toBeGreaterThan(0);
  });

  it("has no label for a code that no longer exists", () => {
    expect(Object.keys(labels).sort()).toEqual([...CONTACT_SPAM_REASONS].sort());
  });
});
