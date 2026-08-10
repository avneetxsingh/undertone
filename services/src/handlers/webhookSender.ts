import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { decryptSecret } from "../lib/webhookSecret";
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signPayload } from "../lib/webhookSign";
import { assertResolvesPublic } from "../lib/webhookUrl";
import { getWebhook, recordDelivery } from "../lib/webhooks";

interface DeliveryJob {
  eventId: string;
  event: string;
  acctId: string;
  whookId: string;
  payload: unknown;
  createdAt: string;
}

/** Delivers one record. Returns an error string on failure, or null on success. */
async function deliver(job: DeliveryJob): Promise<string | null> {
  // Reloaded fresh rather than trusted from the queue, so a delete, pause or
  // url change made while this message was in flight takes effect.
  const sub = await getWebhook(job.acctId, job.whookId);
  if (!sub || sub.status !== "active") return null; // deleted / paused mid-flight — drop, do not retry

  await assertResolvesPublic(sub.url); // send-time SSRF re-check (DNS rebinding guard)
  const secret = await decryptSecret(sub.secretEnc);
  const body = JSON.stringify({
    id: job.eventId,
    type: job.event,
    created: job.createdAt,
    data: job.payload,
  });
  const ts = Math.floor(Date.now() / 1000);

  let ok = false;
  let errMsg = "";
  try {
    const res = await fetch(sub.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signPayload(secret, ts, body),
        [EVENT_HEADER]: job.event,
        [DELIVERY_HEADER]: job.eventId,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    ok = res.ok;
    if (!ok) errMsg = `HTTP ${res.status}`;
  } catch (e) {
    errMsg = (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message;
  }

  // Recorded before the caller decides to retry, so a failed delivery is both
  // visible on the subscription and still redelivered — neither displaces the other.
  await recordDelivery(job.acctId, job.whookId, ok ? "delivered" : "failed", ok ? undefined : errMsg);
  return ok ? null : errMsg;
}

/**
 * Reports failures per message rather than throwing, so one dead destination
 * does not drag its whole batch back through three delivery attempts. Only the
 * ids in batchItemFailures are redelivered; everything else is acked.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    let job: DeliveryJob;
    try {
      job = JSON.parse(record.body) as DeliveryJob;
    } catch (e) {
      // An unparseable body will never parse. Retrying it three times only
      // delays the DLQ, so ack it and let the log carry the evidence.
      console.error("webhook job is not valid JSON; dropping", e);
      continue;
    }

    try {
      const err = await deliver(job);
      if (err) {
        console.error(`webhook delivery failed: ${err}`);
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    } catch (e) {
      // Thrown by the SSRF re-check, KMS, or the subscription read — all
      // genuinely retryable, unlike a non-2xx from the destination.
      console.error("webhook delivery errored", e);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
