import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/guards")>()),
  guardChat: vi.fn(),
}));
vi.mock("@/lib/upstream", () => ({ callUpstream: vi.fn() }));

import { guardChat } from "@/lib/guards";
import { callUpstream } from "@/lib/upstream";
import { DemoError } from "@/lib/demoError";
import { POST as endPost } from "@/app/api/demo/end/route";
import { POST as chatPost } from "@/app/api/demo/chat/route";

const mockGuard = vi.mocked(guardChat);
const mockUpstream = vi.mocked(callUpstream);

const chatBody = (b: unknown) =>
  new Request("https://x/api/demo/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof b === "string" ? b : JSON.stringify(b),
  });

describe("POST /api/demo/end", () => {
  beforeEach(() => mockUpstream.mockReset());

  test("ends the session and returns summary and action items", async () => {
    mockUpstream.mockResolvedValue({ id: "s1", status: "ended", summary: "we shipped", actionItems: [] });
    const res = await endPost(new Request("https://x/api/demo/end?sessionId=s1", { method: "POST" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ended", summary: "we shipped" });
    expect(mockUpstream.mock.calls[0][0]).toBe("/v1/sessions/s1/end");
  });

  test("requires a sessionId", async () => {
    const res = await endPost(new Request("https://x/api/demo/end", { method: "POST" }));
    expect(res.status).toBe(422);
    expect(mockUpstream).not.toHaveBeenCalled();
  });
});

describe("POST /api/demo/chat", () => {
  beforeEach(() => {
    mockGuard.mockReset().mockResolvedValue(undefined);
    mockUpstream.mockReset().mockResolvedValue({ reply: "here is the detail" });
  });

  test("forwards sessionId and prompt and returns the reply", async () => {
    const res = await chatPost(chatBody({ sessionId: "s1", prompt: "why?" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ reply: "here is the detail" });
    const [path, init] = mockUpstream.mock.calls[0];
    expect(path).toBe("/v1/chat");
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: "s1", prompt: "why?" });
  });

  test("rejects a missing prompt before calling upstream", async () => {
    const res = await chatPost(chatBody({ sessionId: "s1" }));
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "missing_prompt" } });
    expect(mockUpstream).not.toHaveBeenCalled();
  });

  test("rejects malformed JSON with invalid_json", async () => {
    const res = await chatPost(chatBody("not json"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "invalid_json" } });
  });

  test("enforces the chat cap before calling upstream", async () => {
    mockGuard.mockRejectedValue(new DemoError(409, "demo_session_complete", "limit"));
    const res = await chatPost(chatBody({ sessionId: "s1", prompt: "why?" }));
    expect(res.status).toBe(409);
    expect(mockUpstream).not.toHaveBeenCalled();
  });
});
