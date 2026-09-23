'use client';

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { Send, Loader2, MessageSquare, Mic, MicOff, GripHorizontal, Minus } from 'lucide-react';
import { Button } from '@agent/shared-ui';
import { chronosSpeechLocale, uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import { buildUserFacingError } from '../lib/user-facing-error';
import { useChronosLocale } from '../lib/hooks';
import {
  parseAgentChatErrorResponse,
  parseAgentChatSuccessResponse,
  type ClientAgentChatMessage,
} from '../lib/agent-chat-response';
import { ChronosMeta } from './chronos-ui';

const AGENT_URL = '/api/agent';

type ChatPhase = 'idle' | 'sending' | 'thinking' | 'long_running';

const PHASE_THINKING_AFTER_MS = 1500;
const PHASE_LONG_RUNNING_AFTER_MS = 12000;

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: string;
  status?: 'pending' | 'complete' | 'error';
}

const PANEL_VIEWPORT_MARGIN = 16;

function buildGuidedPrompts(locale: SupportedLocale) {
  return [
    {
      label: uxText('chronos_chat_prompt_health_label', locale),
      query: uxText('chronos_chat_prompt_health_query', locale),
    },
    {
      label: uxText('chronos_chat_prompt_missions_label', locale),
      query: uxText('chronos_chat_prompt_missions_query', locale),
    },
    {
      label: uxText('chronos_chat_prompt_traces_label', locale),
      query: uxText('chronos_chat_prompt_traces_query', locale),
    },
    {
      label: uxText('chronos_chat_prompt_next_step_label', locale),
      query: uxText('chronos_chat_prompt_next_step_query', locale),
    },
  ];
}

export function SovereignChat({
  onA2UIMessage,
  onReady,
}: {
  onA2UIMessage?: (message: ClientAgentChatMessage) => void;
  onReady?: (sendFn: (query: string) => void) => void;
}) {
  const locale = useChronosLocale();
  const guidedPrompts = useMemo(() => buildGuidedPrompts(locale), [locale]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [phase, setPhase] = useState<ChatPhase>('idle');
  const [isOpen, setIsOpen] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 }); // offset from default bottom-right
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const abortRef = useRef<AbortController | null>(null);
  const phaseTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null
  );

  const clearPhaseTimers = useCallback(() => {
    for (const timer of phaseTimersRef.current) clearTimeout(timer);
    phaseTimersRef.current = [];
  }, []);

  // Abort the in-flight request when the component unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      for (const timer of phaseTimersRef.current) clearTimeout(timer);
    };
  }, []);

  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Keep the panel fully inside the viewport: the panel is anchored at
  // `bottom: 24 - pos.y` / `right: 24 - pos.x`, so the drag offset is clamped
  // against the current window and panel size.
  const clampOffset = useCallback((offset: { x: number; y: number }) => {
    if (typeof window === 'undefined') return offset;
    const width = panelRef.current?.offsetWidth ?? 420;
    const height = panelRef.current?.offsetHeight ?? 520;
    const minX = 24 - (window.innerWidth - PANEL_VIEWPORT_MARGIN - width);
    const maxX = 24 - PANEL_VIEWPORT_MARGIN;
    const minY = 24 - (window.innerHeight - PANEL_VIEWPORT_MARGIN - height);
    const maxY = 24 - PANEL_VIEWPORT_MARGIN;
    return {
      x: Math.min(Math.max(offset.x, Math.min(minX, maxX)), maxX),
      y: Math.min(Math.max(offset.y, Math.min(minY, maxY)), maxY),
    };
  }, []);

  // Re-clamp when the window resizes (e.g. rotation) and when the panel opens.
  useEffect(() => {
    if (!isOpen) return;
    const reclamp = () => setPos((prev) => clampOffset(prev));
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, [isOpen, clampOffset]);

  // --- Drag to move ---
  const onDragStart = useCallback(
    (e: ReactPointerEvent) => {
      dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos]
  );

  const onDragMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPos(clampOffset({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy }));
    },
    [clampOffset]
  );

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
      setPhase('sending');
      clearPhaseTimers();
      phaseTimersRef.current = [
        setTimeout(() => setPhase('thinking'), PHASE_THINKING_AFTER_MS),
        setTimeout(() => setPhase('long_running'), PHASE_LONG_RUNNING_AFTER_MS),
      ];
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(AGENT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, locale }),
          signal: controller.signal,
        });
        const payload = await res.json().catch(() => null);
        if (res.ok) {
          const data = parseAgentChatSuccessResponse(payload);
          if (!data) throw new Error('Invalid Chronos agent response');
          const agentMsg: ChatMessage = {
            id: `agent-${Date.now()}`,
            role: 'agent',
            content: data.response,
            timestamp: data.timestamp,
            status: 'complete',
          };
          setMessages((prev) => [...prev, agentMsg]);

          if (data.a2ui && onA2UIMessage) {
            for (const msg of data.a2ui) onA2UIMessage(msg);
          }
        } else {
          const data = parseAgentChatErrorResponse(payload);
          const envelope = buildUserFacingError(data?.error || new Error(`HTTP ${res.status}`), {
            locale,
            surface: 'chronos',
            traceId: data?.traceId || data?.correlationId,
          });
          const agentMsg: ChatMessage = {
            id: `agent-${Date.now()}`,
            role: 'agent',
            content: `${envelope.title}: ${envelope.body} ${envelope.nextAction}`,
            timestamp: new Date().toISOString(),
            status: 'error',
          };
          setMessages((prev) => [...prev, agentMsg]);
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          setMessages((prev) => [
            ...prev,
            {
              id: `cancelled-${Date.now()}`,
              role: 'agent',
              content: uxText('chronos_chat_cancelled', locale),
              timestamp: new Date().toISOString(),
              status: 'complete',
            },
          ]);
        } else {
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
      }

      abortRef.current = null;
      clearPhaseTimers();
      setPhase('idle');
      setIsLoading(false);
    },
    [isLoading, locale, onA2UIMessage, clearPhaseTimers]
  );

  const cancelQuery = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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
      <div className="chronos-chat__launcher">
        <Button
          label={uxText('chronos_chat_open', locale)}
          variant="primary"
          onClick={() => setIsOpen(true)}
        >
          <MessageSquare size={16} aria-hidden="true" />
          <span>{uxText('chronos_chat_trigger', locale)}</span>
        </Button>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className="chronos-chat"
      role="dialog"
      aria-labelledby="chronos-chat-title"
      style={{ bottom: `${24 - pos.y}px`, right: `${24 - pos.x}px` }}
    >
      {/* Header — drag handle */}
      <div
        className="chronos-chat__header"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
      >
        <GripHorizontal size={14} aria-hidden="true" className="chronos-chat__grip" />
        <span className="chronos-chat__dot" aria-hidden="true" />
        <h2 id="chronos-chat-title" className="chronos-chat__title">
          {uxText('chronos_chat_title', locale)}
        </h2>
        <span className="chronos-chat__header-action" onPointerDown={(e) => e.stopPropagation()}>
          <Button
            label={uxText('chronos_chat_minimize', locale)}
            variant="ghost"
            onClick={() => setIsOpen(false)}
          >
            <Minus size={14} aria-hidden="true" />
          </Button>
        </span>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="chronos-chat__log"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {messages.length === 0 && (
          <div className="chronos-stack">
            <p className="kb-text kb-text--muted">{uxText('chronos_chat_welcome', locale)}</p>
            <div className="chronos-feed">
              <h3 className="chronos-feed__title">
                {uxText('chronos_chat_guided_prompts', locale)}
              </h3>
              <div className="chronos-chat__prompts">
                {guidedPrompts.map((hint) => (
                  <Button
                    key={hint.label}
                    label={`${hint.label}: ${hint.query}`}
                    variant="secondary"
                    onClick={() => void sendQuery(hint.query)}
                  >
                    <span className="chronos-chat__prompt">
                      <span className="chronos-chat__prompt-label">{hint.label}</span>
                      <span className="chronos-chat__prompt-query">{hint.query}</span>
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className="chronos-chat__bubble"
            data-role={msg.role}
            data-status={msg.status === 'error' ? 'error' : undefined}
          >
            <div className="chronos-chat__bubble-text">{msg.content}</div>
            <span className="chronos-chat__bubble-time">
              <ChronosMeta>
                {isMounted ? new Date(msg.timestamp).toLocaleTimeString(chronosSpeechLocale()) : ''}
              </ChronosMeta>
            </span>
          </div>
        ))}
        {isLoading && (
          <div className="chronos-chat__bubble chronos-chat__pending" data-role="agent">
            <Loader2 size={16} aria-hidden="true" className="chronos-chat__spinner" />
            <span className="chronos-chat__phase" role="status">
              {phase === 'sending' && uxText('chronos_chat_phase_sending', locale)}
              {phase === 'thinking' && uxText('chronos_chat_phase_thinking', locale)}
              {phase === 'long_running' && uxText('chronos_chat_phase_long_running', locale)}
            </span>
            <Button
              label={uxText('chronos_chat_cancel', locale)}
              variant="ghost"
              onClick={cancelQuery}
            />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="chronos-chat__composer">
        <input
          className="kb-input"
          data-listening={isListening ? 'true' : undefined}
          aria-label={uxText('chronos_chat_input', locale)}
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
              ? uxText('chronos_chat_listening', locale)
              : uxText('chronos_chat_placeholder', locale)
          }
          disabled={isLoading}
        />
        <Button
          label={
            isListening
              ? uxText('chronos_chat_voice_stop', locale)
              : uxText('chronos_chat_voice_start', locale)
          }
          variant={isListening ? 'danger' : 'secondary'}
          onClick={toggleVoice}
        >
          {isListening ? (
            <MicOff size={16} aria-hidden="true" />
          ) : (
            <Mic size={16} aria-hidden="true" />
          )}
        </Button>
        <Button
          label={uxText('chronos_chat_send', locale)}
          variant="primary"
          onClick={sendMessage}
          disabled={isLoading || !input.trim()}
        >
          <Send size={16} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
