import { describe, expect, test } from "vitest";
import { REPLAY_SESSION } from "@/lib/replay";

const TYPES = ["FACT_CHECK", "TALKING_POINT", "ANSWER", "QUESTION", "CLARIFICATION", "ACTION_ITEM"];

describe("replay fixture", () => {
  test("has enough chunks to be a convincing demo", () => {
    expect(REPLAY_SESSION.length).toBeGreaterThanOrEqual(4);
  });

  test("sequence numbers ascend from 1", () => {
    expect(REPLAY_SESSION.map((c) => c.seq)).toEqual(REPLAY_SESSION.map((_, i) => i + 1));
  });

  test("every chunk carries transcript text and well-formed suggestions", () => {
    for (const chunk of REPLAY_SESSION) {
      expect(chunk.transcript.trim().length).toBeGreaterThan(0);
      expect(chunk.suggestions.length).toBeGreaterThan(0);
      for (const s of chunk.suggestions) {
        expect(TYPES).toContain(s.type);
        expect(s.preview.trim().length).toBeGreaterThan(0);
        expect(s.detail_prompt.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("contains no key-shaped strings", () => {
    expect(JSON.stringify(REPLAY_SESSION)).not.toMatch(/ut_live_|gsk_|whsec_/);
  });
});
