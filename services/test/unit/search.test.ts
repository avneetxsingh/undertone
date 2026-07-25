import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { QueryVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { generateApiKey } from "../../src/lib/auth";
import { handler } from "../../src/handlers/search";

const ddbMock = mockClient(DynamoDBDocumentClient);
const svMock = mockClient(S3VectorsClient);
beforeEach(() => {
  ddbMock.reset(); svMock.reset();
  process.env.KEY_PEPPER = "p"; process.env.TABLE_NAME = "t";
  process.env.VECTOR_BUCKET = "vb"; process.env.VECTOR_INDEX = "chunks";
  process.env.GEMINI_API_KEY = "test-key";
});
afterEach(() => vi.restoreAllMocks());

const authed = () => {
  ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n" }] });
  return { headers: { authorization: `Bearer ${generateApiKey()}` } };
};

describe("GET /v1/search", () => {
  test("401 without a key", async () => {
    expect((await handler({ headers: {} } as never)).statusCode).toBe(401);
  });
  test("422 without q", async () => {
    const res = await handler({ ...authed(), queryStringParameters: {} } as never);
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body!).error.code).toBe("missing_query");
  });
  test("422 for empty or whitespace-only q", async () => {
    const resEmpty = await handler({ ...authed(), queryStringParameters: { q: "" } } as never);
    expect(resEmpty.statusCode).toBe(422);
    expect(JSON.parse(resEmpty.body!).error.code).toBe("missing_query");
    const resWhitespace = await handler({ ...authed(), queryStringParameters: { q: "   " } } as never);
    expect(resWhitespace.statusCode).toBe(422);
    expect(JSON.parse(resWhitespace.body!).error.code).toBe("missing_query");
  });
  test("200 embeds the query and returns account-filtered hits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ embedding: { values: [0.9] } }) }));
    svMock.on(QueryVectorsCommand).resolves({
      vectors: [{ key: "A1/S0/000001", distance: 0.2, metadata: { sessId: "S0", seq: 1, text: "decided postgres", createdAt: "2026-07-01T00:00:00.000Z" } }],
    } as never);
    const res = await handler({ ...authed(), queryStringParameters: { q: "what database did we pick" } } as never);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.results[0].text).toBe("decided postgres");
    const qv = svMock.commandCalls(QueryVectorsCommand)[0].args[0].input;
    expect(qv.topK).toBe(10);
    expect(JSON.stringify(qv.filter)).toContain("A1");
  });
});
