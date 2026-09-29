'use client';

import * as React from 'react';
import { ArrowLeft, Check, Gavel, Radio, Rocket, Sparkles, Users } from 'lucide-react';
import { useChronosLocale } from '../lib/hooks';
import {
  createDiscussion,
  DISCUSSION_EXAMPLES,
  dt,
  fetchDiscussionRooms,
  PHASE_STEPS,
  STATUS_LABELS,
  useDiscussionStream,
  type DiscussionLocale,
  type DiscussionRoomState,
  type DiscussionRoomSummary,
} from '../lib/discussion-client';
import { CommandCenter, ConversationPane, RosterPane, SituationPane } from './DiscussionPanes';
import './discussion-room.css';

const TEMPO: Array<{
  id: 'fast' | 'normal' | 'slow';
  ms: number;
  key: 'tempoFast' | 'tempoNormal' | 'tempoSlow';
}> = [
  { id: 'fast', ms: 700, key: 'tempoFast' },
  { id: 'normal', ms: 1800, key: 'tempoNormal' },
  { id: 'slow', ms: 3200, key: 'tempoSlow' },
];

function readRoomParam(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('room');
}

function writeRoomParam(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('room', id);
  else url.searchParams.delete('room');
  window.history.replaceState(null, '', url.toString());
}

export function DiscussionRoom() {
  const chronosLocale = useChronosLocale();
  const [override, setOverride] = React.useState<DiscussionLocale | null>(null);
  const locale: DiscussionLocale = override ?? (chronosLocale === 'ja' ? 'ja' : 'en');
  const [roomId, setRoomId] = React.useState<string | null>(null);
  const [canSteer, setCanSteer] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    setRoomId(readRoomParam());
    setHydrated(true);
  }, []);

  const open = (id: string | null) => {
    setRoomId(id);
    writeRoomParam(id);
  };

  if (!hydrated) return <div className="dr-root" aria-busy="true" />;
  return (
    <div className="dr-root" data-locale={locale}>
      {roomId ? (
        <RoomView roomId={roomId} locale={locale} canSteer={canSteer} onBack={() => open(null)} />
      ) : (
        <Launcher locale={locale} onLocale={setOverride} onOpen={open} onAccess={setCanSteer} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------- launcher -- */

function Launcher({
  locale,
  onLocale,
  onOpen,
  onAccess,
}: {
  locale: DiscussionLocale;
  onLocale: (locale: DiscussionLocale) => void;
  onOpen: (id: string) => void;
  onAccess: (canSteer: boolean) => void;
}) {
  const [goal, setGoal] = React.useState('');
  const [tempo, setTempo] = React.useState<'fast' | 'normal' | 'slow'>('normal');
  const [speaker, setSpeaker] = React.useState<'auto' | 'scripted' | 'reasoning'>('auto');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [rooms, setRooms] = React.useState<DiscussionRoomSummary[] | null>(null);

  const refresh = React.useCallback(async () => {
    const result = await fetchDiscussionRooms();
    if (result.ok && result.data) {
      setRooms(result.data.rooms);
      onAccess(result.data.accessRole === 'localadmin');
    } else if (!result.ok) {
      setRooms([]);
    }
  }, [onAccess]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await createDiscussion({
      goal: goal.trim(),
      locale,
      speaker,
      turn_delay_ms: TEMPO.find((t) => t.id === tempo)?.ms ?? 1800,
    });
    setBusy(false);
    if (!result.ok || !result.data) {
      setError(result.error ?? 'failed');
      return;
    }
    onOpen(result.data.room.id);
  };

  return (
    <div className="dr-launcher">
      <header className="dr-hero">
        <a className="dr-hero__back" href="/">
          <ArrowLeft size={14} aria-hidden /> Chronos
        </a>
        <div className="dr-langs" role="radiogroup" aria-label="language">
          {(['ja', 'en'] as const).map((code) => (
            <button
              type="button"
              key={code}
              role="radio"
              aria-checked={locale === code}
              data-active={locale === code ? 'true' : undefined}
              onClick={() => onLocale(code)}
            >
              {code.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="dr-hero__mark" aria-hidden>
          <Users size={22} />
        </div>
        <h1>{dt('title', locale)}</h1>
        <p>{dt('subtitle', locale)}</p>
      </header>

      <form className="dr-launch-card" onSubmit={start}>
        <label className="dr-launch-card__label" htmlFor="dr-goal">
          {dt('goalLabel', locale)}
        </label>
        <textarea
          id="dr-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={dt('goalPlaceholder', locale)}
          rows={3}
          maxLength={2000}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void start(e);
          }}
        />
        <div className="dr-examples">
          <span className="dr-muted">{dt('examples', locale)}</span>
          {DISCUSSION_EXAMPLES[locale].map((example) => (
            <button type="button" key={example} onClick={() => setGoal(example)}>
              {example}
            </button>
          ))}
        </div>
        <div className="dr-launch-card__options">
          <div className="dr-seg" role="radiogroup" aria-label={dt('tempo', locale)}>
            <span className="dr-muted">{dt('tempo', locale)}</span>
            {TEMPO.map((t) => (
              <button
                type="button"
                key={t.id}
                role="radio"
                aria-checked={tempo === t.id}
                data-active={tempo === t.id ? 'true' : undefined}
                onClick={() => setTempo(t.id)}
              >
                {dt(t.key, locale)}
              </button>
            ))}
          </div>
          <label className="dr-field dr-field--inline">
            <span>{dt('engine', locale)}</span>
            <select value={speaker} onChange={(e) => setSpeaker(e.target.value as typeof speaker)}>
              <option value="auto">{dt('engineAuto', locale)}</option>
              <option value="scripted">{dt('engineScripted', locale)}</option>
              <option value="reasoning">{dt('engineReasoning', locale)}</option>
            </select>
          </label>
          <button
            type="submit"
            className="dr-btn dr-btn--primary dr-btn--lg"
            disabled={busy || !goal.trim()}
          >
            <Rocket size={16} aria-hidden /> {busy ? dt('starting', locale) : dt('start', locale)}
          </button>
        </div>
        {error ? (
          <div className="dr-note" data-tone="danger" role="alert">
            {error}
          </div>
        ) : null}
      </form>

      <section className="dr-recent">
        <h2>{dt('recent', locale)}</h2>
        {rooms === null ? null : rooms.length === 0 ? (
          <p className="dr-muted">{dt('noRooms', locale)}</p>
        ) : (
          <ul>
            {rooms.map((room) => (
              <li key={room.id}>
                <button type="button" onClick={() => onOpen(room.id)}>
                  <span className="dr-recent__status" data-status={room.status} />
                  <span className="dr-recent__goal">{room.title}</span>
                  <span className="dr-muted">
                    {STATUS_LABELS[room.status]?.[locale] ?? room.status} · {room.message_count} ·{' '}
                    {Math.round(room.consensus * 100)}%
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* --------------------------------------------------------- room view -- */

function RoomView({
  roomId,
  locale,
  canSteer,
  onBack,
}: {
  roomId: string;
  locale: DiscussionLocale;
  canSteer: boolean;
  onBack: () => void;
}) {
  const { room, connection, error, setRoom } = useDiscussionStream(roomId);
  const [access, setAccess] = React.useState(canSteer);
  // The room speaks in the language it was opened in, whatever the console locale.
  const roomLocale: DiscussionLocale = room?.config.locale ?? locale;

  React.useEffect(() => {
    void fetchDiscussionRooms().then((result) => {
      if (result.ok && result.data) setAccess(result.data.accessRole === 'localadmin');
    });
  }, []);

  if (error) {
    return (
      <div className="dr-launcher">
        <button type="button" className="dr-btn" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden /> {dt('back', locale)}
        </button>
        <div className="dr-note" data-tone="danger" role="alert">
          {error}
        </div>
      </div>
    );
  }
  if (!room) {
    return (
      <div className="dr-launcher">
        <div className="dr-forming" role="status">
          <span className="dr-forming__pulse" />
          <p>{dt('connecting', locale)}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="dr-room" data-status={room.status}>
      <TopBar room={room} locale={roomLocale} connection={connection} onBack={onBack} />
      <div className="dr-grid">
        <RosterPane room={room} locale={roomLocale} />
        <ConversationPane room={room} locale={roomLocale} />
        <div className="dr-side">
          <SituationPane room={room} locale={roomLocale} />
          <CommandCenter
            room={room}
            locale={roomLocale}
            canSteer={access}
            onRoom={(next: DiscussionRoomState) => setRoom(next)}
          />
        </div>
      </div>
    </div>
  );
}

function TopBar({
  room,
  locale,
  connection,
  onBack,
}: {
  room: DiscussionRoomState;
  locale: DiscussionLocale;
  connection: string;
  onBack: () => void;
}) {
  const phaseIndex = Math.max(
    0,
    PHASE_STEPS.findIndex((s) => s.id === room.phase)
  );
  const done = room.status === 'concluded';
  return (
    <header className="dr-top">
      <div className="dr-top__left">
        <button
          type="button"
          className="dr-iconbtn"
          onClick={onBack}
          aria-label={dt('back', locale)}
          title={dt('back', locale)}
        >
          <ArrowLeft size={16} aria-hidden />
        </button>
        <div className="dr-top__titles">
          <div className="dr-top__eyebrow">
            <Sparkles size={13} aria-hidden /> {dt('title', locale)}
            {room.scope.tenant_slug ? (
              <span className="dr-pill">
                {dt('scope', locale)}: {room.scope.tenant_slug}
              </span>
            ) : null}
          </div>
          <h1 title={room.goal}>{room.title}</h1>
        </div>
      </div>

      <ol className="dr-steps" aria-label="phase">
        {PHASE_STEPS.map((step, index) => (
          <li
            key={step.id}
            data-state={
              index < phaseIndex || done ? 'done' : index === phaseIndex ? 'current' : 'todo'
            }
          >
            <span className="dr-steps__mark">
              {index < phaseIndex || done ? <Check size={11} aria-hidden /> : index + 1}
            </span>
            <span className="dr-steps__label">
              {locale === 'ja' ? step.ja : step.en}
              {step.id === 'exploring' && room.round > 0
                ? ` ${room.round}/${room.config.max_rounds}`
                : ''}
            </span>
          </li>
        ))}
      </ol>

      <div className="dr-top__right">
        <span className="dr-status" data-status={room.status}>
          <i aria-hidden />
          {STATUS_LABELS[room.status]?.[locale] ?? room.status}
        </span>
        <span
          className="dr-live"
          data-connection={connection}
          title={dt('engineMode', locale) + ': ' + room.config.speaker}
        >
          <Radio size={12} aria-hidden />
          {connection === 'live'
            ? dt('live', locale)
            : connection === 'ended'
              ? dt('ended', locale)
              : dt('connecting', locale)}
        </span>
        {room.decision ? <Gavel size={16} aria-hidden className="dr-top__gavel" /> : null}
      </div>
    </header>
  );
}
