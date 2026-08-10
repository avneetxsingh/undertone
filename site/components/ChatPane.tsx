"use client";

import { useState, useEffect, useRef } from "react";
import type { ChatMessage } from "@/lib/types";

interface Props {
  messages: ChatMessage[];
  isLoading: boolean;
  onSend: (text: string) => void;
}

export default function ChatPane({ messages, isLoading, onSend }: Props) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  function handleSend() {
    const text = input.trim();
    if (!text || isLoading) return;
    onSend(text);
    setInput("");
  }

  return (
    <div className="pane">
      <div className="pane-header">
        <h2 className="pane-title">3. Chat (Detailed Answers)</h2>
        <span className="pane-badge">Session-only</span>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <>
            <div className="desc-card">
              Clicking a suggestion adds it to this chat and streams a detailed answer
              (separate prompt, more context). You can also type questions directly.
              One continuous chat per session — no login, no persistence.
            </div>
            <p className="empty-state">Click a suggestion or type a question below.</p>
          </>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="bubble">{msg.content}</div>
          </div>
        ))}
        {isLoading && (
          <div className="message assistant">
            <div className="bubble muted">Thinking…</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-row">
        <input
          className="chat-input"
          type="text"
          placeholder="Ask anything…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), handleSend())}
        />
        <button className="send-btn" onClick={handleSend} disabled={!input.trim() || isLoading}>
          Send
        </button>
      </div>
    </div>
  );
}
