import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/guards")>()),
  guardSessionCreate: vi.fn(),
}));
vi.mock("@/lib/upstream", () => ({ callUpstream: vi.fn() }));

import { guardSessionCreate } from "@/lib/guards";
import { callUpstream } from "@/lib/upstream";
import { DemoError } from "@/lib/demoError";
import { POST } from "@/app/api/demo/session/route";

const mockGuard = vi.mocked(guardSessionCreate);
const mockUpstream = vi.mocked(callUpstream);
const req = () => new Request("https://x/api/demo/session", { method: "POST" });

describe("POST /api/demo/session", () => {
  beforeEach(() => {
    mockGuard.mockReset().mockResolvedValue(undefined);
    mockUpstream.mockReset();
  });

  test("creates a meeting session and returns the platform payload", async () => {
    mockUpstream.mockResolvedValue({
      id: "s1",
      title: "Live demo",
      kind: "meeting",
      status: "active",
      createdAt: "2026-07-28T00:00:00.000Z",
    });

    const res = await POST(req());

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ id: "s1", kind: "meeting" });
    const [path, init] = mockUpstream.mock.calls[0];
    expect(path).toBe("/v1/sessions");
    // isolateMemory is load-bearing, not cosmetic: every visitor shares one
    // platform account, so without it cross-session retrieval would let one
    // person's suggestions cite another person's meeting.
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "meeting",
      title: "Live demo",
      isolateMemory: true,
    });
  });

  test("checks the guard before calling upstream", async () => {
    mockGuard.mockRejectedValue(new DemoError(429, "demo_rate_limited", "too many"));

    const res = await POST(req());

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "demo_rate_limited" } });
    expect(mockUpstream).not.toHaveBeenCalled();
  });

  test("an unexpected failure returns the generic envelope", async () => {
    mockUpstream.mockRejectedValue(new Error("boom"));
    const res = await POST(req());
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "internal" } });
  });
});
