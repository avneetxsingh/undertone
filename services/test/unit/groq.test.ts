import { afterEach, describe, expect, test } from "vitest";
import { chatJson, chatText, transcribe } from "../../src/lib/groq";
import { startFakeGroq, type FakeGroqRequest } from "../helpers/fakeGroq";

let fake: { url: string; close(): void; requests: FakeGroqRequest[] } | undefined;
afterEach(() => { fake?.close(); delete process.env.GROQ_BASE_URL; });

describe("groq client", () => {
  test("transcribe returns the text field", async () => {
    fake = await startFakeGroq({ transcript: "quarterly roadmap" });
    process.env.GROQ_BASE_URL = fake.url;
    expect(await transcribe("gsk_x", Buffer.from("audio"), "chunk.wav")).toBe("quarterly roadmap");

    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0];
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer gsk_x");
    expect(req.body).toContain("whisper-large-v3");
  });
  test("chatJson parses the model's JSON content", async () => {
    fake = await startFakeGroq({ chat: { suggestions: [] } });
    process.env.GROQ_BASE_URL = fake.url;
    expect(await chatJson("gsk_x", "sys", "user")).toEqual({ suggestions: [] });

    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0];
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer gsk_x");
    const parsed = JSON.parse(req.body);
    expect(parsed.model).toBe("openai/gpt-oss-120b");
    expect(parsed.response_format).toEqual({ type: "json_object" });
  });
  test("groq 401 becomes 402 groq_key_invalid", async () => {
    fake = await startFakeGroq({ status: 401 });
    process.env.GROQ_BASE_URL = fake.url;
    await expect(chatJson("gsk_bad", "s", "u")).rejects.toMatchObject({ status: 402, code: "groq_key_invalid" });
  });
  test("other groq failures become 502 groq_upstream", async () => {
    fake = await startFakeGroq({ status: 500 });
    process.env.GROQ_BASE_URL = fake.url;
    await expect(transcribe("gsk_x", Buffer.from("a"), "c.wav")).rejects.toMatchObject({ status: 502, code: "groq_upstream" });
  });
  test("transcribe rejects with 502 groq_upstream when the response has no text field", async () => {
    fake = await startFakeGroq({ transcript: null });
    process.env.GROQ_BASE_URL = fake.url;
    await expect(transcribe("gsk_x", Buffer.from("a"), "c.wav")).rejects.toMatchObject({ status: 502, code: "groq_upstream" });
  });
  test("chatText returns raw content without json mode", async () => {
    fake = await startFakeGroq({ chatRaw: "Here is the detail you asked for." });
    process.env.GROQ_BASE_URL = fake.url;
    expect(await chatText("gsk_x", "sys", "user")).toBe("Here is the detail you asked for.");
    const req = fake.requests.at(-1)!;
    const parsed = JSON.parse(req.body);
    expect(parsed.model).toBe("openai/gpt-oss-120b");
    expect(parsed.response_format).toBeUndefined();
  });
  test("chatText throws 502 when content is missing", async () => {
    fake = await startFakeGroq({ chatRaw: null });
    process.env.GROQ_BASE_URL = fake.url;
    await expect(chatText("gsk_x", "s", "u")).rejects.toMatchObject({ status: 502, code: "groq_upstream" });
  });
});
