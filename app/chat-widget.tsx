"use client";

import { useState, useRef, useEffect } from "react";

const C = {
  bg: "#0c0f14",
  card: "#141820",
  border: "#1e2430",
  text: "#e8eaed",
  muted: "#7a8194",
  blue: "#4fc3f7",
  red: "#ef5350",
};

interface Message { role: "user" | "assistant"; content: string }

export default function ChatWidget({ financialData }: { financialData: unknown }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const send = async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    setError(null);
    setMessages(prev => [...prev, { role: "user", content: q }]);
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, financialData }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMessages(prev => [...prev, { role: "assistant", content: data.answer }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={open ? "Close chat" : "Open chat"}
        style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 1000,
          width: 56, height: 56, borderRadius: "50%",
          background: C.blue, color: C.bg,
          border: "none", cursor: "pointer",
          fontSize: 22, fontWeight: 700,
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {open ? "×" : "?"}
      </button>

      {open && (
        <div
          style={{
            position: "fixed", bottom: 92, right: 24, zIndex: 1000,
            width: "min(380px, calc(100vw - 32px))",
            height: 480,
            background: C.card,
            border: `1px solid ${C.border}`,
            borderTop: `1px solid ${C.blue}`,
            borderRadius: 12,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            display: "flex", flexDirection: "column",
            color: C.text,
            fontFamily: "system-ui, -apple-system, sans-serif",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: C.blue, fontWeight: 600 }}>Assistant</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>Ask about the data</div>
          </div>

          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
            {messages.length === 0 && !loading && (
              <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.5, textAlign: "center", marginTop: 32, padding: "0 12px" }}>
                Ask about NTM spend, plan variance, headcount, run-rate, anything in the dashboard.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div style={{ color: m.role === "user" ? C.blue : C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4, fontWeight: 600 }}>
                  {m.role === "user" ? "You" : "Assistant"}
                </div>
                <div style={{
                  background: m.role === "user" ? "rgba(79,195,247,0.10)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: "8px 12px",
                  fontSize: 13,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                }}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && <div style={{ color: C.muted, fontSize: 12, fontStyle: "italic" }}>Thinking…</div>}
            {error && <div style={{ color: C.red, fontSize: 12, marginTop: 6 }}>{error}</div>}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); send(); }}
            style={{ display: "flex", gap: 8, padding: "12px 16px", borderTop: `1px solid ${C.border}` }}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={loading}
              placeholder="Ask a question…"
              style={{
                flex: 1,
                background: "#1a1f2e",
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: "8px 12px",
                color: C.text,
                fontSize: 13,
                outline: "none",
              }}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              style={{
                background: C.blue,
                color: C.bg,
                border: "none",
                borderRadius: 8,
                padding: "8px 14px",
                cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                fontSize: 13,
                fontWeight: 600,
                opacity: loading || !input.trim() ? 0.5 : 1,
              }}
            >
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
