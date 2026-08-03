import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import { createHmac } from "node:crypto";
import { handler } from "../../src/handlers/webhookSender";

// The sender re-checks SSRF at send time, which resolves the url's host for
// real. Without this the suite would depend on live DNS (and ok.example.com
// does not resolve at all). Returns a public address so the guard passes and
// the delivery path itself is what gets exercised.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34" }],
}));

const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);
beforeEach(() => {
  ddbMock.reset();
  kmsMock.reset();
  process.env.TABLE_NAME = "t";
  kmsMock.on(DecryptCommand).resolves({ Plaintext: Buffer.from("whsec_secret") });
});
afterEach(() => vi.restoreAllMocks());

const rec = (over = {}) => ({
  body: JSON.stringify({
    eventId: "e1",
    event: "session.completed",
    acctId: "A1",
    whookId: "W1",
    payload: { id: "S1" },
    createdAt: "2026-07-26T00:00:00.000Z",
    ...over,
  }),
});
const sub = (over = {}) => ({
  Item: {
    whookId: "W1",
    url: "https://ok.example.com/x",
    events: ["session.completed"],
    status: "active",
    secretEnc: "enc",
    createdAt: "2026-07-26T00:00:00.000Z",
    ...over,
  },
});

describe("webhookSender", () => {
  test("skips a deleted subscription (no fetch, no throw)", async () => {
    ddbMock.on(GetCommand).resolves({});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await handler({ Records: [rec()] } as never);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test("skips a paused subscription mid-flight", async () => {
    ddbMock.on(GetCommand).resolves(sub({ status: "paused" }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await handler({ Records: [rec()] } as never);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test("signs and POSTs, records delivered", async () => {
    ddbMock.on(GetCommand).resolves(sub());
    ddbMock.on(UpdateCommand).resolves({});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await handler({ Records: [rec()] } as never);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://ok.example.com/x");
    const body = (init as RequestInit).body as string;
    const headers = (init as RequestInit).headers as Record<string, string>;
    const t = headers["X-Undertone-Signature"].match(/^t=(\d+),v1=/)![1];
    const expected = createHmac("sha256", "whsec_secret").update(`${t}.${body}`).digest("hex");
    expect(headers["X-Undertone-Signature"]).toBe(`t=${t},v1=${expected}`);
    expect(headers["X-Undertone-Event"]).toBe("session.completed");
    expect(headers["X-Undertone-Delivery"]).toBe("e1");
    const upd = ddbMock.commandCalls(UpdateCommand).at(-1)!.args[0].input.ExpressionAttributeValues!;
    expect(upd[":st"]).toBe("delivered");
  });
  test("records failed and throws on non-2xx (so SQS retries)", async () => {
    ddbMock.on(GetCommand).resolves(sub());
    ddbMock.on(UpdateCommand).resolves({});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 500 }));
    await expect(handler({ Records: [rec()] } as never)).rejects.toThrow(/delivery failed/);
    const upd = ddbMock.commandCalls(UpdateCommand).at(-1)!.args[0].input.ExpressionAttributeValues!;
    expect(upd[":st"]).toBe("failed");
    expect(upd[":er"]).toBe("HTTP 500");
  });
  test("the delivery body never carries the signing secret", async () => {
    ddbMock.on(GetCommand).resolves(sub());
    ddbMock.on(UpdateCommand).resolves({});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await handler({ Records: [rec()] } as never);
    const body = (fetchSpy.mock.calls[0][1] as RequestInit).body as string;
    expect(body).not.toContain("whsec_secret");
    expect(body).not.toContain("secretEnc");
  });
});
