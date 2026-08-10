"use client";

import { useState } from "react";
import type { Suggestion, SuggestionBatch } from "@/lib/types";

const TYPE_LABEL: Record<Suggestion["type"], string> = {
  FACT_CHECK: "Fact Check",
  TALKING_POINT: "Talking Point",
  ANSWER: "Answer",
  QUESTION: "Question",
  CLARIFICATION: "Clarification",
  ACTION_ITEM: "Action Item",
};

interface Props {
  batches: SuggestionBatch[];
  onSuggestionClick: (suggestion: Suggestion) => void;
}

export default function SuggestionsPane({ batches, onSuggestionClick }: Props) {
  const [clicked, setClicked] = useState<Set<string>>(new Set());

  function handleClick(s: Suggestion, key: string) {
    if (clicked.has(key)) return; // prevent duplicate chat entries
    setClicked((prev) => new Set(prev).add(key));
    onSuggestionClick(s);
  }

  return (
    <div className="pane">
      <div className="pane-header">
        <h2 className="pane-title">2. Live Suggestions</h2>
        <span className="pane-badge">{batches.length} Batches</span>
      </div>

      <div className="pane-body">
        {batches.length === 0 ? (
          <>
            <div className="desc-card">
              Three suggestions are generated from each 15-second segment — a question to ask, a
              talking point, an answer, or a fact-check. The preview alone should already be
              useful.
            </div>
            <p className="empty-state">Suggestions appear here once recording starts.</p>
          </>
        ) : (
          batches.map((batch, i) => (
            <div key={batch.id} className="batch">
              <p className="batch-label">{i === 0 ? `Latest · ${batch.timestamp}` : batch.timestamp}</p>
              {batch.suggestions.map((s, j) => {
                const key = `${batch.id}-${j}`;
                const isClicked = clicked.has(key);
                return (
                  <button
                    key={j}
                    className={`suggestion-card ${isClicked ? "clicked" : ""}`}
                    onClick={() => handleClick(s, key)}
                    title={isClicked ? "Already sent to chat" : undefined}
                  >
                    <span className="suggestion-type">
                      {TYPE_LABEL[s.type]}
                      {isClicked && <span className="suggestion-check"> ✓</span>}
                    </span>
                    <p className="suggestion-preview">{s.preview}</p>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
