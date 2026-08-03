import { beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { generateApiKey } from "../../src/lib/auth";
import { handler as createSession } from "../../src/handlers/createSession";
import { handler as endSession } from "../../src/handlers/endSession";

const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);
const sqsMock = mockClient(SQSClient);

beforeEach(() => {
  ddbMock.reset();
  kmsMock.reset();
  sqsMock.reset();
  process.env.KEY_PEPPER = "p";
  process.env.TABLE_NAME = "t";
  process.env.WEBHOOK_QUEUE_URL = "https://q";
});

const authed = (extra: Record<string, unknown> = {}) => ({
  headers: { authorization: `Bearer ${generateApiKey()}` },
  ...extra,
});

const subscribedTo = (event: string) => ({
  whookId: "W1",
  url: "https://h/x",
  events: [event],
  status: "active",
  secretEnc: "e",
  createdAt: "2026-07-26T00:00:00.000Z",
});

/**
 * requireAccount queries GSI1; the webhook repo queries the table with
 * begins_with(SK, "WHOOK#"); producers query their own chunk rows. Route on
 * those markers so all three coexist in one handler invocation.
 */
const routeQueries = (subs: unknown[], other: unknown[] = []) =>
  ddbMock.on(QueryCommand).callsFake((input) => {
    if (input.IndexName === "GSI1") return { Items: [{ acctId: "A1", name: "n", groqKeyEnc: "x" }] };
    if (input.ExpressionAttributeValues?.[":w"] === "WHOOK#") return { Items: subs };
    return { Items: other };
  });

describe("createSession emits session.created", () => {
  test("enqueues one delivery for a matching subscription", async () => {
    routeQueries([subscribedTo("session.created")]);
    ddbMock.on(PutCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    const res = await createSession(authed({ body: JSON.stringify({ title: "t" }) }) as never);

    expect(res.statusCode).toBe(201);
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].args[0].input.MessageBody!).event).toBe("session.created");
  });

  test("still returns 201 when the emit enqueue fails (best-effort)", async () => {
    routeQueries([subscribedTo("session.created")]);
    ddbMock.on(PutCommand).resolves({});
    sqsMock.on(SendMessageCommand).rejects(new Error("sqs down"));

    const res = await createSession(authed({ body: JSON.stringify({ title: "t" }) }) as never);

    expect(res.statusCode).toBe(201);
  });

  test("does not enqueue for a subscription that did not ask for this event", async () => {
    routeQueries([subscribedTo("session.completed")]);
    ddbMock.on(PutCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await createSession(authed({ body: JSON.stringify({ title: "t" }) }) as never);

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});

describe("endSession emits session.completed", () => {
  test("emits even when summary generation failed", async () => {
    // The summary block catches its own errors and sets warning=summary_failed.
    // The event must still fire: the session did end, which is what subscribers
    // asked about.
    routeQueries([subscribedTo("session.completed")]);
    ddbMock.on(UpdateCommand).resolves({});
    kmsMock.rejects(new Error("kms down")); // forces the summary path to fail
    sqsMock.on(SendMessageCommand).resolves({});

    const res = await endSession(authed({ pathParameters: { id: "S1" } }) as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).warning).toBe("summary_failed");
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].args[0].input.MessageBody!).event).toBe("session.completed");
  });
});
