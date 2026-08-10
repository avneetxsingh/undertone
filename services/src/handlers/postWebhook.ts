import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { requireAccount } from "../lib/auth";
import { ApiError, errorResponse, json } from "../lib/errors";
import { areValidEvents } from "../lib/webhookEvents";
import { assertHttpsPublicUrl } from "../lib/webhookUrl";
import { createWebhook } from "../lib/webhooks";

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    let body: { url?: unknown; events?: unknown };
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
    }
    if (typeof body.url !== "string") throw new ApiError(422, "invalid_url", "url is required");
    assertHttpsPublicUrl(body.url);
    if (!areValidEvents(body.events))
      throw new ApiError(422, "invalid_events", "events must be a non-empty subset of the known event types");
    const { sub, secret } = await createWebhook(acct.acctId, body.url, body.events);
    // `secret` is returned here and never again — the stored copy is KMS ciphertext.
    return json(201, {
      id: sub.whookId,
      url: sub.url,
      events: sub.events,
      status: sub.status,
      createdAt: sub.createdAt,
      secret,
    });
  } catch (e) {
    return errorResponse(e);
  }
};
