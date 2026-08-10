import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { requireAccount } from "../lib/auth";
import { errorResponse, json } from "../lib/errors";
import { listWebhooks, redactWebhook } from "../lib/webhooks";

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    const subs = await listWebhooks(acct.acctId);
    return json(200, { webhooks: subs.map(redactWebhook) });
  } catch (e) {
    return errorResponse(e);
  }
};
