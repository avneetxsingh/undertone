import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { requireAccount } from "../lib/auth";
import { ddb, tableName } from "../lib/ddb";
import { ApiError, errorResponse, json } from "../lib/errors";
import { encryptGroqKey } from "../lib/groqKey";
import { acctPk } from "../lib/keys";

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    let body;
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
    }
    if (typeof body.groqKey !== "string" || !body.groqKey.startsWith("gsk_"))
      throw new ApiError(422, "invalid_groq_key", "Expected { groqKey: \"gsk_...\" }");
    const groqKeyEnc = await encryptGroqKey(body.groqKey);
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: acctPk(acct.acctId), SK: "META" },
        UpdateExpression: "SET groqKeyEnc = :e",
        ExpressionAttributeValues: { ":e": groqKeyEnc },
      }),
    );
    return json(200, { ok: true });
  } catch (e) {
    return errorResponse(e);
  }
};
