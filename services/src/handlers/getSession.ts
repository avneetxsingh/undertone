import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { requireAccount } from "../lib/auth";
import { ddb, tableName } from "../lib/ddb";
import { ApiError, errorResponse, json } from "../lib/errors";
import { acctPk, sessPk, sessSk } from "../lib/keys";

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    const id = event.pathParameters?.id;
    if (!id) throw new ApiError(422, "missing_session_id", "Path must include a session id");
    // Ownership enforced structurally: the lookup key embeds the *authenticated* account id.
    const sess = await ddb.send(
      new GetCommand({ TableName: tableName(), Key: { PK: acctPk(acct.acctId), SK: sessSk(id) } }),
    );
    if (!sess.Item) throw new ApiError(404, "session_not_found", "No session with that id");
    // This query is keyed by the raw session id (not the account) and is only safe because the
    // account-scoped GetCommand above already proved ownership — do not reorder these two calls.
    const chunks = await ddb.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: "PK = :p AND begins_with(SK, :c)",
        ExpressionAttributeValues: { ":p": sessPk(id), ":c": "CHUNK#" },
      }),
    );
    const { PK, SK, ...pub } = sess.Item;
    return json(200, {
      ...pub,
      id: pub.sessId,
      chunks: (chunks.Items ?? []).map(({ seq, transcript, suggestions, createdAt }) => ({
        seq, transcript, suggestions, createdAt,
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
};
