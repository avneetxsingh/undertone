# Undertone

**A multi-tenant, real-time audio-intelligence platform built on AWS serverless.**

Stream meeting audio to it in 30-second chunks; get back a transcript, three
contextually-routed AI suggestions, and — because it remembers every session
you've ever run — suggestions that can cite what you decided in a *previous*
meeting.

It is an API platform, not an app: multi-tenant from the first commit, with
per-account API keys, per-account encrypted inference credentials, and
account isolation enforced structurally at every storage boundary.

---

## Table of contents

- [What this is](#what-this-is)
- [Live deployment](#live-deployment)
- [What it demonstrates](#what-it-demonstrates)
- [Architecture](#architecture)
- [AWS services and why each one](#aws-services-and-why-each-one)
- [Request lifecycle](#request-lifecycle)
- [API reference](#api-reference)
- [Quick start](#quick-start)
- [Project structure](#project-structure)
- [Design decisions](#design-decisions)
- [What changed: Phase 1 → Phase 2](#what-changed-phase-1--phase-2)
- [Testing and verification](#testing-and-verification)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)

---

## What this is

Undertone began as a meeting-copilot coding challenge and was rebuilt as a
platform. The core insight it's built around: a live meeting assistant is
only useful if it says something *specific*. Generic advice ("ask a
clarifying question") is noise. So the suggestion engine doesn't use a flat
prompt — it uses a **routing prompt** that first classifies the meeting's
phase (opening / middle / closing) and the current conversational moment
(a claim, an unanswered question, confusion, a decision), then selects from
six suggestion types according to rules tied to those signals.

Phase 2 added the thing that makes it genuinely hard to replicate: **memory**.
Every transcript chunk is embedded and stored in a per-account vector index,
and each new chunk retrieves semantically-related moments from the account's
*other* sessions and injects them into the suggestion prompt. The model is
instructed to cite them by date. The result is a copilot that can say "on
2026-07-01 you decided to prioritize the mobile app" instead of "consider
your priorities."

**Tech:** TypeScript end to end — Node 22 Lambdas, AWS CDK for infrastructure,
Groq (Whisper + `openai/gpt-oss-120b`) for transcription and generation,
Google Gemini (`gemini-embedding-001`, 768-dim) for embeddings, and S3 Vectors
for retrieval.

### Where it came from

This repository holds both halves of the story:

- **`web/`** — the original challenge submission: a single-user Next.js
  meeting copilot with browser audio capture, live transcription, and the
  first version of the routing-prompt suggestion engine. Self-contained, no
  backend of its own, API key held in the browser.
- **`infra/`, `services/`, `scripts/`** — the rebuild: that same suggestion
  engine extracted into a multi-tenant AWS platform with authentication,
  persistence, isolation, cross-session memory, and infrastructure as code.

The prompt engineering carried over verbatim — the routing prompt in
`services/src/lib/prompts.ts` is a byte-for-byte port, verified by a
mechanical diff, because the product logic was the part worth keeping. What
changed is everything underneath it.

---

## Live deployment

The stack is deployed and running in AWS (`us-east-1`, stack `Undertone-dev`).
Currently provisioned:

| Resource | Count |
|---|---|
| Lambda functions | 10 |
| API Gateway HTTP API routes | 8 |
| IAM roles / scoped policies | 10 / 9 |
| DynamoDB tables (single-table design) | 1 |
| S3 buckets (private audio storage) | 1 |
| S3 Vectors bucket + index | 1 + 1 |
| SQS queues (work queue + dead-letter) | 2 |
| KMS keys | 1 |

Every endpoint below has been exercised against the live stack by an
end-to-end smoke script (`scripts/smoke.ts`), not just by unit tests.

---

## What it demonstrates

Written plainly, because this project exists to show capability:

- **Multi-tenant serverless architecture on AWS**, defined entirely as
  infrastructure-as-code with CDK (TypeScript) — reproducible from an empty
  account with two commands.
- **A production RAG pipeline**: asynchronous embedding via SQS + a worker
  Lambda, vector storage in an account-namespaced S3 Vectors index, and
  retrieval that grounds live generation — with the embedding path
  deliberately kept *off* the request path so a slow model call can never
  delay a user response.
- **Security as a structural property.** Every DynamoDB key and every vector
  query derives its partition from the *authenticated* account, never from
  client input. Cross-account access isn't "checked for" — it's
  unrepresentable, because the lookup key an attacker would need cannot be
  constructed. Platform API keys are stored as peppered HMAC hashes;
  per-account Groq keys are KMS-encrypted at rest; IAM is scoped per-Lambda
  to least privilege (only one function can write vectors, only one can
  encrypt, only two can decrypt).
- **Failure design.** Every AI call on the hot path degrades gracefully: a
  suggestion-generation failure still returns the transcript; a summary
  failure still ends the session. Meanwhile structural failures (bad auth,
  wrong owner, malformed input) fail fast with a consistent typed error
  contract. Async failures retry and land in a dead-letter queue.
- **Test discipline.** 94 automated tests that assert on *recorded AWS
  command inputs* — the actual DynamoDB keys, IAM policy shapes, S3 object
  keys, and vector filters being sent — rather than on mocked return values,
  so a regression that silently broke account isolation would fail CI.
- **AI engineering judgment**: prompt version control, verbatim prompt
  porting verified byte-for-byte, hallucination guards, and retrieval scoped
  to avoid the model restating what's already on screen.

---

## Architecture

```
                          ┌──────────────────────────────────────────────┐
   client (any app)       │  AWS us-east-1 · stack: Undertone-dev        │
   ─────────────────      │                                              │
   POST /v1/sessions      │   ┌────────────────────────┐                 │
   POST   …/chunks   ────▶│   │ API Gateway (HTTP API) │  CORS enabled   │
   GET  /v1/search        │   └───────────┬────────────┘                 │
   POST /v1/chat          │               │ 8 routes → 9 Lambdas         │
                          │               ▼                              │
                          │   ┌───────────────────────────────────┐      │
                          │   │ auth: peppered-HMAC key → GSI     │      │
                          │   │ lookup → authenticated account    │      │
                          │   └───────────────┬───────────────────┘      │
                          │                   ▼                          │
   ┌──────────────────────┴───────────────────────────────────────┐      │
   │  ingest (postChunk)                                          │      │
   │   1. atomic seq claim  ─────────────▶ DynamoDB (conditional) │      │
   │   2. store audio       ─────────────▶ S3 (private)           │      │
   │   3. transcribe        ─────────────▶ Groq Whisper           │      │
   │   4. retrieve history  ─────────────▶ S3 Vectors (best-effort)│     │
   │   5. suggestions       ─────────────▶ Groq gpt-oss-120b      │      │
   │   6. persist + enqueue ─────────────▶ DynamoDB + SQS         │      │
   └──────────────────────┬───────────────────────────────────────┘      │
                          │                                              │
                          │   SQS ──▶ embedWorker Lambda ──▶ Gemini      │
                          │    │         (async, off hot path)  embeddings│
                          │    │                                    │    │
                          │    ▼                                    ▼    │
                          │   DLQ (3 retries)          S3 Vectors index  │
                          │                            (per-account)     │
                          │                                              │
                          │   KMS ── encrypts each account's Groq key    │
                          └──────────────────────────────────────────────┘
```

---

## AWS services and why each one

| Service | Role in the system | Why this one |
|---|---|---|
| **API Gateway (HTTP API)** | Public edge for all 8 routes, CORS-enabled | Cheaper and lower-latency than REST APIs; native binary-body support means audio uploads need no multipart parsing |
| **Lambda (Node 22)** | 9 handlers — one per endpoint, plus the embed worker | Per-endpoint isolation lets IAM be scoped per function; no idle cost between meetings |
| **DynamoDB** | Single-table store for accounts, sessions, chunks | Single-digit-ms point lookups for auth on every request; conditional writes give atomic sequence claiming without a lock |
| **S3** | Raw audio chunk storage, fully private | Durable, cheap, and keeps large blobs out of the database |
| **S3 Vectors** | Per-account embedding index for semantic retrieval | Purpose-built vector storage — no vector database to run, pay-per-use, native metadata filtering for tenant isolation |
| **SQS + DLQ** | Decouples embedding from the request path; 3 retries then dead-letter | Embedding is slow and failure-prone; the user's response must never wait on it, and failed jobs must not vanish silently |
| **KMS** | Encrypts each account's Groq API key at rest | Third-party credentials must never sit in plaintext in a database |
| **CloudFormation via CDK** | Whole stack as TypeScript infrastructure-as-code | The architecture is reviewable, diffable, and testable — the test suite asserts on the synthesized template |

Embeddings are the one piece **not** on AWS: they call **Google Gemini**
(`gemini-embedding-001`, 768-dim, free tier) over HTTPS from the embed worker.
Bedrock Titan was the original choice but was quota-blocked on the dev account
(details in [Known limitations](#known-limitations)); the provider lives behind
a single function, so the swap touched one file and the index dimension.

---

## Request lifecycle

What happens when a client posts 30 seconds of audio:

1. **Authenticate.** The `ut_live_…` bearer token is HMAC-hashed with a
   server-side pepper and looked up through a sparse GSI — a point lookup,
   never a scan. This resolves the authenticated account id used for
   everything downstream.
2. **Claim the sequence number.** A single conditional DynamoDB update
   increments the session's chunk counter *only if* the session exists,
   belongs to this account, and is still active. One call yields the next
   sequence number and proves ownership and liveness simultaneously; a
   failed condition returns 404 without leaking whether the session exists.
3. **Persist audio** to a private S3 key namespaced `accountId/sessionId/…`.
4. **Transcribe** via Groq Whisper (`whisper-large-v3`), using the account's
   own decrypted Groq key.
5. **Retrieve memory** — embed the new transcript, query the account's vector
   index for related moments in *other* sessions. Best-effort: any failure
   here logs and proceeds with empty history rather than failing the request.
6. **Generate suggestions** through the routing prompt, with recent
   transcript, full transcript, previously-shown suggestions (for
   deduplication), and retrieved history as inputs.
7. **Persist and enqueue.** The chunk row is written; an SQS message is
   enqueued for asynchronous embedding. The enqueue is non-fatal — if the
   queue is unreachable, the caller still gets their transcript.
8. **Respond** with the transcript and suggestions in a single round trip.

Separately, `embedWorker` consumes the queue, embeds the transcript via
Gemini, and writes the vector; failures throw so SQS retries, and after
three attempts the message lands in the dead-letter queue.

---

## API reference

Every request carries `authorization: Bearer ut_live_…`.

| Method | Path | Description | Status |
|---|---|---|---|
| POST | `/v1/sessions` | Create a session — `{title?, kind?: meeting\|interview\|lecture}` | shipped |
| GET | `/v1/sessions` | List the account's sessions, newest first | shipped |
| GET | `/v1/sessions/{id}` | Full session: chunks, transcripts, suggestion history | shipped |
| POST | `/v1/sessions/{id}/chunks` | Raw audio body → `{ seq, transcript, suggestions[] }` | shipped |
| POST | `/v1/sessions/{id}/end` | Close the session; generate summary + action items | shipped |
| PUT | `/v1/account/groq-key` | Store the account's Groq key (KMS-encrypted) | shipped |
| GET | `/v1/search?q=…` | Semantic search across the account's sessions | shipped |
| POST | `/v1/chat` | Session-grounded deep-dive — `{sessionId, prompt}` → `{reply}` | shipped |
| CRUD | `/v1/webhooks` | Webhook subscriptions | roadmap |

Errors are uniform: `{"error": {"code": "…", "message": "…"}}` with
meaningful status codes — `401` unauthorized, `402` missing/invalid Groq key,
`404` not found or not owned, `409` already ended, `422` validation, `502`
upstream model failure. Internal errors return an opaque `500`; details go to
CloudWatch, never to the caller.

`/v1/` is reserved for versioning — breaking changes would ship as `/v2/`.

---

## Quick start

**Prerequisites:** an AWS account with credentials configured
(`aws configure`), CDK bootstrapped once per account/region
(`npx cdk bootstrap`), and a Groq API key (free at
[console.groq.com](https://console.groq.com)).

```bash
npm install

# 1. Deploy the stack. Set a real pepper — it salts every API key hash.
export UNDERTONE_PEPPER="$(openssl rand -hex 32)"
cd infra && npx cdk deploy -c stage=dev && cd ..
# → outputs ApiUrl, TableName, BucketName, VectorBucketName
```

```bash
# 2. Mint an account and platform API key (same pepper as the deploy).
TABLE_NAME=<TableName output> npx tsx scripts/create-account.ts "my account"
# → prints ut_live_… ONCE. It is stored only as a hash; save it now.
```

```bash
# 3. Store your Groq key on the account — inference is bring-your-own-key,
#    so the platform operator pays nothing for it.
curl -X PUT "$API/v1/account/groq-key" \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"groqKey": "gsk_…"}'
```

```bash
# 4. Run a session.
curl -X POST "$API/v1/sessions" -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" -d '{"title": "standup"}'

curl -X POST "$API/v1/sessions/<id>/chunks" -H "authorization: Bearer $KEY" \
  -H "content-type: audio/wav" \
  --data-binary @services/test/fixtures/hello.wav
# → { "seq": 1, "transcript": "…", "suggestions": [ … ] }

curl -X POST "$API/v1/sessions/<id>/end" -H "authorization: Bearer $KEY"
# → { "status": "ended", "summary": "…", "actionItems": [ … ] }
```

```bash
# 5. Verify the whole platform end to end against the live stack.
UNDERTONE_API=$API UNDERTONE_KEY=$KEY npx tsx scripts/smoke.ts
# → create → chunk → retrieve → end → search → chat → list → SMOKE PASS
```

---

## Project structure

```
.
├── infra/                      AWS CDK app — the entire architecture as code
│   ├── lib/undertone-stack.ts    every resource, IAM grant, and route
│   └── test/stack.test.ts        assertions on the synthesized template
├── services/
│   ├── src/
│   │   ├── handlers/             one Lambda per endpoint + embedWorker
│   │   └── lib/                  auth, dynamo, groq, bedrock, vectors,
│   │                             prompts, suggestions, errors
│   └── test/unit/                81 tests asserting on AWS command inputs
├── scripts/
│   ├── create-account.ts         mint an account + API key
│   └── smoke.ts                  end-to-end live verification
├── web/                        the original Next.js challenge app (see
│                                 "Where it came from" above)
└── README.md
```

---

## Design decisions

**Single-table DynamoDB.** Accounts, sessions, and chunks share one table:
`ACCT#<id>/META` for accounts, `ACCT#<id>/SESS#<ulid>` for sessions,
`SESS#<id>/CHUNK#<seq>` for chunks. A sparse GSI maps a hashed API key
directly to its account, so authentication is always a point lookup. ULIDs
give sessions chronological ordering for free, and chunk sort keys are
zero-padded so lexical order matches numeric order.

**Peppered HMAC API keys.** Platform keys are hashed with HMAC-SHA256 plus a
server-side pepper before touching the database. The plaintext is shown once
at creation and never stored or logged. A database leak yields no usable
keys.

**Bring-your-own inference keys, KMS-encrypted.** Each account supplies its
own Groq key; it's encrypted with a dedicated KMS key, decrypted in-Lambda
only at the moment of a model call, and IAM ensures only the handlers that
need decryption can perform it. This is what makes a public multi-tenant
deployment cost the operator nothing for inference.

**Ownership proven before every read.** Chunk rows are keyed by session id
alone, which carries no ownership signal — so every handler that reads them
performs an account-scoped ownership check *first*, and the code says so at
the call site. The test suite asserts this ordering, so a future refactor
that reordered them would fail.

**Graceful degradation, deliberately asymmetric.** On the ingest path,
failures degrade: no suggestions still returns the transcript; a failed
summary still ends the session; a failed retrieval still produces
suggestions. But `/v1/search` deliberately does *not* degrade — returning
`200` with an empty result set when embeddings are down would tell the user
"nothing matched" when the truth is "we couldn't look." It fails loudly
instead.

**Raw binary audio bodies.** Chunks are posted as the literal request body
with an `audio/*` content type rather than multipart form data — API Gateway
base64-decodes binary bodies natively, so the ingest handler needs no form
parsing on the hot path.

**Embedding is asynchronous and idempotent.** Vector writes are keyed by
`account/session/sequence`, so a retried SQS message overwrites rather than
duplicates. That makes at-least-once delivery safe without deduplication
logic.

**Memory is cross-session only.** Retrieval explicitly excludes the current
session — the model already receives the current transcript in full, so
including it would just restate what's on screen. Memory exists to surface
what happened *last time*.

**No SDK for Groq.** The client is a thin `fetch` wrapper whose base URL is
environment-overridable, so tests point it at a local fake HTTP server —
real request/response shapes, real error paths, no network and no API key in
CI.

---

## What changed: Phase 1 → Phase 2

**Phase 1 — the core pipeline.** Multi-tenant sessions API, API-key
authentication, audio ingestion to S3, Groq transcription, the routing-prompt
suggestion engine, session summaries with action items, KMS-encrypted
per-account credentials, and the full CDK stack. Delivered as 12 reviewed
tasks; deployed and smoke-tested live.

**Phase 2 — memory and retrieval.** Nine further tasks, each independently
reviewed:

| Added | What it does |
|---|---|
| Embeddings library | `gemini-embedding-001` at 768 dimensions (originally Bedrock Titan; swapped after a quota block) |
| S3 Vectors library | Account-namespaced writes and metadata-filtered queries |
| Async embed pipeline | SQS + dead-letter queue + `embedWorker` Lambda, so embedding never blocks a response |
| `GET /v1/search` | Semantic search across an account's entire history |
| `relevant_history` injection | Cross-session memory injected into the live suggestion prompt, with date-citation rules |
| `POST /v1/chat` | Session-grounded deep-dive replies |
| CORS | Browser clients can call the API directly |
| Memory-aware smoke test | End-to-end verification including search and chat |

Both phases were built with a plan → task → independent-review workflow: each
task shipped only after a reviewer verified it against its spec, and each
phase closed with a whole-branch review covering cross-task seams. Several
findings were caught this way — including an environment-variable naming
mismatch that would have broken authentication on the first production
deploy, and an API response-field inconsistency that would have become a
breaking change if it had shipped.

---

## Testing and verification

- **81 service tests** — handlers and libraries, asserting on recorded AWS
  SDK command inputs: the exact DynamoDB keys, S3 object keys, KMS
  ciphertext, vector filters, and outbound model request bodies (including
  that the correct model IDs are actually sent).
- **13 infrastructure tests** — assertions against the synthesized
  CloudFormation template: route set, table key schema, public-access
  blocking, dead-letter redrive policy, and IAM least-privilege grants.
- **End-to-end smoke script** — runs against the live deployed stack,
  exercising every endpoint in sequence.
- **Type safety** — `tsc --noEmit` clean across all three workspaces.

```bash
cd services && npx vitest run     # 81 tests
cd infra    && npx vitest run     # 13 template assertions
npx tsx scripts/smoke.ts          # live end-to-end
```

---

## Known limitations

**Embeddings run through Google Gemini, not Amazon Bedrock — and here's why,
because it's a more honest story than pretending the first choice worked.**
The original design used Bedrock Titan Text Embeddings V2. It turned out that
Bedrock gates on-demand inference per account, and the development account had
a quota of **0 requests/minute** for Titan V2 in every region tested
(`us-east-1`, `us-west-2`, `us-east-2`) — non-adjustable through the console,
and in some regions the Service Quotas API *reported* 6000 rpm while live
calls still threw `ThrottlingException`, so the reported number didn't reflect
real entitlement. Rather than block the whole memory feature on an AWS Support
case, `embedText` was pointed at Gemini's `gemini-embedding-001` (768-dim,
free tier), which has no per-region gating. The embedding provider is a single
function (`services/src/lib/embeddings.ts`) precisely so a swap like this
touches one file plus the vector-index dimension.

The rest of the platform is unchanged and still fully on AWS — DynamoDB, S3,
S3 Vectors, SQS, KMS, Lambda, all of it. Only the embedding HTTPS call leaves
AWS. Verified live end to end: posting a chunk writes a real 768-dim vector to
the index, `/v1/search` returns the matching moment, and the smoke test takes
its search-hits branch. The Gemini key is supplied to the Lambdas as an
environment variable.

**Chat is not streamed.** `/v1/chat` returns a complete JSON reply. Streaming
requires a Lambda Function URL (API Gateway HTTP APIs don't stream) and is
deferred.

**Pagination.** Session listing is capped at 50 and the per-session chunk
query is unpaginated; a session long enough to exceed DynamoDB's 1 MB query
limit would silently truncate. Fine at demo scale, tracked for long sessions.

**Batch retries.** The embed worker fails an entire SQS batch on a single bad
message rather than reporting partial batch failures. Vector writes are
idempotent so this is wasteful rather than incorrect.

---

## Roadmap

**Phase 3 — platform surface.** Webhook subscriptions with HMAC-signed
delivery (SQS-backed, dead-lettered), a developer dashboard for key and
session management, per-account rate limiting, and a public demo application
consuming the platform as its first customer.

**Beyond.** Streaming chat via Lambda Function URLs, speaker diarization,
and richer post-meeting artifacts.
