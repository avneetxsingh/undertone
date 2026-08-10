import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { generateApiKey } from "../../src/lib/auth";
import { handler } from "../../src/handlers/endSession";
import { startFakeGroq } from "../helpers/fakeGroq";

const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);
let fake: { url: string; close(): void } | undefined;

beforeEach(() => {
  ddbMock.reset(); kmsMock.reset();
  process.env.KEY_PEPPER = "p"; process.env.TABLE_NAME = "t";
});
afterEach(() => { fake?.close(); delete process.env.GROQ_BASE_URL; });

const authedEvent = { headers: { authorization: `Bearer ${generateApiKey()}` }, pathParameters: { id: "S1" } };

describe("POST /v1/sessions/{id}/end", () => {
  test("409 when already ended (or nonexistent)", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", groqKeyEnc: "x" }] });
    const err = new Error("cond"); err.name = "ConditionalCheckFailedException";
    ddbMock.on(UpdateCommand).rejects(err);
    const res = await handler(authedEvent as never);
    expect(res.statusCode).toBe(409);
  });
  test("ends session and returns summary", async () => {
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [{ acctId: "A1", groqKeyEnc: Buffer.from("c").toString("base64") }] })
      .resolves({ Items: [{ transcript: "we agreed to ship friday", suggestions: [] }] });
    ddbMock.on(UpdateCommand).resolves({});
    kmsMock.on(DecryptCommand).resolves({ Plaintext: Buffer.from("gsk_k") });
    fake = await startFakeGroq({ chat: { summary: "Shipped decision", action_items: [{ owner: null, task: "ship friday" }] } });
    process.env.GROQ_BASE_URL = fake.url;
    const res = await handler(authedEvent as never);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("ended");
    expect(body.summary).toBe("Shipped decision");
    expect(body.actionItems).toHaveLength(1);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(2);
    const secondInput = updateCalls[1].args[0].input;
    expect(secondInput.Key).toEqual({ PK: "ACCT#A1", SK: "SESS#S1" });
    expect(secondInput.UpdateExpression).toContain("summary");
    expect(secondInput.UpdateExpression).toContain("actionItems");
    expect(secondInput.ExpressionAttributeValues).toMatchObject({
      ":s": "Shipped decision",
      ":a": [{ owner: null, task: "ship friday" }],
    });
  });
  test("does not query chunks when session end is rejected", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", groqKeyEnc: "x" }] });
    const err = new Error("cond"); err.name = "ConditionalCheckFailedException";
    ddbMock.on(UpdateCommand).rejects(err);
    const res = await handler(authedEvent as never);
    expect(res.statusCode).toBe(409);

    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls.length).toBeGreaterThan(0);
    for (const call of queryCalls) {
      expect(call.args[0].input.IndexName).toBe("GSI1");
    }
  });
  test("still ends the session when summary generation fails", async () => {
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [{ acctId: "A1" }] }) // no groqKeyEnc → getGroqKey throws
      .resolves({ Items: [] });
    ddbMock.on(UpdateCommand).resolves({});
    const res = await handler(authedEvent as never);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("ended");
    expect(body.warning).toBe("summary_failed");
  });
});
