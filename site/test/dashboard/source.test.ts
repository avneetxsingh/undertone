import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSampleSource } from "@/lib/dashboard/sampleSource";

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
