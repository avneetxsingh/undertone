import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSampleSource } from "@/lib/dashboard/sampleSource";
import { createLiveSource } from "@/lib/dashboard/liveSource";
import { DashboardError } from "@/lib/dashboard/source";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("sampleSource", () => {
  test("is marked as sample", () => {
    expect(createSampleSource().isSample).toBe(true);
  });

  test("returns sessions with chunks, suggestions and a summary", async () => {
    const s = createSampleSource();
    const sessions = await s.listSessions();
    expect(sessions.length).toBeGreaterThan(0);

    const detail = await s.getSession(sessions[0].sessId);
    expect(detail.chunks.length).toBeGreaterThan(0);
    expect(detail.chunks[0].suggestions.length).toBeGreaterThan(0);
    expect(typeof detail.summary).toBe("string");
  });

  test("issues no network requests, even through a register and a replay", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const s = createSampleSource();

    await s.listSessions();
    await s.listWebhooks();
    await s.listEvents();
    const created = await s.createWebhook("https://example.com/hook", ["session.completed"]);
    await s.replayEvent((await s.listEvents())[0].evtId);
    await s.deleteWebhook(created.webhook.whookId);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a registered webhook appears in the list and its secret is returned once", async () => {
    const s = createSampleSource();
    const before = (await s.listWebhooks()).length;
    const { webhook, secret } = await s.createWebhook("https://example.com/hook", [
      "session.completed",
    ]);

    expect(secret).toMatch(/^whsec_/);
    const after = await s.listWebhooks();
    expect(after.length).toBe(before + 1);
    // The stored record must not carry the plaintext secret anywhere.
    expect(JSON.stringify(after)).not.toContain(secret);
    expect(after.some((w) => w.whookId === webhook.whookId)).toBe(true);
  });

  test("deleting a webhook removes it", async () => {
    const s = createSampleSource();
    const { webhook } = await s.createWebhook("https://example.com/hook", ["session.completed"]);
    await s.deleteWebhook(webhook.whookId);
    expect((await s.listWebhooks()).some((w) => w.whookId === webhook.whookId)).toBe(false);
  });

  test("replay reports how many subscriptions matched", async () => {
    const s = createSampleSource();
    const events = await s.listEvents();
    const completed = events.find((e) => e.event === "session.completed")!;
    const { replayed } = await s.replayEvent(completed.evtId);
    expect(replayed).toBeGreaterThanOrEqual(1);
  });
});

const okJson = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe("liveSource", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_UNDERTONE_API = "https://api.test";
  });

  test("is not marked as sample", () => {
    expect(createLiveSource("ut_live_x").isSample).toBe(false);
  });

  test("sends the key as a bearer token and never in the url", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => okJson({ sessions: [] }));
    await createLiveSource("ut_live_abc").listSessions();

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe("https://api.test/v1/sessions");
    expect(String(url)).not.toContain("ut_live_abc");
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer ut_live_abc",
    });
  });

  test("unwraps the platform's list envelopes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/v1/sessions")) return okJson({ sessions: [{ sessId: "S1" }] });
      if (u.includes("/v1/webhooks")) return okJson({ webhooks: [{ whookId: "W1" }] });
      return okJson({ events: [{ evtId: "E1" }], retentionDays: 7 });
    });

    const s = createLiveSource("ut_live_abc");
    expect((await s.listSessions())[0].sessId).toBe("S1");
    expect((await s.listWebhooks())[0].whookId).toBe("W1");
    expect((await s.listEvents())[0].evtId).toBe("E1");
  });

  test("maps 401 to a DashboardError carrying the platform's code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "Unknown API key" } }), {
        status: 401,
      }),
    );
    await expect(createLiveSource("ut_live_abc").listSessions()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  test("maps 429 to rate_limited", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }), {
        status: 429,
      }),
    );
    await expect(createLiveSource("ut_live_abc").listSessions()).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  test("maps a bodyless 503 to a capacity error rather than a parse crash", async () => {
    // API Gateway returns 503 with no JSON body when Lambda is throttled.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    await expect(createLiveSource("ut_live_abc").listSessions()).rejects.toBeInstanceOf(
      DashboardError,
    );
  });

  test("maps a network failure to a DashboardError, not a raw TypeError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(createLiveSource("ut_live_abc").listSessions()).rejects.toMatchObject({
      code: "network",
    });
  });

  test("delete tolerates the 204 empty body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await expect(createLiveSource("ut_live_abc").deleteWebhook("W1")).resolves.toBeUndefined();
  });
});
