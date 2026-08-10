import {
  DashboardError,
  type DashboardSource,
  type SessionDetail,
  type SessionSummary,
  type StoredEvent,
  type Webhook,
  type WebhookEventName,
} from "./source";

const base = () => process.env.NEXT_PUBLIC_UNDERTONE_API ?? "";

/**
 * One request path for every call, so error mapping cannot diverge between
 * endpoints. Returns null for 204, which DELETE relies on.
 */
async function call(
  apiKey: string,
  path: string,
  init: { method: string; body?: string } = { method: "GET" },
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    });
  } catch {
    // fetch rejects only on transport failure; everything else is a Response.
    throw new DashboardError(0, "network", "Could not reach the platform.");
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (res.ok) return parsed;

  // API Gateway answers 503 with no JSON body when Lambda is throttled, so a
  // missing envelope must not become a parse crash.
  const envelope = parsed as { error?: { code?: string; message?: string } } | null;
  const fallback =
    res.status === 503
      ? { code: "capacity", message: "The platform is at capacity. Try again shortly." }
      : { code: "upstream_error", message: `Request failed (HTTP ${res.status}).` };

  throw new DashboardError(
    res.status,
    envelope?.error?.code ?? fallback.code,
    envelope?.error?.message ?? fallback.message,
  );
}

export function createLiveSource(apiKey: string): DashboardSource {
  return {
    isSample: false,

    async listSessions() {
      const body = (await call(apiKey, "/v1/sessions")) as { sessions?: SessionSummary[] };
      return body?.sessions ?? [];
    },

    async getSession(id) {
      return (await call(apiKey, `/v1/sessions/${encodeURIComponent(id)}`)) as SessionDetail;
    },

    async listWebhooks() {
      const body = (await call(apiKey, "/v1/webhooks")) as { webhooks?: Webhook[] };
      return body?.webhooks ?? [];
    },

    async createWebhook(url: string, events: WebhookEventName[]) {
      // The create response returns `id`, while list returns `whookId`. This
      // adapter is the only place that difference is allowed to exist.
      const body = (await call(apiKey, "/v1/webhooks", {
        method: "POST",
        body: JSON.stringify({ url, events }),
      })) as {
        id: string;
        url: string;
        events: WebhookEventName[];
        status: "active";
        createdAt: string;
        secret: string;
      };

      return {
        webhook: {
          whookId: body.id,
          url: body.url,
          events: body.events,
          status: body.status,
          createdAt: body.createdAt,
        },
        secret: body.secret,
      };
    },

    async deleteWebhook(id) {
      await call(apiKey, `/v1/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    async listEvents(limit = 50) {
      const body = (await call(apiKey, `/v1/events?limit=${limit}`)) as { events?: StoredEvent[] };
      return body?.events ?? [];
    },

    async replayEvent(id) {
      const body = (await call(apiKey, `/v1/events/${encodeURIComponent(id)}/replay`, {
        method: "POST",
      })) as { replayed: number };
      return { replayed: body.replayed };
    },
  };
}
