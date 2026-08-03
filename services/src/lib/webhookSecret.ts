import { randomBytes } from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

const kms = new KMSClient({});

export const generateWebhookSecret = () => `whsec_${randomBytes(24).toString("hex")}`;

export async function encryptSecret(plaintext: string): Promise<string> {
  const res = await kms.send(
    new EncryptCommand({ KeyId: process.env.KMS_KEY_ID!, Plaintext: Buffer.from(plaintext) }),
  );
  return Buffer.from(res.CiphertextBlob!).toString("base64");
}

export async function decryptSecret(enc: string): Promise<string> {
  const res = await kms.send(new DecryptCommand({ CiphertextBlob: Buffer.from(enc, "base64") }));
  return Buffer.from(res.Plaintext!).toString();
}
