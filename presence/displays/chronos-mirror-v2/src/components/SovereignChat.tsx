"use client";

import { useState, useRef, useEffect, useCallback, PointerEvent as ReactPointerEvent } from "react";
import { Send, Loader2, MessageSquare, Mic, MicOff, GripHorizontal } from "lucide-react";
import { chronosSpeechLocale, resolveChronosLocale, uxText } from "../lib/ux-vocabulary";

const AGENT_URL = "/api/agent";

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: string;
  status?: "pending" | "complete" | "error";
}

export function SovereignChat({
  onA2UIMessage,
  onReady,
}: {
  onA2UIMessage?: (message: any) => void;
  onReady?: (sendFn: (query: string) => void) => void;
}) {
  const locale = resolveChronosLocale();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 }); // offset from default bottom-right
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // --- Drag to move ---
  const onDragStart = useCallback((e: ReactPointerEvent) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [pos]);

  const onDragMove = useCallback((e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPos({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
  }, []);

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const sendQuery = useCallback(async (query: string) => {
    if (!query || !query.trim() || isLoading) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: query,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);
    setIsOpen(true);

    try {
      const res = await fetch(AGENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, locale }),
      });
      const data = await res.json();

      const agentMsg: ChatMessage = {
        id: `agent-${Date.now()}`,
        role: "agent",
        content: data.response || data.error || uxText("chronos_chat_no_response", "No response", locale),
        timestamp: data.timestamp || new Date().toISOString(),
        status: res.ok ? "complete" : "error",
      };
      setMessages((prev) => [...prev, agentMsg]);

      if (data.a2ui && Array.isArray(data.a2ui) && onA2UIMessage) {
        for (const msg of data.a2ui) {
          onA2UIMessage(msg);
        }
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "agent",
          content: `${uxText("chronos_chat_connection_error", "Connection error", locale)}: ${err.message}`,
          timestamp: new Date().toISOString(),
          status: "error",
        },
      ]);
    }

    setIsLoading(false);
  }, [isLoading, onA2UIMessage]);

  // Expose sendQuery to parent via onReady
  useEffect(() => {
    if (onReady) onReady(sendQuery);
  }, [onReady, sendQuery]);

  const sendMessage = () => sendQuery(input);

  // --- Voice Input (Web Speech API) ---
  const toggleVoice = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = chronosSpeechLocale(locale);
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((r: any) => r[0].transcript)
        .join("");
      setInput(transcript);

      // Auto-send on final result
      if (event.results[event.results.length - 1].isFinal) {
        setIsListening(false);
        if (transcript.trim()) {
          // Small delay so user can see the transcription
          setTimeout(() => sendQuery(transcript), 300);
        }
      }
    };

    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isListening, sendQuery]);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 w-14 h-14 bg-kyberion-gold/20 border border-kyberion-gold/30 rounded-full flex items-center justify-center hover:bg-kyberion-gold/30 transition z-50"
      >
        <MessageSquare className="text-kyberion-gold w-6 h-6" />
      </button>
    );
  }

  return (
    <div
      className="fixed w-[420px] h-[520px] kyberion-glass rounded-2xl border border-kyberion-gold/20 flex flex-col overflow-hidden z-50"
      style={{ bottom: `${24 - pos.y}px`, right: `${24 - pos.x}px` }}
    >
      {/* Header — drag handle */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-white/5 cursor-grab active:cursor-grabbing select-none"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
      >
        <div className="flex items-center gap-2">
          <GripHorizontal size={12} className="opacity-30" />
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-[11px] uppercase tracking-[0.2em] font-bold opacity-60">
            Sovereign Link
          </span>
        </div>
        <button
          onClick={() => setIsOpen(false)}
          className="text-[10px] opacity-40 hover:opacity-80 transition"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {uxText("chronos_chat_minimize", "MINIMIZE", locale)}
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-[11px] opacity-30 italic pt-8">
            {uxText("chronos_chat_welcome", "Welcome, Sovereign. The mirror is ready for your command.", locale)}
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] px-3 py-2 rounded-xl text-[11px] leading-relaxed ${
                msg.role === "user"
                  ? "bg-kyberion-gold/20 border border-kyberion-gold/20"
                  : msg.status === "error"
                  ? "bg-red-900/20 border border-red-500/20"
                  : "bg-white/5 border border-white/5"
              }`}
            >
              <div className="whitespace-pre-wrap">{msg.content}</div>
              <div className="text-[8px] opacity-30 mt-1 text-right">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="px-3 py-2 bg-white/5 border border-white/5 rounded-xl">
              <Loader2 className="w-4 h-4 animate-spin opacity-40" />
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-3 border-t border-white/5">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder={isListening
              ? uxText("chronos_chat_listening", "Listening...", locale)
              : uxText("chronos_chat_placeholder", "Command the mirror...", locale)}
            className={`flex-1 bg-white/5 border rounded-lg px-3 py-2 text-[11px] outline-none transition ${
              isListening ? "border-red-500/50 bg-red-900/10" : "border-white/10 focus:border-kyberion-gold/30"
            }`}
            disabled={isLoading}
          />
          <button
            onClick={toggleVoice}
            className={`p-2 rounded-lg border transition ${
              isListening
                ? "bg-red-900/30 border-red-500/30 text-red-400"
                : "bg-white/5 border-white/10 text-white/40 hover:text-white/70 hover:border-white/20"
            }`}
          >
            {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>
          <button
            onClick={sendMessage}
            disabled={isLoading || !input.trim()}
            className="p-2 bg-kyberion-gold/20 border border-kyberion-gold/20 rounded-lg hover:bg-kyberion-gold/30 transition disabled:opacity-20"
          >
            <Send className="w-4 h-4 text-kyberion-gold" />
          </button>
        </div>
      </div>
    </div>
  );
}
