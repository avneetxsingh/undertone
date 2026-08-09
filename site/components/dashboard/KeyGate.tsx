"use client";

import { useState, type FormEvent } from "react";

export const KEY_STORAGE = "undertone_dashboard_key";

/** Matches the platform's key format exactly, so a typo never leaves the browser. */
export const KEY_PATTERN = /^ut_live_[0-9a-f]{48}$/;

interface Props {
  onKey: (key: string) => void;
  onSample: () => void;
  rejected?: boolean;
}

export default function KeyGate({ onKey, onSample, rejected }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!KEY_PATTERN.test(trimmed)) {
      setError("That does not look like a key. They start with ut_live_ and are 56 characters.");
      return;
    }
    setError("");
    onKey(trimmed);
  }

  const notice = error || (rejected ? "That key was rejected. Check it and try again." : "");

  return (
    <section className="key-gate">
      <h2>Your data, or a tour</h2>
      <p>
        Paste an Undertone API key to see your own sessions, webhooks and events. The key goes
        straight to the platform and never touches this site&apos;s server &mdash; it stays in this
        tab and is gone when you close it.
      </p>

      <form onSubmit={submit}>
        <label htmlFor="api-key">API key</label>
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="ut_live_…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit">View my data</button>
      </form>

      {notice ? (
        <p className="key-gate-error" role="alert">
          {notice}
        </p>
      ) : null}

      <p className="key-gate-alt">
        No key?{" "}
        <button type="button" className="link-button" onClick={onSample}>
          Explore with sample data
        </button>
      </p>
    </section>
  );
}
