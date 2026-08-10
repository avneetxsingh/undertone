import type { Suggestion } from "@/lib/types";

export type WebhookEventName =
  | "session.created"
  | "chunk.transcribed"
  | "suggestions.generated"
  | "session.completed";

export const WEBHOOK_EVENT_NAMES: WebhookEventName[] = [
  "session.created",
  "chunk.transcribed",
  "suggestions.generated",
  "session.completed",
];

export interface SessionSummary {
  sessId: string;
  title: string;
  kind: string;
  status: "active" | "ended";
  createdAt: string;
  chunkCount: number;
}

export interface SessionChunk {
  seq: number;
  transcript: string;
  suggestions: Suggestion[];
  createdAt: string;
}

export interface SessionDetail extends SessionSummary {
  chunks: SessionChunk[];
  summary?: string;
  actionItems?: { task: string; owner: string | null }[];
}

export interface Webhook {
  whookId: string;
  url: string;
  events: WebhookEventName[];
  status: "active" | "paused";
  createdAt: string;
  lastStatus?: "delivered" | "failed";
  lastDeliveryAt?: string;
  lastError?: string | null;
}

export interface StoredEvent {
  evtId: string;
  event: WebhookEventName;
  payload: unknown;
  createdAt: string;
}

/**
 * Carries the platform's own error code so panels can distinguish a rejected
 * key from a rate limit from a capacity failure without parsing strings.
 */
export class DashboardError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "DashboardError";
  }
}

export interface DashboardSource {
  readonly isSample: boolean;
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetail>;
  listWebhooks(): Promise<Webhook[]>;
  createWebhook(
    url: string,
    events: WebhookEventName[],
  ): Promise<{ webhook: Webhook; secret: string }>;
  deleteWebhook(id: string): Promise<void>;
  listEvents(limit?: number): Promise<StoredEvent[]>;
  replayEvent(id: string): Promise<{ replayed: number }>;
}
