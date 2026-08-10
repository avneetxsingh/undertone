import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { requireAccount } from "../lib/auth";
import { ddb, tableName } from "../lib/ddb";
import { ApiError, errorResponse, json } from "../lib/errors";
import { chatText } from "../lib/groq";
import { getGroqKey } from "../lib/groqKey";
import { acctPk, sessPk, sessSk } from "../lib/keys";
import { CHAT_SYSTEM_PROMPT } from "../lib/prompts";

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    let body: { sessionId?: unknown; prompt?: unknown };
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!sessionId) throw new ApiError(422, "missing_session_id", "Body must include sessionId");
    if (!prompt) throw new ApiError(422, "missing_prompt", "Body must include prompt");

    // Ownership proof first: account-scoped session read (chunk query below is only safe after this).
    const sess = await ddb.send(
      new GetCommand({ TableName: tableName(), Key: { PK: acctPk(acct.acctId), SK: sessSk(sessionId) } }),
    );
    if (!sess.Item) throw new ApiError(404, "session_not_found", "No session with that id");

    const chunks = await ddb.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: "PK = :p AND begins_with(SK, :c)",
        ExpressionAttributeValues: { ":p": sessPk(sessionId), ":c": "CHUNK#" },
      }),
    );
    const transcriptText = (chunks.Items ?? []).map((c) => c.transcript).join("\n");
    const summary = typeof sess.Item.summary === "string" ? sess.Item.summary : "";

    const groqKey = await getGroqKey(acct);
    const user = `MEETING TRANSCRIPT:\n${transcriptText}\n\nMEETING SUMMARY:\n${summary || "none"}\n\nUSER REQUEST:\n${prompt}`;
    const reply = await chatText(groqKey, CHAT_SYSTEM_PROMPT, user);
    return json(200, { reply });
  } catch (e) {
    return errorResponse(e);
  }
};
