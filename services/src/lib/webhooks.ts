import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { ddb, tableName } from "./ddb";
import { acctPk, whookSk } from "./keys";
import { encryptSecret, generateWebhookSecret } from "./webhookSecret";
import type { WebhookEvent } from "./webhookEvents";

export interface WebhookSub {
  whookId: string;
  url: string;
  events: WebhookEvent[];
  status: "active" | "paused";
  createdAt: string;
  secretEnc: string;
  lastStatus?: "delivered" | "failed";
  lastDeliveryAt?: string;
  lastError?: string;
}

export type PublicWebhook = Omit<WebhookSub, "secretEnc">;

export const redactWebhook = ({ secretEnc: _s, ...rest }: WebhookSub): PublicWebhook => rest;

const view = (i: Record<string, unknown>): WebhookSub => ({
  whookId: i.whookId as string,
  url: i.url as string,
  events: i.events as WebhookEvent[],
  status: i.status as WebhookSub["status"],
  createdAt: i.createdAt as string,
  secretEnc: i.secretEnc as string,
  lastStatus: i.lastStatus as WebhookSub["lastStatus"],
  lastDeliveryAt: i.lastDeliveryAt as string | undefined,
  lastError: i.lastError as string | undefined,
});

export async function createWebhook(
  acctId: string,
  url: string,
  events: WebhookEvent[],
): Promise<{ sub: WebhookSub; secret: string }> {
  const whookId = ulid();
  const secret = generateWebhookSecret();
  const secretEnc = await encryptSecret(secret);
  const createdAt = new Date().toISOString();
  const sub: WebhookSub = { whookId, url, events, status: "active", createdAt, secretEnc };
  await ddb.send(
    new PutCommand({ TableName: tableName(), Item: { PK: acctPk(acctId), SK: whookSk(whookId), ...sub } }),
  );
  return { sub, secret };
}

export async function listWebhooks(acctId: string): Promise<WebhookSub[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: "PK = :p AND begins_with(SK, :w)",
      ExpressionAttributeValues: { ":p": acctPk(acctId), ":w": "WHOOK#" },
    }),
  );
  return (res.Items ?? []).map(view);
}

export async function getWebhook(acctId: string, whookId: string): Promise<WebhookSub | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: tableName(), Key: { PK: acctPk(acctId), SK: whookSk(whookId) } }),
  );
  return res.Item ? view(res.Item) : null;
}

export async function updateWebhook(
  acctId: string,
  whookId: string,
  patch: { url?: string; events?: WebhookEvent[]; status?: "active" | "paused"; rotateSecret?: boolean },
): Promise<{ sub: WebhookSub; secret?: string } | null> {
  const sets: string[] = [];
  const values: Record<string, unknown> = {};
  // url, events and status are all DynamoDB reserved words, so every one of
  // them is aliased. Writing them bare fails with a ValidationException that a
  // mocked test cannot see — it only appears against the real table.
  const names: Record<string, string> = {};
  if (patch.url !== undefined) {
    sets.push("#url = :url");
    names["#url"] = "url";
    values[":url"] = patch.url;
  }
  if (patch.events !== undefined) {
    sets.push("#events = :events");
    names["#events"] = "events";
    values[":events"] = patch.events;
  }
  if (patch.status !== undefined) {
    sets.push("#status = :status");
    names["#status"] = "status";
    values[":status"] = patch.status;
  }
  let secret: string | undefined;
  if (patch.rotateSecret) {
    secret = generateWebhookSecret();
    sets.push("secretEnc = :secretEnc");
    values[":secretEnc"] = await encryptSecret(secret);
  }
  if (sets.length === 0) {
    const existing = await getWebhook(acctId, whookId);
    return existing ? { sub: existing } : null;
  }
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: acctPk(acctId), SK: whookSk(whookId) },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "attribute_exists(PK)",
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
    return { sub: view(res.Attributes!), secret };
  } catch (e) {
    if ((e as Error).name === "ConditionalCheckFailedException") return null;
    throw e;
  }
}

export async function deleteWebhook(acctId: string, whookId: string): Promise<boolean> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: tableName(),
        Key: { PK: acctPk(acctId), SK: whookSk(whookId) },
        ConditionExpression: "attribute_exists(PK)",
      }),
    );
    return true;
  } catch (e) {
    if ((e as Error).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/**
 * Best-effort delivery bookkeeping. Never throws: the sender calls this and
 * then rethrows the delivery failure so SQS retries, and a bookkeeping error
 * must not mask or replace that.
 */
export async function recordDelivery(
  acctId: string,
  whookId: string,
  status: "delivered" | "failed",
  error?: string,
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: acctPk(acctId), SK: whookSk(whookId) },
        UpdateExpression: "SET lastStatus = :st, lastDeliveryAt = :at, lastError = :er",
        ExpressionAttributeValues: { ":st": status, ":at": new Date().toISOString(), ":er": error ?? null },
      }),
    );
  } catch (e) {
    console.error("recordDelivery failed (non-fatal)", e);
  }
}
