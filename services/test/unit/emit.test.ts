import { beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { emitEvent, emitEvents } from "../../src/lib/emit";

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);
beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  process.env.TABLE_NAME = "t";
  process.env.WEBHOOK_QUEUE_URL = "https://q";
});

const sub = (over: Record<string, unknown> = {}) => ({
  whookId: "W1",
  url: "https://h/x",
  events: ["session.completed"],
  status: "active",
  createdAt: "2026-07-26T00:00:00.000Z",
  secretEnc: "enc",
  ...over,
});

describe("emitEvent", () => {
  test("no-ops when WEBHOOK_QUEUE_URL is unset", async () => {
    delete process.env.WEBHOOK_QUEUE_URL;
    await emitEvent("A1", "session.completed", { id: "S1" });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
  test("enqueues one message per matching active subscription", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        sub({ whookId: "W1", events: ["session.completed"] }),
        sub({ whookId: "W2", events: ["chunk.transcribed"] }), // event mismatch
        sub({ whookId: "W3", events: ["session.completed"], status: "paused" }), // inactive
      ],
    });
    sqsMock.on(SendMessageCommand).resolves({});
    await emitEvent("A1", "session.completed", { id: "S1" });
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    const msg = JSON.parse(calls[0].args[0].input.MessageBody!);
    expect(msg).toMatchObject({
      event: "session.completed",
      acctId: "A1",
      whookId: "W1",
      payload: { id: "S1" },
    });
    expect(calls[0].args[0].input.QueueUrl).toBe("https://q");
  });
  test("never puts the signing secret on the queue", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [sub({ secretEnc: "SUPERSECRETCIPHER" })] });
    sqsMock.on(SendMessageCommand).resolves({});
    await emitEvent("A1", "session.completed", { id: "S1" });
    const body = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!;
    expect(body).not.toContain("SUPERSECRETCIPHER");
    expect(body).not.toContain("secretEnc");
  });
  test("swallows failures (best-effort)", async () => {
    ddbMock.on(QueryCommand).rejects(new Error("ddb down"));
    await expect(emitEvent("A1", "session.completed", {})).resolves.toBeUndefined();
  });
});

describe("emitEvents (batch)", () => {
  test("reads the subscription list once for several events", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [sub({ whookId: "W1", events: ["chunk.transcribed", "suggestions.generated"] })],
    });
    sqsMock.on(SendMessageCommand).resolves({});

    await emitEvents("A1", [
      { event: "chunk.transcribed", payload: { seq: 1 } },
      { event: "suggestions.generated", payload: { seq: 1 } },
    ]);

    // The point of the batch form: one DynamoDB query, two deliveries.
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    const events = sqsMock
      .commandCalls(SendMessageCommand)
      .map((c) => JSON.parse(c.args[0].input.MessageBody!).event)
      .sort();
    expect(events).toEqual(["chunk.transcribed", "suggestions.generated"]);
  });

  test("filters each event against its own subscribers", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        sub({ whookId: "W1", events: ["chunk.transcribed"] }),
        sub({ whookId: "W2", events: ["suggestions.generated"] }),
        sub({ whookId: "W3", events: ["chunk.transcribed"], status: "paused" }),
      ],
    });
    sqsMock.on(SendMessageCommand).resolves({});

    await emitEvents("A1", [
      { event: "chunk.transcribed", payload: {} },
      { event: "suggestions.generated", payload: {} },
    ]);

    const pairs = sqsMock
      .commandCalls(SendMessageCommand)
      .map((c) => {
        const m = JSON.parse(c.args[0].input.MessageBody!);
        return `${m.whookId}:${m.event}`;
      })
      .sort();
    expect(pairs).toEqual(["W1:chunk.transcribed", "W2:suggestions.generated"]);
  });

  test("an empty batch does nothing", async () => {
    await emitEvents("A1", []);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});
