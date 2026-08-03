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
  const queueUrl = process.env.WEBHOOK_QUEUE_URL;
  if (!queueUrl) return; // webhooks not wired (e.g. unit tests) — no-op
  try {
    const subs = (await listWebhooks(acctId)).filter(
      (s) => s.status === "active" && s.events.includes(event),
    );
    await Promise.all(
      subs.map((s) =>
        sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify({
              eventId: ulid(),
              event,
              acctId,
              whookId: s.whookId,
              payload,
              createdAt: new Date().toISOString(),
            }),
          }),
        ),
      ),
    );
  } catch (e) {
    console.error("emitEvent failed (non-fatal)", e); // webhooks are best-effort; API response must not fail
  }
}
