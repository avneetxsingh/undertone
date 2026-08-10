import { beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { KMSClient, EncryptCommand } from "@aws-sdk/client-kms";
import { generateApiKey } from "../../src/lib/auth";
import { handler as postWebhook } from "../../src/handlers/postWebhook";
import { handler as listWebhooks } from "../../src/handlers/listWebhooks";
import { handler as getWebhook } from "../../src/handlers/getWebhook";
import { handler as patchWebhook } from "../../src/handlers/patchWebhook";
import { handler as deleteWebhook } from "../../src/handlers/deleteWebhook";

const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);
beforeEach(() => {
  ddbMock.reset();
  kmsMock.reset();
  process.env.KEY_PEPPER = "p";
  process.env.TABLE_NAME = "t";
  process.env.KMS_KEY_ID = "kms-key-1";
  kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: Buffer.from("cipher") });
});

// requireAccount does a GSI1 query; the webhook repo does table queries/gets.
// Route by IndexName so both coexist inside one handler invocation.
const withAuth = (extra: Record<string, unknown> = {}) => ({
  headers: { authorization: `Bearer ${generateApiKey()}` },
  ...extra,
});
const routeQueries = (webhookItems: unknown[]) =>
  ddbMock
    .on(QueryCommand)
    .callsFake((input) =>
      input.IndexName === "GSI1" ? { Items: [{ acctId: "A1", name: "n" }] } : { Items: webhookItems },
    );
const row = (over = {}) => ({
  whookId: "W1",
  url: "https://h.example.com/x",
  events: ["session.completed"],
  status: "active",
  createdAt: "2026-07-26T00:00:00.000Z",
  secretEnc: "enc",
  ...over,
});

describe("POST /v1/webhooks", () => {
  test("401 without key", async () => {
    expect((await postWebhook({ headers: {} } as never)).statusCode).toBe(401);
  });
  test("422 invalid_url for http", async () => {
    routeQueries([]);
    const res = await postWebhook(
      withAuth({ body: JSON.stringify({ url: "http://x.com", events: ["session.completed"] }) }) as never,
    );
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body!).error.code).toBe("invalid_url");
  });
  test("422 invalid_events for empty events", async () => {
    routeQueries([]);
    const res = await postWebhook(
      withAuth({ body: JSON.stringify({ url: "https://h.example.com/x", events: [] }) }) as never,
    );
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body!).error.code).toBe("invalid_events");
  });
  test("201 creates and returns the secret exactly once", async () => {
    routeQueries([]);
    ddbMock.on(PutCommand).resolves({});
    const res = await postWebhook(
      withAuth({
        body: JSON.stringify({ url: "https://h.example.com/x", events: ["session.completed"] }),
      }) as never,
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body!);
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.url).toBe("https://h.example.com/x");
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!.PK).toBe("ACCT#A1");
  });
  test("the create response never leaks the ciphertext", async () => {
    routeQueries([]);
    ddbMock.on(PutCommand).resolves({});
    const res = await postWebhook(
      withAuth({
        body: JSON.stringify({ url: "https://h.example.com/x", events: ["session.completed"] }),
      }) as never,
    );
    expect(res.body!).not.toContain("secretEnc");
  });
});

describe("GET list + get", () => {
  test("list never returns secretEnc", async () => {
    routeQueries([row()]);
    const res = await listWebhooks(withAuth() as never);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.webhooks[0]).not.toHaveProperty("secretEnc");
    expect(body.webhooks[0].whookId).toBe("W1");
  });
  test("get 404 when not owned", async () => {
    routeQueries([]);
    ddbMock.on(GetCommand).resolves({});
    const res = await getWebhook(withAuth({ pathParameters: { id: "W1" } }) as never);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body!).error.code).toBe("webhook_not_found");
  });
});

describe("PATCH /v1/webhooks/{id}", () => {
  test("404 when the update misses (IDOR-proof)", async () => {
    routeQueries([]);
    ddbMock
      .on(UpdateCommand)
      .rejects(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));
    const res = await patchWebhook(
      withAuth({ pathParameters: { id: "W1" }, body: JSON.stringify({ status: "paused" }) }) as never,
    );
    expect(res.statusCode).toBe(404);
  });
  test("rotateSecret returns a new secret once, never secretEnc", async () => {
    routeQueries([]);
    ddbMock.on(UpdateCommand).resolves({ Attributes: row({ status: "paused" }) });
    const res = await patchWebhook(
      withAuth({ pathParameters: { id: "W1" }, body: JSON.stringify({ rotateSecret: true }) }) as never,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.secret).toMatch(/^whsec_/);
    expect(body).not.toHaveProperty("secretEnc");
  });
  test("422 invalid_status for a bad status", async () => {
    routeQueries([]);
    const res = await patchWebhook(
      withAuth({ pathParameters: { id: "W1" }, body: JSON.stringify({ status: "on" }) }) as never,
    );
    expect(res.statusCode).toBe(422);
  });
});

describe("DELETE /v1/webhooks/{id}", () => {
  test("204 on success, 404 on miss", async () => {
    routeQueries([]);
    ddbMock
      .on(DeleteCommand)
      .resolvesOnce({})
      .rejectsOnce(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));
    expect((await deleteWebhook(withAuth({ pathParameters: { id: "W1" } }) as never)).statusCode).toBe(204);
    expect((await deleteWebhook(withAuth({ pathParameters: { id: "W1" } }) as never)).statusCode).toBe(404);
  });
});
