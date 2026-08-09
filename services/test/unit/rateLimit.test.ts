import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { enforceRateLimit } from "../../src/lib/rateLimit";
import { generateApiKey, requireAccount } from "../../src/lib/auth";

const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => {
  ddbMock.reset();
  process.env.TABLE_NAME = "t";
  process.env.KEY_PEPPER = "p";
});
afterEach(() => delete process.env.RATE_LIMIT_PER_MINUTE);

describe("enforceRateLimit", () => {
  test("does nothing when the limit is unset", async () => {
    await enforceRateLimit("A1");
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  test("counts under an account-scoped RATE# key", async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "10";
    ddbMock.on(UpdateCommand).resolves({ Attributes: { hits: 1 } });

    await enforceRateLimit("A1");

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toMatchObject({ PK: "ACCT#A1" });
    expect(String(input.Key!.SK)).toMatch(/^RATE#\d+$/);
    expect(input.UpdateExpression).toContain("ADD hits :one");
  });

  test("allows the request exactly at the limit and rejects the one after", async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "10";
    ddbMock.on(UpdateCommand).resolvesOnce({ Attributes: { hits: 10 } });
    await expect(enforceRateLimit("A1")).resolves.toBeUndefined();

    ddbMock.on(UpdateCommand).resolves({ Attributes: { hits: 11 } });
    await expect(enforceRateLimit("A1")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  test("fails open when the counter write errors", async () => {
    // Availability over enforcement: a DynamoDB blip must not take the whole
    // API down for every account at once.
    process.env.RATE_LIMIT_PER_MINUTE = "10";
    ddbMock.on(UpdateCommand).rejects(new Error("ddb down"));
    await expect(enforceRateLimit("A1")).resolves.toBeUndefined();
  });
});

describe("requireAccount integration", () => {
  const authed = { headers: { authorization: `Bearer ${generateApiKey()}` } };

  test("a valid key over the limit gets 429, not 200", async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "5";
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n" }] });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { hits: 6 } });

    await expect(requireAccount(authed)).rejects.toMatchObject({ status: 429 });
  });

  test("an unknown key is rejected before anything is counted against an account", async () => {
    // Otherwise a stranger guessing keys could burn a real account's quota.
    process.env.RATE_LIMIT_PER_MINUTE = "5";
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(requireAccount(authed)).rejects.toMatchObject({ status: 401 });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
