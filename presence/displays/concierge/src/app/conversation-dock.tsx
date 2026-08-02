'use client';

import * as React from 'react';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
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

function newMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ConversationDock() {
  const { locale, t } = useConciergeI18n();
  const [open, setOpen] = React.useState(false);
  const [messages, setMessages] = React.useState<DockMessage[]>([]);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const sessionIdRef = React.useRef(
    `concierge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const logRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, busy, open]);

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
    [busy, locale, t]
  );

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
      <form className="dock-input-row" onSubmit={submitDraft}>
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
