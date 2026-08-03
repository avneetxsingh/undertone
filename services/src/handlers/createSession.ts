import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { requireAccount } from "../lib/auth";
import { ddb, tableName } from "../lib/ddb";
import { emitEvent } from "../lib/emit";
import { ApiError, errorResponse, json } from "../lib/errors";
import { acctPk, sessSk } from "../lib/keys";

const KINDS = ["meeting", "interview", "lecture"] as const;

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    let body;
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
    }
    const kind = body.kind ?? "meeting";
    if (!KINDS.includes(kind)) throw new ApiError(422, "invalid_kind", `kind must be one of ${KINDS.join(", ")}`);
    const id = ulid();
    const item = {
      PK: acctPk(acct.acctId),
      SK: sessSk(id),
      sessId: id,
      title: typeof body.title === "string" && body.title ? body.title : "Untitled session",
      kind,
      status: "active",
      chunkCount: 0,
      createdAt: new Date().toISOString(),
    };
    await ddb.send(new PutCommand({ TableName: tableName(), Item: item }));
    await emitEvent(acct.acctId, "session.created", {
      id,
      title: item.title,
      kind: item.kind,
      createdAt: item.createdAt,
    });
    return json(201, { id, title: item.title, kind: item.kind, status: item.status, createdAt: item.createdAt });
  } catch (e) {
    return errorResponse(e);
  }
};
