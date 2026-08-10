import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { requireAccount } from "../lib/auth";
import { embedText } from "../lib/embeddings";
import { ApiError, errorResponse, json } from "../lib/errors";
import { searchVectors } from "../lib/vectors";

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    const q = event.queryStringParameters?.q?.trim();
    if (!q) throw new ApiError(422, "missing_query", "Provide ?q=<search text>");
    const embedding = await embedText(q);
    const results = await searchVectors(embedding, acct.acctId, 10);
    return json(200, { results });
  } catch (e) {
    return errorResponse(e);
  }
};
