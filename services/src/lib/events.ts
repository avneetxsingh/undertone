import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { ddb, tableName } from "./ddb";
import { acctPk, evtSk } from "./keys";
import type { WebhookEvent } from "./webhookEvents";

/** How long an emitted event stays replayable. */
export const EVENT_TTL_DAYS = 7;

export interface StoredEvent {
  evtId: string;
  event: WebhookEvent;
  payload: unknown;
  createdAt: string;
}

const view = (i: Record<string, unknown>): StoredEvent => ({
  evtId: i.evtId as string,
  event: i.event as WebhookEvent,
  payload: i.payload,
  createdAt: i.createdAt as string,
});

/**
 * Persists an emitted event so it can be replayed later.
 *
 * Deliberately written even when no subscription matches: the common reason to
 * replay is that a webhook was registered — or fixed — *after* the event
 * happened, so a log that only kept delivered events would be useless for
 * exactly the case it exists to serve.
 *
 * Best-effort, like every other webhook-side write: returns null instead of
 * throwing, because a failure here must never fail the API call that emitted it.
 */
export async function recordEvent(
  acctId: string,
  event: WebhookEvent,
  payload: unknown,
  createdAt: string,
): Promise<string | null> {
  const evtId = ulid();
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          PK: acctPk(acctId),
          SK: evtSk(evtId),
          evtId,
          event,
          payload,
          createdAt,
          expiresAt: Math.floor(Date.now() / 1000) + EVENT_TTL_DAYS * 86400,
        },
      }),
    );
    return evtId;
  } catch (e) {
    console.error("recordEvent failed (non-fatal)", e);
    return null;
  }
}

/** Newest first. ULIDs sort lexicographically by time, so ScanIndexForward:false is enough. */
export async function listEvents(acctId: string, limit = 50): Promise<StoredEvent[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: "PK = :p AND begins_with(SK, :e)",
      ExpressionAttributeValues: { ":p": acctPk(acctId), ":e": "EVT#" },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (res.Items ?? []).map(view);
}

export async function getEvent(acctId: string, evtId: string): Promise<StoredEvent | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: tableName(), Key: { PK: acctPk(acctId), SK: evtSk(evtId) } }),
  );
  return res.Item ? view(res.Item) : null;
}
