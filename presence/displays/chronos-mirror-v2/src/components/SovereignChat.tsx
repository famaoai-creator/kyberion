'use client';

import { useState, useRef, useEffect, useCallback, PointerEvent as ReactPointerEvent } from 'react';
import { Send, Loader2, MessageSquare, Mic, MicOff, GripHorizontal } from 'lucide-react';
import { chronosSpeechLocale, uxText } from '../lib/ux-vocabulary';
import { buildUserFacingError } from '../lib/user-facing-error';
import { useChronosLocale } from '../lib/hooks';

const AGENT_URL = '/api/agent';

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: string;
  status?: 'pending' | 'complete' | 'error';
}

const GUIDED_PROMPTS = [
  {
    label: 'Health',
    query: 'Summarize system health and current blockers.',
  },
  {
    label: 'Missions',
    query: 'List the active missions and what needs attention.',
  },
  {
    label: 'Traces',
    query: 'Show the latest trace issues and what failed.',
  },
  {
    label: 'Next step',
    query: 'What should I do next to unblock delivery?',
  },
];

export function SovereignChat({
  onA2UIMessage,
  onReady,
}: {
  onA2UIMessage?: (message: any) => void;
  onReady?: (sendFn: (query: string) => void) => void;
}) {
  const locale = useChronosLocale();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 }); // offset from default bottom-right
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null
  );

  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // --- Drag to move ---
  const onDragStart = useCallback(
    (e: ReactPointerEvent) => {
      dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos]
  );

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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const sendQuery = useCallback(
    async (query: string) => {
      if (!query || !query.trim() || isLoading) return;

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: query,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput('');
      setIsLoading(true);
      setIsOpen(true);

      try {
        const res = await fetch(AGENT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, locale }),
        });
        const data = await res.json();
        const envelope = buildUserFacingError(
          data.error || data.response || new Error('No response'),
          {
            locale,
            surface: 'chronos',
            traceId: data.traceId,
          }
        );

        const agentMsg: ChatMessage = {
          id: `agent-${Date.now()}`,
          role: 'agent',
          content: data.response || `${envelope.title}: ${envelope.body} ${envelope.nextAction}`,
          timestamp: data.timestamp || new Date().toISOString(),
          status: res.ok ? 'complete' : 'error',
        };
        setMessages((prev) => [...prev, agentMsg]);

        if (data.a2ui && Array.isArray(data.a2ui) && onA2UIMessage) {
          for (const msg of data.a2ui) {
            onA2UIMessage(msg);
          }
        }
      } catch (err: any) {
        const envelope = buildUserFacingError(err, { locale, surface: 'chronos' });
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: 'agent',
            content: `${envelope.title}: ${envelope.body} ${envelope.nextAction}`,
            timestamp: new Date().toISOString(),
            status: 'error',
          },
        ]);
      }

      setIsLoading(false);
    },
    [isLoading, onA2UIMessage]
  );

  // Expose sendQuery to parent via onReady
  useEffect(() => {
    if (onReady) onReady(sendQuery);
  }, [onReady, sendQuery]);

  const sendMessage = () => sendQuery(input);

  // --- Voice Input (Web Speech API) ---
  const toggleVoice = useCallback(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
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
        .join('');
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
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label={uxText('chronos_chat_open', 'Open Sovereign chat', locale)}
        className="fixed bottom-6 right-6 w-14 h-14 bg-kyberion-warning/20 border border-kyberion-warning/30 rounded-full flex items-center justify-center hover:bg-kyberion-warning/30 transition z-50"
      >
        <MessageSquare className="text-kyberion-warning w-6 h-6" />
      </button>
    );
  }

  return (
    <div
      className="fixed w-[420px] h-[520px] kyberion-glass rounded-2xl border border-kyberion-warning/20 flex flex-col overflow-hidden z-50"
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
          type="button"
          onClick={() => setIsOpen(false)}
          aria-label={uxText('chronos_chat_minimize', 'Minimize Sovereign chat', locale)}
          className="text-[10px] opacity-40 hover:opacity-80 transition"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {uxText('chronos_chat_minimize', 'MINIMIZE', locale)}
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 space-y-3"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {messages.length === 0 && (
          <div className="flex flex-col gap-6 pt-4">
            <div className="text-center text-[11px] leading-6 text-white/45">
              {uxText(
                'chronos_chat_welcome',
                'Start with a short request or pick one of the guided prompts below.',
                locale
              )}
            </div>

            <div className="space-y-3">
              <div className="px-2 text-[9px] uppercase tracking-widest text-white/30">
                Guided prompts
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {GUIDED_PROMPTS.map((hint) => (
                  <button
                    key={hint.label}
                    type="button"
                    aria-label={`${hint.label}: ${hint.query}`}
                    onClick={() => void sendQuery(hint.query)}
                    className="rounded-xl border border-white/8 bg-white/5 p-3 text-left transition hover:border-cyan-400/30 hover:bg-cyan-400/[0.06]"
                  >
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/72">
                      {hint.label}
                    </div>
                    <div className="mt-1 text-[9px] leading-5 text-white/34">{hint.query}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] px-3 py-2 rounded-xl text-[11px] leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-kyberion-warning/20 border border-kyberion-warning/20'
                  : msg.status === 'error'
                    ? 'bg-red-900/20 border border-red-500/20'
                    : 'bg-white/5 border border-white/5'
              }`}
            >
              <div className="whitespace-pre-wrap">{msg.content}</div>
              <div className="text-[8px] opacity-30 mt-1 text-right">
                {isMounted ? new Date(msg.timestamp).toLocaleTimeString() : ''}
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
            aria-label={uxText('chronos_chat_input', 'Chat input', locale)}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder={
              isListening
                ? uxText('chronos_chat_listening', 'Listening...', locale)
                : uxText(
                    'chronos_chat_placeholder',
                    'Ask for health, missions, traces, or a next step...',
                    locale
                  )
            }
            className={`flex-1 bg-white/5 border rounded-lg px-3 py-2 text-[11px] outline-none transition ${
              isListening
                ? 'border-red-500/50 bg-red-900/10'
                : 'border-white/10 focus:border-kyberion-warning/30'
            }`}
            disabled={isLoading}
          />
          <button
            type="button"
            onClick={toggleVoice}
            aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
            className={`p-2 rounded-lg border transition ${
              isListening
                ? 'bg-red-900/30 border-red-500/30 text-red-400'
                : 'bg-white/5 border-white/10 text-white/40 hover:text-white/70 hover:border-white/20'
            }`}
          >
            {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={sendMessage}
            disabled={isLoading || !input.trim()}
            aria-label={uxText('chronos_chat_send', 'Send message', locale)}
            className="p-2 bg-kyberion-warning/20 border border-kyberion-warning/20 rounded-lg hover:bg-kyberion-warning/30 transition disabled:opacity-20"
          >
            <Send className="w-4 h-4 text-kyberion-warning" />
          </button>
        </div>
      </div>
    </div>
  );
}
