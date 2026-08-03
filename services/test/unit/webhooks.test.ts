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
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhooks,
  recordDelivery,
  redactWebhook,
  updateWebhook,
} from "../../src/lib/webhooks";

const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);
beforeEach(() => {
  ddbMock.reset();
  kmsMock.reset();
  process.env.TABLE_NAME = "t";
  process.env.KMS_KEY_ID = "kms-key-1";
  kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: Buffer.from("cipher") });
});

const row = (over: Record<string, unknown> = {}) => ({
  whookId: "W1",
  url: "https://h.example.com/x",
  events: ["session.completed"],
  status: "active",
  createdAt: "2026-07-26T00:00:00.000Z",
  secretEnc: "enc",
  ...over,
});

describe("createWebhook", () => {
  test("stores an account-scoped active item with encrypted secret; returns plaintext once", async () => {
    ddbMock.on(PutCommand).resolves({});
    const { sub, secret } = await createWebhook("A1", "https://h.example.com/x", ["session.completed"]);
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.PK).toBe("ACCT#A1");
    expect(String(item.SK)).toMatch(/^WHOOK#/);
    expect(item.status).toBe("active");
    expect(item.secretEnc).toBe(Buffer.from("cipher").toString("base64"));
    expect(item.secretEnc).not.toBe(secret);
    expect(sub.whookId).toBe(item.whookId);
  });
});

describe("listWebhooks / getWebhook / redactWebhook", () => {
  test("list queries WHOOK# under the account", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row()] });
    const subs = await listWebhooks("A1");
    expect(subs[0].whookId).toBe("W1");
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues![":p"]).toBe("ACCT#A1");
    expect(input.ExpressionAttributeValues![":w"]).toBe("WHOOK#");
  });
  test("get returns null when absent, item when present", async () => {
    ddbMock.on(GetCommand).resolvesOnce({}).resolvesOnce({ Item: row() });
    expect(await getWebhook("A1", "W1")).toBeNull();
    expect((await getWebhook("A1", "W1"))!.url).toBe("https://h.example.com/x");
  });
  test("redactWebhook drops secretEnc", () => {
    expect(redactWebhook(row() as never)).not.toHaveProperty("secretEnc");
  });
});

describe("updateWebhook", () => {
  test("returns null when the conditional update misses (not owned)", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));
    expect(await updateWebhook("A1", "W1", { status: "paused" })).toBeNull();
  });
  test("rotateSecret writes a new encrypted secret and returns the plaintext once", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: row({ status: "paused" }) });
    const res = await updateWebhook("A1", "W1", { rotateSecret: true });
    expect(res!.secret).toMatch(/^whsec_/);
    const values = ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues!;
    expect(values[":secretEnc"]).toBe(Buffer.from("cipher").toString("base64"));
  });
  test("reserved attribute names go through ExpressionAttributeNames", async () => {
    // url and status are DynamoDB reserved words. Writing them bare produces a
    // ValidationException that only shows up against the real table, never
    // against this mock — so assert the aliases here instead.
    ddbMock.on(UpdateCommand).resolves({ Attributes: row() });
    await updateWebhook("A1", "W1", { url: "https://new.example.com/x", status: "paused" });
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    // The lookbehind matters: \b matches between "#" and "u", so a bare /\burl/
    // would also match the correctly-aliased "#url".
    expect(input.UpdateExpression).not.toMatch(/(?<!#)\burl\s*=/);
    expect(input.UpdateExpression).not.toMatch(/(?<!#)\bstatus\s*=/);
    expect(Object.values(input.ExpressionAttributeNames!)).toEqual(
      expect.arrayContaining(["url", "status"]),
    );
  });
});

describe("deleteWebhook", () => {
  test("true on success, false on conditional miss", async () => {
    ddbMock
      .on(DeleteCommand)
      .resolvesOnce({})
      .rejectsOnce(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));
    expect(await deleteWebhook("A1", "W1")).toBe(true);
    expect(await deleteWebhook("A1", "W1")).toBe(false);
  });
});

describe("recordDelivery", () => {
  test("writes status best-effort and swallows failures", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await recordDelivery("A1", "W1", "delivered");
    const v = ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues!;
    expect(v[":st"]).toBe("delivered");
    ddbMock.on(UpdateCommand).rejects(new Error("ddb down"));
    await expect(recordDelivery("A1", "W1", "failed", "timeout")).resolves.toBeUndefined();
  });
});
