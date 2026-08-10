import { chatJson } from "./groq";
import { SUGGESTIONS_PROMPT } from "./prompts";
import type { VectorHit } from "./vectors";

export interface Suggestion {
  type: string;
  preview: string;
  detail_prompt: string;
}

const formatHistory = (hits: VectorHit[]) =>
  hits.length === 0 ? "none" : hits.map((h) => `[${h.createdAt.slice(0, 10)}] ${h.text}`).join("\n");

export function buildSuggestionInput(
  transcripts: string[],
  last: Suggestion[],
  recentCount = 2,
  relevantHistory: VectorHit[] = [],
): string {
  return [
    `FULL TRANSCRIPT:\n${transcripts.join("\n")}`,
    `RECENT TRANSCRIPT:\n${transcripts.slice(-recentCount).join("\n")}`,
    `LAST SUGGESTIONS:\n${JSON.stringify(last)}`,
    `RELEVANT HISTORY:\n${formatHistory(relevantHistory)}`,
  ].join("\n\n");
}

export async function generateSuggestionsSafe(
  groqKey: string,
  transcripts: string[],
  last: Suggestion[],
  relevantHistory: VectorHit[] = [],
): Promise<{ suggestions: Suggestion[]; warning?: string }> {
  try {
    const out = (await chatJson(groqKey, SUGGESTIONS_PROMPT, buildSuggestionInput(transcripts, last, 2, relevantHistory))) as {
      suggestions?: Suggestion[];
    };
    if (!Array.isArray(out.suggestions)) throw new Error("malformed model output");
    return { suggestions: out.suggestions };
  } catch (e) {
    console.error("suggestion generation failed", e);
    return { suggestions: [], warning: "suggestions_failed" };
  }
}
