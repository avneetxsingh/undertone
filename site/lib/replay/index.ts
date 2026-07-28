import type { Suggestion } from "@/lib/types";
import raw from "./sample-session.json";

export interface ReplayChunk {
  seq: number;
  transcript: string;
  suggestions: Suggestion[];
}

/** A real captured session, replayed when the live demo is unavailable. */
export const REPLAY_SESSION: ReplayChunk[] = raw as ReplayChunk[];
