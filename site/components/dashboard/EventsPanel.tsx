"use client";

import { useEffect, useState } from "react";
import type { DashboardSource, StoredEvent } from "@/lib/dashboard/source";
import { errorCopy } from "./SessionsPanel";

export default function EventsPanel({ source }: { source: DashboardSource }) {
  const [events, setEvents] = useState<StoredEvent[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    let live = true;
    setEvents(null);
    setNote("");
    source
      .listEvents()
      .then((e) => {
        if (live) setEvents(e);
      })
      .catch((e) => {
        if (live) setError(errorCopy(e));
      });
    return () => {
      live = false;
    };
  }, [source]);

  async function replay(id: string) {
    setError("");
    try {
      const { replayed } = await source.replayEvent(id);
      setNote(
        replayed === 0
          ? "No active subscription wants that event."
          : `Re-sent to ${replayed} subscription${replayed === 1 ? "" : "s"}.`,
      );
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
  if (!events) return <p className="panel-loading">Loading events&hellip;</p>;

  return (
    <div className="panel-stack">
      <p className="panel-note">Events are kept for 7 days and can be re-sent at any point.</p>
      {note ? (
        <p className="panel-status" role="status">
          {note}
        </p>
      ) : null}

      {events.length === 0 ? (
        <p className="panel-empty">No events yet.</p>
      ) : (
        <ul className="event-list">
          {events.map((e) => (
            <li key={e.evtId}>
              <span className="event-name">{e.event}</span>
              <span className="event-time">{new Date(e.createdAt).toLocaleString()}</span>
              <button type="button" onClick={() => replay(e.evtId)}>
                Replay
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
