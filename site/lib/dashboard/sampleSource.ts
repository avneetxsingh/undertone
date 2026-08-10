import type {
  DashboardSource,
  SessionDetail,
  SessionSummary,
  StoredEvent,
  Webhook,
} from "./source";

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const SESSIONS: SessionDetail[] = [
  {
    sessId: "01SAMPLE0000000000000000Q2",
    title: "Q2 roadmap review",
    kind: "meeting",
    status: "ended",
    createdAt: iso(180),
    chunkCount: 2,
    summary:
      "The team agreed to prioritise the mobile app for Q2, citing that 40% of users have requested it, and deferred the analytics rebuild to Q3.",
    actionItems: [
      { task: "Draft the mobile app scope by Friday", owner: null },
      { task: "Move the analytics rebuild to the Q3 board", owner: null },
    ],
    chunks: [
      {
        seq: 1,
        createdAt: iso(180),
        transcript:
          "So for the second quarter I think the mobile app has to be the priority. Roughly forty percent of our users have asked for it.",
        suggestions: [
          {
            type: "FACT_CHECK",
            preview:
              "The 40% figure comes from the March survey, which only sampled active weekly users — it likely overstates demand across the whole base.",
            detail_prompt:
              "Where does the 40% mobile-app demand figure come from, and what population did it sample?",
          },
          {
            type: "QUESTION",
            preview:
              "Ask: what has to slip to make room for mobile in Q2 — analytics, or the billing migration?",
            detail_prompt:
              "Given a fixed Q2 capacity, what are the trade-offs of prioritising the mobile app over analytics or billing?",
          },
          {
            type: "TALKING_POINT",
            preview:
              "Shipping a responsive web build first would test the demand in weeks rather than committing a quarter to native.",
            detail_prompt:
              "Make the case for validating mobile demand with a responsive web build before committing to native development.",
          },
        ],
      },
      {
        seq: 2,
        createdAt: iso(179),
        transcript:
          "Agreed. Let's push the analytics rebuild to Q3 then, and I'll draft the mobile scope by Friday.",
        suggestions: [
          {
            type: "CLARIFICATION",
            preview:
              '"Mobile scope" is ambiguous here — native iOS and Android, or a single cross-platform build? The estimate changes by roughly double.',
            detail_prompt:
              "Clarify whether the mobile scope means native apps per platform or a single cross-platform build.",
          },
          {
            type: "TALKING_POINT",
            preview:
              "Deferring analytics removes the measurement needed to prove the mobile bet worked — worth keeping a minimal event pipeline.",
            detail_prompt:
              "Explain why deferring the analytics rebuild could undermine measuring the success of the mobile app launch.",
          },
          {
            type: "ANSWER",
            preview:
              "Friday is realistic for a scope draft; a full estimate needs design input and typically lands a week later.",
            detail_prompt:
              "Is a Friday deadline realistic for drafting mobile app scope, and what does a full estimate additionally require?",
          },
        ],
      },
    ],
  },
  {
    sessId: "01SAMPLE0000000000000000I1",
    title: "Candidate interview — backend",
    kind: "interview",
    status: "active",
    createdAt: iso(20),
    chunkCount: 1,
    chunks: [
      {
        seq: 1,
        createdAt: iso(20),
        transcript:
          "Walk me through how you'd design a rate limiter that works across several instances.",
        suggestions: [
          {
            type: "QUESTION",
            preview:
              "Follow up on what happens when the shared counter store is unreachable — fail open or fail closed is the real design decision.",
            detail_prompt:
              "What should a distributed rate limiter do when its shared counter store is unavailable, and what are the trade-offs?",
          },
          {
            type: "TALKING_POINT",
            preview:
              "A fixed window is far simpler than a sliding one and is usually sufficient; ask them to justify the extra complexity.",
            detail_prompt:
              "Compare fixed-window and sliding-window rate limiting, and when the added complexity of sliding windows is justified.",
          },
          {
            type: "CLARIFICATION",
            preview:
              "Worth pinning down whether the limit is per account, per key or per IP — the storage design differs for each.",
            detail_prompt:
              "How does the storage design of a rate limiter differ between per-account, per-key and per-IP limits?",
          },
        ],
      },
    ],
  },
];

const INITIAL_WEBHOOKS: Webhook[] = [
  {
    whookId: "01SAMPLEWHOOK000000000001",
    url: "https://hooks.example.com/undertone",
    events: ["session.completed"],
    status: "active",
    createdAt: iso(240),
    lastStatus: "delivered",
    lastDeliveryAt: iso(179),
    lastError: null,
  },
  {
    whookId: "01SAMPLEWHOOK000000000002",
    url: "https://ops.example.com/ingest",
    events: ["chunk.transcribed", "suggestions.generated"],
    status: "paused",
    createdAt: iso(300),
    lastStatus: "failed",
    lastDeliveryAt: iso(200),
    lastError: "HTTP 500",
  },
];

const INITIAL_EVENTS: StoredEvent[] = [
  {
    evtId: "01SAMPLEEVENT00000000004",
    event: "session.completed",
    createdAt: iso(179),
    payload: { id: SESSIONS[0].sessId, status: "ended" },
  },
  {
    evtId: "01SAMPLEEVENT00000000003",
    event: "suggestions.generated",
    createdAt: iso(179),
    payload: { sessionId: SESSIONS[0].sessId, seq: 2 },
  },
  {
    evtId: "01SAMPLEEVENT00000000002",
    event: "chunk.transcribed",
    createdAt: iso(180),
    payload: { sessionId: SESSIONS[0].sessId, seq: 1 },
  },
  {
    evtId: "01SAMPLEEVENT00000000001",
    event: "session.created",
    createdAt: iso(180),
    payload: { id: SESSIONS[0].sessId, title: SESSIONS[0].title },
  },
];

const summarise = (s: SessionDetail): SessionSummary => ({
  sessId: s.sessId,
  title: s.title,
  kind: s.kind,
  status: s.status,
  createdAt: s.createdAt,
  chunkCount: s.chunkCount,
});

const randomHex = (bytes: number) =>
  Array.from(
    { length: bytes * 2 },
    () => "0123456789abcdef"[Math.floor(Math.random() * 16)],
  ).join("");

/**
 * In-memory implementation. Each call to createSampleSource() gets its own
 * copies, so one component's mutations cannot leak into another's view — and a
 * test does not inherit state from the test before it.
 */
export function createSampleSource(): DashboardSource {
  const webhooks: Webhook[] = INITIAL_WEBHOOKS.map((w) => ({ ...w }));
  const events: StoredEvent[] = INITIAL_EVENTS.map((e) => ({ ...e }));

  return {
    isSample: true,

    async listSessions() {
      return SESSIONS.map(summarise);
    },

    async getSession(id) {
      const found = SESSIONS.find((s) => s.sessId === id);
      if (!found) throw new Error(`sample session ${id} not found`);
      return found;
    },

    async listWebhooks() {
      return webhooks.map((w) => ({ ...w }));
    },

    async createWebhook(url, wanted) {
      const webhook: Webhook = {
        whookId: `01SAMPLEWHOOK${randomHex(6)}`.toUpperCase(),
        url,
        events: wanted,
        status: "active",
        createdAt: new Date().toISOString(),
      };
      webhooks.unshift(webhook);
      // Returned once and never stored, exactly as the real API behaves.
      return { webhook: { ...webhook }, secret: `whsec_${randomHex(24)}` };
    },

    async deleteWebhook(id) {
      const i = webhooks.findIndex((w) => w.whookId === id);
      if (i >= 0) webhooks.splice(i, 1);
    },

    async listEvents(limit = 50) {
      return events.slice(0, limit).map((e) => ({ ...e }));
    },

    async replayEvent(id) {
      const evt = events.find((e) => e.evtId === id);
      if (!evt) throw new Error(`sample event ${id} not found`);
      const matched = webhooks.filter((w) => w.status === "active" && w.events.includes(evt.event));
      const now = new Date().toISOString();
      for (const w of matched) {
        w.lastStatus = "delivered";
        w.lastDeliveryAt = now;
        w.lastError = null;
      }
      return { replayed: matched.length };
    },
  };
}
