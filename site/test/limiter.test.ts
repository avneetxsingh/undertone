import { beforeEach, describe, expect, test, vi } from "vitest";
import { __resetMemoryStore, incr } from "@/lib/limiter";

describe("limiter (memory backing)", () => {
  beforeEach(() => {
    __resetMemoryStore();
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  test("counts up from 1 per key", async () => {
    expect(await incr("a", 60)).toBe(1);
    expect(await incr("a", 60)).toBe(2);
    expect(await incr("b", 60)).toBe(1);
  });

  test("a key expires after its ttl", async () => {
    await incr("a", 60);
    __resetMemoryStore({ advanceSeconds: 61 });
    expect(await incr("a", 60)).toBe(1);
  });

  test("throws in production when redis is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(incr("a", 60)).rejects.toThrow(/redis/i);
  });
});
