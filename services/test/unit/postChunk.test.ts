import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { QueryVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { generateApiKey } from "../../src/lib/auth";
import { handler } from "../../src/handlers/postChunk";
import { startFakeGroq, type FakeGroqRequest } from "../helpers/fakeGroq";

const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);
const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);
const svMock = mockClient(S3VectorsClient);

let fake: { url: string; close(): void; requests: FakeGroqRequest[] } | undefined;

// Gemini embedText uses global fetch; the fake Groq server also uses real fetch.
// This stub answers only the Gemini embed call and delegates everything else
// (transcription + suggestions to the fake Groq server) to the real fetch.
const realFetch = globalThis.fetch;
const stubGeminiEmbed = (values: number[]) =>
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown, init?: unknown) =>
      String(url).includes("generativelanguage")
        ? Promise.resolve({ ok: true, status: 200, json: async () => ({ embedding: { values } }) })
        : (realFetch as (u: unknown, i?: unknown) => Promise<unknown>)(url, init),
    ),
  );

beforeEach(() => {
  ddbMock.reset();
  kmsMock.reset();
  s3Mock.reset();
  sqsMock.reset();
  svMock.reset();
  process.env.KEY_PEPPER = "p";
  process.env.GEMINI_API_KEY = "test-key";
  stubGeminiEmbed([0.1, 0.2]); // default; history tests re-stub as needed
  process.env.TABLE_NAME = "t";
  process.env.BUCKET_NAME = "b";
  process.env.KMS_KEY_ID = "kms-key-1";
  process.env.EMBED_QUEUE_URL = "https://q";
  process.env.VECTOR_BUCKET = "vb";
  process.env.VECTOR_INDEX = "chunks";
});

afterEach(() => {
  fake?.close();
  fake = undefined;
  delete process.env.GROQ_BASE_URL;
  vi.unstubAllGlobals();
});

describe("POST /v1/sessions/{id}/chunks", () => {
  test("401 without a key", async () => {
    const res = await handler({ headers: {} } as never);
    expect(res.statusCode).toBe(401);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test("404 session_not_found when the session doesn't exist or isn't active", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n", groqKeyEnc: "enc" }] });
    ddbMock.on(UpdateCommand).rejects(Object.assign(new Error("cond failed"), {
      name: "ConditionalCheckFailedException",
    }));

    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}`, "content-type": "audio/wav" },
      pathParameters: { id: "S1" },
      body: Buffer.alloc(200, "a").toString("base64"),
      isBase64Encoded: true,
    } as never);

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body!);
    expect(body.error.code).toBe("session_not_found");

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall.args[0].input).toMatchObject({
      Key: { PK: "ACCT#A1", SK: "SESS#S1" },
    });
    expect(updateCall.args[0].input.ConditionExpression).toContain("attribute_exists(PK)");
  });

  test("422 empty_audio for a body under 100 bytes (validated before the seq claim)", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n" }] });

    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}` },
      pathParameters: { id: "S1" },
      body: "hi",
      isBase64Encoded: false,
    } as never);

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body!);
    expect(body.error.code).toBe("empty_audio");
    // Audio validation happens before the UpdateCommand seq claim in the handler.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  test("422 unsupported_audio_type for an unrecognized content-type", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n" }] });

    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}`, "content-type": "text/plain" },
      pathParameters: { id: "S1" },
      body: Buffer.alloc(200, "a").toString("base64"),
      isBase64Encoded: true,
    } as never);

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body!);
    expect(body.error.code).toBe("unsupported_audio_type");
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  test("402 groq_key_missing when the account has no stored Groq key", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", name: "n" }] });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { chunkCount: 1 } });

    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}`, "content-type": "audio/wav" },
      pathParameters: { id: "S1" },
      body: Buffer.alloc(200, "a").toString("base64"),
      isBase64Encoded: true,
    } as never);

    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.body!);
    expect(body.error.code).toBe("groq_key_missing");
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test("200 happy path transcribes, generates suggestions, and scopes S3/chunk writes", async () => {
    fake = await startFakeGroq({ transcript: "hello roadmap", chat: { suggestions: [{ type: "QUESTION", preview: "p2", detail_prompt: "d2" }] } });
    process.env.GROQ_BASE_URL = fake.url;

    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ acctId: "A1", name: "n", groqKeyEnc: "enc" }] })
      .resolves({
        Items: [{ transcript: "earlier", suggestions: [{ type: "QUESTION", preview: "p", detail_prompt: "d" }] }],
      });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { chunkCount: 3 } });
    ddbMock.on(PutCommand).resolves({});
    kmsMock.on(DecryptCommand).resolves({ Plaintext: Buffer.from("gsk_k") });
    s3Mock.on(PutObjectCommand).resolves({});

    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}`, "content-type": "audio/wav" },
      pathParameters: { id: "S1" },
      body: Buffer.alloc(200, "a").toString("base64"),
      isBase64Encoded: true,
    } as never);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.seq).toBe(3);
    expect(body.transcript).toBe("hello roadmap");
    expect(body.suggestions).toEqual([{ type: "QUESTION", preview: "p2", detail_prompt: "d2" }]);

    const putObjectCall = s3Mock.commandCalls(PutObjectCommand)[0];
    expect(putObjectCall.args[0].input).toMatchObject({
      Bucket: "b",
      Key: "A1/S1/chunk-3.wav",
    });

    const putChunkCall = ddbMock.commandCalls(PutCommand)[0];
    expect(putChunkCall.args[0].input.Item).toMatchObject({
      PK: "SESS#S1",
      SK: "CHUNK#000003",
      audioKey: "A1/S1/chunk-3.wav",
    });

    const sendCalls = sqsMock.commandCalls(SendMessageCommand);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].args[0].input.QueueUrl).toBe("https://q");
    const sentBody = sendCalls[0].args[0].input.MessageBody as string;
    expect(sentBody).toContain(`"sessId":"S1"`);
    expect(sentBody).toContain("hello roadmap");
  });

  test("200 still returned when the embed enqueue fails (non-fatal)", async () => {
    fake = await startFakeGroq({ transcript: "hello roadmap", chat: { suggestions: [{ type: "QUESTION", preview: "p2", detail_prompt: "d2" }] } });
    process.env.GROQ_BASE_URL = fake.url;

    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ acctId: "A1", name: "n", groqKeyEnc: "enc" }] })
      .resolves({
        Items: [{ transcript: "earlier", suggestions: [{ type: "QUESTION", preview: "p", detail_prompt: "d" }] }],
      });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { chunkCount: 3 } });
    ddbMock.on(PutCommand).resolves({});
    kmsMock.on(DecryptCommand).resolves({ Plaintext: Buffer.from("gsk_k") });
    s3Mock.on(PutObjectCommand).resolves({});
    sqsMock.on(SendMessageCommand).rejects(new Error("sqs down"));

    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}`, "content-type": "audio/wav" },
      pathParameters: { id: "S1" },
      body: Buffer.alloc(200, "a").toString("base64"),
      isBase64Encoded: true,
    } as never);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.transcript).toBe("hello roadmap");
  });

  test("200 includes relevant history from past sessions in the suggestions request", async () => {
    fake = await startFakeGroq({ transcript: "hello roadmap", chat: { suggestions: [{ type: "QUESTION", preview: "p2", detail_prompt: "d2" }] } });
    process.env.GROQ_BASE_URL = fake.url;

    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ acctId: "A1", name: "n", groqKeyEnc: "enc" }] })
      .resolves({
        Items: [{ transcript: "earlier", suggestions: [{ type: "QUESTION", preview: "p", detail_prompt: "d" }] }],
      });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { chunkCount: 3 } });
    ddbMock.on(PutCommand).resolves({});
    kmsMock.on(DecryptCommand).resolves({ Plaintext: Buffer.from("gsk_k") });
    s3Mock.on(PutObjectCommand).resolves({});
    stubGeminiEmbed([0.1, 0.2]);
    svMock.on(QueryVectorsCommand).resolves({
      vectors: [
        { key: "A1/S0/000001", distance: 0.1, metadata: { sessId: "S0", seq: 1, text: "we chose postgres", createdAt: "2026-07-01T00:00:00.000Z" } },
      ],
    } as never);

    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}`, "content-type": "audio/wav" },
      pathParameters: { id: "S1" },
      body: Buffer.alloc(200, "a").toString("base64"),
      isBase64Encoded: true,
    } as never);

    expect(res.statusCode).toBe(200);

    const queryCall = svMock.commandCalls(QueryVectorsCommand)[0];
    expect(queryCall.args[0].input.filter).toMatchObject({ acctId: { $eq: "A1" } });
    expect(queryCall.args[0].input.topK).toBe(4);

    const chatRequest = fake.requests.find((r) => r.url.includes("/chat/completions"));
    expect(chatRequest?.body).toContain("RELEVANT HISTORY");
    expect(chatRequest?.body).toContain("[2026-07-01]");
  });

  test("200 still returned when history retrieval (QueryVectorsCommand) rejects (non-fatal)", async () => {
    fake = await startFakeGroq({ transcript: "hello roadmap", chat: { suggestions: [{ type: "QUESTION", preview: "p2", detail_prompt: "d2" }] } });
    process.env.GROQ_BASE_URL = fake.url;

    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ acctId: "A1", name: "n", groqKeyEnc: "enc" }] })
      .resolves({
        Items: [{ transcript: "earlier", suggestions: [{ type: "QUESTION", preview: "p", detail_prompt: "d" }] }],
      });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { chunkCount: 3 } });
    ddbMock.on(PutCommand).resolves({});
    kmsMock.on(DecryptCommand).resolves({ Plaintext: Buffer.from("gsk_k") });
    s3Mock.on(PutObjectCommand).resolves({});
    stubGeminiEmbed([0.1, 0.2]);
    svMock.on(QueryVectorsCommand).rejects(new Error("vector search down"));

    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}`, "content-type": "audio/wav" },
      pathParameters: { id: "S1" },
      body: Buffer.alloc(200, "a").toString("base64"),
      isBase64Encoded: true,
    } as never);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.suggestions).toEqual([{ type: "QUESTION", preview: "p2", detail_prompt: "d2" }]);
  });

  test("a session marked isolateMemory never queries other sessions' vectors", async () => {
    // The hosted demo runs every visitor through one shared platform account,
    // so cross-session retrieval would pool strangers' transcripts. An isolated
    // session must not reach the vector index at all.
    fake = await startFakeGroq({
      transcript: "hello roadmap",
      chat: { suggestions: [{ type: "QUESTION", preview: "p2", detail_prompt: "d2" }] },
    });
    process.env.GROQ_BASE_URL = fake.url;

    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ acctId: "A1", name: "n", groqKeyEnc: "enc" }] })
      .resolves({ Items: [] });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { chunkCount: 1, isolateMemory: true } });
    ddbMock.on(PutCommand).resolves({});
    kmsMock.on(DecryptCommand).resolves({ Plaintext: Buffer.from("gsk_k") });
    s3Mock.on(PutObjectCommand).resolves({});
    svMock.on(QueryVectorsCommand).resolves({ vectors: [] } as never);

    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}`, "content-type": "audio/wav" },
      pathParameters: { id: "S1" },
      body: Buffer.alloc(200, "a").toString("base64"),
      isBase64Encoded: true,
    } as never);

    expect(res.statusCode).toBe(200);
    expect(svMock.commandCalls(QueryVectorsCommand)).toHaveLength(0);
    // The prompt always carries a RELEVANT HISTORY section; what matters is
    // that it is empty, so assert on the section's contents rather than on the
    // heading (which also appears in the system prompt's own rules).
    const chatRequest = fake.requests.find((r) => r.url.includes("/chat/completions"));
    expect(chatRequest?.body).toContain("RELEVANT HISTORY:\\nnone");
  });

  test("emits chunk.transcribed and suggestions.generated when webhooks are wired", async () => {
    fake = await startFakeGroq({
      transcript: "hello roadmap",
      chat: { suggestions: [{ type: "QUESTION", preview: "p2", detail_prompt: "d2" }] },
    });
    process.env.GROQ_BASE_URL = fake.url;
    process.env.WEBHOOK_QUEUE_URL = "https://wq";

    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "GSI1") return { Items: [{ acctId: "A1", name: "n", groqKeyEnc: "enc" }] };
      if (input.ExpressionAttributeValues?.[":w"] === "WHOOK#")
        return {
          Items: [
            {
              whookId: "W1",
              url: "https://h/x",
              events: ["chunk.transcribed", "suggestions.generated"],
              status: "active",
              secretEnc: "e",
              createdAt: "2026-07-26T00:00:00.000Z",
            },
          ],
        };
      return { Items: [] };
    });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { chunkCount: 1 } });
    ddbMock.on(PutCommand).resolves({});
    kmsMock.on(DecryptCommand).resolves({ Plaintext: Buffer.from("gsk_k") });
    s3Mock.on(PutObjectCommand).resolves({});
    svMock.on(QueryVectorsCommand).resolves({ vectors: [] } as never);
    sqsMock.on(SendMessageCommand).resolves({});

    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}`, "content-type": "audio/wav" },
      pathParameters: { id: "S1" },
      body: Buffer.alloc(200, "a").toString("base64"),
      isBase64Encoded: true,
    } as never);

    expect(res.statusCode).toBe(200);
    const webhookMsgs = sqsMock
      .commandCalls(SendMessageCommand)
      .filter((c) => c.args[0].input.QueueUrl === "https://wq")
      .map((c) => JSON.parse(c.args[0].input.MessageBody!));
    expect(webhookMsgs.map((m) => m.event).sort()).toEqual(["chunk.transcribed", "suggestions.generated"]);
    expect(webhookMsgs.every((m) => m.acctId === "A1" && m.whookId === "W1")).toBe(true);
    expect(webhookMsgs.find((m) => m.event === "chunk.transcribed")!.payload).toMatchObject({
      sessionId: "S1",
      seq: 1,
      transcript: "hello roadmap",
    });
    delete process.env.WEBHOOK_QUEUE_URL;
  });

  test("a webhook enqueue failure does not fail the chunk (best-effort)", async () => {
    fake = await startFakeGroq({
      transcript: "hello roadmap",
      chat: { suggestions: [{ type: "QUESTION", preview: "p2", detail_prompt: "d2" }] },
    });
    process.env.GROQ_BASE_URL = fake.url;
    process.env.WEBHOOK_QUEUE_URL = "https://wq";

    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "GSI1") return { Items: [{ acctId: "A1", name: "n", groqKeyEnc: "enc" }] };
      if (input.ExpressionAttributeValues?.[":w"] === "WHOOK#")
        return {
          Items: [
            {
              whookId: "W1",
              url: "https://h/x",
              events: ["chunk.transcribed"],
              status: "active",
              secretEnc: "e",
              createdAt: "2026-07-26T00:00:00.000Z",
            },
          ],
        };
      return { Items: [] };
    });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { chunkCount: 1 } });
    ddbMock.on(PutCommand).resolves({});
    kmsMock.on(DecryptCommand).resolves({ Plaintext: Buffer.from("gsk_k") });
    s3Mock.on(PutObjectCommand).resolves({});
    svMock.on(QueryVectorsCommand).resolves({ vectors: [] } as never);
    sqsMock.on(SendMessageCommand).rejects(new Error("sqs down"));

    const res = await handler({
      headers: { authorization: `Bearer ${generateApiKey()}`, "content-type": "audio/wav" },
      pathParameters: { id: "S1" },
      body: Buffer.alloc(200, "a").toString("base64"),
      isBase64Encoded: true,
    } as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).transcript).toBe("hello roadmap");
    delete process.env.WEBHOOK_QUEUE_URL;
  });
});
