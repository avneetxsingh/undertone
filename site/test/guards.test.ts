import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/limiter", () => ({ incr: vi.fn() }));

import { incr } from "@/lib/limiter";
import { DemoError } from "@/lib/demoError";
import {
  MAX_CHUNKS_PER_SESSION,
  clientIp,
  guardChat,
  guardChunk,
  guardSessionCreate,
} from "@/lib/guards";

const mockIncr = vi.mocked(incr);
const req = (ip = "1.2.3.4") =>
  new Request("https://x/api/demo/session", { method: "POST", headers: { "x-forwarded-for": ip } });

describe("guards", () => {
  beforeEach(() => mockIncr.mockReset());

  test("clientIp takes the first x-forwarded-for entry", () => {
    expect(clientIp(req("9.9.9.9, 10.0.0.1"))).toBe("9.9.9.9");
  });

  test("clientIp falls back to a constant when the header is absent", () => {
    expect(clientIp(new Request("https://x"))).toBe("unknown");
  });

  test("session create passes under the per-IP limit", async () => {
    mockIncr.mockResolvedValue(2);
    await expect(guardSessionCreate(req())).resolves.toBeUndefined();
  });

  test("session create rejects over the per-IP limit", async () => {
    mockIncr.mockResolvedValue(3);
    await expect(guardSessionCreate(req())).rejects.toMatchObject({
      status: 429,
      code: "demo_rate_limited",
    });
  });

  test("chunk rejects once the per-session cap is exceeded", async () => {
    mockIncr.mockResolvedValueOnce(MAX_CHUNKS_PER_SESSION + 1);
    await expect(guardChunk("s1")).rejects.toMatchObject({
      status: 409,
      code: "demo_session_complete",
    });
  });

  test("chunk rejects when the global daily ceiling is exceeded", async () => {
    mockIncr.mockResolvedValueOnce(1).mockResolvedValueOnce(401);
    await expect(guardChunk("s1")).rejects.toMatchObject({
      status: 503,
      code: "demo_capacity",
    });
  });

  test("chat rejects over the per-session chat cap", async () => {
    mockIncr.mockResolvedValue(6);
    await expect(guardChat("s1")).rejects.toMatchObject({
      status: 409,
      code: "demo_session_complete",
    });
  });

  test("a store failure refuses the request rather than allowing it", async () => {
    mockIncr.mockRejectedValueOnce(new Error("redis down"));
    await expect(guardChunk("s1")).rejects.toMatchObject({
      status: 503,
      code: "demo_capacity",
    });
    mockIncr.mockRejectedValueOnce(new Error("redis down"));
    await expect(guardSessionCreate(req())).rejects.toBeInstanceOf(DemoError);
  });

  test("chunk store failure on global daily counter refusal", async () => {
    mockIncr.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("redis down"));
    await expect(guardChunk("s1")).rejects.toMatchObject({
      status: 503,
      code: "demo_capacity",
    });
  });
});
