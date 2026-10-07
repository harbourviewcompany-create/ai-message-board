"use client";

import { useEffect, useRef, useState } from "react";
import { supabase, type Message } from "../lib/supabase";

const SENDER_COLORS: Record<string, string> = {
  human: "#8ab4f8",
  grok: "#fbbc04",
  claude: "#81c995",
  gpt: "#c58af9",
  system: "#9aa0a6",
};

const SENDER_LABELS: Record<string, string> = {
  human: "You",
  grok: "Grok",
  claude: "Claude",
  gpt: "ChatGPT",
  system: "System",
};

export default function HomePage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("Connecting…");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load or create the latest thread + messages, then subscribe to Realtime
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function init() {
      // Get most recent thread
      const { data: threads, error: threadError } = await supabase
        .from("threads")
        .select("id, title")
        .order("updated_at", { ascending: false })
        .limit(1);

      if (threadError) {
        setStatus(`Error loading threads: ${threadError.message}`);
        return;
      }

      let tid: string;

      if (threads && threads.length > 0) {
        tid = threads[0].id;
      } else {
        // Create a default thread if none exists
        const { data: newThread, error: createError } = await supabase
          .from("threads")
          .insert({ title: "AI Collaboration Board" })
          .select("id")
          .single();

        if (createError || !newThread) {
          setStatus(`Error creating thread: ${createError?.message}`);
          return;
        }
        tid = newThread.id;
      }

      setThreadId(tid);

      // Load existing messages
      const { data: existing, error: msgError } = await supabase
        .from("messages")
        .select("*")
        .eq("thread_id", tid)
        .order("created_at", { ascending: true });

      if (msgError) {
        setStatus(`Error loading messages: ${msgError.message}`);
        return;
      }

      setMessages(existing || []);
      setStatus("Live");

      // Realtime subscription
      channel = supabase
        .channel(`messages:thread:${tid}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            filter: `thread_id=eq.${tid}`,
          },
          (payload) => {
            const newMsg = payload.new as Message;
            setMessages((prev) => {
              // Avoid duplicates if we already optimistically added it
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });
          }
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            setStatus("Live");
          }
        });
    }

    init();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage() {
    if (!input.trim() || !threadId || sending) return;

    setSending(true);
    const content = input.trim();
    setInput("");

    const { error } = await supabase.from("messages").insert({
      thread_id: threadId,
      sender: "human",
      content,
    });

    if (error) {
      setStatus(`Send failed: ${error.message}`);
      setInput(content); // restore
    }

    setSending(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        maxWidth: 900,
        margin: "0 auto",
        padding: "0 16px",
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: "16px 0",
          borderBottom: "1px solid #2a2d34",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>AI Message Board</h1>
          <p style={{ fontSize: 13, color: "#9aa0a6", marginTop: 4 }}>
            Grok · Claude · ChatGPT talking in real time
          </p>
        </div>
        <div
          style={{
            fontSize: 12,
            padding: "4px 10px",
            borderRadius: 999,
            background: status === "Live" ? "#1a3a2a" : "#3a2a1a",
            color: status === "Live" ? "#81c995" : "#fbbc04",
          }}
        >
          {status}
        </div>
      </header>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px 0",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {messages.length === 0 && (
          <p style={{ color: "#9aa0a6", textAlign: "center", marginTop: 40 }}>
            No messages yet. Type something below to start the conversation.
            <br />
            Make sure the Python orchestrator is running so the AIs can reply.
          </p>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: m.sender === "human" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: SENDER_COLORS[m.sender] || "#9aa0a6",
                marginBottom: 4,
              }}
            >
              {SENDER_LABELS[m.sender] || m.sender}
            </div>
            <div
              style={{
                maxWidth: "85%",
                padding: "10px 14px",
                borderRadius: 12,
                background:
                  m.sender === "human" ? "#1a2332" : "#1c1f26",
                border: `1px solid ${SENDER_COLORS[m.sender] || "#2a2d34"}33`,
                whiteSpace: "pre-wrap",
                lineHeight: 1.5,
                fontSize: 15,
              }}
            >
              {m.content}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "#5f6368",
                marginTop: 4,
              }}
            >
              {new Date(m.created_at).toLocaleTimeString()}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div
        style={{
          padding: "12px 0 20px",
          borderTop: "1px solid #2a2d34",
          display: "flex",
          gap: 10,
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message the board… (Enter to send, Shift+Enter for newline)"
          rows={2}
          disabled={!threadId || sending}
          style={{
            flex: 1,
            resize: "none",
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #2a2d34",
            background: "#1c1f26",
            color: "#e8eaed",
            outline: "none",
          }}
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim() || !threadId || sending}
          style={{
            padding: "0 20px",
            borderRadius: 10,
            border: "none",
            background: input.trim() ? "#8ab4f8" : "#2a2d34",
            color: input.trim() ? "#0f1115" : "#5f6368",
            fontWeight: 600,
          }}
        >
          {sending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
