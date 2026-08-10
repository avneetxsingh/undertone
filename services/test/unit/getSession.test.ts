import { beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { generateApiKey } from "../../src/lib/auth";
import { handler } from "../../src/handlers/getSession";

const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => {
  ddbMock.reset();
  process.env.KEY_PEPPER = "p";
  process.env.TABLE_NAME = "t";
});

describe("GET /v1/sessions/{id}", () => {
  test("401 without a key", async () => {
    const res = await handler({ headers: {} } as never);
    expect(res.statusCode).toBe(401);
  });

  test("422 when pathParameters.id is missing", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n" }] });
    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}` },
      pathParameters: {},
    } as never);
    expect(res.statusCode).toBe(422);
  });

  test("404 when the account-scoped GetCommand finds no item (IDOR regression)", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n" }] });
    ddbMock.on(GetCommand).resolves({});
    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}` },
      pathParameters: { id: "S1" },
    } as never);
    expect(res.statusCode).toBe(404);
    // The Key must be built from the authenticated account, never anything client-supplied.
    const getCall = ddbMock.commandCalls(GetCommand)[0];
    expect(getCall.args[0].input).toMatchObject({
      Key: { PK: "ACCT#A1", SK: "SESS#S1" },
    });
  });

  test("200 happy path returns session without PK/SK plus chunks", async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [{ acctId: "A1", name: "n" }] })
      .resolves({
        Items: [
          { seq: 1, transcript: "hello there", suggestions: ["hi"], createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      });
    ddbMock.on(GetCommand).resolves({
      Item: {
        PK: "ACCT#A1",
        SK: "SESS#S1",
        sessId: "S1",
        title: "Standup",
        kind: "meeting",
        status: "active",
        chunkCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}` },
      pathParameters: { id: "S1" },
    } as never);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.PK).toBeUndefined();
    expect(body.SK).toBeUndefined();
    expect(body.sessId).toBe("S1");
    expect(body.id).toBe("S1");
    expect(body.chunks).toEqual([
      { seq: 1, transcript: "hello there", suggestions: ["hi"], createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });
});
