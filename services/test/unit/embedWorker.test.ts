import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { PutVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { handler } from "../../src/handlers/embedWorker";

const svMock = mockClient(S3VectorsClient);
beforeEach(() => {
  svMock.reset();
  process.env.VECTOR_BUCKET = "vb";
  process.env.VECTOR_INDEX = "chunks";
  process.env.GEMINI_API_KEY = "test-key";
});
afterEach(() => vi.restoreAllMocks());

const embedOk = (values: number[]) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ embedding: { values } }) });

const record = (body: unknown) => ({ body: JSON.stringify(body) });
const msg = { acctId: "A1", sessId: "S1", seq: 2, transcript: "we picked postgres", createdAt: "2026-07-19T00:00:00.000Z" };

describe("embedWorker", () => {
  test("embeds each record and writes the vector", async () => {
    vi.stubGlobal("fetch", embedOk([0.1, 0.2]));
    svMock.on(PutVectorsCommand).resolves({});
    await handler({ Records: [record(msg)] } as never);
    const put = svMock.commandCalls(PutVectorsCommand)[0].args[0].input;
    expect(put.vectors![0].key).toBe("A1/S1/000002");
    expect((put.vectors![0].metadata as Record<string, unknown>).text).toBe("we picked postgres");
  });
  test("throws on embed failure so sqs retries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("gemini down")));
    await expect(handler({ Records: [record(msg)] } as never)).rejects.toThrow();
    expect(svMock.commandCalls(PutVectorsCommand).length).toBe(0);
  });
});
