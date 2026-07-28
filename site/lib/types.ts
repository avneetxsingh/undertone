export interface TranscriptChunk {
  id: string;
  timestamp: string; // e.g. "0:42"
  text: string;
}

export type SuggestionType =
  | "FACT_CHECK"
  | "TALKING_POINT"
  | "ANSWER"
  | "QUESTION"
  | "CLARIFICATION"
  | "ACTION_ITEM";

export interface Suggestion {
  type: SuggestionType;
  preview: string;
  detail_prompt: string;
}

export interface SuggestionBatch {
  id: string;
  timestamp: string; // e.g. "0:42"
  suggestions: Suggestion[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}
