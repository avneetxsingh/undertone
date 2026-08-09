// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSampleSource } from "@/lib/dashboard/sampleSource";
import { DashboardError, type DashboardSource } from "@/lib/dashboard/source";
import SessionsPanel from "@/components/dashboard/SessionsPanel";
import WebhooksPanel from "@/components/dashboard/WebhooksPanel";
import EventsPanel from "@/components/dashboard/EventsPanel";

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
