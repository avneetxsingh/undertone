import { describe, expect, test } from "vitest";
import { ApiError, errorResponse, json } from "../../src/lib/errors";

describe("errors", () => {
  test("json builds a proxy response", () => {
    const r = json(201, { id: "x" });
    expect(r.statusCode).toBe(201);
    expect(r.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(r.body!)).toEqual({ id: "x" });
  });
  test("ApiError maps to structured body", () => {
    const r = errorResponse(new ApiError(402, "groq_key_missing", "Set your key"));
    expect(r.statusCode).toBe(402);
    expect(JSON.parse(r.body!)).toEqual({ error: { code: "groq_key_missing", message: "Set your key" } });
  });
  test("unknown errors become opaque 500s (no stack leak)", () => {
    const r = errorResponse(new Error("secret internal detail"));
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain("secret internal detail");
    expect(JSON.parse(r.body!).error.code).toBe("internal");
  });
});
