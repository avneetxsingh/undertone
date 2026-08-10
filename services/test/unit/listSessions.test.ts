import { beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { generateApiKey } from "../../src/lib/auth";
import { handler } from "../../src/handlers/listSessions";

const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => {
  ddbMock.reset();
  process.env.KEY_PEPPER = "p";
  process.env.TABLE_NAME = "t";
});

describe("GET /v1/sessions", () => {
  test("401 without a key", async () => {
    const res = await handler({ headers: {} } as never);
    expect(res.statusCode).toBe(401);
  });

  test("200 queries only the authenticated account's partition and strips PK/SK", async () => {
    // The auth lookup issues a QueryCommand (GSI1) before the handler's own data QueryCommand.
    // resolvesOnce covers the auth call; resolves() becomes the default for the data call after it.
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [{ acctId: "A1", name: "n" }] })
      .resolves({
        Items: [
          { PK: "ACCT#A1", SK: "SESS#S1", sessId: "S1", title: "Standup", kind: "meeting", status: "active" },
        ],
      });
    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}` },
    } as never);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.sessions).toEqual([
      { sessId: "S1", title: "Standup", kind: "meeting", status: "active", id: "S1" },
    ]);

    // Distinguish the data call from the auth call by input shape (auth call has IndexName "GSI1").
    const calls = ddbMock.commandCalls(QueryCommand);
    const dataCall = calls.find((c) => !c.args[0].input.IndexName);
    expect(dataCall).toBeDefined();
    expect(dataCall!.args[0].input).toMatchObject({
      ExpressionAttributeValues: { ":p": "ACCT#A1" },
      ScanIndexForward: false,
      Limit: 50,
    });
  });
});
