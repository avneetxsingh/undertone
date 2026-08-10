import { beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { generateApiKey, hashApiKey, requireAccount } from "../../src/lib/auth";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  process.env.KEY_PEPPER = "test-pepper";
  process.env.TABLE_NAME = "test-table";
});

describe("api keys", () => {
  test("generated keys match the documented shape", () => {
    expect(generateApiKey()).toMatch(/^ut_live_[0-9a-f]{48}$/);
  });
  test("hash is deterministic and pepper-dependent", () => {
    expect(hashApiKey("k", "p")).toBe(hashApiKey("k", "p"));
    expect(hashApiKey("k", "p")).not.toBe(hashApiKey("k", "p2"));
  });
});

describe("requireAccount", () => {
  test("rejects missing/malformed header with 401", async () => {
    await expect(requireAccount({ headers: {} })).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    await expect(requireAccount({ headers: { authorization: "Bearer nope" } })).rejects.toMatchObject({ status: 401 });
  });
  test("rejects unknown key with 401", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(requireAccount({ headers: { authorization: `Bearer ${generateApiKey()}` } }))
      .rejects.toMatchObject({ status: 401 });
  });
  test("returns the account for a known key", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "avneet" }] });
    const acct = await requireAccount({ headers: { authorization: `Bearer ${generateApiKey()}` } });
    expect(acct.acctId).toBe("A1");
  });
});
