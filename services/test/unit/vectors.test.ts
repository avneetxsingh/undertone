import { beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { PutVectorsCommand, QueryVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { putChunkVector, searchVectors } from "../../src/lib/vectors";

const svMock = mockClient(S3VectorsClient);
beforeEach(() => {
  svMock.reset();
  process.env.VECTOR_BUCKET = "vb";
  process.env.VECTOR_INDEX = "chunks";
});

describe("putChunkVector", () => {
  test("writes an account-namespaced key with metadata, text truncated", async () => {
    svMock.on(PutVectorsCommand).resolves({});
    await putChunkVector([0.1, 0.2], {
      acctId: "A1", sessId: "S1", seq: 3, text: "t".repeat(2000), createdAt: "2026-07-19T00:00:00.000Z",
    });
    const input = svMock.commandCalls(PutVectorsCommand)[0].args[0].input;
    expect(input.vectorBucketName).toBe("vb");
    expect(input.indexName).toBe("chunks");
    const v = input.vectors![0];
    expect(v.key).toBe("A1/S1/000003");
    expect(v.data).toEqual({ float32: [0.1, 0.2] });
    expect((v.metadata as Record<string, unknown>).acctId).toBe("A1");
    expect(String((v.metadata as Record<string, unknown>).text).length).toBe(1000);
  });
});

describe("searchVectors", () => {
  test("queries with account filter and maps hits", async () => {
    svMock.on(QueryVectorsCommand).resolves({
      vectors: [
        { key: "A1/S0/000001", distance: 0.1, metadata: { sessId: "S0", seq: 1, text: "we chose postgres", createdAt: "2026-07-01T00:00:00.000Z" } },
        { key: "A1/S9/000002", distance: 0.3, metadata: { sessId: "S9", seq: 2, text: "current session", createdAt: "2026-07-19T00:00:00.000Z" } },
      ],
    } as never);
    const hits = await searchVectors([0.5], "A1", 8, "S9");
    expect(hits).toEqual([{ sessId: "S0", seq: 1, text: "we chose postgres", createdAt: "2026-07-01T00:00:00.000Z", distance: 0.1 }]);
    const input = svMock.commandCalls(QueryVectorsCommand)[0].args[0].input;
    expect(input.topK).toBe(8);
    expect(JSON.stringify(input.filter)).toContain("A1");
    expect(input.returnMetadata).toBe(true);
  });
  test("empty result maps to empty array", async () => {
    svMock.on(QueryVectorsCommand).resolves({ vectors: [] } as never);
    expect(await searchVectors([0.5], "A1")).toEqual([]);
  });
  test("maps missing metadata fields to safe defaults", async () => {
    svMock.on(QueryVectorsCommand).resolves({
      vectors: [
        { key: "A1/SX/000001", distance: 0.4 },
        { key: "A1/SY/000002", distance: 0.5, metadata: { sessId: "SY" } },
      ],
    } as never);
    const hits = await searchVectors([0.5], "A1");
    expect(hits).toEqual([
      { sessId: "", seq: 0, text: "", createdAt: "", distance: 0.4 },
      { sessId: "SY", seq: 0, text: "", createdAt: "", distance: 0.5 },
    ]);
  });
  test("returns all hits when excludeSessId is not provided", async () => {
    svMock.on(QueryVectorsCommand).resolves({
      vectors: [
        { key: "A1/S0/000001", distance: 0.1, metadata: { sessId: "S0", seq: 1, text: "first", createdAt: "2026-07-01T00:00:00.000Z" } },
        { key: "A1/S9/000002", distance: 0.2, metadata: { sessId: "S9", seq: 2, text: "second", createdAt: "2026-07-19T00:00:00.000Z" } },
      ],
    } as never);
    const hits = await searchVectors([0.5], "A1");
    expect(hits).toHaveLength(2);
    expect(hits[0].sessId).toBe("S0");
    expect(hits[1].sessId).toBe("S9");
  });
});
