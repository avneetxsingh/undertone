import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { requireAccount } from "../lib/auth";
import { ApiError, errorResponse, json } from "../lib/errors";
import { areValidEvents, type WebhookEvent } from "../lib/webhookEvents";
import { assertHttpsPublicUrl } from "../lib/webhookUrl";
import { redactWebhook, updateWebhook } from "../lib/webhooks";

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    const id = event.pathParameters?.id;
    if (!id) throw new ApiError(422, "missing_webhook_id", "Path must include a webhook id");
    let body: { url?: unknown; events?: unknown; status?: unknown; rotateSecret?: unknown };
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
    }
    const patch: {
      url?: string;
      events?: WebhookEvent[];
      status?: "active" | "paused";
      rotateSecret?: boolean;
    } = {};
    if (body.url !== undefined) {
      if (typeof body.url !== "string") throw new ApiError(422, "invalid_url", "url must be a string");
      assertHttpsPublicUrl(body.url);
      patch.url = body.url;
    }
    if (body.events !== undefined) {
      if (!areValidEvents(body.events))
        throw new ApiError(422, "invalid_events", "events must be a non-empty subset of the known event types");
      patch.events = body.events;
    }
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "paused")
        throw new ApiError(422, "invalid_status", "status must be active or paused");
      patch.status = body.status;
    }
    if (body.rotateSecret === true) patch.rotateSecret = true;

    const result = await updateWebhook(acct.acctId, id, patch);
    if (!result) throw new ApiError(404, "webhook_not_found", "No webhook with that id");
    return json(200, { ...redactWebhook(result.sub), ...(result.secret ? { secret: result.secret } : {}) });
  } catch (e) {
    return errorResponse(e);
  }
};
