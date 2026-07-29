"use client";

import { useCallback, useRef, useState } from "react";
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

  /** Plays the captured session. Never throws; this is the last line of defence. */
  const startReplay = useCallback(
    (message: string | null) => {
      stopHardware();
      setError(message);
      setStatus("replay");
      startedAtRef.current = Date.now();
      let i = 0;
      const step = () => {
        if (i >= REPLAY_SESSION.length) return;
        const chunk = REPLAY_SESSION[i++];
        appendResult(chunk.transcript, chunk.suggestions);
        if (i < REPLAY_SESSION.length) setTimeout(step, SEGMENT_MS);
      };
      step();
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
        startReplay("Lost the connection — showing a recorded session instead.");
      } finally {
        clearInterval(processTick);
        setProcessingFor(0);
      }
    },
    [appendResult, startReplay, stopHardware],
  );

  const start = useCallback(async () => {
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

    startedAtRef.current = Date.now();
    runningRef.current = true;
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
    setStatus("recording");
  }, [sendSegment, startReplay]);

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
