import { lookup } from "node:dns/promises";
import { ApiError } from "./errors";

export function isBlockedIp(ip: string): boolean {
  // Unwrap v4-mapped v6 (::ffff:127.0.0.1) FIRST. It contains dots, so the
  // dotted-quad parse below would split it into four parts, fail the digit
  // test on "::ffff:127", and return false — letting ::ffff:169.254.169.254
  // through as a public address.
  const mapped = ip.toLowerCase();
  if (mapped.startsWith("::ffff:")) return isBlockedIp(mapped.slice(7));

  const parts = ip.split(".");
  if (parts.length === 4) {
    const [a, b] = parts.map(Number);
    if (parts.some((p) => !/^\d+$/.test(p)) || [a, b].some((n) => n < 0 || n > 255)) return false;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const s = mapped;
  if (s === "::1" || s === "::") return true;
  if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true; // link-local + ULA
  return false;
}

const hostOf = (u: URL) => {
  const h = u.hostname.toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
};
const isLiteralIp = (h: string) => /^[0-9.]+$/.test(h) || h.includes(":");

export function assertHttpsPublicUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ApiError(422, "invalid_url", "url must be a valid URL");
  }
  if (u.protocol !== "https:") throw new ApiError(422, "invalid_url", "url must use https");
  const host = hostOf(u);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    throw new ApiError(422, "invalid_url", "url must be a public host");
  if (isLiteralIp(host) && isBlockedIp(host))
    throw new ApiError(422, "invalid_url", "url must not target a private address");
}

type Lookup = (host: string) => Promise<{ address: string }[]>;
const defaultLookup: Lookup = (host) => lookup(host, { all: true });

/**
 * Send-time check. The registration-time guard is re-run first because a
 * subscription's url can be PATCHed, and then DNS is resolved: a hostname that
 * passed at registration can be re-pointed at an internal address afterwards
 * (DNS rebinding), so resolving once at registration would not be enough.
 */
export async function assertResolvesPublic(url: string, doLookup: Lookup = defaultLookup): Promise<void> {
  assertHttpsPublicUrl(url);
  const host = hostOf(new URL(url));
  if (isLiteralIp(host)) return; // already validated as a literal
  for (const { address } of await doLookup(host))
    if (isBlockedIp(address)) throw new Error(`webhook url resolves to blocked address ${address}`);
}
