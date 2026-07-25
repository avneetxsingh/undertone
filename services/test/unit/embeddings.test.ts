import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EMBED_DIM, embedText } from "../../src/lib/embeddings";

const okResp = (values: number[]) => ({ ok: true, status: 200, json: async () => ({ embedding: { values } }) });

describe("embedText (Gemini)", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    delete process.env.GEMINI_BASE_URL;
  });
  afterEach(() => vi.restoreAllMocks());

  test("posts to gemini embedContent with 768 dims and returns the vector", async () => {
    const vec = Array.from({ length: EMBED_DIM }, (_, i) => i / EMBED_DIM);
    const fetchMock = vi.fn().mockResolvedValue(okResp(vec));
    vi.stubGlobal("fetch", fetchMock);
    const out = await embedText("hello roadmap");
    expect(out).toEqual(vec);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("models/gemini-embedding-001:embedContent");
    expect(url).toContain("key=test-key");
    const body = JSON.parse(init.body);
    expect(body.content.parts[0].text).toBe("hello roadmap");
    expect(body.outputDimensionality).toBe(768);
  });

  test("truncates very long input to 8000 chars", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResp([0.1]));
    vi.stubGlobal("fetch", fetchMock);
    await embedText("x".repeat(20000));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content.parts[0].text.length).toBe(8000);
  });

  test("non-2xx response throws 502 embed_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
    await expect(embedText("t")).rejects.toMatchObject({ status: 502, code: "embed_failed" });
  });

  test("malformed body (no embedding) throws 502 embed_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ nope: true }) }));
    await expect(embedText("t")).rejects.toMatchObject({ status: 502, code: "embed_failed" });
  });

  test("missing GEMINI_API_KEY throws 502 embed_failed", async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(embedText("t")).rejects.toMatchObject({ status: 502, code: "embed_failed" });
  });
});
