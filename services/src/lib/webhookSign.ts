import { createHmac } from "node:crypto";

export const SIGNATURE_HEADER = "X-Undertone-Signature";
export const EVENT_HEADER = "X-Undertone-Event";
export const DELIVERY_HEADER = "X-Undertone-Delivery";

/**
 * Stripe-style signature. The timestamp is signed alongside the body rather
 * than sent beside it, so a captured delivery cannot be replayed later with a
 * fresh `t` — changing the timestamp invalidates the MAC.
 */
export function signPayload(secret: string, timestampSeconds: number, rawBody: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}
