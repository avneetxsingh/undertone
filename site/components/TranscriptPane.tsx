"use client";

import { useEffect, useRef } from "react";
import type { TranscriptChunk } from "@/lib/types";

interface Props {
  chunks: TranscriptChunk[];
  isRecording: boolean;
  recordingTime: number;
  onToggleRecording: () => void;
  error: string | null;
}

export default function TranscriptPane({ chunks, isRecording, recordingTime, onToggleRecording, error }: Props) {
  const mins = Math.floor(recordingTime / 60);
  const secs = String(recordingTime % 60).padStart(2, "0");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chunks]);

  return (
    <div className="pane">
      <div className="pane-header">
        <h2 className="pane-title">1. Mic &amp; Transcript</h2>
        <span className="pane-badge">
          {isRecording ? (
            <span className="recording-timer">{mins}:{secs}</span>
          ) : (
            "Idle"
          )}
        </span>
      </div>

      <div className="pane-body">
        <div className="mic-circle-row">
          <button
            onClick={onToggleRecording}
            className={`mic-circle ${isRecording ? "active" : ""}`}
            title={isRecording ? "Stop recording" : "Start recording"}
          >
            <span className="mic-circle-dot" />
          </button>
          <span className="mic-circle-label">
            {isRecording
              ? "Recording… click to stop."
              : "Click the mic to start. Transcript appends every 15s."}
          </span>
        </div>

        {error && (
          <p className="recording-error">{error}</p>
        )}

        {chunks.length === 0 ? (
          <>
            <div className="desc-card">
              The transcript scrolls and appends new chunks every 15 seconds while recording.
              Use the mic button to start/stop.
            </div>
            <p className="empty-state">No transcript yet — start the mic.</p>
          </>
        ) : (
          chunks.map((chunk) => (
            <div key={chunk.id} className="transcript-chunk">
              <span className="chunk-timestamp">{chunk.timestamp}</span>
              <p className="chunk-text">{chunk.text}</p>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
