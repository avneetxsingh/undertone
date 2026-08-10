import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { requireAccount } from "../lib/auth";
import { fanOutStored } from "../lib/emit";
import { ApiError, errorResponse, json } from "../lib/errors";
import { getEvent } from "../lib/events";

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const acct = await requireAccount(event);
    const id = event.pathParameters?.id;
    if (!id) throw new ApiError(422, "missing_event_id", "Path must include an event id");

    // Keyed by the authenticated account, so another account's event id is a
    // 404 rather than a replay of someone else's data.
    const stored = await getEvent(acct.acctId, id);
    if (!stored) throw new ApiError(404, "event_not_found", "No event with that id");

    // Unlike the emit path, this failure is surfaced: the caller asked for the
    // replay and deserves to know it did not happen.
    const replayed = await fanOutStored(acct.acctId, stored);
    return json(200, { evtId: stored.evtId, event: stored.event, replayed });
  } catch (e) {
    return errorResponse(e);
  }
};
