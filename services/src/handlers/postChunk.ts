import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { extFromContentType } from "../lib/audio";
import { requireAccount } from "../lib/auth";
import { ddb, tableName } from "../lib/ddb";
import { embedText } from "../lib/embeddings";
import { emitEvents } from "../lib/emit";
import { ApiError, errorResponse, json } from "../lib/errors";
import { transcribe } from "../lib/groq";
import { getGroqKey } from "../lib/groqKey";
import { acctPk, chunkSk, sessPk, sessSk } from "../lib/keys";
import { generateSuggestionsSafe, type Suggestion } from "../lib/suggestions";
import { searchVectors, type VectorHit } from "../lib/vectors";

const s3 = new S3Client({});
const sqsClient = new SQSClient({});

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    const sessId = event.pathParameters?.id;
    if (!sessId) throw new ApiError(422, "missing_session_id", "Path must include a session id");
    if (!event.body) throw new ApiError(422, "empty_audio", "Request body must contain audio bytes");
    const audio = Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
    if (audio.length < 100) throw new ApiError(422, "empty_audio", "Audio payload too small to transcribe");
    const contentType = event.headers["content-type"];
    const ext = extFromContentType(contentType);

    // Atomically claim the next sequence number; the condition doubles as
    // "session exists, belongs to this account, and is still active".
    let seq: number;
    let isolateMemory = false;
    try {
      const upd = await ddb.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { PK: acctPk(acct.acctId), SK: sessSk(sessId) },
          UpdateExpression: "ADD chunkCount :one",
          ConditionExpression: "attribute_exists(PK) AND #s = :active",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":one": 1, ":active": "active" },
          ReturnValues: "ALL_NEW",
        }),
      );
      seq = upd.Attributes!.chunkCount as number;
      // ALL_NEW already returns the whole session item, so the isolation flag
      // costs no extra read.
      isolateMemory = upd.Attributes!.isolateMemory === true;
    } catch (e) {
      if ((e as Error).name === "ConditionalCheckFailedException")
        throw new ApiError(404, "session_not_found", "No active session with that id");
      throw e;
    }

    const groqKey = await getGroqKey(acct);

    const audioKey = `${acct.acctId}/${sessId}/chunk-${seq}.${ext}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME!,
        Key: audioKey,
        Body: audio,
        ContentType: contentType,
      }),
    );

    const transcript = await transcribe(groqKey, audio, `chunk.${ext}`);

    const prior = await ddb.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: "PK = :p AND begins_with(SK, :c)",
        ExpressionAttributeValues: { ":p": sessPk(sessId), ":c": "CHUNK#" },
      }),
    );
    const priorChunks = (prior.Items ?? []) as { transcript: string; suggestions: Suggestion[] }[];
    const lastSuggestions = priorChunks.at(-1)?.suggestions ?? [];

    // Cross-session retrieval reaches every OTHER session on the account. That
    // is the whole point for a real tenant, and exactly wrong for the hosted
    // demo, where one shared account holds every visitor's sessions — retrieval
    // there would surface strangers' transcripts to each other. An isolated
    // session skips the vector index entirely rather than filtering after the
    // fact, so there is no path by which another session's text is even read.
    let relevantHistory: VectorHit[] = [];
    if (!isolateMemory) {
      try {
        const embedding = await embedText(transcript);
        relevantHistory = await searchVectors(embedding, acct.acctId, 4, sessId);
      } catch (e) {
        console.error("history retrieval failed (non-fatal)", e);
      }
    }

    const { suggestions, warning } = await generateSuggestionsSafe(
      groqKey,
      [...priorChunks.map((c) => c.transcript), transcript],
      lastSuggestions,
      relevantHistory,
    );

    const createdAt = new Date().toISOString();
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          PK: sessPk(sessId),
          SK: chunkSk(seq),
          seq,
          transcript,
          suggestions,
          audioKey,
          createdAt,
        },
      }),
    );

    try {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: process.env.EMBED_QUEUE_URL!,
          MessageBody: JSON.stringify({ acctId: acct.acctId, sessId, seq, transcript, createdAt }),
        }),
      );
    } catch (e) {
      console.error("embed enqueue failed (non-fatal)", e); // memory is best-effort; the chunk response must not fail
    }

    // Same discipline as the embed enqueue above: emitEvents swallows its own
    // failures, so a webhook problem cannot turn a successful chunk into an
    // error. Batched so both events share one subscription lookup.
    await emitEvents(acct.acctId, [
      { event: "chunk.transcribed", payload: { sessionId: sessId, seq, transcript, createdAt } },
      { event: "suggestions.generated", payload: { sessionId: sessId, seq, suggestions, createdAt } },
    ]);

    return json(200, { seq, transcript, suggestions, ...(warning ? { warning } : {}) });
  } catch (e) {
    return errorResponse(e);
  }
};
