import { describe, expect, it } from "vitest";
import { assessContactContent, type ContactContent } from "@/lib/spamHeuristics";

const clean: ContactContent = {
  name: "Anna Müller",
  email: "anna.mueller@example.invalid",
  subject: "Frage zur Mitgliedschaft",
  message: "Hallo zusammen, ich würde gern mehr über eure Projekte erfahren.",
};

function assess(overrides: Partial<ContactContent>) {
  return assessContactContent({ ...clean, ...overrides });
}

// Random strings as they arrived through the live form. Only the strings
// themselves; the sender addresses are not reproduced anywhere.
const SPAM_NAMES = ["aUubpMfPxUvNtpHEEaTgU", "umuIfiPzmfXUjvrTdumQ", "YBRzweYDPeVzKrZNQPWtF"];
const SPAM_SUBJECTS = [
  "HBBPNQHYMRjYrUrUBKsXccV",
  "bfXzPWPdUPtJXLDl",
  "lOYkjvlHhCsBAwjhjdxPu",
  "xUOhActwLvLxzgaptZR",
  "JzxHoRRsWefRpfXyjQq",
  "hGnDmUuWpuXcFDAAVwoCHo",
];

describe("assessContactContent: real spam strings", () => {
  it.each(SPAM_NAMES)("flags %s as a random name on its own", (name) => {
    const result = assess({ name });
    expect(result.spam).toBe(true);
    expect(result.reasons).toContain("random_name");
  });

  it.each(SPAM_SUBJECTS)("flags %s as a random subject on its own", (subject) => {
    const result = assess({ subject });
    expect(result.spam).toBe(true);
    expect(result.reasons).toContain("random_subject");
  });

  it("flags a name and subject pair together", () => {
    const result = assess({ name: SPAM_NAMES[0], subject: SPAM_SUBJECTS[0] });
    expect(result.reasons).toEqual(expect.arrayContaining(["random_name", "random_subject"]));
  });
});

describe("assessContactContent: ordinary names", () => {
  it.each([
    "Anna Müller",
    "Mary-Kate O'Neill",
    "Ronald McDonald",
    "DeShawn Washington",
    "Nguyễn Thị Minh Khai",
    "Øystein Ødegård",
    "Llwyd",
    "María José Fernández-Ruiz",
    "Wolfeschlegelsteinhausenbergerdorff",
    "MacKenzie",
  ])("does not flag %s", (name) => {
    expect(assess({ name }).spam).toBe(false);
  });

  it.each([
    ["Chinese", "王小明"],
    ["Cyrillic", "Алексей Смирнов"],
    ["Arabic", "محمد أحمد"],
    ["Hebrew", "יעל כהן"],
    ["Greek", "Γιώργος Παπαδόπουλος"],
    ["Thai", "สมชาย ใจดี"],
    ["Korean", "김민수"],
    ["Japanese", "山田太郎"],
  ])("never evaluates a %s name", (_script, name) => {
    expect(assess({ name })).toEqual({ spam: false, reasons: [] });
  });

  it("does not run the case rule on a mixed-case non-Latin name", () => {
    const result = assess({ name: "АлексейСмирновИванович" });
    expect(result.reasons).not.toContain("random_name");
  });
});

describe("assessContactContent: ordinary subjects", () => {
  it.each([
    "Kooperationsanfrage",
    "SDG-Workshop",
    "Frage zu WiSe 2026/27",
    "iPhone App",
    "KPMG",
    "BlaBlaCar Sponsoring",
    "Mitgliedsbescheinigung",
    "Praktikum bei LinkedIn",
    "Anfrage von der McDonaldsGmbH",
    "Partnerschaft mit WhatsApp",
  ])("does not flag %s", (subject) => {
    expect(assess({ subject }).spam).toBe(false);
  });

  it("accepts a missing subject", () => {
    expect(assess({ subject: undefined })).toEqual({ spam: false, reasons: [] });
  });
});

describe("assessContactContent: weak signals need a second one", () => {
  it("lets a long single-word name through on its own", () => {
    const result = assess({ name: "Wolfeschlegelsteinhausenbergerdorff" });
    expect(result).toEqual({ spam: false, reasons: ["long_single_name"] });
  });

  it("lets a consonant-only word through on its own", () => {
    const result = assess({ subject: "Zxcvbnmqwrt" });
    expect(result).toEqual({ spam: false, reasons: ["no_vowel"] });
  });

  it("lets a dotted address through on its own", () => {
    const result = assess({ email: "x.y.z.ab.c.d@example.invalid" });
    expect(result).toEqual({ spam: false, reasons: ["dotted_email"] });
  });

  it("flags two different weak signals together", () => {
    const result = assess({
      name: "Wolfeschlegelsteinhausenbergerdorff",
      email: "x.y.z.ab.c.d@example.invalid",
    });
    expect(result.spam).toBe(true);
    expect(result.reasons).toEqual(["long_single_name", "dotted_email"]);
  });
});

describe("assessContactContent: dotted addresses", () => {
  it.each(["vor.nachname@example.invalid", "a.b.mueller@example.invalid", "max.mustermann.uni@example.invalid"])(
    "does not flag %s",
    (email) => {
      expect(assess({ email }).reasons).not.toContain("dotted_email");
    },
  );

  it.each(["m.e.g.a.n.ve.l@example.invalid", "bo.xaba.ya.jaf4.5.4@example.invalid"])("flags %s", (email) => {
    expect(assess({ email }).reasons).toContain("dotted_email");
  });
});

describe("assessContactContent: messages", () => {
  it("accepts a very short message", () => {
    expect(assess({ message: "Hallo, Frage?" })).toEqual({ spam: false, reasons: [] });
  });

  it.each([
    ["Chinese", "你好，我想了解更多关于你们的项目的信息，谢谢你们的帮助。"],
    ["Arabic", "مرحبا، أود معرفة المزيد عن مشاريعكم، شكرا جزيلا لكم."],
    ["Cyrillic", "Здравствуйте, хочу узнать больше о ваших проектах."],
  ])("never treats a %s message as wordless", (_script, message) => {
    expect(assess({ message }).reasons).not.toContain("wordless_message");
  });

  it("does not treat a bare URL as wordless", () => {
    const result = assess({ message: "https://example.invalid/some/long/path/to/read" });
    expect(result.reasons).not.toContain("wordless_message");
  });

  it("does not flag a hashtag in a normal sentence", () => {
    const result = assess({ message: "Wir machen mit bei #EnactusMannheimSocialDay und freuen uns auf euch." });
    expect(result.spam).toBe(false);
  });

  it("does not flag consonant-heavy real words", () => {
    expect(assess({ message: "Strč prst skrz krk, sagte er und lachte." }).spam).toBe(false);
  });

  it("flags a long run of letters with no spaces as a weak signal", () => {
    const result = assess({ message: "qwertzuiopasdfghjklyxcvbnm" });
    expect(result.reasons).toContain("wordless_message");
    expect(result.spam).toBe(false);
  });

  it("flags a message that is mostly random tokens", () => {
    const result = assess({ message: "aUubpMfPxUvNtpHEEaTgU bfXzPWPdUPtJXLDl hallo" });
    expect(result.reasons).toContain("wordless_message");
  });

  it("combines a wordless message with a dotted address into spam", () => {
    const result = assess({
      message: "qwertzuiopasdfghjklyxcvbnm",
      email: "x.y.z.ab.c.d@example.invalid",
    });
    expect(result.spam).toBe(true);
  });
});
