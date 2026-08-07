import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { ulid } from "ulid";
import { listWebhooks } from "./webhooks";
import type { WebhookEvent } from "./webhookEvents";

const sqs = new SQSClient({});

/**
 * Emit-time fan-out: one queue message per matching active subscription. Only
 * the whookId travels — the sender reloads the subscription and decrypts the
 * secret itself, so no signing material is ever written to the queue.
 *
 * Never throws. Producers call this after their real work is done, and a
 * webhook problem must not turn a successful API call into an error.
 */
export async function emitEvent(acctId: string, event: WebhookEvent, payload: unknown): Promise<void> {
  return emitEvents(acctId, [{ event, payload }]);
}

/**
 * Batch form. Producers that fire more than one event for the same account —
 * postChunk fires two per chunk — should use this: the subscription list is
 * read once and filtered per event, rather than querying DynamoDB once per
 * event for identical rows.
 */
export async function emitEvents(
  acctId: string,
  batch: { event: WebhookEvent; payload: unknown }[],
): Promise<void> {
  const queueUrl = process.env.WEBHOOK_QUEUE_URL;
  if (!queueUrl || batch.length === 0) return; // webhooks not wired (e.g. unit tests) — no-op
  try {
    const active = (await listWebhooks(acctId)).filter((s) => s.status === "active");
    const createdAt = new Date().toISOString();
    const sends = batch.flatMap(({ event, payload }) =>
      active
        .filter((s) => s.events.includes(event))
        .map((s) =>
          sqs.send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: JSON.stringify({
                eventId: ulid(),
                event,
                acctId,
                whookId: s.whookId,
                payload,
                createdAt,
              }),
            }),
          ),
        ),
    );
    await Promise.all(sends);
  } catch (e) {
    console.error("emitEvent failed (non-fatal)", e); // webhooks are best-effort; API response must not fail
  }
}
