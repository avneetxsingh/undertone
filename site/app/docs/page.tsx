import Link from "next/link";
import "../docs.css";

export const metadata = {
  title: "API reference — Undertone",
  description: "Endpoints, request/response shapes, error codes, and demo limits for the Undertone API.",
};

export default function DocsPage() {
  return (
    <main className="docs">
      <header className="site-header">
        <Link href="/" className="docs-home-link">
          Undertone
        </Link>
        <nav>
          <Link href="/architecture">Architecture</Link>
          <a href="https://github.com/avneetxsingh/undertone" target="_blank" rel="noreferrer">
            Source
          </a>
        </nav>
      </header>

      <h1>API reference</h1>
      <p className="docs-intro">
        Undertone runs on a real multi-tenant serverless API: API Gateway routing to Lambda handlers backed
        by a single-table DynamoDB store. Every request below hits that live platform, not a mock.
      </p>

      {/* ── 1. Authentication ─────────────────────────────── */}
      <section className="docs-section">
        <h2>Authentication</h2>
        <p>
          Every request must carry an <code>Authorization</code> header with a bearer API key issued by the
          platform:
        </p>
        <pre className="code-block">
          <code>Authorization: Bearer ut_live_&hellip;</code>
        </pre>
        <p>
          A missing or malformed key returns <code>401</code> before any other handler logic runs. Keys are never
          accepted as a query parameter or request body field &mdash; only the header.
        </p>
      </section>

      {/* ── 2. Endpoints ───────────────────────────────────── */}
      <section className="docs-section">
        <h2>Endpoints</h2>
        <div className="table-scroll">
          <table className="endpoint-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="method-badge post">POST</span></td>
                <td><code>/v1/sessions</code></td>
                <td>Create a new session.</td>
              </tr>
              <tr>
                <td><span className="method-badge get">GET</span></td>
                <td><code>/v1/sessions</code></td>
                <td>List the calling account&apos;s sessions, newest first.</td>
              </tr>
              <tr>
                <td><span className="method-badge get">GET</span></td>
                <td><code>/v1/sessions/&#123;id&#125;</code></td>
                <td>Fetch one session with its full chunk history.</td>
              </tr>
              <tr>
                <td><span className="method-badge post">POST</span></td>
                <td><code>/v1/sessions/&#123;id&#125;/end</code></td>
                <td>End a session and generate its summary + action items.</td>
              </tr>
              <tr>
                <td><span className="method-badge post">POST</span></td>
                <td><code>/v1/sessions/&#123;id&#125;/chunks</code></td>
                <td>Post one audio segment; returns its transcript and suggestions.</td>
              </tr>
              <tr>
                <td><span className="method-badge put">PUT</span></td>
                <td><code>/v1/account/groq-key</code></td>
                <td>Store the account&apos;s Groq API key (encrypted at rest).</td>
              </tr>
              <tr>
                <td><span className="method-badge get">GET</span></td>
                <td><code>/v1/search</code></td>
                <td>Semantic search over the account&apos;s past chunks.</td>
              </tr>
              <tr>
                <td><span className="method-badge post">POST</span></td>
                <td><code>/v1/chat</code></td>
                <td>Ask a question grounded in one session&apos;s transcript and summary.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="endpoint-detail">
          <h3>
            <span className="method-badge post">POST</span> <code>/v1/sessions</code>
          </h3>
          <p>Request body (all fields optional):</p>
          <pre className="code-block">
            <code>{`{
  "kind": "meeting" | "interview" | "lecture",  // default: "meeting"
  "title": "string"                              // default: "Untitled session"
}`}</code>
          </pre>
          <p>Response &mdash; <code>201</code>:</p>
          <pre className="code-block">
            <code>{`{
  "id": "string",
  "title": "string",
  "kind": "string",
  "status": "active",
  "createdAt": "ISO 8601 string"
}`}</code>
          </pre>
          <p className="endpoint-errors">
            Errors: <code>400 invalid_json</code>, <code>422 invalid_kind</code>.
          </p>
        </div>

        <div className="endpoint-detail">
          <h3>
            <span className="method-badge get">GET</span> <code>/v1/sessions</code>
          </h3>
          <p>No request body. Response &mdash; <code>200</code>:</p>
          <pre className="code-block">
            <code>{`{
  "sessions": [
    {
      "id": "string",        // mirrors "sessId" below — both keys carry the same value
      "sessId": "string",
      "title": "string",
      "kind": "string",
      "status": "active" | "ended",
      "chunkCount": 0,
      "createdAt": "ISO 8601 string"
      // "endedAt", "summary", "actionItems" also present once ended
    }
  ]
}`}</code>
          </pre>
          <p className="endpoint-errors">Returns at most the 50 most recent sessions, newest first.</p>
        </div>

        <div className="endpoint-detail">
          <h3>
            <span className="method-badge get">GET</span> <code>/v1/sessions/&#123;id&#125;</code>
          </h3>
          <p>No request body. Response &mdash; <code>200</code>:</p>
          <pre className="code-block">
            <code>{`{
  "id": "string",        // mirrors "sessId" below — both keys carry the same value
  "sessId": "string",
  "title": "string",
  "kind": "string",
  "status": "active" | "ended",
  "chunkCount": 0,
  "createdAt": "ISO 8601 string",
  // "endedAt", "summary", "actionItems" also present once ended
  "chunks": [
    { "seq": 1, "transcript": "string", "suggestions": [ /* see below */ ], "createdAt": "ISO 8601 string" }
  ]
}`}</code>
          </pre>
          <p className="endpoint-errors">
            Errors: <code>422 missing_session_id</code>, <code>404 session_not_found</code>.
          </p>
        </div>

        <div className="endpoint-detail">
          <h3>
            <span className="method-badge post">POST</span> <code>/v1/sessions/&#123;id&#125;/end</code>
          </h3>
          <p>No request body. Response &mdash; <code>200</code>:</p>
          <pre className="code-block">
            <code>{`{
  "id": "string",
  "status": "ended",
  "summary": "string" | null,
  "actionItems": [ { "owner": "string" | null, "task": "string" } ] | null,
  "warning": "summary_failed"  // present only if summary generation failed; the session still ends
}`}</code>
          </pre>
          <p className="endpoint-errors">
            Errors: <code>422 missing_session_id</code>, <code>409 session_already_ended</code>.
          </p>
        </div>

        <div className="endpoint-detail">
          <h3>
            <span className="method-badge post">POST</span> <code>/v1/sessions/&#123;id&#125;/chunks</code>
          </h3>
          <p>
            Request body is the <strong>raw audio bytes</strong> &mdash; see{" "}
            <a href="#audio-format">Audio format</a> below. Response &mdash; <code>200</code>:
          </p>
          <pre className="code-block">
            <code>{`{
  "seq": 1,
  "transcript": "string",
  "suggestions": [
    { "type": "string", "preview": "string", "detail_prompt": "string" }
  ],
  "warning": "suggestions_failed"  // present only if suggestion generation failed; the chunk still saves
}`}</code>
          </pre>
          <p className="endpoint-errors">
            Errors: <code>422 missing_session_id</code>, <code>422 empty_audio</code>,{" "}
            <code>422 unsupported_audio_type</code>, <code>404 session_not_found</code>,{" "}
            <code>402 groq_key_missing</code>, <code>402 groq_key_invalid</code>, <code>502 groq_upstream</code>.
          </p>
        </div>

        <div className="endpoint-detail">
          <h3>
            <span className="method-badge put">PUT</span> <code>/v1/account/groq-key</code>
          </h3>
          <p>Request body:</p>
          <pre className="code-block">
            <code>{`{ "groqKey": "gsk_..." }`}</code>
          </pre>
          <p>Response &mdash; <code>200</code>:</p>
          <pre className="code-block">
            <code>{`{ "ok": true }`}</code>
          </pre>
          <p className="endpoint-errors">
            Errors: <code>400 invalid_json</code>, <code>422 invalid_groq_key</code> (key must start with{" "}
            <code>gsk_</code>).
          </p>
        </div>

        <div className="endpoint-detail">
          <h3>
            <span className="method-badge get">GET</span> <code>/v1/search?q=&#123;text&#125;</code>
          </h3>
          <p>No request body; query text is passed as <code>?q=</code>. Response &mdash; <code>200</code>:</p>
          <pre className="code-block">
            <code>{`{
  "results": [
    { "sessId": "string", "seq": 1, "text": "string", "createdAt": "ISO 8601 string", "distance": 0.12 }
    // "distance" is optional — omitted if the vector index didn't return one
  ]
}`}</code>
          </pre>
          <p className="endpoint-errors">
            Errors: <code>422 missing_query</code>, <code>502 embed_failed</code>.
          </p>
        </div>

        <div className="endpoint-detail">
          <h3>
            <span className="method-badge post">POST</span> <code>/v1/chat</code>
          </h3>
          <p>Request body:</p>
          <pre className="code-block">
            <code>{`{ "sessionId": "string", "prompt": "string" }`}</code>
          </pre>
          <p>Response &mdash; <code>200</code>:</p>
          <pre className="code-block">
            <code>{`{ "reply": "string" }`}</code>
          </pre>
          <p className="endpoint-errors">
            Errors: <code>400 invalid_json</code>, <code>422 missing_session_id</code>,{" "}
            <code>422 missing_prompt</code>, <code>404 session_not_found</code>,{" "}
            <code>402 groq_key_missing</code>, <code>402 groq_key_invalid</code>, <code>502 groq_upstream</code>.
          </p>
        </div>

        <h3>Try it</h3>
        <p>Two runnable examples against the live platform (needs your own API key and Groq key on file):</p>
        <pre className="code-block curl-block">
          <code>{`# Create a session
curl -X POST "$UNDERTONE_API/v1/sessions" \\
  -H "authorization: Bearer $UNDERTONE_KEY" \\
  -H "content-type: application/json" \\
  -d '{"kind":"meeting","title":"Standup"}'

# Post 15 seconds of audio as a raw body
curl -X POST "$UNDERTONE_API/v1/sessions/$SESSION_ID/chunks" \\
  -H "authorization: Bearer $UNDERTONE_KEY" \\
  -H "content-type: audio/webm" \\
  --data-binary @segment.webm`}</code>
        </pre>
      </section>

      {/* ── 3. Errors ──────────────────────────────────────── */}
      <section className="docs-section">
        <h2>Errors</h2>
        <p>Every error response uses the same envelope:</p>
        <pre className="code-block">
          <code>{`{ "error": { "code": "string", "message": "string" } }`}</code>
        </pre>
        <div className="table-scroll">
          <table className="error-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Code</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>400</td>
                <td><code>invalid_json</code></td>
                <td>Request body could not be parsed as JSON.</td>
              </tr>
              <tr>
                <td>401</td>
                <td><code>unauthorized</code></td>
                <td>Bearer key missing, malformed, or unrecognized.</td>
              </tr>
              <tr>
                <td>404</td>
                <td><code>session_not_found</code></td>
                <td>No session with that id for this account.</td>
              </tr>
              <tr>
                <td>409</td>
                <td><code>session_already_ended</code></td>
                <td>Session was already ended (or never existed).</td>
              </tr>
              <tr>
                <td>422</td>
                <td><code>missing_session_id</code></td>
                <td>Path or body did not include a session id.</td>
              </tr>
              <tr>
                <td>422</td>
                <td><code>empty_audio</code></td>
                <td>Chunk body was missing or too small to transcribe.</td>
              </tr>
              <tr>
                <td>422</td>
                <td><code>unsupported_audio_type</code></td>
                <td>Content-type was not one of the accepted audio formats.</td>
              </tr>
              <tr>
                <td>422</td>
                <td><code>invalid_kind</code></td>
                <td>Session <code>kind</code> was not meeting, interview, or lecture.</td>
              </tr>
              <tr>
                <td>422</td>
                <td><code>missing_prompt</code></td>
                <td>Chat body did not include a prompt.</td>
              </tr>
              <tr>
                <td>422</td>
                <td><code>invalid_groq_key</code></td>
                <td>Groq key was missing or didn&apos;t start with <code>gsk_</code>.</td>
              </tr>
              <tr>
                <td>422</td>
                <td><code>missing_query</code></td>
                <td>Search request did not include <code>?q=</code>.</td>
              </tr>
              <tr>
                <td>402</td>
                <td><code>groq_key_missing</code></td>
                <td>No Groq key is on file for this account; set one via <code>PUT /v1/account/groq-key</code>.</td>
              </tr>
              <tr>
                <td>402</td>
                <td><code>groq_key_invalid</code></td>
                <td>Groq rejected the stored key.</td>
              </tr>
              <tr>
                <td>502</td>
                <td><code>groq_upstream</code></td>
                <td>Groq returned a non-2xx status or an unusable response.</td>
              </tr>
              <tr>
                <td>502</td>
                <td><code>embed_failed</code></td>
                <td>The embeddings provider (Gemini) failed or is unconfigured.</td>
              </tr>
              <tr>
                <td>500</td>
                <td><code>internal</code></td>
                <td>Unhandled server error; details are logged server-side only.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 4. Audio format ───────────────────────────────── */}
      <section className="docs-section" id="audio-format">
        <h2>Audio format</h2>
        <p>
          The chunk endpoint takes audio as a <strong>raw binary request body &mdash; not a multipart form
          upload</strong>. Send the bytes directly (e.g. <code>--data-binary</code> with curl) and set
          <code>content-type</code> to one of:
        </p>
        <ul className="audio-type-list">
          <li><code>audio/webm</code></li>
          <li><code>audio/wav</code></li>
          <li><code>audio/x-wav</code></li>
          <li><code>audio/mpeg</code></li>
          <li><code>audio/mp4</code></li>
          <li><code>audio/ogg</code></li>
        </ul>
        <p>Any other content-type returns <code>422 unsupported_audio_type</code>.</p>
      </section>

      {/* ── 5. Demo limits ─────────────────────────────────── */}
      <section className="docs-section">
        <h2>Demo limits</h2>
        <p>
          The live demo on this site (no API key required) sits in front of the same platform, guarded by
          fixed caps so the shared account stays usable for everyone:
        </p>
        <div className="table-scroll">
          <table className="limits-table">
            <thead>
              <tr>
                <th>Limit</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Sessions per IP per hour</td>
                <td>2</td>
              </tr>
              <tr>
                <td>Audio chunks per session</td>
                <td>20 (15s each &mdash; 5 minutes of audio)</td>
              </tr>
              <tr>
                <td>Chat questions per session</td>
                <td>5</td>
              </tr>
              <tr>
                <td>Audio chunks per day, across all visitors</td>
                <td>400</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="docs-note">
          These caps apply only to the hosted demo&apos;s rate limiter, not to the underlying platform API
          documented above &mdash; a request made directly with your own key never hits them.
        </p>
      </section>
    </main>
  );
}
