import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import type { Account } from "./auth";
import { ApiError } from "./errors";

const kms = new KMSClient({});

export async function encryptGroqKey(plaintext: string): Promise<string> {
  const res = await kms.send(
    new EncryptCommand({ KeyId: process.env.KMS_KEY_ID!, Plaintext: Buffer.from(plaintext) }),
  );
  return Buffer.from(res.CiphertextBlob!).toString("base64");
}

export async function getGroqKey(acct: Account): Promise<string> {
  if (!acct.groqKeyEnc)
    throw new ApiError(402, "groq_key_missing", "Set your Groq key via PUT /v1/account/groq-key");
  const res = await kms.send(new DecryptCommand({ CiphertextBlob: Buffer.from(acct.groqKeyEnc, "base64") }));
  return Buffer.from(res.Plaintext!).toString();
}
