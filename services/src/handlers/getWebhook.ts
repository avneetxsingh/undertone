import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { requireAccount } from "../lib/auth";
import { ApiError, errorResponse, json } from "../lib/errors";
import { getWebhook, redactWebhook } from "../lib/webhooks";

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    const id = event.pathParameters?.id;
    if (!id) throw new ApiError(422, "missing_webhook_id", "Path must include a webhook id");
    // The read is keyed by the authenticated acctId, so another account's id
    // simply misses — an IDOR is structurally a 404, not a leak.
    const sub = await getWebhook(acct.acctId, id);
    if (!sub) throw new ApiError(404, "webhook_not_found", "No webhook with that id");
    return json(200, redactWebhook(sub));
  } catch (e) {
    return errorResponse(e);
  }
};
