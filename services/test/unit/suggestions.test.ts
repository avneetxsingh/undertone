import { afterEach, describe, expect, test } from "vitest";
import { buildSuggestionInput, generateSuggestionsSafe } from "../../src/lib/suggestions";
import { startFakeGroq } from "../helpers/fakeGroq";

let fake: { url: string; close(): void } | undefined;
afterEach(() => { fake?.close(); delete process.env.GROQ_BASE_URL; });

describe("buildSuggestionInput", () => {
  test("includes full transcript, recent window, and last suggestions", () => {
    const out = buildSuggestionInput(["a", "b", "c"], [{ type: "QUESTION", preview: "p", detail_prompt: "d" }], 2);
    expect(out).toContain("FULL TRANSCRIPT:\na\nb\nc");
    expect(out).toContain("RECENT TRANSCRIPT:\nb\nc");
    expect(out).toContain('"type":"QUESTION"');
  });
  test("includes formatted relevant history with dates", () => {
    const out = buildSuggestionInput(["a"], [], 2, [
      { sessId: "S0", seq: 1, text: "we chose postgres", createdAt: "2026-07-01T10:00:00.000Z" },
    ]);
    expect(out).toContain("RELEVANT HISTORY:\n[2026-07-01] we chose postgres");
  });
  test("empty history renders none", () => {
    expect(buildSuggestionInput(["a"], [])).toContain("RELEVANT HISTORY:\nnone");
  });
});

describe("generateSuggestionsSafe", () => {
  test("returns model suggestions on success", async () => {
    const sugg = [{ type: "FACT_CHECK", preview: "x", detail_prompt: "y" }];
    fake = await startFakeGroq({ chat: { detected_part: "MIDDLE", detected_moment: "CLAIM", suggestions: sugg } });
    process.env.GROQ_BASE_URL = fake.url;
    const r = await generateSuggestionsSafe("gsk_x", ["t"], []);
    expect(r.suggestions).toEqual(sugg);
    expect(r.warning).toBeUndefined();
  });
  test("degrades to empty suggestions + warning on malformed output", async () => {
    fake = await startFakeGroq({ chat: { nonsense: true } });
    process.env.GROQ_BASE_URL = fake.url;
    const r = await generateSuggestionsSafe("gsk_x", ["t"], []);
    expect(r).toEqual({ suggestions: [], warning: "suggestions_failed" });
  });
  test("degrades on upstream failure instead of throwing", async () => {
    fake = await startFakeGroq({ status: 500 });
    process.env.GROQ_BASE_URL = fake.url;
    const r = await generateSuggestionsSafe("gsk_x", ["t"], []);
    expect(r.warning).toBe("suggestions_failed");
  });
});
