"use client";

import { useEffect, useState } from "react";
import {
  DashboardError,
  type DashboardSource,
  type SessionDetail,
  type SessionSummary,
} from "@/lib/dashboard/source";

/** One place that turns a platform error code into something a human reads. */
export function errorCopy(e: unknown): string {
  if (e instanceof DashboardError) {
    if (e.status === 401) return "That key was rejected.";
    if (e.code === "rate_limited") return "Too many requests for this account. Try again shortly.";
    if (e.code === "capacity") return "The platform is at capacity. Try again shortly.";
    if (e.code === "network") return "Could not reach the platform. Check your connection.";
    return e.message;
  }
  return "Something went wrong.";
}

export default function SessionsPanel({ source }: { source: DashboardSource }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [open, setOpen] = useState<SessionDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setSessions(null);
    setOpen(null);
    setError("");
    source
      .listSessions()
      .then((s) => {
        if (live) setSessions(s);
      })
      .catch((e) => {
        if (live) setError(errorCopy(e));
      });
    return () => {
      live = false;
    };
  }, [source]);

  async function openSession(id: string) {
    try {
      setOpen(await source.getSession(id));
    } catch (e) {
      setError(errorCopy(e));
    }
  }

  if (error)
    return (
      <p className="panel-error" role="alert">
        {error}
      </p>
    );
  if (!sessions) return <p className="panel-loading">Loading sessions&hellip;</p>;
  if (sessions.length === 0) return <p className="panel-empty">No sessions yet.</p>;

  return (
    <div className="panel-split">
      <ul className="session-list">
        {sessions.map((s) => (
          <li key={s.sessId}>
            <button type="button" onClick={() => openSession(s.sessId)}>
              <span className="session-title">{s.title}</span>
              <span className="session-meta">
                {s.kind} &middot; {s.chunkCount} chunk{s.chunkCount === 1 ? "" : "s"} &middot;{" "}
                {s.status}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="session-detail">
        {!open ? (
          <p className="panel-empty">Select a session.</p>
        ) : (
          <>
            <h3>{open.title}</h3>
            {open.summary ? (
              <div className="session-summary">
                <h4>Summary</h4>
                <p>{open.summary}</p>
                {open.actionItems?.length ? (
                  <ul className="action-items">
                    {open.actionItems.map((a, i) => (
                      <li key={i}>{a.task}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {open.chunks.map((c) => (
              <article key={c.seq} className="chunk">
                <p className="chunk-transcript">{c.transcript}</p>
                <ul className="chunk-suggestions">
                  {c.suggestions.map((sg, i) => (
                    <li key={i}>
                      <span className="suggestion-type">{sg.type}</span>
                      <span className="suggestion-preview">{sg.preview}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
