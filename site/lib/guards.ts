import { DemoError } from "./demoError";
import { incr } from "./limiter";

export const MAX_SESSIONS_PER_IP_PER_HOUR = 2;
export const MAX_CHUNKS_PER_SESSION = 20; // 20 x 15s = 5 minutes
export const MAX_CHATS_PER_SESSION = 5;
export const MAX_CHUNKS_PER_DAY = 400;

const HOUR = 3600;
const TWO_HOURS = 7200;
const TWO_DAYS = 172800;

/** Counts through the limiter, converting any store failure into a refusal. */
async function count(key: string, ttl: number): Promise<number> {
  try {
    return await incr(key, ttl);
  } catch (e) {
    console.error("limiter unavailable; refusing request", e);
    throw new DemoError(503, "demo_capacity", "The live demo is temporarily unavailable.");
  }
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

export async function guardSessionCreate(req: Request): Promise<void> {
  const n = await count(`ip:${clientIp(req)}:sessions`, HOUR);
  if (n > MAX_SESSIONS_PER_IP_PER_HOUR)
    throw new DemoError(
      429,
      "demo_rate_limited",
      "You have started the maximum number of demo sessions this hour.",
    );
}

export async function guardChunk(sessId: string): Promise<void> {
  const perSession = await count(`sess:${sessId}:chunks`, TWO_HOURS);
  if (perSession > MAX_CHUNKS_PER_SESSION)
    throw new DemoError(409, "demo_session_complete", "This demo session has reached its length limit.");

  const day = new Date().toISOString().slice(0, 10);
  const global = await count(`global:chunks:${day}`, TWO_DAYS);
  if (global > MAX_CHUNKS_PER_DAY)
    throw new DemoError(503, "demo_capacity", "The live demo has reached today's capacity.");
}

export async function guardChat(sessId: string): Promise<void> {
  const n = await count(`sess:${sessId}:chats`, TWO_HOURS);
  if (n > MAX_CHATS_PER_SESSION)
    throw new DemoError(409, "demo_session_complete", "This demo session has reached its question limit.");
}
