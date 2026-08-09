import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { ulid } from "ulid";
import { recordEvent } from "./events";
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
 * Re-enqueues an already-recorded event to whichever subscriptions match it
 * *now* — not the ones that matched when it first happened. That is the point
 * of replay: a subscriber registered late, or was paused while broken, and
 * wants the event it missed.
 *
 * Throws, unlike emitEvents. This runs behind an explicit request, so a caller
 * who asked for a replay must not be told it succeeded when it did not.
 * Returns the number of deliveries enqueued.
 */
export async function fanOutStored(
  acctId: string,
  stored: { evtId: string; event: WebhookEvent; payload: unknown; createdAt: string },
): Promise<number> {
  const queueUrl = process.env.WEBHOOK_QUEUE_URL;
  if (!queueUrl) return 0;
  const targets = (await listWebhooks(acctId)).filter(
    (s) => s.status === "active" && s.events.includes(stored.event),
  );
  await Promise.all(
    targets.map((s) =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({
            // A replay keeps the original event id, so a receiver that
            // de-duplicates on X-Undertone-Delivery recognises it as the same
            // event rather than a new one.
            eventId: stored.evtId,
            event: stored.event,
            acctId,
            whookId: s.whookId,
            payload: stored.payload,
            createdAt: stored.createdAt,
          }),
        }),
      ),
    ),
  );
  return targets.length;
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

    // Logged before fan-out, and regardless of whether anything matches: the
    // usual reason to replay is that a subscription was registered or repaired
    // after the fact, so an event nobody was listening for is precisely the one
    // worth keeping.
    const evtIds = await Promise.all(
      batch.map(({ event, payload }) => recordEvent(acctId, event, payload, createdAt)),
    );

    const sends = batch.flatMap(({ event, payload }, i) =>
      active
        .filter((s) => s.events.includes(event))
        .map((s) =>
          sqs.send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: JSON.stringify({
                // Reuse the stored id so a delivery header and the event log
                // refer to the same thing; fall back if the log write failed.
                eventId: evtIds[i] ?? ulid(),
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
