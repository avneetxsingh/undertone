import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { callUpstream } from "@/lib/upstream";

const DEMO_KEY = "ut_live_testkey_do_not_use";

describe("callUpstream", () => {
  beforeEach(() => {
    process.env.UNDERTONE_API = "https://api.example.test";
    process.env.UNDERTONE_DEMO_KEY = DEMO_KEY;
  });
  afterEach(() => vi.unstubAllGlobals());

  test("sends the demo key as a bearer token and returns the parsed body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "s1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await callUpstream("/v1/sessions", {
      method: "POST",
      body: "{}",
      contentType: "application/json",
    });

    expect(out).toEqual({ id: "s1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.test/v1/sessions");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${DEMO_KEY}`);
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  test("forwards an arbitrary content-type verbatim", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ seq: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await callUpstream("/v1/sessions/s1/chunks", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
      contentType: "audio/mp4;codecs=mp4a.40.2",
    });

    const init = fetchMock.mock.calls[0][1];
    expect((init.headers as Record<string, string>)["content-type"]).toBe("audio/mp4;codecs=mp4a.40.2");
  });

  test("passes a platform error envelope through unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "session_not_found", message: "No active session with that id" } }),
          { status: 404 },
        ),
      ),
    );
    await expect(callUpstream("/v1/sessions/x/chunks", { method: "POST" })).rejects.toMatchObject({
      status: 404,
      code: "session_not_found",
    });
  });

  test("maps upstream 401 to demo_capacity and never leaks the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "unauthorized", message: "bad key" } }), { status: 401 }),
      ),
    );
    const err = (await callUpstream("/v1/sessions", { method: "POST" }).catch((e) => e)) as unknown;
    expect(err).toMatchObject({ status: 503, code: "demo_capacity" });
    expect(JSON.stringify((err as { message?: string }).message)).not.toContain(DEMO_KEY);
  });

  test("maps a network failure to demo_capacity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(callUpstream("/v1/sessions", { method: "POST" })).rejects.toMatchObject({
      status: 503,
      code: "demo_capacity",
    });
  });

  test("throws when the demo key is unset rather than calling upstream", async () => {
    delete process.env.UNDERTONE_DEMO_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(callUpstream("/v1/sessions", { method: "POST" })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
