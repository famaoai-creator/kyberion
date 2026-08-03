'use client';

import * as React from 'react';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import { useVoice } from '../lib/use-voice';
import type { ConciergeMessageKey } from '../lib/i18n';
import type {
  ConversationMessageResponse,
  ConversationNextAction,
  ConversationPromotion,
  ConversationShape,
} from '../lib/conversation-types';

type DockMessage = {
  id: string;
  role: 'user' | 'secretary';
  text: string;
  shape?: ConversationShape;
  promoted?: ConversationPromotion;
  nextActions?: ConversationNextAction[];
  error?: boolean;
};

// Only the four contract shapes carry a card label; a plain reply stays a
// plain bubble (docs/USER_EXPERIENCE_CONTRACT.md).
const SHAPE_LABEL_KEYS: Record<Exclude<ConversationShape, 'reply'>, ConciergeMessageKey> = {
  clarification: 'dock.shape.clarification',
  execution_preview: 'dock.shape.execution_preview',
  status_summary: 'dock.shape.status_summary',
  delivery_summary: 'dock.shape.delivery_summary',
};

// CS-03 会話クイック起票 (方式C): prefilled asks for meetings, email drafts,
// and today's calendar. Each chip only fills and sends the text through the
// normal /api/message path — routing stays with the orchestrator, there is no
// special-case handling per chip.
const QUICK_REQUEST_KEYS: ConciergeMessageKey[] = [
  'dock.quick.meeting',
  'dock.quick.email',
  'dock.quick.calendar',
];

function newMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ConversationDock() {
  const { locale, t } = useConciergeI18n();
  const [open, setOpen] = React.useState(false);
  const [messages, setMessages] = React.useState<DockMessage[]>([]);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const voice = useVoice(locale);
  const [voiceSettingsOpen, setVoiceSettingsOpen] = React.useState(false);
  const { speakText, notifyServerSpeech } = voice;
  const sessionIdRef = React.useRef(
    `concierge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const logRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, busy, open]);

  // CS-04: the command palette (and anything else) can open the dock via a
  // window event — same-page action, no navigation.
  React.useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('concierge:open-dock', onOpen);
    return () => window.removeEventListener('concierge:open-dock', onOpen);
  }, []);

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      setMessages((prev) => [...prev, { id: newMessageId(), role: 'user', text: trimmed }]);
      try {
        const response = await fetch('/api/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed, locale, sessionId: sessionIdRef.current }),
        });
        const payload = (await response.json()) as Partial<ConversationMessageResponse> & {
          error?: string;
        };
        // A 503 still carries a polite, actionable reply — show it as the
        // secretary's answer instead of a technical failure.
        const reply = typeof payload.reply === 'string' ? payload.reply : '';
        if (!reply) throw new Error(payload.error || `request failed (${response.status})`);
        setMessages((prev) => [
          ...prev,
          {
            id: newMessageId(),
            role: 'secretary',
            text: reply,
            shape: payload.shape || 'reply',
            promoted: payload.promoted,
            nextActions: payload.nextActions,
            error: payload.mode === 'unavailable',
          },
        ]);
        // Voice output (CS-02): a voice-hub reply was ALREADY spoken
        // server-side (ingest-text does TTS) — only mirror the speaking
        // indicator. Orchestrator/unavailable turns are browser-spoken.
        if (payload.mode === 'voice-hub') {
          notifyServerSpeech();
        } else {
          speakText(reply);
        }
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          {
            id: newMessageId(),
            role: 'secretary',
            text: t('dock.error', {
              error: error instanceof Error ? error.message : String(error),
            }),
            shape: 'reply',
            error: true,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, locale, t, notifyServerSpeech, speakText]
  );

  // Tier 1 mic turn: one server-side capture → STT → reply. The transcript is
  // always shown as the user bubble (captions requirement) and the reply as
  // the secretary bubble; the reply audio already played server-side.
  const runVoiceHubTurn = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await voice.listenOnce();
      const transcript = result.stt?.text?.trim() || '';
      const reply = typeof result.replyText === 'string' ? result.replyText.trim() : '';
      if (!result.ok || !transcript) {
        setMessages((prev) => [
          ...prev,
          {
            id: newMessageId(),
            role: 'secretary',
            text:
              !result.ok && result.error && result.error !== 'empty_transcript'
                ? t('dock.voice.error', { error: result.error })
                : t('dock.voice.no_transcript'),
            shape: 'reply',
            error: true,
          },
        ]);
        return;
      }
      setMessages((prev) => [
        ...prev,
        { id: newMessageId(), role: 'user', text: transcript },
        ...(reply
          ? [
              {
                id: newMessageId(),
                role: 'secretary' as const,
                text: reply,
                shape: 'reply' as const,
              },
            ]
          : []),
      ]);
    } finally {
      setBusy(false);
    }
  }, [busy, t, voice]);

  const handleMicClick = React.useCallback(() => {
    if (voice.listening) {
      voice.stopListening();
      return;
    }
    if (voice.tier === 1) {
      void runVoiceHubTurn();
      return;
    }
    // Tier 0: browser recognition — interim text mirrors into the draft field
    // (live caption), the final transcript goes through the normal send()
    // path so it appears as a user bubble like any typed message.
    voice.startListening(
      (text) => {
        setDraft('');
        void send(text);
      },
      (interim) => setDraft(interim)
    );
  }, [voice, runVoiceHubTurn, send]);

  const submitDraft = React.useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const text = draft;
      setDraft('');
      void send(text);
    },
    [draft, send]
  );

  if (!open) {
    return (
      <button
        type="button"
        className="dock-toggle"
        aria-label={t('dock.open')}
        onClick={() => setOpen(true)}
      >
        {t('dock.title')}
      </button>
    );
  }

  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;

  return (
    <aside className="conversation-dock" aria-label={t('dock.title')}>
      <div className="dock-header">
        <strong>{t('dock.title')}</strong>
        <button
          type="button"
          className="dock-collapse"
          aria-label={t('dock.close')}
          onClick={() => setOpen(false)}
        >
          –
        </button>
      </div>
      <div className="dock-log" ref={logRef} aria-live="polite">
        {messages.length === 0 ? <p className="dock-empty">{t('dock.empty')}</p> : null}
        {messages.map((message) => {
          const shapeKey =
            message.shape && message.shape !== 'reply' ? SHAPE_LABEL_KEYS[message.shape] : null;
          const actionable = message.role === 'secretary' && message.id === lastMessageId;
          // Only render actions the server actually proposed — fabricating a
          // confirm button for approval-queue items would suggest chat text
          // can stand in for the guarded approval flow.
          const actions = message.nextActions ?? [];
          return (
            <div
              key={message.id}
              className={`dock-bubble ${message.role}${message.error ? ' error' : ''}`}
            >
              <span className="dock-speaker">
                {message.role === 'user' ? t('dock.you') : t('dock.secretary')}
              </span>
              {shapeKey ? <span className="dock-shape-chip">{t(shapeKey)}</span> : null}
              <p className="dock-text">{message.text}</p>
              {message.promoted ? (
                <p className="dock-promoted">
                  {t(
                    message.promoted.kind === 'mission'
                      ? 'dock.promoted.mission'
                      : 'dock.promoted.task_session',
                    { label: message.promoted.label }
                  )}
                </p>
              ) : null}
              {actionable && actions.length > 0 ? (
                <div className="button-row">
                  {actions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      className={`action-button${action.id === 'confirm' ? '' : ' secondary'}`}
                      disabled={busy}
                      onClick={() => void send(action.label)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {busy ? <p className="dock-busy">{t('dock.busy')}</p> : null}
      </div>
      {voice.supported || voice.outputSupported ? (
        <div className="dock-voice-row">
          {voice.outputSupported ? (
            <button
              type="button"
              className={`dock-voice-chip${voice.voiceOutputEnabled ? ' on' : ''}`}
              aria-pressed={voice.voiceOutputEnabled}
              onClick={() => voice.setVoiceOutputEnabled(!voice.voiceOutputEnabled)}
            >
              {t(voice.voiceOutputEnabled ? 'dock.voice.output_on' : 'dock.voice.output_off')}
            </button>
          ) : null}
          {voice.tier === 1 && (voice.sttBackends.length > 0 || voice.inputDevices.length > 0) ? (
            <button
              type="button"
              className={`dock-voice-chip${voiceSettingsOpen ? ' on' : ''}`}
              aria-expanded={voiceSettingsOpen}
              onClick={() => {
                const next = !voiceSettingsOpen;
                setVoiceSettingsOpen(next);
                // Re-probe on demand so the backend/device lists are fresh.
                if (next) void voice.refreshStatus();
              }}
            >
              {t('dock.voice.settings')}
            </button>
          ) : null}
          {voice.listening ? (
            <span className="dock-voice-state" role="status">
              {t('dock.voice.listening')}
            </span>
          ) : null}
          {voice.speaking ? (
            <span className="dock-voice-state" role="status">
              {t('dock.voice.speaking')}
              <button
                type="button"
                className="dock-voice-chip"
                onClick={() => void voice.stopSpeaking()}
              >
                {t('dock.voice.stop_speaking')}
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      {voiceSettingsOpen && voice.tier === 1 ? (
        <div className="dock-voice-settings">
          {voice.sttBackends.length > 0 ? (
            <label>
              {t('dock.voice.backend')}
              <select
                value={voice.sttBackend}
                onChange={(event) => voice.setSttBackend(event.target.value)}
              >
                <option value="">{t('dock.voice.auto')}</option>
                {voice.sttBackends.map((backend) => (
                  <option key={backend} value={backend}>
                    {backend}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {voice.inputDevices.length > 0 ? (
            <label>
              {t('dock.voice.device')}
              <select
                value={voice.inputDevice}
                onChange={(event) => voice.setInputDevice(event.target.value)}
              >
                <option value="">{t('dock.voice.default_device')}</option>
                {voice.inputDevices.map((device) => (
                  <option key={device.uid} value={device.uid}>
                    {device.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      {messages.length === 0 ? (
        <div className="dock-quick-row" role="group" aria-label={t('dock.quick.label')}>
          {QUICK_REQUEST_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className="dock-quick-chip"
              disabled={busy}
              onClick={() => void send(t(key))}
            >
              {t(key)}
            </button>
          ))}
        </div>
      ) : null}
      <form className="dock-input-row" onSubmit={submitDraft}>
        {voice.supported ? (
          <button
            type="button"
            className={`dock-mic${voice.listening ? ' listening' : ''}`}
            aria-pressed={voice.listening}
            aria-label={t(voice.listening ? 'dock.voice.mic_stop' : 'dock.voice.mic_start')}
            title={t(voice.listening ? 'dock.voice.mic_stop' : 'dock.voice.mic_start')}
            disabled={busy}
            onClick={handleMicClick}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
              <path d="M12 18v4" />
            </svg>
          </button>
        ) : null}
        <input
          type="text"
          value={draft}
          placeholder={t('dock.placeholder')}
          aria-label={t('dock.placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          disabled={busy}
        />
        <button type="submit" className="action-button" disabled={busy || !draft.trim()}>
          {t('dock.send')}
        </button>
      </form>
    </aside>
  );
}
