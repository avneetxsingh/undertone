import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { requireAccount } from "../lib/auth";
import { ApiError, errorResponse } from "../lib/errors";
import { deleteWebhook } from "../lib/webhooks";

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    const id = event.pathParameters?.id;
    if (!id) throw new ApiError(422, "missing_webhook_id", "Path must include a webhook id");
    const ok = await deleteWebhook(acct.acctId, id);
    if (!ok) throw new ApiError(404, "webhook_not_found", "No webhook with that id");
    return { statusCode: 204, headers: { "content-type": "application/json" }, body: "" };
  } catch (e) {
    return errorResponse(e);
  }
};
