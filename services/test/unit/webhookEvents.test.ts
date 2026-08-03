import { describe, expect, test } from "vitest";
import { WEBHOOK_EVENTS, areValidEvents, isWebhookEvent } from "../../src/lib/webhookEvents";

describe("webhookEvents", () => {
  test("exposes exactly the four known events", () => {
    expect([...WEBHOOK_EVENTS]).toEqual([
      "session.created",
      "chunk.transcribed",
      "suggestions.generated",
      "session.completed",
    ]);
  });
  test("isWebhookEvent accepts known, rejects unknown/non-string", () => {
    expect(isWebhookEvent("session.completed")).toBe(true);
    expect(isWebhookEvent("session.deleted")).toBe(false);
    expect(isWebhookEvent(42)).toBe(false);
  });
  test("areValidEvents requires a non-empty subset of known events", () => {
    expect(areValidEvents(["session.created", "session.completed"])).toBe(true);
    expect(areValidEvents([])).toBe(false);
    expect(areValidEvents(["nope"])).toBe(false);
    expect(areValidEvents("session.created")).toBe(false);
  });
});
