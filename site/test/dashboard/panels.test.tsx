// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSampleSource } from "@/lib/dashboard/sampleSource";
import { DashboardError, type DashboardSource } from "@/lib/dashboard/source";
import SessionsPanel from "@/components/dashboard/SessionsPanel";
import WebhooksPanel from "@/components/dashboard/WebhooksPanel";
import EventsPanel from "@/components/dashboard/EventsPanel";
import DashboardPage from "@/app/dashboard/page";

// See keyGate.test.tsx: this repo does not enable vitest globals, so Testing
// Library never registers its own cleanup.
afterEach(cleanup);

const failing = (err: unknown): DashboardSource => ({
  isSample: false,
  listSessions: () => Promise.reject(err),
  getSession: () => Promise.reject(err),
  listWebhooks: () => Promise.reject(err),
  createWebhook: () => Promise.reject(err),
  deleteWebhook: () => Promise.reject(err),
  listEvents: () => Promise.reject(err),
  replayEvent: () => Promise.reject(err),
});

describe("SessionsPanel", () => {
  test("lists sessions and opens one to show transcript and suggestions", async () => {
    render(<SessionsPanel source={createSampleSource()} />);

    const row = await screen.findByRole("button", { name: /Q2 roadmap review/i });
    fireEvent.click(row);

    await waitFor(() => {
      expect(screen.getByText(/mobile app has to be the priority/i)).toBeTruthy();
      expect(screen.getByText("FACT_CHECK")).toBeTruthy();
    });
  });

  test("surfaces a rate limit rather than a blank panel", async () => {
    render(<SessionsPanel source={failing(new DashboardError(429, "rate_limited", "slow down"))} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/too many requests/i));
  });
});

describe("WebhooksPanel", () => {
  test("shows delivery status including a failure reason", async () => {
    render(<WebhooksPanel source={createSampleSource()} />);
    await waitFor(() => {
      expect(screen.getByText(/hooks\.example\.com/)).toBeTruthy();
      expect(screen.getByText(/HTTP 500/)).toBeTruthy();
    });
  });

  test("shows the signing secret once after registering, then never again", async () => {
    render(<WebhooksPanel source={createSampleSource()} />);
    await screen.findByText(/hooks\.example\.com/);

    fireEvent.change(screen.getByLabelText(/endpoint url/i), {
      target: { value: "https://example.com/hook" },
    });
    fireEvent.click(screen.getByLabelText("session.completed"));
    fireEvent.click(screen.getByRole("button", { name: /^register$/i }));

    const secret = await screen.findByTestId("new-secret");
    expect(secret.textContent).toMatch(/^whsec_/);

    // Dismissing is the only exit, and the value must not survive it.
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(screen.queryByTestId("new-secret")).toBeNull();
  });

  test("rejects a non-https endpoint before calling the source", async () => {
    const source = createSampleSource();
    const spy = vi.spyOn(source, "createWebhook");
    render(<WebhooksPanel source={source} />);
    await screen.findByText(/hooks\.example\.com/);

    fireEvent.change(screen.getByLabelText(/endpoint url/i), {
      target: { value: "http://example.com/hook" },
    });
    fireEvent.click(screen.getByLabelText("session.completed"));
    fireEvent.click(screen.getByRole("button", { name: /^register$/i }));

    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/https/i);
  });
});

describe("EventsPanel", () => {
  test("lists events and reports how many subscriptions a replay reached", async () => {
    render(<EventsPanel source={createSampleSource()} />);
    await screen.findByText("session.completed");

    fireEvent.click(screen.getAllByRole("button", { name: /replay/i })[0]);

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/1 subscription/i));
  });

  test("renders an empty state rather than nothing", async () => {
    const empty: DashboardSource = { ...createSampleSource(), listEvents: async () => [] };
    render(<EventsPanel source={empty} />);
    await waitFor(() => expect(screen.getByText(/no events yet/i)).toBeTruthy());
  });
});

describe("dashboard shell", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  test("starts at the gate and reaches sample data without any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<DashboardPage />);

    fireEvent.click(screen.getByRole("button", { name: /sample data/i }));

    await screen.findByRole("button", { name: /Q2 roadmap review/i });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("switches panels", async () => {
    render(<DashboardPage />);
    fireEvent.click(screen.getByRole("button", { name: /sample data/i }));
    await screen.findByRole("button", { name: /Q2 roadmap review/i });

    fireEvent.click(screen.getByRole("tab", { name: /webhooks/i }));
    expect(await screen.findByText(/hooks\.example\.com/)).toBeTruthy();
  });

  test("the api key is never written into the DOM", async () => {
    const key = `ut_live_${"b".repeat(48)}`;
    // A Response body can only be read once, and the shell and SessionsPanel
    // both call listSessions — so the mock must mint a fresh Response per call
    // rather than share one via mockResolvedValue.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 }),
    );
    const { container } = render(<DashboardPage />);

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: key } });
    fireEvent.click(screen.getByRole("button", { name: /view my data/i }));

    await waitFor(() => expect(screen.queryByLabelText(/api key/i)).toBeNull());
    expect(container.innerHTML).not.toContain(key);
  });

  test("a 401 clears the stored key and returns to the gate", async () => {
    const key = `ut_live_${"c".repeat(48)}`;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), {
          status: 401,
        }),
    );
    render(<DashboardPage />);

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: key } });
    fireEvent.click(screen.getByRole("button", { name: /view my data/i }));

    // Wait for the GATE to come back, not merely for text matching /rejected/:
    // SessionsPanel renders that same copy from its own 401, so asserting on
    // the alert alone can resolve before the shell has cleared storage.
    await waitFor(() => expect(screen.getByLabelText(/api key/i)).toBeTruthy());
    expect(sessionStorage.getItem("undertone_dashboard_key")).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/rejected/i);
  });
});
