import type { SQSEvent } from "aws-lambda";
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

export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const job = JSON.parse(record.body) as DeliveryJob;
    // Reloaded fresh rather than trusted from the queue, so a delete, pause or
    // url change made while this message was in flight takes effect.
    const sub = await getWebhook(job.acctId, job.whookId);
    if (!sub || sub.status !== "active") continue; // deleted / paused mid-flight — drop

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

    // Recorded BEFORE the throw, so a failed delivery still updates status to
    // "failed" and still gets retried — the two must not compete.
    await recordDelivery(job.acctId, job.whookId, ok ? "delivered" : "failed", ok ? undefined : errMsg);
    if (!ok) throw new Error(`webhook delivery failed: ${errMsg}`); // SQS redelivers → DLQ after 3
  }
};
