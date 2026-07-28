import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/guards")>()),
  guardChunk: vi.fn(),
}));
vi.mock("@/lib/upstream", () => ({ callUpstream: vi.fn() }));

import { guardChunk } from "@/lib/guards";
import { callUpstream } from "@/lib/upstream";
import { DemoError } from "@/lib/demoError";
import { POST } from "@/app/api/demo/chunk/route";

const mockGuard = vi.mocked(guardChunk);
const mockUpstream = vi.mocked(callUpstream);

const audioReq = (sessionId = "s1", contentType = "audio/webm;codecs=opus") =>
  new Request(`https://x/api/demo/chunk?sessionId=${sessionId}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Uint8Array(200),
  });

describe("POST /api/demo/chunk", () => {
  beforeEach(() => {
    mockGuard.mockReset().mockResolvedValue(undefined);
    mockUpstream.mockReset().mockResolvedValue({ seq: 1, transcript: "hello", suggestions: [] });
  });

  test("forwards audio to the session's chunk endpoint with the content-type verbatim", async () => {
    const res = await POST(audioReq("abc", "audio/mp4"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ seq: 1, transcript: "hello" });
    const [path, init] = mockUpstream.mock.calls[0];
    expect(path).toBe("/v1/sessions/abc/chunks");
    expect(init.contentType).toBe("audio/mp4");
    expect(init.method).toBe("POST");
  });

  test("rejects a request with no sessionId before calling upstream", async () => {
    const res = await POST(
      new Request("https://x/api/demo/chunk", { method: "POST", body: new Uint8Array(200) }),
    );
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "missing_session_id" } });
    expect(mockUpstream).not.toHaveBeenCalled();
  });

  test("checks the cap before calling upstream", async () => {
    mockGuard.mockRejectedValue(new DemoError(409, "demo_session_complete", "done"));
    const res = await POST(audioReq());
    expect(res.status).toBe(409);
    expect(mockUpstream).not.toHaveBeenCalled();
  });

  test("rejects an empty body without spending a cap slot", async () => {
    const res = await POST(
      new Request("https://x/api/demo/chunk?sessionId=s1", {
        method: "POST",
        headers: { "content-type": "audio/webm" },
        body: new Uint8Array(0),
      }),
    );
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "empty_audio" } });
    expect(mockGuard).not.toHaveBeenCalled();
    expect(mockUpstream).not.toHaveBeenCalled();
  });

  test("passes a platform error through with its own code", async () => {
    mockUpstream.mockRejectedValue(new DemoError(404, "session_not_found", "gone"));
    const res = await POST(audioReq());
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "session_not_found" } });
  });

  test("no response body contains the demo key", async () => {
    process.env.UNDERTONE_DEMO_KEY = "ut_live_secret";
    mockUpstream.mockRejectedValue(new DemoError(503, "demo_capacity", "unavailable"));
    const res = await POST(audioReq());
    expect(await res.text()).not.toContain("ut_live_secret");
  });
});
