import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, tableName } from "./ddb";
import { ApiError } from "./errors";
import { acctPk, rateSk } from "./keys";

/**
 * Per-account request ceiling, enforced by the platform itself rather than by
 * whatever app happens to be calling it.
 *
 * No-ops when RATE_LIMIT_PER_MINUTE is unset — the same convention emitEvent
 * uses for WEBHOOK_QUEUE_URL. That keeps unit tests and local runs unlimited
 * while the deployed Lambdas, which do set it, are always covered.
 *
 * The window is fixed, not sliding: the counter opens on the first request of
 * a wall-clock minute and resets at the boundary. A caller could therefore
 * burst across a boundary, which is the accepted trade for a single atomic
 * counter and no read-before-write.
 */
export async function enforceRateLimit(acctId: string): Promise<void> {
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE);
  if (!Number.isFinite(limit) || limit <= 0) return;

  const minute = Math.floor(Date.now() / 60000);
  let hits: number;
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: acctPk(acctId), SK: rateSk(minute) },
        UpdateExpression: "ADD hits :one SET expiresAt = if_not_exists(expiresAt, :exp)",
        ExpressionAttributeValues: {
          ":one": 1,
          // Counters are swept by DynamoDB TTL rather than deleted by hand; a
          // few minutes of slack keeps the window readable while it matters.
          ":exp": Math.floor(Date.now() / 1000) + 300,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    hits = Number(res.Attributes?.hits ?? 0);
  } catch (e) {
    // Fails OPEN, unlike the demo's limiter, which fails closed. That limiter
    // protects a spend cap the operator pays for; this one protects capacity.
    // Making every account's every request depend on a second DynamoDB write
    // succeeding would trade a rare abuse case for a common outage.
    console.error("rate limit check failed; allowing request", e);
    return;
  }

  if (hits > limit)
    throw new ApiError(429, "rate_limited", "Too many requests for this account; try again shortly");
}
