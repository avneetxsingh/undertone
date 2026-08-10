import { beforeEach, describe, expect, test, vi } from "vitest";
import { __resetMemoryStore, incr } from "@/lib/limiter";

// Returns 7 rather than 1 deliberately: a fresh key on the in-memory path
// always counts to 1, so a 7 can only have come through this client. That is
// what makes the KV_REST_API_* test below prove the store was actually found.
vi.mock("@upstash/redis", () => ({
  Redis: class {
    async incr() {
      return 7;
    }
    async expire() {
      return 1;
    }
  },
}));

describe("limiter (memory backing)", () => {
  beforeEach(() => {
    __resetMemoryStore();
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
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

  test("counts through redis when only Vercel's KV_REST_API_* names are set", async () => {
    // Vercel's Upstash marketplace integration injects KV_REST_API_URL and
    // KV_REST_API_TOKEN — not the UPSTASH_REDIS_REST_* pair. While only the
    // latter were honoured, production found no store, refused every count,
    // and the demo answered 503 to every visitor.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KV_REST_API_URL", "https://example.upstash.io");
    vi.stubEnv("KV_REST_API_TOKEN", "token");
    __resetMemoryStore();

    await expect(incr("a", 60)).resolves.toBe(7);
  });
});
