import { beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { KMSClient, EncryptCommand } from "@aws-sdk/client-kms";
import { generateApiKey } from "../../src/lib/auth";
import { handler } from "../../src/handlers/putGroqKey";

const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);

beforeEach(() => {
  ddbMock.reset();
  kmsMock.reset();
  process.env.KEY_PEPPER = "p";
  process.env.TABLE_NAME = "t";
  process.env.KMS_KEY_ID = "kms-key-1";
});

describe("PUT /v1/account/groq-key", () => {
  test("401 without a key", async () => {
    const res = await handler({ headers: {} } as never);
    expect(res.statusCode).toBe(401);
    expect(kmsMock.commandCalls(EncryptCommand)).toHaveLength(0);
  });

  test("422 invalid_groq_key for a malformed key", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n" }] });
    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}` },
      body: JSON.stringify({ groqKey: "not-a-gsk-key" }),
    } as never);
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body!);
    expect(body.error.code).toBe("invalid_groq_key");
    expect(kmsMock.commandCalls(EncryptCommand)).toHaveLength(0);
  });

  test("422 invalid_groq_key for missing body", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n" }] });
    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}` },
    } as never);
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body!);
    expect(body.error.code).toBe("invalid_groq_key");
    expect(kmsMock.commandCalls(EncryptCommand)).toHaveLength(0);
  });

  test("400 invalid_json on malformed body", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n" }] });
    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}` },
      body: "{not json",
    } as never);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error.code).toBe("invalid_json");
    expect(kmsMock.commandCalls(EncryptCommand)).toHaveLength(0);
  });

  test("200 happy path encrypts the key and scopes the update to the authenticated account", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n" }] });
    kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: Buffer.from("cipher") });
    ddbMock.on(UpdateCommand).resolves({});

    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}` },
      body: JSON.stringify({ groqKey: "gsk_test123" }),
    } as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ ok: true });

    const encryptCall = kmsMock.commandCalls(EncryptCommand)[0];
    expect(encryptCall.args[0].input).toMatchObject({
      Plaintext: Buffer.from("gsk_test123"),
      KeyId: "kms-key-1",
    });

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall.args[0].input).toMatchObject({
      Key: { PK: "ACCT#A1", SK: "META" },
    });
    const storedValue = updateCall.args[0].input.ExpressionAttributeValues![":e"];
    expect(storedValue).toBe(Buffer.from("cipher").toString("base64"));
    expect(storedValue).not.toBe("gsk_test123");
  });
});
