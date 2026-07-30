"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { REPLAY_SESSION } from "@/lib/replay";
import type { ChatMessage, Suggestion, SuggestionBatch, TranscriptChunk } from "@/lib/types";

const SEGMENT_MS = 15000;

export type DemoStatus = "idle" | "recording" | "uploading" | "processing" | "complete" | "replay";

const stamp = (startedAt: number) => {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  return `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
};

export function useDemoSession() {
  const [status, setStatus] = useState<DemoStatus>("idle");
  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const [batches, setBatches] = useState<SuggestionBatch[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [processingFor, setProcessingFor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isChatLoading, setIsChatLoading] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const runningRef = useRef(false);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const replayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const appendResult = useCallback((transcript: string, suggestions: Suggestion[]) => {
    const timestamp = stamp(startedAtRef.current);
    if (transcript.trim())
      setChunks((prev) => [...prev, { id: crypto.randomUUID(), timestamp, text: transcript.trim() }]);
    if (suggestions.length)
      setBatches((prev) => [{ id: crypto.randomUUID(), timestamp, suggestions }, ...prev]);
  }, []);

  const stopHardware = useCallback(() => {
    runningRef.current = false;
    if (tickRef.current) clearInterval(tickRef.current);

    // Cancel any pending replay continuation. Without this, a second failure
    // path calling startReplay() (or an explicit stop()) would leave the
    // previous chain's setTimeout alive, appending chunks/batches on top of
    // whatever runs next.
    if (replayTimeoutRef.current) {
      clearTimeout(replayTimeoutRef.current);
      replayTimeoutRef.current = null;
    }

    // Detach the handlers before stopping. The final stop still emits one
    // dataavailable, and letting it through would upload a trailing segment
    // against a session we are already ending — which answers 409 and calls
    // back into here, stopping the recorder again, forever.
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state === "recording") recorder.stop(); // stop() on an inactive recorder throws
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Always-current ref to stopHardware, so the unmount effect below can call
  // through it without listing stopHardware as a dependency. stopHardware's
  // own deps are `[]` so its identity never actually changes today, but a
  // cleanup keyed to a useCallback's identity is one future edit away from
  // tearing down a live recording mid-session — reading through a ref makes
  // that impossible regardless of how stopHardware evolves.
  const stopHardwareRef = useRef(stopHardware);
  stopHardwareRef.current = stopHardware;

  // Unmount-only cleanup: an empty dependency array guarantees this effect's
  // cleanup runs exactly once, on unmount, and never in response to a
  // start/stop cycle. Without it, a visitor navigating away mid-recording
  // leaves the microphone live and the elapsed-timer interval ticking forever
  // in a hook nobody is listening to anymore.
  useEffect(() => {
    return () => stopHardwareRef.current();
  }, []);

  /** Plays the captured session. Never throws; this is the last line of defence. */
  const startReplay = useCallback(
    (message: string | null) => {
      // stopHardware() also cancels any replay chain already in flight, so a
      // second failure path calling startReplay() supersedes the first
      // instead of racing it.
      stopHardware();
      // Drop the live session id. ask() branches on this ref alone, so leaving
      // a previous session's id here would answer a question about the canned
      // fixture out of the visitor's earlier real meeting — a different
      // transcript than the one on screen — and spend live chat calls that
      // degrading to replay exists to avoid.
      sessionIdRef.current = null;
      setError(message);
      setStatus("replay");
      startedAtRef.current = Date.now();
      let i = 0;
      const step = () => {
        if (i >= REPLAY_SESSION.length) {
          replayTimeoutRef.current = null;
          return;
        }
        const chunk = REPLAY_SESSION[i++];
        appendResult(chunk.transcript, chunk.suggestions);
        replayTimeoutRef.current = i < REPLAY_SESSION.length ? setTimeout(step, SEGMENT_MS) : null;
      };
      // Schedule even the first step (rather than calling it inline) so it
      // lives behind replayTimeoutRef too: if another startReplay() call
      // lands before this fires, its stopHardware() cancels this one
      // outright instead of both loops appending the opening chunk.
      replayTimeoutRef.current = setTimeout(step, 0);
    },
    [appendResult, stopHardware],
  );

  const sendSegment = useCallback(
    async (blob: Blob, contentType: string) => {
      const sessId = sessionIdRef.current;
      if (!sessId) return;
      setStatus("uploading");
      const startedProcessing = Date.now();
      const processTick = setInterval(
        () => setProcessingFor(Math.floor((Date.now() - startedProcessing) / 1000)),
        1000,
      );
      try {
        setStatus("processing");
        const res = await fetch(`/api/demo/chunk?sessionId=${sessId}`, {
          method: "POST",
          headers: { "content-type": contentType },
          body: blob,
        });
        // The session can end while this request is inside Whisper. stop()
        // detaches the recorder and POSTs /end in ~200ms, so the chunk lands
        // on an ended session and the platform answers 404 session_not_found
        // — which would otherwise fall through to startReplay() below and
        // flip a session the visitor just finished into a capacity apology
        // with canned chunks appended under their real transcript.
        if (!runningRef.current) return;
        const data = await res.json();
        if (!res.ok) {
          if (data?.error?.code === "demo_session_complete") {
            stopHardware();
            await fetch(`/api/demo/end?sessionId=${sessId}`, { method: "POST" }).catch(() => {});
            setStatus("complete");
            return;
          }
          startReplay("The live demo is at capacity — showing a recorded session instead.");
          return;
        }
        appendResult(data.transcript ?? "", data.suggestions ?? []);
        if (runningRef.current) setStatus("recording");
      } catch {
        // Same guard on the rejection path: a fetch aborted by unmount or by
        // stop() must not start a 45-second replay chain in a hook nobody is
        // rendering anymore.
        if (!runningRef.current) return;
        startReplay("Lost the connection — showing a recorded session instead.");
      } finally {
        clearInterval(processTick);
        setProcessingFor(0);
      }
    },
    [appendResult, startReplay, stopHardware],
  );

  const start = useCallback(async () => {
    // Re-entry guard. Everything below awaits before it touches any state, so
    // two clicks inside the getUserMedia window would each create a session
    // and burn both of the visitor's hourly slots before a word is recorded.
    if (runningRef.current) return;
    // Cancel a replay chain left over from an earlier failure. Without this a
    // visitor who was denied the mic, granted it, and clicked again would get
    // the fixture still appending every 15s underneath their real audio —
    // with the "recorded sample" banner gone, because that only renders while
    // status === "replay".
    stopHardware();
    // Claim liveness synchronously, after stopHardware() (which clears the
    // same flag). Every failure path below routes through startReplay(),
    // which calls stopHardware() and releases it, so a failed attempt cannot
    // lock the visitor out of starting.
    runningRef.current = true;
    setError(null);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access denied — showing a recorded session instead."
          : err instanceof DOMException && err.name === "NotFoundError"
            ? "No microphone found — showing a recorded session instead."
            : "Could not access the microphone — showing a recorded session instead.";
      startReplay(msg);
      return;
    }
    streamRef.current = stream;

    let created: Response;
    try {
      created = await fetch("/api/demo/session", { method: "POST" });
    } catch {
      startReplay("Could not reach the demo — showing a recorded session instead.");
      return;
    }
    const createdBody = await created.json().catch(() => ({}));
    if (!created.ok) {
      startReplay(
        createdBody?.error?.code === "demo_rate_limited"
          ? "You have used your demo sessions for this hour — showing a recorded session instead."
          : "The live demo is at capacity — showing a recorded session instead.",
      );
      return;
    }
    sessionIdRef.current = createdBody.id;

    // A session is really beginning: clear the previous one. Timestamps are
    // relative to startedAtRef, so keeping the old panes would restack a
    // second session beneath the first with its clock restarting at 0:00.
    setChunks([]);
    setBatches([]);
    setMessages([]);
    setElapsed(0);

    startedAtRef.current = Date.now();
    tickRef.current = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)),
      1000,
    );

    const runSegment = () => {
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        startReplay("This browser cannot record audio — showing a recorded session instead.");
        return;
      }
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size) void sendSegment(e.data, recorder.mimeType || "audio/webm");
      };
      recorder.onstop = () => {
        if (runningRef.current) runSegment();
      };
      recorder.onerror = () =>
        startReplay("Recording stopped unexpectedly — showing a recorded session instead.");
      recorder.start();
      setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, SEGMENT_MS);
    };

    runSegment();
    // Guarded for the same reason as finding 1: if the MediaRecorder
    // constructor threw, runSegment() already degraded to replay and this
    // would paint "recording" over it, hiding the disclosure banner.
    if (runningRef.current) setStatus("recording");
  }, [sendSegment, startReplay, stopHardware]);

  const stop = useCallback(async () => {
    stopHardware();
    const sessId = sessionIdRef.current;
    setStatus("complete");
    if (sessId) await fetch(`/api/demo/end?sessionId=${sessId}`, { method: "POST" }).catch(() => {});
  }, [stopHardware]);

  const ask = useCallback(async (prompt: string) => {
    const sessId = sessionIdRef.current;
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content: prompt }]);
    if (!sessId) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: "Chat is available during a live session." },
      ]);
      return;
    }
    setIsChatLoading(true);
    try {
      const res = await fetch("/api/demo/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessId, prompt }),
      });
      const data = await res.json();
      const content = res.ok
        ? (data.reply ?? "")
        : data?.error?.code === "demo_session_complete"
          ? "You have reached this demo session's question limit."
          : "That request could not be completed right now.";
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "That request could not be completed right now.",
        },
      ]);
    } finally {
      setIsChatLoading(false);
    }
  }, []);

  return { status, chunks, batches, messages, elapsed, processingFor, error, isChatLoading, start, stop, ask };
}
