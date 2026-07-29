import Link from "next/link";
import DemoStage from "@/components/DemoStage";
import "./page.css";

export default function Home() {
  return (
    <main className="landing">
      <header className="site-header">
        <h1>Undertone</h1>
        <nav>
          <Link href="/docs">API docs</Link>
          <Link href="/architecture">Architecture</Link>
          <a href="https://github.com/avneetxsingh/undertone" target="_blank" rel="noreferrer">
            Source
          </a>
        </nav>
      </header>

      <section className="hero">
        <h2>Talk. Watch it think.</h2>
        <p>
          Undertone listens to a conversation as it happens and surfaces three suggestions for what
          to say next. No account, no API key — this demo runs on the live platform.
        </p>
        <DemoStage />
      </section>

      <section className="explainer">
        <h3>The suggestion engine is a router, not a prompt</h3>
        <p>
          A generic &quot;give me suggestions&quot; prompt returns generic suggestions. Undertone first
          detects where the conversation is — <strong>opening, middle, or closing</strong> — and what
          just happened in it — <strong>a claim, a question, confusion, or a decision</strong> — then
          routes to the suggestion type that fits.
        </p>
        <ul className="type-list">
          <li><strong>Fact check</strong> — a claim was made</li>
          <li><strong>Answer</strong> — a question went unanswered</li>
          <li><strong>Clarification</strong> — someone is confused</li>
          <li><strong>Talking point</strong> — a decision is forming</li>
          <li><strong>Question</strong> — at most one per batch, favoured while opening</li>
          <li><strong>Action item</strong> — only while closing, and always then</li>
        </ul>
        <p>
          Every preview carries the actual insight rather than a pointer to it. Reading the card
          without clicking it should already be worth something.
        </p>
      </section>

      <section className="platform-strip">
        <h3>Running on a real platform</h3>
        <p>
          Multi-tenant serverless API on AWS: API Gateway, Lambda, DynamoDB single-table, S3, SQS
          with a dead-letter queue, KMS-encrypted per-account keys, and S3 Vectors for cross-session
          memory. Transcription and generation run on Groq; embeddings on Gemini.
        </p>
        <Link className="cta" href="/architecture">How it is built →</Link>
      </section>
    </main>
  );
}
