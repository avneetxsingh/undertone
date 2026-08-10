import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { requireAccount } from "../lib/auth";
import { ddb, tableName } from "../lib/ddb";
import { errorResponse, json } from "../lib/errors";
import { acctPk } from "../lib/keys";

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: "PK = :p AND begins_with(SK, :s)",
        ExpressionAttributeValues: { ":p": acctPk(acct.acctId), ":s": "SESS#" },
        ScanIndexForward: false, // ULIDs sort by time → newest first
        Limit: 50,
      }),
    );
    return json(200, {
      sessions: (res.Items ?? []).map(({ PK, SK, ...pub }) => ({ ...pub, id: pub.sessId })),
    });
  } catch (e) {
    return errorResponse(e);
  }
};
