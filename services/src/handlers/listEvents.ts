import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { requireAccount } from "../lib/auth";
import { errorResponse, json } from "../lib/errors";
import { EVENT_TTL_DAYS, listEvents } from "../lib/events";

const MAX_LIMIT = 100;

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    const raw = Number(event.queryStringParameters?.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : 50;
    const events = await listEvents(acct.acctId, limit);
    return json(200, { events, retentionDays: EVENT_TTL_DAYS });
  } catch (e) {
    return errorResponse(e);
  }
};
