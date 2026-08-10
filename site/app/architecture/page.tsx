import Link from "next/link";
import "../architecture.css";

export const metadata = {
  title: "Architecture — Undertone",
  description: "The chunk request lifecycle, the AWS services behind it, and the Bedrock-to-Gemini embeddings swap.",
};

export default function ArchitecturePage() {
  return (
    <main className="architecture">
      <header className="site-header">
        <Link href="/" className="wordmark">
          Undertone
        </Link>
        <nav>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/docs">API docs</Link>
          <a href="https://github.com/avneetxsingh/undertone" target="_blank" rel="noreferrer">
            Source
          </a>
        </nav>
      </header>

      <h1>Architecture</h1>
      <p className="architecture-intro">
        What actually happens when a client posts an audio chunk, why the platform is built on the AWS
        services it is, and the story behind the one part that isn&apos;t on AWS at all &mdash; embeddings.
      </p>

      {/* ── 1. Request lifecycle ──────────────────────────── */}
      <section className="architecture-section">
        <h2>Request lifecycle</h2>
        <p>
          <code>POST /v1/sessions/&#123;id&#125;/chunks</code> is the hot path &mdash; the handler in{" "}
          <code>services/src/handlers/postChunk.ts</code> does all of the following in a single Lambda
          invocation before responding:
        </p>
        <ol className="lifecycle-list">
          <li>
            <strong>Claim the sequence number.</strong> A single DynamoDB <code>UpdateCommand</code> does{" "}
            <code>ADD chunkCount :one</code> with a condition expression of{" "}
            <code>attribute_exists(PK) AND #s = :active</code>. That one atomic conditional update is doing
            three jobs at once: it proves the session exists, proves it belongs to this account (the key is
            built from the authenticated account id), and proves it&apos;s still active &mdash; all before a
            single byte of audio is touched. A failed condition maps to <code>404 session_not_found</code>{" "}
            without saying which check failed.
          </li>
          <li>
            <strong>Decrypt the account&apos;s Groq key.</strong> The account&apos;s KMS-encrypted Groq API
            key is decrypted in-Lambda so the transcription and suggestion calls that follow can use it.
          </li>
          <li>
            <strong>Archive the audio to S3.</strong> The raw chunk bytes are written to a private bucket
            under a key namespaced <code>accountId/sessionId/chunk-&#123;seq&#125;.&#123;ext&#125;</code>.
          </li>
          <li>
            <strong>Transcribe.</strong> The audio is sent to Groq Whisper and comes back as plain text.
          </li>
          <li>
            <strong>Query prior chunks.</strong> A DynamoDB query fetches every prior chunk row for this
            session so the suggestion step gets the full transcript, and the last batch of suggestions shown
            to the user is pulled off the most recent one for deduplication.
          </li>
          <li>
            <strong>Retrieve memory.</strong> The new transcript is embedded (Gemini) and used to query the
            account&apos;s S3 Vectors index for related moments from the account&apos;s <em>other</em>{" "}
            sessions &mdash; the current session is excluded, since its own transcript is already being sent
            in full.
          </li>
          <li>
            <strong>Generate suggestions.</strong> The routing prompt runs with the full transcript, the
            prior suggestions, and the retrieved cross-session history as inputs, and returns the routed
            suggestion set.
          </li>
          <li>
            <strong>Persist.</strong> The chunk row &mdash; transcript, suggestions, audio key, sequence,
            timestamp &mdash; is written to DynamoDB.
          </li>
          <li>
            <strong>Enqueue for embedding.</strong> An SQS message carrying the transcript is sent so a
            separate worker Lambda can embed and index it asynchronously.
          </li>
          <li>
            <strong>Fan out to webhook subscribers.</strong> Any active subscription that asked for{" "}
            <code>chunk.transcribed</code> or <code>suggestions.generated</code> gets one queue message per
            subscription, for a second worker to deliver.
          </li>
        </ol>
        <p>
          The response carries the transcript and suggestions back in the same round trip that started this
          list.
        </p>
        <p>
          Two of those steps are deliberately wrapped so a failure there degrades the response instead of
          failing it outright. Memory retrieval (<code>postChunk.ts:80&ndash;82</code>) is wrapped in its own
          try/catch: if embedding or the vector query throws, the error is logged and the request proceeds
          with an empty history array rather than surfacing an error to the caller. The embed-enqueue step (
          <code>postChunk.ts:114&ndash;116</code>) is wrapped the same way &mdash; if SQS is unreachable, the
          failure is logged and swallowed, because memory is best-effort and the chunk response must not
          fail on its account. Suggestion generation itself goes through a separate safe wrapper that can
          return an empty suggestions array with a <code>suggestions_failed</code> warning rather than
          throwing; nothing else in the list above degrades &mdash; a failure anywhere else propagates as a
          real error response.
        </p>
        <p className="architecture-note">
          Live capture has shown this in practice: an 18-chunk session never once produced an{" "}
          <code>ACTION_ITEM</code> suggestion, and later chunks in longer sessions have intermittently come
          back with an empty <code>suggestions</code> array and <code>warning: &quot;suggestions_failed&quot;</code>.
          The routing design selects from six suggestion types by rule &mdash; it doesn&apos;t guarantee any
          particular type shows up in a given batch, and a degraded response is an expected, handled outcome,
          not a bug.
        </p>
      </section>

      {/* ── 2. Webhook fan-out ─────────────────────────────── */}
      <section className="architecture-section">
        <h2>Webhook fan-out</h2>
        <p>
          The lifecycle above describes the platform answering a caller. Webhooks are the other direction:
          the platform calling out. Four events fire &mdash; <code>session.created</code>,{" "}
          <code>chunk.transcribed</code>, <code>suggestions.generated</code> and{" "}
          <code>session.completed</code> &mdash; and each subscription declares which of them it wants.
        </p>
        <p>
          Fan-out happens at emit time. The producing handler lists the account&apos;s matching active
          subscriptions and puts one message on a dedicated queue per subscription. That message carries the
          event and the subscription id, and deliberately never carries the signing secret. A separate sender
          Lambda consumes the queue, re-loads the subscription fresh, re-checks the destination against the
          SSRF rules, decrypts the secret through KMS, and POSTs a signed body with a five-second timeout.
        </p>
        <p>
          Reloading rather than trusting the queue message is what makes a delete or a pause take effect on
          deliveries already in flight. A non-2xx or a timeout is re-thrown so the queue redelivers; after
          three attempts the message lands in a dead-letter queue that raises a CloudWatch alarm. Delivery
          status is written to the subscription <em>before</em> that re-throw, so a failed delivery is
          recorded <em>and</em> retried instead of one outcome displacing the other.
        </p>
        <p className="architecture-note">
          Emitting is best-effort in exactly the same sense as the embed enqueue above: the call is wrapped
          so a webhook problem can never turn a successful API response into an error. A subscriber being
          down is the subscriber&apos;s problem, not the caller&apos;s. The batch size on the sender is
          deliberately small, so one broken destination dead-letters on its own rather than dragging a large
          batch through three delivery attempts with it.
        </p>
      </section>

      {/* ── 3. Design decisions ────────────────────────────── */}
      <section className="architecture-section">
        <h2>Design decisions</h2>
        <p>The AWS services underneath the request lifecycle above, and why each one was chosen:</p>
        <div className="table-scroll">
          <table className="decisions-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Role in the system</th>
                <th>Why this one</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>DynamoDB</strong></td>
                <td>Single-table store for accounts, sessions, chunks</td>
                <td>
                  Single-digit-ms point lookups for auth on every request; conditional writes give atomic
                  sequence claiming without a lock
                </td>
              </tr>
              <tr>
                <td><strong>S3</strong></td>
                <td>Raw audio chunk storage, fully private</td>
                <td>Durable, cheap, and keeps large blobs out of the database</td>
              </tr>
              <tr>
                <td><strong>S3 Vectors</strong></td>
                <td>Per-account embedding index for semantic retrieval</td>
                <td>
                  Purpose-built vector storage &mdash; no vector database to run, pay-per-use, native
                  metadata filtering for tenant isolation
                </td>
              </tr>
              <tr>
                <td><strong>SQS + DLQ</strong></td>
                <td>
                  Two queues, each with 3 retries then dead-letter: one decouples embedding from the request
                  path, one carries webhook deliveries
                </td>
                <td>
                  Embedding is slow and failure-prone and webhook destinations are outside our control; the
                  user&apos;s response must never wait on either, and failed jobs must not vanish silently
                </td>
              </tr>
              <tr>
                <td><strong>CloudWatch</strong></td>
                <td>Alarms when the webhook dead-letter queue is non-empty</td>
                <td>
                  A delivery that has exhausted its retries is a real failure someone has to know about, not
                  a line in a log nobody reads
                </td>
              </tr>
              <tr>
                <td><strong>KMS</strong></td>
                <td>
                  Encrypts each account&apos;s Groq API key and each webhook signing secret at rest
                </td>
                <td>Third-party credentials must never sit in plaintext in a database</td>
              </tr>
              <tr>
                <td><strong>CDK</strong></td>
                <td>Whole stack as TypeScript infrastructure-as-code</td>
                <td>
                  The architecture is reviewable, diffable, and testable &mdash; the test suite asserts on
                  the synthesized template
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 4. The embeddings story ────────────────────────── */}
      <section className="architecture-section">
        <h2>The embeddings story</h2>
        <p>
          Embeddings are the one piece of this platform that isn&apos;t on AWS, and the reason why is more
          useful than pretending the first choice worked.
        </p>
        <p>
          The original design used Bedrock Titan Text Embeddings V2. Bedrock gates on-demand inference per
          account, and the development account&apos;s Titan V2 quota was <strong>0 requests per minute</strong>{" "}
          &mdash; in every region tested, non-adjustable through the console.
        </p>
        <p>
          Because the embedding provider sat behind a single function (<code>embedText</code> in{" "}
          <code>services/src/lib/embeddings.ts</code>), swapping providers didn&apos;t touch the handler, the
          retrieval logic, or anything that calls it &mdash; it touched that one file and the vector index&apos;s
          dimension. The swap went to Google Gemini&apos;s <code>gemini-embedding-001</code>, requested at{" "}
          <strong>768 dimensions</strong>, which has no per-region gating.
        </p>
        <p className="architecture-note">
          That&apos;s the point worth showing: the boundary was drawn before it was needed, and when the
          original plan hit a wall, the cost of changing it was one file and one number &mdash; not a
          rewrite of the request lifecycle above.
        </p>
      </section>
    </main>
  );
}
