import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { generateApiKey } from "../../src/lib/auth";
import { handler } from "../../src/handlers/chat";
import { startFakeGroq } from "../helpers/fakeGroq";

const ddbMock = mockClient(DynamoDBDocumentClient);
const kmsMock = mockClient(KMSClient);
let fake: Awaited<ReturnType<typeof startFakeGroq>> | undefined;
beforeEach(() => {
  ddbMock.reset(); kmsMock.reset();
  process.env.KEY_PEPPER = "p"; process.env.TABLE_NAME = "t";
});
afterEach(() => { fake?.close(); delete process.env.GROQ_BASE_URL; });

const authedBody = (body: unknown) => ({
  headers: { authorization: `Bearer ${generateApiKey()}` },
  body: JSON.stringify(body),
});

describe("POST /v1/chat", () => {
  test("401 without key", async () => {
    expect((await handler({ headers: {} } as never)).statusCode).toBe(401);
  });
  test("422 without sessionId or prompt", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1" }] });
    expect((await handler(authedBody({ prompt: "x" }) as never)).statusCode).toBe(422);
    expect((await handler(authedBody({ sessionId: "S1" }) as never)).statusCode).toBe(422);
  });
  test("404 when session not owned", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ acctId: "A1", groqKeyEnc: "x" }] });
    ddbMock.on(GetCommand).resolves({});
    expect((await handler(authedBody({ sessionId: "S1", prompt: "why" }) as never)).statusCode).toBe(404);
  });
  test("200 replies using session context", async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [{ acctId: "A1", groqKeyEnc: Buffer.from("c").toString("base64") }] })
      .resolves({ Items: [{ transcript: "we agreed on postgres", suggestions: [] }] });
    ddbMock.on(GetCommand).resolves({ Item: { PK: "ACCT#A1", SK: "SESS#S1", sessId: "S1", title: "t", status: "ended", summary: "db decision" } });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: Buffer.from("gsk_k") });
    fake = await startFakeGroq({ chatRaw: "You picked postgres because..." });
    process.env.GROQ_BASE_URL = fake.url;
    const res = await handler(authedBody({ sessionId: "S1", prompt: "why postgres?" }) as never);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).reply).toBe("You picked postgres because...");
    const sent = JSON.parse(fake.requests.at(-1)!.body);
    expect(JSON.stringify(sent.messages)).toContain("we agreed on postgres");
  });
});
