import { DemoError } from "./demoError";

const unavailable = () =>
  new DemoError(503, "demo_capacity", "The live demo is temporarily unavailable.");

/**
 * Calls the Undertone API with the demo account's key. This is the only file
 * that reads UNDERTONE_DEMO_KEY, and the key never appears in a thrown message.
 */
export async function callUpstream(
  path: string,
  init: { method: string; body?: BodyInit; contentType?: string },
): Promise<unknown> {
  const base = process.env.UNDERTONE_API;
  const key = process.env.UNDERTONE_DEMO_KEY;
  if (!base || !key) {
    console.error("demo credentials are not configured"); // operator alert; no values logged
    throw unavailable();
  }

  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (init.contentType) headers["content-type"] = init.contentType;

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { method: init.method, body: init.body, headers });
  } catch (e) {
    console.error("upstream request failed", e);
    throw unavailable();
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (res.ok) return parsed;

  // A 401 means our own demo key is wrong or revoked — an operator problem, not
  // the visitor's. Never surface it as an auth error to the browser.
  if (res.status === 401) {
    console.error("demo key rejected by the platform — check UNDERTONE_DEMO_KEY");
    throw unavailable();
  }

  const envelope = parsed as { error?: { code?: string; message?: string } } | null;
  throw new DemoError(
    res.status,
    envelope?.error?.code ?? "upstream_error",
    envelope?.error?.message ?? "The platform returned an error.",
  );
}
