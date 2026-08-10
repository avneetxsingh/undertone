import { beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import { getGroqKey } from "../../src/lib/groqKey";

const kmsMock = mockClient(KMSClient);
beforeEach(() => kmsMock.reset());

describe("getGroqKey", () => {
  test("throws 402 when the account has no stored key", async () => {
    await expect(getGroqKey({ acctId: "A1", name: "n" })).rejects.toMatchObject({
      status: 402,
      code: "groq_key_missing",
    });
  });
  test("decrypts the stored ciphertext", async () => {
    kmsMock.on(DecryptCommand).resolves({ Plaintext: Buffer.from("gsk_secret") });
    const key = await getGroqKey({ acctId: "A1", name: "n", groqKeyEnc: Buffer.from("cipher").toString("base64") });
    expect(key).toBe("gsk_secret");
  });
});
