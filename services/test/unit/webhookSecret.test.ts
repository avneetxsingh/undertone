import { beforeEach, describe, expect, test } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { decryptSecret, encryptSecret, generateWebhookSecret } from "../../src/lib/webhookSecret";

const kmsMock = mockClient(KMSClient);
beforeEach(() => {
  kmsMock.reset();
  process.env.KMS_KEY_ID = "kms-key-1";
});

describe("webhookSecret", () => {
  test("generateWebhookSecret has whsec_ prefix and 48 hex chars", () => {
    expect(generateWebhookSecret()).toMatch(/^whsec_[0-9a-f]{48}$/);
  });
  test("encryptSecret sends plaintext under KMS_KEY_ID and returns base64", async () => {
    kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: Buffer.from("cipher") });
    const out = await encryptSecret("whsec_x");
    expect(out).toBe(Buffer.from("cipher").toString("base64"));
    expect(kmsMock.commandCalls(EncryptCommand)[0].args[0].input).toMatchObject({
      KeyId: "kms-key-1",
      Plaintext: Buffer.from("whsec_x"),
    });
  });
  test("decryptSecret round-trips base64 ciphertext to plaintext", async () => {
    kmsMock.on(DecryptCommand).resolves({ Plaintext: Buffer.from("whsec_x") });
    expect(await decryptSecret(Buffer.from("cipher").toString("base64"))).toBe("whsec_x");
  });
});
