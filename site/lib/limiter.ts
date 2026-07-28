import { Redis } from "@upstash/redis";

interface Entry {
  count: number;
  expiresAt: number;
}

let memory = new Map<string, Entry>();
let clockOffsetMs = 0;

const now = () => Date.now() + clockOffsetMs;

/** Test-only. Clears the in-memory store, or shifts its clock forward. */
export function __resetMemoryStore(opts?: { advanceSeconds?: number }): void {
  if (opts?.advanceSeconds) {
    clockOffsetMs += opts.advanceSeconds * 1000;
    return;
  }
  memory = new Map();
  clockOffsetMs = 0;
}

let redis: Redis | null = null;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis ??= new Redis({ url, token });
  return redis;
}

/**
 * Increment `key` and return its new value. The counter opens a fixed window on
 * first increment — not a sliding window. The spec's "rolling hour" is
 * approximated this way deliberately; it errs toward restricting, not allowing.
 *
 * Throws if the backing store is unavailable. Callers must treat a throw as
 * "refuse the request" — see guards.ts.
 */
export async function incr(key: string, ttlSeconds: number): Promise<number> {
  const client = getRedis();
  if (client) {
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, ttlSeconds);
    return count;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("redis is not configured; refusing to count in memory in production");
  }
  const entry = memory.get(key);
  if (!entry || entry.expiresAt <= now()) {
    memory.set(key, { count: 1, expiresAt: now() + ttlSeconds * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}
