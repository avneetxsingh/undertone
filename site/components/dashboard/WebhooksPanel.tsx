"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  WEBHOOK_EVENT_NAMES,
  type DashboardSource,
  type Webhook,
  type WebhookEventName,
} from "@/lib/dashboard/source";
import { errorCopy } from "./SessionsPanel";

export default function WebhooksPanel({ source }: { source: DashboardSource }) {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEventName[]>([]);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const load = useCallback(() => {
    setHooks(null);
    source
      .listWebhooks()
      .then(setHooks)
      .catch((e) => setError(errorCopy(e)));
  }, [source]);

  useEffect(load, [load]);

  function toggle(name: WebhookEventName) {
    setEvents((prev) => (prev.includes(name) ? prev.filter((e) => e !== name) : [...prev, name]));
  }

  async function register(e: FormEvent) {
    e.preventDefault();
    setError("");
    // Mirrors the platform's own validation so an obvious mistake costs no round trip.
    if (!url.startsWith("https://")) {
      setError("The endpoint must use https.");
      return;
    }
    if (events.length === 0) {
      setError("Choose at least one event.");
      return;
    }
    try {
      const { secret } = await source.createWebhook(url, events);
      setNewSecret(secret);
      setUrl("");
      setEvents([]);
      load();
    } catch (err) {
      setError(errorCopy(err));
    }
  }

  async function remove(id: string) {
    try {
      await source.deleteWebhook(id);
      load();
    } catch (e) {
      setError(errorCopy(e));
    }
  }

  return (
    <div className="panel-stack">
      {newSecret ? (
        <div className="secret-reveal">
          <h4>Copy this signing secret now</h4>
          <p>
            It is shown once and cannot be retrieved again. Rotating is the only way to replace it.
          </p>
          <code data-testid="new-secret">{newSecret}</code>
          <button type="button" onClick={() => setNewSecret(null)}>
            Done
          </button>
        </div>
      ) : null}

      <form className="webhook-form" onSubmit={register}>
        <label htmlFor="hook-url">Endpoint URL</label>
        <input
          id="hook-url"
          type="text"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />

        <fieldset>
          <legend>Events</legend>
          {WEBHOOK_EVENT_NAMES.map((name) => (
            <label key={name} htmlFor={`evt-${name}`}>
              <input
                id={`evt-${name}`}
                type="checkbox"
                checked={events.includes(name)}
                onChange={() => toggle(name)}
              />
              {name}
            </label>
          ))}
        </fieldset>

        <button type="submit">Register</button>
      </form>

      {error ? (
        <p className="panel-error" role="alert">
          {error}
        </p>
      ) : null}

      {!hooks ? (
        <p className="panel-loading">Loading webhooks&hellip;</p>
      ) : hooks.length === 0 ? (
        <p className="panel-empty">No webhooks registered.</p>
      ) : (
        <ul className="webhook-list">
          {hooks.map((w) => (
            <li key={w.whookId}>
              <div className="webhook-url">{w.url}</div>
              <div className="webhook-meta">
                <span className={`webhook-status ${w.status}`}>{w.status}</span>
                {w.events.join(", ")}
              </div>
              <div className="webhook-delivery">
                {w.lastStatus
                  ? `last delivery: ${w.lastStatus}${w.lastError ? ` (${w.lastError})` : ""}`
                  : "no deliveries yet"}
              </div>
              <button type="button" onClick={() => remove(w.whookId)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
