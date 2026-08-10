import { readFile } from "node:fs/promises";

const API = process.env.UNDERTONE_API;
const KEY = process.env.UNDERTONE_KEY;
if (!API || !KEY) throw new Error("Set UNDERTONE_API (ApiUrl output) and UNDERTONE_KEY (ut_live_...)");
const h = { authorization: `Bearer ${KEY}` };

async function call(method: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, { method, ...init, headers: { ...h, ...(init.headers ?? {}) } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body as Record<string, unknown>;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
}

// Registered before the session so both session.created and session.completed
// fan out to it. The receiver is the public demo's own session route, which
// answers POST with 201 — no third-party endpoint is involved.
const RECEIVER = "https://undertone-two.vercel.app/api/demo/session";
const webhook = await call("POST", "/v1/webhooks", {
  body: JSON.stringify({ url: RECEIVER, events: ["session.created", "session.completed"] }),
  headers: { "content-type": "application/json" },
});
assert(typeof webhook.id === "string" && typeof webhook.secret === "string", "webhook create returns id + secret");
assert(String(webhook.secret).startsWith("whsec_"), "secret has whsec_ prefix");
console.log(`✓ registered webhook ${webhook.id}`);

const listedHooks = await call("GET", "/v1/webhooks");
assert(
  (listedHooks.webhooks as { whookId?: string }[]).some((w) => w.whookId === webhook.id),
  "webhook appears in list",
);
assert(!JSON.stringify(listedHooks.webhooks).includes("secretEnc"), "list never leaks secretEnc");
console.log("✓ webhook listed without any secret material");

const session = await call("POST", "/v1/sessions", {
  body: JSON.stringify({ title: "smoke test" }),
  headers: { "content-type": "application/json" },
});
assert(typeof session.id === "string", "session has an id");
console.log(`✓ created session ${session.id}`);

const audio = await readFile(new URL("../services/test/fixtures/hello.wav", import.meta.url));
const chunk = await call("POST", `/v1/sessions/${session.id}/chunks`, {
  body: audio,
  headers: { "content-type": "audio/wav" },
});
assert(typeof chunk.transcript === "string" && (chunk.transcript as string).length > 10, "transcript is non-trivial");
assert(Array.isArray(chunk.suggestions), "suggestions is an array");
console.log(`✓ chunk transcribed (${(chunk.transcript as string).length} chars, ${(chunk.suggestions as unknown[]).length} suggestions)`);

const fetched = await call("GET", `/v1/sessions/${session.id}`);
assert(Array.isArray(fetched.chunks) && (fetched.chunks as unknown[]).length === 1, "session shows 1 chunk");
console.log("✓ session retrieval works");

const ended = await call("POST", `/v1/sessions/${session.id}/end`);
assert(ended.status === "ended", "session ended");
console.log(`✓ ended with summary: ${String(ended.summary).slice(0, 80)}...`);

console.log("waiting 20s for async embedding...");
await new Promise((r) => setTimeout(r, 20000));

// TODO(quota): make hard assertion once Bedrock quota > 0. Replace this block with:
//   const search = await call("GET", `/v1/search?q=${encodeURIComponent("mobile app roadmap priority")}`);
//   assert(Array.isArray(search.results) && (search.results as unknown[]).length >= 1, "search finds embedded chunk");
//   console.log(`✓ search returned ${(search.results as unknown[]).length} hits`);
const searchPath = `/v1/search?q=${encodeURIComponent("mobile app roadmap priority")}`;
const searchRes = await fetch(`${API}${searchPath}`, { headers: h });
const searchBody = (await searchRes.json()) as Record<string, unknown>;
if (searchRes.status >= 500) {
  console.log("⚠ search skipped: embeddings blocked on Bedrock quota (see ledger)");
} else if (searchRes.ok) {
  const hits = (searchBody.results as unknown[]) ?? [];
  if (hits.length >= 1) {
    console.log(`✓ search returned ${hits.length} hits`);
  } else {
    console.log(
      "⚠ search returned 0 hits — could be quota (no vectors embedded yet) OR a real search bug; investigate before demo",
    );
  }
} else {
  throw new Error(`GET ${searchPath} → ${searchRes.status}: ${JSON.stringify(searchBody)}`);
}

const chat = await call("POST", "/v1/chat", {
  body: JSON.stringify({ sessionId: session.id, prompt: "What was discussed?" }),
  headers: { "content-type": "application/json" },
});
assert(typeof chat.reply === "string" && (chat.reply as string).length > 10, "chat replies with content");
console.log("✓ chat deep-dive works");

const list = await call("GET", "/v1/sessions");
assert((list.sessions as { sessId?: string }[]).some((s) => s.sessId === session.id), "session in list");
console.log("✓ list works");

// Delivery is asynchronous: emit → SQS → sender. Give it a moment to land.
await new Promise((r) => setTimeout(r, 10000));
const afterDelivery = await call("GET", `/v1/webhooks/${webhook.id}`);
const { lastStatus, lastError, lastDeliveryAt } = afterDelivery as {
  lastStatus?: string;
  lastError?: string;
  lastDeliveryAt?: string;
};
// lastDeliveryAt is the hard assertion: it can only be set by the sender having
// loaded the subscription, passed the SSRF re-check, decrypted the secret and
// actually made a signed request. Whether the receiver answered 2xx is a
// property of the receiver — and this one deliberately rate-limits itself
// (2 sessions per IP per hour), so requiring "delivered" would make the smoke
// flaky rather than more truthful.
assert(typeof lastDeliveryAt === "string", "webhook delivery was attempted and recorded");
if (lastStatus === "delivered") {
  console.log("✓ webhook delivered and status recorded");
} else {
  console.log(`⚠ webhook delivery attempted but not 2xx (lastError=${lastError}) — receiver-side, pipeline ran`);
}

const delRes = await fetch(`${API}/v1/webhooks/${webhook.id}`, { method: "DELETE", headers: h });
assert(delRes.status === 204, "webhook delete returns 204"); // 204 has no body, so `call` cannot parse it
console.log("✓ webhook deleted\nSMOKE PASS");
