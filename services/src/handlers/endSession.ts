import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { requireAccount } from "../lib/auth";
import { ddb, tableName } from "../lib/ddb";
import { emitEvent } from "../lib/emit";
import { ApiError, errorResponse, json } from "../lib/errors";
import { chatJson } from "../lib/groq";
import { getGroqKey } from "../lib/groqKey";
import { acctPk, sessPk, sessSk } from "../lib/keys";
import { SUMMARY_PROMPT } from "../lib/prompts";

interface SummaryOut {
  summary: string;
  action_items: { owner: string | null; task: string }[];
}

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    const sessId = event.pathParameters?.id;
    if (!sessId) throw new ApiError(422, "missing_session_id", "Path must include a session id");

    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { PK: acctPk(acct.acctId), SK: sessSk(sessId) },
          UpdateExpression: "SET #s = :ended, endedAt = :now",
          ConditionExpression: "attribute_exists(PK) AND #s = :active",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":ended": "ended", ":active": "active", ":now": new Date().toISOString() },
        }),
      );
    } catch (e) {
      if ((e as Error).name === "ConditionalCheckFailedException")
        throw new ApiError(409, "session_already_ended", "Session does not exist or was already ended");
      throw e;
    }

    const chunks = await ddb.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: "PK = :p AND begins_with(SK, :c)",
        ExpressionAttributeValues: { ":p": sessPk(sessId), ":c": "CHUNK#" },
      }),
    );
    const fullTranscript = (chunks.Items ?? []).map((c) => c.transcript).join("\n");

    let summary: string | null = null;
    let actionItems: SummaryOut["action_items"] | null = null;
    let warning: string | undefined;
    try {
      const groqKey = await getGroqKey(acct);
      const out = (await chatJson(groqKey, SUMMARY_PROMPT, fullTranscript)) as SummaryOut;
      summary = out.summary ?? "";
      actionItems = Array.isArray(out.action_items) ? out.action_items : [];
      await ddb.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { PK: acctPk(acct.acctId), SK: sessSk(sessId) },
          UpdateExpression: "SET summary = :s, actionItems = :a",
          ExpressionAttributeValues: { ":s": summary, ":a": actionItems },
        }),
      );
    } catch (e) {
      console.error("summary generation failed", e);
      warning = "summary_failed"; // the session still ends — ending must never fail on summary
    }

    await emitEvent(acct.acctId, "session.completed", {
      id: sessId,
      status: "ended",
      summary,
      actionItems,
    });
    return json(200, { id: sessId, status: "ended", summary, actionItems, ...(warning ? { warning } : {}) });
  } catch (e) {
    return errorResponse(e);
  }
};
