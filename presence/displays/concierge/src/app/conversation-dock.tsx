'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  frontDeskArtifactRevisionCommand,
  type FrontDeskArtifactRevisionInput,
  type FrontDeskConversationArtifact,
  type FrontDeskReceiptFormat,
} from '@agent/core/surface/front-desk-conversation-history';
import {
  artifactRevisionForMessage,
  sameArtifactRevision,
  sameConversationRequestScope,
  prepareConversationRequest,
  parsePendingConversationRequest,
  type ConversationRequestScope,
  type PendingConversationRequest,
} from '../lib/conversation-request';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import { useVoice } from '../lib/use-voice';
import { DockAvatar } from './dock-avatar';
import { buildIntentResolutionView } from '../lib/intent-resolution-view';
import { parseConversationHistory } from '../lib/conversation-history';
import {
  readSelectedTenant,
  withSelectedTenant,
  TENANT_CHANGED_EVENT,
  tenantFromChangeEvent,
} from '../lib/tenant-context';
import { frontDeskText, type ConciergeMessageKey, type FrontDeskMessageKey } from '../lib/i18n';
import type {
  ConversationMessageResponse,
  ConversationNextAction,
  ConversationPromotion,
  ConversationShape,
} from '../lib/conversation-types';
import {
  parseIntentResolutionContract,
  type IntentResolutionContract,
} from '@agent/core/intent/intent-resolution-contract-parser';

type HistoryFailure = 'unavailable' | 'signin' | 'forbidden' | 'scope' | 'revision';

type DockMessage = {
  id: string;
  role: 'user' | 'secretary';
  text: string;
  createdAt?: number;
  artifact?: FrontDeskConversationArtifact;
  shape?: ConversationShape;
  promoted?: ConversationPromotion;
  nextActions?: ConversationNextAction[];
  intentResolution?: IntentResolutionContract;
  error?: boolean;
};

const AUTHORITY_LABEL_KEYS: Record<
  IntentResolutionContract['authority_level'],
  ConciergeMessageKey
> = {
  autonomous: 'dock.intent_resolution.authority_autonomous',
  approval_required: 'dock.intent_resolution.authority_approval',
  human_clarification_required: 'dock.intent_resolution.authority_clarification',
};

const OUTCOME_LABEL_KEYS: Record<IntentResolutionContract['outcome_kind'], ConciergeMessageKey> = {
  answer: 'dock.intent_resolution.outcome_answer',
  artifact: 'dock.intent_resolution.outcome_artifact',
  approval_ready_plan: 'dock.intent_resolution.outcome_approval_ready_plan',
  service_change: 'dock.intent_resolution.outcome_service_change',
  status_report: 'dock.intent_resolution.outcome_status_report',
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

/** Window event that opens the dock (header action, ⌘K palette). */
export const CONVERSATION_DOCK_OPEN_EVENT = 'concierge:open-dock';

function newMessageId(): string {
  return `msg-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

function currentRequestScope(sessionId: string, tenant: string | null): ConversationRequestScope {
  const query = new URL(window.location.href).searchParams;
  return {
    sessionId,
    tenant: tenant || undefined,
    organizationId: query.get('organizationId') || undefined,
    projectId: query.get('projectId') || undefined,
  };
}

export function ConversationDock(props: { progressHref?: string } = {}) {
  return (
    <React.Suspense fallback={null}>
      <ConversationDockContent {...props} />
    </React.Suspense>
  );
}

function ConversationDockContent({ progressHref = '/progress' }: { progressHref?: string }) {
  const { locale, t } = useConciergeI18n();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const navigationKey = pathname + '?' + searchParams.toString();
  const previousNavigation = React.useRef(navigationKey);
  const [open, setOpen] = React.useState(false);
  const [messages, setMessages] = React.useState<DockMessage[]>([]);
  const [draft, setDraft] = React.useState('');
  const [tenant, setTenant] = React.useState<string | null>(readSelectedTenant);
  const scopeEpoch = React.useRef(0);
  const sendEpoch = React.useRef(0);
  const pendingRequest = React.useRef<PendingConversationRequest | null>(null);
  const [revisionSelection, setRevisionSelection] = React.useState<{
    messageId: string;
    format: FrontDeskReceiptFormat;
  } | null>(null);
  const inFlight = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const [historyState, setHistoryState] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  const [historyFailure, setHistoryFailure] = React.useState<HistoryFailure>('unavailable');
  const [historyWarning, setHistoryWarning] = React.useState(false);
  const [storageVerified, setStorageVerified] = React.useState(false);
  const [pendingTurns, setPendingTurns] = React.useState(0);
  const [historyAttempt, setHistoryAttempt] = React.useState(0);
  const voice = useVoice(locale);
  const [voiceSettingsOpen, setVoiceSettingsOpen] = React.useState(false);
  const { speakText, notifyServerSpeech, unlockSpeechAudio, stopListening, resetPlayback } = voice;
  const sessionIdRef = React.useRef<string | null>(null);
  const restoredScope = React.useRef<ConversationRequestScope | null>(null);
  const logRef = React.useRef<HTMLDivElement | null>(null);

  // A fresh history read owns all visible state. Retained storage is inert until
  // the server verifies the same session and scope; recovery never replays a POST.
  const clearVerifiedConversation = React.useCallback(() => {
    scopeEpoch.current += 1;
    sendEpoch.current += 1;
    stopListening?.();
    resetPlayback?.();
    sessionIdRef.current = null;
    restoredScope.current = null;
    pendingRequest.current = null;
    inFlight.current = false;
    setRevisionSelection(null);
    setDraft('');
    setMessages([]);
    setBusy(false);
    setPendingTurns(0);
    setHistoryWarning(false);
    setStorageVerified(false);
  }, [stopListening, resetPlayback]);

  const invalidateHistory = React.useCallback(
    (reason: HistoryFailure) => {
      clearVerifiedConversation();
      setHistoryFailure(reason);
      setHistoryState('failed');
    },
    [clearVerifiedConversation]
  );

  React.useEffect(() => {
    if (previousNavigation.current === navigationKey) return;
    previousNavigation.current = navigationKey;
    clearVerifiedConversation();
    setHistoryFailure('unavailable');
    setHistoryState('loading');
    setTenant(readSelectedTenant());
  }, [navigationKey, clearVerifiedConversation]);

  const closeDock = () => {
    clearVerifiedConversation();
    setHistoryState('loading');
    setOpen(false);
  };

  React.useEffect(() => {
    if (!open) return;
    clearVerifiedConversation();
    const epoch = scopeEpoch.current;
    const navigation = window.location.pathname + window.location.search;
    const controller = new AbortController();
    const current = () =>
      !controller.signal.aborted &&
      epoch === scopeEpoch.current &&
      navigation === window.location.pathname + window.location.search;
    const timeout = setTimeout(() => {
      if (!current()) return;
      invalidateHistory('unavailable');
      controller.abort();
    }, 15000);
    setHistoryFailure('unavailable');
    setHistoryState('loading');
    void (async () => {
      try {
        const response = await fetch(withSelectedTenant('/api/message', tenant), {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!current()) return;
        if (response.status === 401 || response.status === 403) {
          invalidateHistory(response.status === 401 ? 'signin' : 'forbidden');
          return;
        }
        if (!response.ok) throw new Error('history_unavailable');
        const history = parseConversationHistory(await response.json());
        if (!history) throw new Error('invalid_history');
        if (!current()) return;
        sessionIdRef.current = history.sessionId;
        restoredScope.current = currentRequestScope(history.sessionId, tenant);
        try {
          const raw = window.sessionStorage.getItem('front-desk.request.' + history.sessionId);
          const saved =
            raw === null
              ? null
              : parsePendingConversationRequest(
                  JSON.parse(raw),
                  currentRequestScope(history.sessionId, tenant),
                  locale
                );
          if (raw !== null && !saved) throw new Error('invalid saved request');
          const completed =
            saved && history.messages.some((message) => message.id === saved.id + '-secretary');
          pendingRequest.current = completed ? null : saved || null;
          const savedDraft =
            window.sessionStorage.getItem('front-desk.draft.' + history.sessionId) || '';
          // A recovered completed turn must not leave its submitted draft
          // looking unsent. Preserve a newer edit, but never invite a new-ID
          // repeat merely because the original reply was interrupted.
          if (completed && savedDraft.trim() === saved.text) {
            window.sessionStorage.removeItem('front-desk.draft.' + history.sessionId);
          } else {
            setDraft(savedDraft);
          }
          // Keep the completion correlation until draft cleanup succeeds.
          if (completed)
            window.sessionStorage.removeItem('front-desk.request.' + history.sessionId);
          setStorageVerified(true);
        } catch {
          setStorageVerified(false);
        }
        setMessages(history.messages);
        setRevisionSelection(null);
        setPendingTurns(history.pending);
        setHistoryState('ready');
      } catch {
        if (current()) invalidateHistory('unavailable');
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      clearTimeout(timeout);
      controller.abort();
      if (epoch === scopeEpoch.current) scopeEpoch.current += 1;
    };
  }, [open, historyAttempt, tenant, navigationKey, clearVerifiedConversation, invalidateHistory]);

  React.useEffect(() => {
    const change = (event: Event) => {
      const next = tenantFromChangeEvent(event);
      if (!next || next === tenant) return;
      clearVerifiedConversation();
      setHistoryFailure('unavailable');
      setHistoryState('loading');
      setTenant(next);
    };
    window.addEventListener(TENANT_CHANGED_EVENT, change);
    return () => window.removeEventListener(TENANT_CHANGED_EVENT, change);
  }, [tenant, clearVerifiedConversation]);

  function storeDraft(value: string) {
    setDraft(value);
    if (!sessionIdRef.current) return;
    try {
      window.sessionStorage.setItem('front-desk.draft.' + sessionIdRef.current, value);
    } catch {
      /* Optional. */
    }
  }

  React.useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, busy, open]);

  // CS-04: the command palette (and anything else) can open the dock via a
  // window event — same-page action, no navigation.
  React.useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(CONVERSATION_DOCK_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CONVERSATION_DOCK_OPEN_EVENT, onOpen);
  }, []);

  const send = React.useCallback(
    async (text: string, artifactRevision?: FrontDeskArtifactRevisionInput) => {
      const trimmed = text.trim();
      if (
        !trimmed ||
        busy ||
        inFlight.current ||
        !storageVerified ||
        historyState !== 'ready' ||
        !sessionIdRef.current
      )
        return;
      // PA-09: every send path starts from a user gesture (submit, chip,
      // action button) or a mic turn that began with one — resume Web Audio
      // now so the avatar's reply audio may play (autoplay policy).
      void unlockSpeechAudio();
      const epoch = scopeEpoch.current;
      const navigation = window.location.pathname + window.location.search;
      const scope = currentRequestScope(sessionIdRef.current, tenant);
      if (!restoredScope.current || !sameConversationRequestScope(restoredScope.current, scope))
        return;
      const retained = pendingRequest.current;
      // A pending revision can only be retried with its complete original selection.
      if (
        retained?.payload.artifactRevision &&
        (retained.text !== trimmed ||
          !sameArtifactRevision(retained.payload.artifactRevision, artifactRevision))
      )
        return;
      const retryingRevision = Boolean(
        artifactRevision &&
        retained &&
        retained.text === trimmed &&
        sameArtifactRevision(retained.payload.artifactRevision, artifactRevision) &&
        sameConversationRequestScope(retained.payload, scope)
      );
      if (
        artifactRevision &&
        !retryingRevision &&
        !messages.some((message) =>
          sameArtifactRevision(
            artifactRevisionForMessage(message, artifactRevision.format),
            artifactRevision
          )
        )
      )
        return;
      const waiting =
        !artifactRevision &&
        messages.find(
          (message) =>
            message.role === 'user' &&
            message.text === trimmed &&
            message.id.endsWith('-user') &&
            !messages.some((reply) => reply.id === message.id.replace(/-user$/, '-secretary'))
        );
      const request = prepareConversationRequest(
        trimmed,
        scope,
        locale,
        waiting ? waiting.id.replace(/-user$/, '') : crypto.randomUUID(),
        waiting ? (waiting.createdAt ?? Date.now()) : Date.now(),
        pendingRequest.current,
        artifactRevision
      );
      try {
        const key = 'front-desk.request.' + request.payload.sessionId;
        const serialized = JSON.stringify(request);
        window.sessionStorage.setItem(key, serialized);
        if (window.sessionStorage.getItem(key) !== serialized)
          throw new Error('request not retained');
      } catch {
        setStorageVerified(false);
        return;
      }
      pendingRequest.current = request;
      const sequence = ++sendEpoch.current;
      inFlight.current = true;
      setBusy(true);
      setRevisionSelection(null);
      if (artifactRevision)
        setMessages((current) =>
          current.map((message) =>
            message.artifact?.requestId === artifactRevision.requestId
              ? { ...message, artifact: { ...message.artifact, canRevise: false } }
              : message
          )
        );
      setMessages((prev) =>
        prev.some((message) => message.id === request.id + '-user')
          ? prev
          : [
              ...prev,
              {
                id: request.id + '-user',
                role: 'user',
                text: trimmed,
                createdAt: request.createdAt,
              },
            ]
      );
      let outcomeUncertain = true;
      try {
        const response = await fetch('/api/message', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.payload),
        });
        if (
          epoch !== scopeEpoch.current ||
          navigation !== window.location.pathname + window.location.search
        )
          return;
        // Authentication failures may be HTML/empty bodies from a proxy. The
        // status alone withdraws old content before any JSON parsing.
        if (response.status === 401 || response.status === 403) {
          invalidateHistory(response.status === 401 ? 'signin' : 'forbidden');
          return;
        }
        const rawPayload: unknown = await response.json();
        if (
          epoch !== scopeEpoch.current ||
          navigation !== window.location.pathname + window.location.search
        )
          return;
        if (!response.ok || response.status === 202) {
          const raw =
            rawPayload && typeof rawPayload === 'object'
              ? (rawPayload as Record<string, unknown>)
              : {};
          const failure = conversationFailurePolicy(response.status, raw);
          outcomeUncertain = failure.uncertain;
          if (
            artifactRevision &&
            [
              'conversation_revision_conflict',
              'conversation_revision_target_unavailable',
              'conversation_invalid_revision',
            ].includes(String(raw.error))
          ) {
            pendingRequest.current = null;
            setRevisionSelection(null);
            try {
              window.sessionStorage.removeItem('front-desk.request.' + request.payload.sessionId);
            } catch {
              /* Optional. */
            }
            invalidateHistory('revision');
            return;
          }
          if (failure.invalidateHistory) {
            invalidateHistory('scope');
            return;
          }
          const typedError = failure.messageKey;
          throw new Error(
            typedError
              ? frontDeskText(typedError, locale)
              : t(raw.retry_safe === true ? 'api.history_unavailable' : 'dock.history.pending')
          );
        }
        const payload = parseConversationMessageResponse(rawPayload);
        if (response.status === 413) throw new Error(t('api.message_too_long'));
        if (response.status === 503 && !payload.reply)
          throw new Error(t('api.history_unavailable'));
        if (payload.historySaved === false) setHistoryWarning(true);
        const reply = typeof payload.reply === 'string' ? payload.reply : '';
        if (!reply) throw new Error(payload.error || `request failed (${response.status})`);
        setMessages((prev) => [
          ...prev.filter((message) => message.id !== request.id + '-secretary'),
          {
            id: request.id + '-secretary',
            role: 'secretary',
            text: reply,
            shape: payload.shape || 'reply',
            promoted: payload.promoted,
            nextActions: payload.nextActions,
            intentResolution: payload.intentResolution,
            error: payload.mode === 'unavailable',
          },
        ]);
        pendingRequest.current = null;
        // Re-read only verified version metadata, preserving live clarification/approval cards.
        void (async () => {
          try {
            const response = await fetch(withSelectedTenant('/api/message', tenant), {
              cache: 'no-store',
            });
            const current = () =>
              sequence === sendEpoch.current &&
              epoch === scopeEpoch.current &&
              navigation === window.location.pathname + window.location.search;
            if (!current()) return;
            if (response.status === 401 || response.status === 403) {
              invalidateHistory(response.status === 401 ? 'signin' : 'forbidden');
              return;
            }
            if (!response.ok) return;
            const history = parseConversationHistory(await response.json());
            if (!history || !current()) return;
            if (history.sessionId !== request.payload.sessionId) {
              invalidateHistory('scope');
              return;
            }
            setMessages((current) =>
              current.map((message) => ({
                ...message,
                artifact: history.messages.find((entry) => entry.id === message.id)?.artifact,
              }))
            );
            setPendingTurns(history.pending);
          } catch {
            /* A failed refresh never enables a new artifact action. */
          }
        })();
        try {
          window.sessionStorage.removeItem('front-desk.request.' + request.payload.sessionId);
        } catch {
          /* Optional. */
        }
        setDraft((value) => (value.trim() === trimmed ? '' : value));
        try {
          if (
            window.sessionStorage
              .getItem('front-desk.draft.' + request.payload.sessionId)
              ?.trim() === trimmed
          )
            window.sessionStorage.removeItem('front-desk.draft.' + request.payload.sessionId);
        } catch {
          /* Optional. */
        }
        // Voice output (CS-02): a voice-hub reply was ALREADY spoken
        // server-side (ingest-text does TTS) — only mirror the speaking
        // indicator. Orchestrator/unavailable turns are browser-spoken.
        if (payload.mode === 'voice-hub') {
          notifyServerSpeech();
        } else {
          speakText(reply);
        }
      } catch (error) {
        if (
          epoch !== scopeEpoch.current ||
          navigation !== window.location.pathname + window.location.search
        )
          return;
        if (outcomeUncertain) setPendingTurns((count) => Math.max(count, 1));
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
        if (epoch === scopeEpoch.current) {
          inFlight.current = false;
          setBusy(false);
        }
      }
    },
    [
      busy,
      messages,
      storageVerified,
      historyState,
      locale,
      tenant,
      t,
      notifyServerSpeech,
      speakText,
      unlockSpeechAudio,
      invalidateHistory,
    ]
  );

  // Tier 1 mic turn: one server-side capture → STT → reply. The transcript is
  // always shown as the user bubble (captions requirement) and the reply as
  // the secretary bubble; the reply audio already played server-side.
  const runVoiceHubTurn = React.useCallback(async () => {
    if (busy || inFlight.current || historyState !== 'ready' || !storageVerified) return;
    const epoch = scopeEpoch.current;
    const navigation = window.location.pathname + window.location.search;
    const current = () =>
      epoch === scopeEpoch.current &&
      navigation === window.location.pathname + window.location.search;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await voice.listenOnce(current);
      if (!current()) return;
      if (result.error === 'listen_failed_401' || result.error === 'listen_failed_403') {
        invalidateHistory(result.error === 'listen_failed_401' ? 'signin' : 'forbidden');
        return;
      }
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
                intentResolution: result.intentResolution,
              },
            ]
          : []),
      ]);
      // The separate voice-hub listen-once protocol is not yet a durable thread.
      setHistoryWarning(true);
    } finally {
      if (current()) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }, [busy, historyState, storageVerified, t, voice, invalidateHistory]);

  const handleMicClick = React.useCallback(() => {
    if (busy || historyState !== 'ready' || !storageVerified) return;
    const epoch = scopeEpoch.current;
    const navigation = window.location.pathname + window.location.search;
    const current = () =>
      epoch === scopeEpoch.current &&
      navigation === window.location.pathname + window.location.search;
    void voice.unlockSpeechAudio();
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
        if (!current()) return;
        storeDraft(text);
        void send(text);
      },
      (interim) => {
        if (current()) setDraft(interim);
      }
    );
  }, [voice, runVoiceHubTurn, send, busy, historyState, storageVerified]);

  const submitDraft = React.useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const text = draft;
      void send(text);
    },
    [draft, send]
  );

  // Closed: nothing floats over the page — the header's "秘書に相談" action
  // (and the ⌘K palette) open the dock through CONVERSATION_DOCK_OPEN_EVENT.
  if (!open) return null;

  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;

  return (
    <aside className="conversation-dock" aria-label={t('dock.title')}>
      <div className="dock-header">
        <div className="dock-header-title">
          <DockAvatar
            voice={voice}
            busy={busy}
            label={t('dock.avatar_label')}
            personalLabel={t('dock.avatar_personal_label')}
          />
          <strong>{t('dock.title')}</strong>
        </div>
        <button
          type="button"
          className="dock-collapse"
          aria-label={t('dock.close')}
          onClick={closeDock}
        >
          –
        </button>
      </div>
      <div className="dock-empty" role="status" aria-live="polite">
        {historyState === 'loading' ? t('dock.history.loading') : null}
        {historyState === 'failed' ? (
          <>
            {t(
              historyFailure === 'signin'
                ? 'dock.history.signin'
                : historyFailure === 'forbidden'
                  ? 'dock.history.forbidden'
                  : historyFailure === 'scope'
                    ? 'dock.history.scope_changed'
                    : historyFailure === 'revision'
                      ? 'dock.history.revision_changed'
                      : 'dock.history.failed'
            )}{' '}
            {historyFailure === 'signin' ? (
              <a
                href={
                  '/login?next=' +
                  encodeURIComponent(window.location.pathname + window.location.search)
                }
              >
                {t('dock.history.signin_action')}
              </a>
            ) : null}
          </>
        ) : null}
        {historyState === 'ready' && pendingTurns > 0 ? t('dock.history.pending') : null}
        {historyState === 'ready' && historyWarning ? t('dock.history.unsaved') : null}
        {historyState === 'ready' && !storageVerified
          ? frontDeskText('conversation_storage_required', locale)
          : null}
        {historyState === 'failed' ||
        (historyState === 'ready' && (pendingTurns > 0 || !storageVerified)) ? (
          <>
            {' '}
            <button type="button" onClick={() => setHistoryAttempt((attempt) => attempt + 1)}>
              {t('dock.history.retry')}
            </button>{' '}
            {historyState === 'ready' && pendingTurns > 0 ? (
              <a href={withSelectedTenant(progressHref, tenant)}>
                {frontDeskText('nav_progress', locale)}
              </a>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="dock-log" ref={logRef} aria-live="polite">
        {historyState === 'ready' && messages.length === 0 ? (
          <p className="dock-empty">{t('dock.empty')}</p>
        ) : null}
        {(historyState === 'ready' ? messages : []).map((message) => {
          const shapeKey =
            message.shape && message.shape !== 'reply' ? SHAPE_LABEL_KEYS[message.shape] : null;
          const actionable = message.role === 'secretary' && message.id === lastMessageId;
          // Only render actions the server actually proposed — fabricating a
          // confirm button for approval-queue items would suggest chat text
          // can stand in for the guarded approval flow.
          const actions = message.nextActions ?? [];
          const intentView = message.intentResolution
            ? buildIntentResolutionView(message.intentResolution)
            : null;
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
              {message.role === 'user' && /^[a-f0-9-]{36}-user$/.test(message.id) ? (
                <a
                  href={withSelectedTenant(
                    progressHref + '?request=' + encodeURIComponent(message.id.slice(0, -5)),
                    tenant
                  )}
                >
                  {frontDeskText('nav_progress', locale)}
                </a>
              ) : null}
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
              {intentView ? (
                <section
                  className="dock-intent-resolution"
                  aria-label={t('dock.intent_resolution.title')}
                  data-testid="intent-resolution-card"
                >
                  <div className="dock-intent-heading">
                    <strong>{t('dock.intent_resolution.title')}</strong>
                    <span className="dock-intent-authority">
                      {t(AUTHORITY_LABEL_KEYS[intentView.authority])}
                    </span>
                  </div>
                  <dl>
                    <div>
                      <dt>{t('dock.intent_resolution.understood')}</dt>
                      <dd>{intentView.understood}</dd>
                    </div>
                    <div>
                      <dt>{t('dock.intent_resolution.missing')}</dt>
                      <dd>
                        {intentView.missingInputs.length > 0
                          ? intentView.missingInputs.join(', ')
                          : t('dock.intent_resolution.none')}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('dock.intent_resolution.next')}</dt>
                      <dd>
                        {intentView.nextAction.label}
                        <small>{intentView.nextAction.consequence}</small>
                      </dd>
                    </div>
                    <div>
                      <dt>{t('dock.intent_resolution.outcome')}</dt>
                      <dd>{t(OUTCOME_LABEL_KEYS[intentView.outcome])}</dd>
                    </div>
                  </dl>
                  {intentView.authority === 'approval_required' ? (
                    <p className="dock-intent-waiting" role="status">
                      {t('dock.intent_resolution.waiting_approval')}
                    </p>
                  ) : null}
                </section>
              ) : null}
              {message.role === 'secretary' && message.artifact?.canRevise ? (
                <div className="button-row">
                  <button
                    type="button"
                    className="action-button secondary"
                    disabled={
                      busy ||
                      historyState !== 'ready' ||
                      !storageVerified ||
                      Boolean(pendingRequest.current?.payload.artifactRevision)
                    }
                    onClick={() =>
                      setRevisionSelection({
                        messageId: message.id,
                        format: message.artifact?.format === 'compact' ? 'readable' : 'compact',
                      })
                    }
                  >
                    {frontDeskText('artifact_revision_action', locale)}
                  </button>
                </div>
              ) : null}
              {revisionSelection?.messageId === message.id ? (
                <form
                  className="dock-intent-resolution"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const selected = artifactRevisionForMessage(message, revisionSelection.format);
                    if (selected)
                      void send(frontDeskArtifactRevisionCommand(selected.format), selected);
                  }}
                >
                  <label>
                    {frontDeskText('artifact_revision_format', locale)}
                    <select
                      value={revisionSelection.format}
                      disabled={busy}
                      onChange={(event) => {
                        const format = event.target.value;
                        if (format === 'compact' || format === 'readable')
                          setRevisionSelection({ messageId: message.id, format });
                      }}
                    >
                      <option value="compact">
                        {frontDeskText('artifact_revision_compact', locale)}
                      </option>
                      <option value="readable">
                        {frontDeskText('artifact_revision_readable', locale)}
                      </option>
                    </select>
                  </label>
                  <div className="button-row">
                    <button
                      type="submit"
                      className="action-button"
                      disabled={
                        busy || !artifactRevisionForMessage(message, revisionSelection.format)
                      }
                    >
                      {frontDeskText('artifact_revision_submit', locale)}
                    </button>
                    <button
                      type="button"
                      className="action-button secondary"
                      onClick={() => setRevisionSelection(null)}
                    >
                      {frontDeskText('artifact_revision_cancel', locale)}
                    </button>
                  </div>
                </form>
              ) : null}
              {actionable && actions.length > 0 ? (
                <div className="button-row">
                  {actions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      className={`action-button${action.id === 'confirm' ? '' : ' secondary'}`}
                      disabled={busy || historyState !== 'ready' || !storageVerified}
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
      {historyState === 'ready' && messages.length === 0 ? (
        <div className="dock-quick-row" role="group" aria-label={t('dock.quick.label')}>
          {QUICK_REQUEST_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className="dock-quick-chip"
              disabled={busy || historyState !== 'ready' || !storageVerified}
              onClick={() => void send(t(key))}
            >
              {t(key)}
            </button>
          ))}
        </div>
      ) : null}
      {pendingRequest.current?.payload.artifactRevision ? (
        <div className="button-row">
          <button
            type="button"
            className="action-button secondary"
            disabled={busy || historyState !== 'ready' || !storageVerified}
            onClick={() => {
              const pending = pendingRequest.current;
              if (pending?.payload.artifactRevision)
                void send(pending.text, pending.payload.artifactRevision);
            }}
          >
            {frontDeskText('artifact_revision_retry', locale)}
          </button>
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
            disabled={busy || historyState !== 'ready' || !storageVerified}
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
          value={historyState === 'ready' ? draft : ''}
          placeholder={t('dock.placeholder')}
          aria-label={t('dock.placeholder')}
          onChange={(event) => storeDraft(event.target.value)}
          maxLength={8192}
          disabled={
            historyState !== 'ready' || Boolean(pendingRequest.current?.payload.artifactRevision)
          }
        />
        <button
          type="submit"
          className="action-button"
          disabled={
            busy ||
            historyState !== 'ready' ||
            !storageVerified ||
            !draft.trim() ||
            Boolean(pendingRequest.current?.payload.artifactRevision)
          }
        >
          {t('dock.send')}
        </button>
      </form>
    </aside>
  );
}

export function parseConversationMessageResponse(
  value: unknown
): Partial<ConversationMessageResponse> & { error?: string } {
  if (!isSafeConversationResponseTree(value)) {
    return { error: 'The conversation response was invalid.' };
  }
  const raw = value as Record<string, unknown>;
  const reply = typeof raw.reply === 'string' ? raw.reply.trim() : undefined;
  const mode =
    raw.mode === 'voice-hub' ||
    raw.mode === 'orchestrator' ||
    raw.mode === 'intake' ||
    raw.mode === 'unavailable' ||
    raw.mode === 'history'
      ? raw.mode
      : undefined;
  const shape =
    raw.shape === 'clarification' ||
    raw.shape === 'execution_preview' ||
    raw.shape === 'status_summary' ||
    raw.shape === 'delivery_summary' ||
    raw.shape === 'reply'
      ? raw.shape
      : undefined;
  if (!reply || !mode || !shape) {
    return { error: 'The conversation response was invalid.' };
  }
  if (mode === 'history')
    return {
      reply,
      mode,
      shape: 'reply',
      ...(typeof raw.historySaved === 'boolean' ? { historySaved: raw.historySaved } : {}),
    };
  const intentResolution = parseIntentResolutionContract(raw.intentResolution);
  const nextActions = Array.isArray(raw.nextActions)
    ? raw.nextActions.flatMap((action): ConversationNextAction[] => {
        if (!action || typeof action !== 'object' || Array.isArray(action)) return [];
        const candidate = action as Record<string, unknown>;
        return typeof candidate.id === 'string' &&
          candidate.id.trim() &&
          typeof candidate.label === 'string' &&
          candidate.label.trim()
          ? [{ id: candidate.id, label: candidate.label }]
          : [];
      })
    : undefined;
  const promoted =
    raw.promoted && typeof raw.promoted === 'object' && !Array.isArray(raw.promoted)
      ? (() => {
          const candidate = raw.promoted as Record<string, unknown>;
          return isConversationPromotionKind(candidate.kind) &&
            typeof candidate.label === 'string' &&
            candidate.label.trim()
            ? { kind: candidate.kind, label: candidate.label }
            : undefined;
        })()
      : undefined;
  return {
    reply,
    mode,
    shape,
    ...(promoted ? { promoted } : {}),
    ...(nextActions ? { nextActions } : {}),
    ...(intentResolution ? { intentResolution } : {}),
    ...(typeof raw.historySaved === 'boolean' ? { historySaved: raw.historySaved } : {}),
  };
}

const CONVERSATION_RESPONSE_DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeConversationResponseTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isSafeConversationResponseTree);
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(
    ([key, nested]) =>
      !CONVERSATION_RESPONSE_DANGEROUS_KEYS.has(key) && isSafeConversationResponseTree(nested)
  );
}

function isConversationPromotionKind(value: unknown): value is ConversationPromotion['kind'] {
  return value === 'mission' || value === 'task_session';
}

/** Pure recovery policy shared by the POST handler and regression tests. */
export function conversationFailurePolicy(
  status: number,
  raw: Record<string, unknown>
): { uncertain: boolean; invalidateHistory: boolean; messageKey: FrontDeskMessageKey | undefined } {
  const messageKey =
    raw.error === 'conversation_not_started' ||
    raw.error === 'conversation_scope_selection_required' ||
    raw.error === 'conversation_capability_unsupported' ||
    raw.error === 'conversation_revision_conflict' ||
    raw.error === 'conversation_revision_target_unavailable' ||
    raw.error === 'conversation_invalid_revision'
      ? raw.error
      : undefined;
  return {
    uncertain: raw.retry_safe !== true,
    invalidateHistory:
      status === 401 ||
      status === 403 ||
      (status === 409 && raw.error === 'conversation_scope_changed'),
    messageKey,
  };
}
