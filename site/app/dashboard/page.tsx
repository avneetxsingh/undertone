"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import KeyGate, { KEY_STORAGE } from "@/components/dashboard/KeyGate";
import SessionsPanel from "@/components/dashboard/SessionsPanel";
import WebhooksPanel from "@/components/dashboard/WebhooksPanel";
import EventsPanel from "@/components/dashboard/EventsPanel";
import { createLiveSource } from "@/lib/dashboard/liveSource";
import { createSampleSource } from "@/lib/dashboard/sampleSource";
import { DashboardError } from "@/lib/dashboard/source";
import "../dashboard.css";

type Tab = "sessions" | "webhooks" | "events";
const TABS: Tab[] = ["sessions", "webhooks", "events"];

export default function DashboardPage() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [sample, setSample] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [tab, setTab] = useState<Tab>("sessions");

  // sessionStorage, not localStorage: a platform credential should not outlive
  // the tab it was pasted into.
  useEffect(() => {
    const stored = sessionStorage.getItem(KEY_STORAGE);
    if (stored) setApiKey(stored);
  }, []);

  const source = useMemo(() => {
    if (apiKey) return createLiveSource(apiKey);
    if (sample) return createSampleSource();
    return null;
  }, [apiKey, sample]);

  // A rejected key must not survive the rejection.
  useEffect(() => {
    if (!source || source.isSample) return;
    let live = true;
    source.listSessions().catch((e) => {
      if (!live) return;
      if (e instanceof DashboardError && e.status === 401) {
        sessionStorage.removeItem(KEY_STORAGE);
        setApiKey(null);
        setRejected(true);
      }
    });
    return () => {
      live = false;
    };
  }, [source]);

  function acceptKey(key: string) {
    sessionStorage.setItem(KEY_STORAGE, key);
    setRejected(false);
    setApiKey(key);
  }

  function signOut() {
    sessionStorage.removeItem(KEY_STORAGE);
    setApiKey(null);
    setSample(true);
  }

  return (
    <main className="dashboard">
      <header className="site-header">
        <Link href="/" className="wordmark">
          Undertone
        </Link>
        <nav>
          <Link href="/docs">Docs</Link>
          <Link href="/architecture">Architecture</Link>
        </nav>
      </header>

      <h1>Dashboard</h1>

      {!source ? (
        <KeyGate onKey={acceptKey} onSample={() => setSample(true)} rejected={rejected} />
      ) : (
        <>
          {source.isSample ? (
            <p className="sample-banner">
              Sample data &mdash; paste an API key to see your own.{" "}
              <button type="button" className="link-button" onClick={() => setSample(false)}>
                Add a key
              </button>
            </p>
          ) : (
            <p className="live-banner">
              Live data.{" "}
              <button type="button" className="link-button" onClick={signOut}>
                Sign out
              </button>
            </p>
          )}

          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? "active" : ""}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === "sessions" ? <SessionsPanel source={source} /> : null}
          {tab === "webhooks" ? <WebhooksPanel source={source} /> : null}
          {tab === "events" ? <EventsPanel source={source} /> : null}
        </>
      )}
    </main>
  );
}
