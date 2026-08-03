export const WEBHOOK_EVENTS = [
  "session.created",
  "chunk.transcribed",
  "suggestions.generated",
  "session.completed",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const isWebhookEvent = (v: unknown): v is WebhookEvent =>
  typeof v === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(v);

export const areValidEvents = (v: unknown): v is WebhookEvent[] =>
  Array.isArray(v) && v.length > 0 && v.every(isWebhookEvent);
