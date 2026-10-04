import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { renderWithIntl } from "../../fixtures/intl";
import { Datenschutz } from "@/components/sections/Datenschutz";
import { org } from "@/content/org";

describe("Datenschutz", () => {
  it("renders exactly one h1 titled Datenschutzerklärung", () => {
    renderWithIntl(<Datenschutz />);
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("Datenschutzerklärung");
  });

  it("renders all 19 sections as h2 headings", () => {
    renderWithIntl(<Datenschutz />);
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings).toHaveLength(19);
  });

  it("shows the effective date but not a review-confirmation notice", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getByText("Stand: Oktober 2026")).toBeInTheDocument();
    expect(screen.queryByText(/^Zuletzt geprüft am/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Entwurf\./)).not.toBeInTheDocument();
  });

  it("renders the responsible party's real legal name, address, and register entry", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getByText(org.legalName)).toBeInTheDocument();
    expect(screen.getByText(org.registeredOffice!)).toBeInTheDocument();
    expect(screen.getByText(org.registerEntry!)).toBeInTheDocument();
    expect(screen.getByText(org.legalRepresentatives.names.join(", "))).toBeInTheDocument();
  });

  it("states plainly that no in-house data protection officer is appointed", () => {
    renderWithIntl(<Datenschutz />);
    expect(
      screen.getByText(/Ein betrieblicher Datenschutzbeauftragter ist .* nicht bestellt/),
    ).toBeInTheDocument();
  });

  it("describes Resend as an active processor in the EU-West-1 (Ireland) region, with tracking off", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getByText(/Irland.*eu-west-1/)).toBeInTheDocument();
    expect(screen.getByText(/kein Öffnungs-Tracking, kein Klick-Tracking/)).toBeInTheDocument();
  });

  it("states the retention periods in the Speicherdauer table", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getByRole("heading", { level: 2, name: "Speicherdauer" })).toBeInTheDocument();
    expect(screen.getAllByText(/6 Monate nach Ende des jeweiligen Bewerbungszeitraums/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/12 Monate nach Eingang der Anfrage/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/30 Tage nach Anmeldung/).length).toBeGreaterThan(0);
  });

  it("lists Vercel, Neon, and Resend in the Auftragsverarbeiter table", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getByRole("heading", { level: 2, name: "Auftragsverarbeiter und Empfänger" })).toBeInTheDocument();
    expect(screen.getAllByText(/Vercel Inc\., USA/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Neon Inc\., USA/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Plus Five Five, Inc\. \(Resend\), USA/).length).toBeGreaterThan(0);
  });

  it("states IP addresses used for abuse protection are stored only as a hash", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getByText(/ausschließlich als kryptografischen Hashwert/)).toBeInTheDocument();
  });

  it("states no CAPTCHA is used and explains why", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getByText(/Ein Captcha setzen wir bewusst nicht ein/)).toBeInTheDocument();
  });

  it("states the application form has a CV upload, as a PDF up to 4 MB, and warns about Art. 9 data", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getByText(/Der Lebenslauf ist als PDF-Datei hochzuladen, maximal 4 MB/)).toBeInTheDocument();
    expect(screen.getByText(/nicht auf Schadsoftware geprüft/)).toBeInTheDocument();
  });

  it("lists every application field named in the /mitmachen brief, including the CV upload and prioritized areas", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getAllByText(/Vorname, Nachname, E-Mail-Adresse/).length).toBeGreaterThan(0);
    expect(screen.getByText(/priorisierte Wunschbereiche mit jeweiliger Begründung/)).toBeInTheDocument();
    expect(screen.getByText(/bis zu drei Ressorts, in denen du mitarbeiten möchtest/)).toBeInTheDocument();
    expect(screen.getByText("Lebenslauf als PDF-Datei (Upload)")).toBeInTheDocument();
    expect(screen.getByText(/Relevante Skills für den gewünschten Einsatzbereich/)).toBeInTheDocument();
    expect(screen.getByText(/Was du aus deiner Zeit bei Enactus mitnehmen möchtest/)).toBeInTheDocument();
    expect(screen.getByText(/gewünschte Zeitfenster für ein Bewerbungsgespräch/)).toBeInTheDocument();
    expect(screen.getByText(/Verfügbarkeit in Stunden pro Woche/)).toBeInTheDocument();
    expect(screen.getByText(/Zeitpunkt deiner Einwilligung/)).toBeInTheDocument();
    expect(screen.queryByText(/Hochschule/)).not.toBeInTheDocument();
  });

  it("describes the CV as stored separately at Vercel Blob, with private access", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getByText(/Vercel Blob/)).toBeInTheDocument();
    expect(screen.getByText(/ausschließlich nach Authentifizierung über den passwortgeschützten Vorstandsbereich möglich/)).toBeInTheDocument();
  });

  it("states the CV retention period alongside the application it belongs to", () => {
    // LegalTable renders every row twice (a <table> for wide viewports, a
    // <dl> for narrow ones — see its own comment), so table content is
    // always asserted with getAllByText, never getByText.
    renderWithIntl(<Datenschutz />);
    expect(screen.getAllByText("Lebenslauf (PDF)").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/6 Monate nach Ende des jeweiligen Bewerbungszeitraums, gemeinsam mit der zugehörigen Bewerbung/)
        .length,
    ).toBeGreaterThan(0);
  });

  it("lists the Ideathon signup section with its field list and purpose", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getByRole("heading", { level: 2, name: "Ideathon-Anmeldung" })).toBeInTheDocument();
    expect(screen.getByText(/Angabe, ob bereits eine Idee vorhanden ist/)).toBeInTheDocument();
    expect(screen.getByText(/Organisation und Durchführung des Ideathons/)).toBeInTheDocument();
  });

  it("states the Ideathon signup retention period in the Speicherdauer table", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getAllByText(/6 Monate nach Anmeldung/).length).toBeGreaterThan(0);
  });

  it("describes the reminder list's double opt-in proof of consent", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getByText(/Double-Opt-in-Verfahren/)).toBeInTheDocument();
    expect(screen.getByText(/als Nachweis deiner Einwilligung; ohne diesen Nachweis/)).toBeInTheDocument();
  });

  it("names the real application recipient, not the outdated it@ address", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getAllByText(/info@unimannheim\.enactus\.team/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/it@unimannheim\.enactus\.team/)).not.toBeInTheDocument();
  });

  it("states the contact form is live and forwards messages, not that it's unconnected", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.queryByText(/noch nicht angebunden/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Noch nicht aktiv/)).not.toBeInTheDocument();
  });

  it("names the supervisory authority for a complaint", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.getByText(/Landesbeauftragte für den Datenschutz und die Informationsfreiheit Baden-Württemberg/)).toBeInTheDocument();
  });

  it("has no PlaceholderMark elements — every fact on this page is confirmed", () => {
    renderWithIntl(<Datenschutz />);
    expect(screen.queryByText("Angabe fehlt")).not.toBeInTheDocument();
    expect(screen.queryByText(/Diese Angabe ist noch nicht verfügbar/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Diese Zahl ist noch nicht vom Vorstand bestätigt/)).not.toBeInTheDocument();
  });

  it("has no accessibility violations in German", async () => {
    const { container } = renderWithIntl(<Datenschutz />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no accessibility violations in English", async () => {
    const { container } = renderWithIntl(<Datenschutz />, { locale: "en" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("renders a genuine English translation, not a German mirror", () => {
    renderWithIntl(<Datenschutz />, { locale: "en" });
    expect(screen.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeInTheDocument();
    expect(screen.getByText(/must be uploaded as a PDF file, 4 MB maximum/)).toBeInTheDocument();
  });
});
