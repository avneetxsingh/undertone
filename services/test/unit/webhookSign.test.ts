import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signPayload } from "../../src/lib/webhookSign";

describe("signPayload", () => {
  test("produces t=<ts>,v1=<hmac over ts.body>", () => {
    const body = JSON.stringify({ id: "e1", type: "session.completed" });
    const expected = createHmac("sha256", "whsec_abc").update(`1700000000.${body}`).digest("hex");
    expect(signPayload("whsec_abc", 1700000000, body)).toBe(`t=1700000000,v1=${expected}`);
  });
  test("header names are stable", () => {
    expect([SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_HEADER]).toEqual([
      "X-Undertone-Signature",
      "X-Undertone-Event",
      "X-Undertone-Delivery",
    ]);
  });
});
