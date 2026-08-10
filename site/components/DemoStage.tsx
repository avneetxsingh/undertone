"use client";

import ChatPane from "@/components/ChatPane";
import SuggestionsPane from "@/components/SuggestionsPane";
import TranscriptPane from "@/components/TranscriptPane";
import { useDemoSession, type DemoStatus } from "@/hooks/useDemoSession";

const STATUS_COPY: Record<DemoStatus, string> = {
  idle: "Click the mic to start.",
  recording: "Recording — 15-second segments.",
  uploading: "Uploading segment…",
  processing: "Transcribing and routing suggestions…",
  complete: "Demo session complete.",
  replay: "Playing a recorded session.",
};

export default function DemoStage() {
  const demo = useDemoSession();
  const isLive =
    demo.status === "recording" || demo.status === "uploading" || demo.status === "processing";

  return (
    <div className="demo-stage">
      {demo.status === "replay" && (
        <p className="replay-banner">Recorded sample — not a live recording.</p>
      )}
      <p className="demo-status">
        {STATUS_COPY[demo.status]}
        {demo.status === "processing" && demo.processingFor > 0 && ` (${demo.processingFor}s)`}
      </p>
      <div className="columns">
        <TranscriptPane
          chunks={demo.chunks}
          isRecording={isLive}
          recordingTime={demo.elapsed}
          onToggleRecording={() => (isLive ? void demo.stop() : void demo.start())}
          error={demo.error}
        />
        <SuggestionsPane
          batches={demo.batches}
          onSuggestionClick={(s) => void demo.ask(s.detail_prompt)}
        />
        <ChatPane messages={demo.messages} isLoading={demo.isChatLoading} onSend={(t) => void demo.ask(t)} />
      </div>
    </div>
  );
}
