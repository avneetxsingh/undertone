import { beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { generateApiKey } from "../../src/lib/auth";
import { recordEvent } from "../../src/lib/events";
import { emitEvent } from "../../src/lib/emit";
import { handler as listEvents } from "../../src/handlers/listEvents";
import { handler as replayEvent } from "../../src/handlers/replayEvent";

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  process.env.TABLE_NAME = "t";
  process.env.KEY_PEPPER = "p";
  process.env.WEBHOOK_QUEUE_URL = "https://q";
});

const authed = (extra: Record<string, unknown> = {}) => ({
  headers: { authorization: `Bearer ${generateApiKey()}` },
  ...extra,
});

const storedEvent = {
  evtId: "E1",
  event: "session.completed",
  payload: { id: "S1" },
  createdAt: "2026-08-09T12:00:00.000Z",
};

const sub = (over: Record<string, unknown> = {}) => ({
  whookId: "W1",
  url: "https://h/x",
  events: ["session.completed"],
  status: "active",
  secretEnc: "e",
  createdAt: "2026-08-09T00:00:00.000Z",
  ...over,
});

/** requireAccount hits GSI1; the repos query WHOOK#/EVT# on the table. */
const routeQueries = (opts: { subs?: unknown[]; events?: unknown[] } = {}) =>
  ddbMock.on(QueryCommand).callsFake((input) => {
    if (input.IndexName === "GSI1") return { Items: [{ acctId: "A1", name: "n" }] };
    if (input.ExpressionAttributeValues?.[":w"] === "WHOOK#") return { Items: opts.subs ?? [] };
    if (input.ExpressionAttributeValues?.[":e"] === "EVT#") return { Items: opts.events ?? [] };
    return { Items: [] };
  });

describe("recordEvent", () => {
  test("stores the event account-scoped with a TTL", async () => {
    ddbMock.on(PutCommand).resolves({});
    const id = await recordEvent("A1", "session.completed", { id: "S1" }, storedEvent.createdAt);

    expect(id).toBeTruthy();
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.PK).toBe("ACCT#A1");
    expect(String(item.SK)).toMatch(/^EVT#/);
    expect(item.event).toBe("session.completed");
    expect(Number(item.expiresAt)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("never throws into its caller", async () => {
    ddbMock.on(PutCommand).rejects(new Error("ddb down"));
    await expect(recordEvent("A1", "session.completed", {}, storedEvent.createdAt)).resolves.toBeNull();
  });
});

describe("emit logs events even with no subscribers", () => {
  test("an event nobody is listening for is still recorded", async () => {
    // This is the case replay exists for: register a webhook after the fact.
    routeQueries({ subs: [] });
    ddbMock.on(PutCommand).resolves({});
    await emitEvent("A1", "session.completed", { id: "S1" });

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});

describe("GET /v1/events", () => {
  test("401 without a key", async () => {
    expect((await listEvents({ headers: {} } as never)).statusCode).toBe(401);
  });

  test("returns the account's events newest first", async () => {
    routeQueries({ events: [storedEvent] });
    const res = await listEvents(authed() as never);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.events[0].evtId).toBe("E1");
    expect(body.retentionDays).toBe(7);
    const input = ddbMock
      .commandCalls(QueryCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.ExpressionAttributeValues?.[":e"] === "EVT#")!;
    expect(input.ScanIndexForward).toBe(false);
    expect(input.ExpressionAttributeValues![":p"]).toBe("ACCT#A1");
  });

  test("caps an oversized limit rather than trusting the caller", async () => {
    routeQueries({ events: [] });
    await listEvents(authed({ queryStringParameters: { limit: "100000" } }) as never);

    const input = ddbMock
      .commandCalls(QueryCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.ExpressionAttributeValues?.[":e"] === "EVT#")!;
    expect(input.Limit).toBe(100);
  });
});

describe("POST /v1/events/{id}/replay", () => {
  test("404 for an event id this account does not own", async () => {
    routeQueries();
    ddbMock.on(GetCommand).resolves({});
    const res = await replayEvent(authed({ pathParameters: { id: "E1" } }) as never);

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body!).error.code).toBe("event_not_found");
  });

  test("re-enqueues to subscriptions matching now, keeping the original event id", async () => {
    routeQueries({ subs: [sub()] });
    ddbMock.on(GetCommand).resolves({ Item: storedEvent });
    sqsMock.on(SendMessageCommand).resolves({});

    const res = await replayEvent(authed({ pathParameters: { id: "E1" } }) as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).replayed).toBe(1);
    const msg = JSON.parse(sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!);
    // Same id as the original delivery, so a receiver de-duplicating on
    // X-Undertone-Delivery sees a repeat rather than a new event.
    expect(msg.eventId).toBe("E1");
    expect(msg.event).toBe("session.completed");
    expect(msg.whookId).toBe("W1");
  });

  test("skips subscriptions that do not want this event, reporting zero", async () => {
    routeQueries({ subs: [sub({ events: ["chunk.transcribed"] })] });
    ddbMock.on(GetCommand).resolves({ Item: storedEvent });

    const res = await replayEvent(authed({ pathParameters: { id: "E1" } }) as never);

    expect(JSON.parse(res.body!).replayed).toBe(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});
