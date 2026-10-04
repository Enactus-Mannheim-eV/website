import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { renderWithIntl } from "../../../fixtures/intl";
import { mockRouter, nextNavigationMock } from "../../../fixtures/navigation";
import { NotSpamButton } from "@/components/admin/NotSpamButton";

vi.mock("next/navigation", () => nextNavigationMock);

const ID = "0f2b8c3a-9d4e-4b1f-8a7c-2e5d6f7a8b9c";

function respond(status: number, body?: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
}

describe("NotSpamButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mockRouter.refresh.mockClear();
  });

  it("posts to the release route for this message and refreshes the list on success", async () => {
    respond(200, { ok: true });
    const user = userEvent.setup();

    renderWithIntl(<NotSpamButton id={ID} />);
    await user.click(screen.getByRole("button", { name: "Kein Spam" }));

    expect(fetch).toHaveBeenCalledWith(`/api/admin/kontakt/${ID}/not-spam`, { method: "POST" });
    await vi.waitFor(() => expect(mockRouter.refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a visible error and does not refresh when the request fails", async () => {
    respond(500, { ok: false, error: "server_error" });
    const user = userEvent.setup();

    renderWithIntl(<NotSpamButton id={ID} />);
    await user.click(screen.getByRole("button", { name: "Kein Spam" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Das Freigeben hat nicht geklappt");
    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });

  it("shows an error when the network request itself throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    renderWithIntl(<NotSpamButton id={ID} />);
    await user.click(screen.getByRole("button", { name: "Kein Spam" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Das Freigeben hat nicht geklappt");
  });

  it("refreshes quietly when the message was already released elsewhere", async () => {
    respond(404, { ok: false, error: "not_found" });
    const user = userEvent.setup();

    renderWithIntl(<NotSpamButton id={ID} />);
    await user.click(screen.getByRole("button", { name: "Kein Spam" }));

    await vi.waitFor(() => expect(mockRouter.refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the row on screen with a notice when it was released but the forward failed", async () => {
    respond(502, { ok: false, error: "released_mail_failed", message: "Resend is down" });
    const user = userEvent.setup();

    renderWithIntl(<NotSpamButton id={ID} />);
    await user.click(screen.getByRole("button", { name: "Kein Spam" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Fehlgeschlagene Mails");
    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderWithIntl(<NotSpamButton id={ID} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
