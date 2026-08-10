import { beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { generateApiKey } from "../../src/lib/auth";
import { handler } from "../../src/handlers/createSession";

const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => {
  ddbMock.reset();
  process.env.KEY_PEPPER = "p";
  process.env.TABLE_NAME = "t";
});

describe("POST /v1/sessions", () => {
  test("401 without a key", async () => {
    const res = await handler({ headers: {} } as never);
    expect(res.statusCode).toBe(401);
  });
  test("201 with defaults for a valid key", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n" }] });
    ddbMock.on(PutCommand).resolves({});
    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}` },
      body: JSON.stringify({ title: "Standup", kind: "meeting" }),
    } as never);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body!);
    expect(body.title).toBe("Standup");
    expect(body.status).toBe("active");
    expect(body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ulid
  });
  test("422 on invalid kind", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1" }] });
    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}` },
      body: JSON.stringify({ kind: "podcast" }),
    } as never);
    expect(res.statusCode).toBe(422);
  });
  test("400 invalid_json on malformed body", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1" }] });
    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}` },
      body: "{not json",
    } as never);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error.code).toBe("invalid_json");
  });
});
