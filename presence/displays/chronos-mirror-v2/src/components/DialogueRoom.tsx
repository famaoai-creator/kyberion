'use client';

import * as React from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronLeft,
  FileText,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import {
  dt,
  fetchDiscussionRooms,
  patchDiscussionRoom,
  PHASE_STEPS,
  roleLabel,
  sendDiscussionCommand,
  STATUS_LABELS,
  type DiscussionLocale,
  type DiscussionRoomState,
  type DiscussionRoomSummary,
} from '../lib/discussion-client';
import { ChatPane, type ComposerHandle } from './DialogueChat';
import { OutcomesCard } from './DiscussionOutcomes';
import { Avatar, participantColor } from './DiscussionPanes';
import './discussion-room.css';
import './dialogue-room.css';

/* ------------------------------------------------------- conversation list -- */

function ConversationList({
  activeId,
  locale,
  canSteer,
  onOpen,
  onNew,
}: {
  activeId: string;
  locale: DiscussionLocale;
  canSteer: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = React.useState('');
  const [archived, setArchived] = React.useState(false);
  const [rooms, setRooms] = React.useState<DiscussionRoomSummary[] | null>(null);

  const refresh = React.useCallback(async () => {
    const result = await fetchDiscussionRooms({
      mode: 'dialogue',
      archived,
      ...(query.trim() ? { q: query.trim() } : {}),
    });
    if (result.ok && result.data) setRooms(result.data.rooms);
  }, [archived, query]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), query ? 220 : 0);
    const poll = window.setInterval(() => void refresh(), 6000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
    };
  }, [refresh, query]);

  return (
    <aside className="dr-pane dl-list" aria-label={dt('convos', locale)}>
      <header className="dl-list__head">
        <h2>{dt('convos', locale)}</h2>
        <button type="button" className="dr-btn dr-btn--primary" onClick={onNew}>
          <Plus size={14} aria-hidden /> {dt('newConvo', locale)}
        </button>
      </header>
      <label className="dl-search">
        <Search size={14} aria-hidden />
        <input
          type="search"
          value={query}
          placeholder={dt('searchConvos', locale)}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <ul className="dl-list__items">
        {rooms === null ? null : rooms.length === 0 ? (
          <li className="dr-muted dl-list__empty">{dt('noMatches', locale)}</li>
        ) : (
          rooms.map((room) => (
            <li key={room.id} data-active={room.id === activeId ? 'true' : undefined}>
              <button type="button" className="dl-list__item" onClick={() => onOpen(room.id)}>
                <span className="dl-list__title">{room.title || dt('untitled', locale)}</span>
                <span className="dl-list__preview">{room.last_message_preview}</span>
                <span className="dl-list__meta">
                  <span className="dl-bar" aria-hidden>
                    <i style={{ width: `${Math.round(room.readiness * 100)}%` }} />
                  </span>
                  <span className="dr-muted">
                    {STATUS_LABELS[room.status]?.[locale] ?? room.status}
                  </span>
                </span>
              </button>
              {canSteer ? (
                <button
                  type="button"
                  className="dl-list__archive"
                  title={room.archived ? dt('restore', locale) : dt('archive', locale)}
                  aria-label={room.archived ? dt('restore', locale) : dt('archive', locale)}
                  onClick={() =>
                    void patchDiscussionRoom(room.id, { archived: !room.archived }).then(refresh)
                  }
                >
                  {room.archived ? (
                    <ArchiveRestore size={13} aria-hidden />
                  ) : (
                    <Archive size={13} aria-hidden />
                  )}
                </button>
              ) : null}
            </li>
          ))
        )}
      </ul>
      <label className="dl-toggle">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
        {dt('showArchived', locale)}
      </label>
    </aside>
  );
}

/* ---------------------------------------------------------------- goal pane -- */

function ReadinessRing({ value, ready }: { value: number; ready: boolean }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      viewBox="0 0 90 90"
      className="dl-ring"
      role="img"
      aria-label={`${Math.round(value * 100)}%`}
    >
      <circle cx="45" cy="45" r={radius} className="dl-ring__track" />
      <circle
        cx="45"
        cy="45"
        r={radius}
        className="dl-ring__fill"
        data-ready={ready ? 'true' : undefined}
        strokeDasharray={`${circumference * value} ${circumference}`}
        transform="rotate(-90 45 45)"
      />
      <text x="45" y="50" textAnchor="middle" className="dl-ring__value">
        {Math.round(value * 100)}
        <tspan className="dl-ring__unit">%</tspan>
      </text>
    </svg>
  );
}

function GoalList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="dr-card dl-goal-card">
      <div className="dr-card__title">{title}</div>
      {items.length === 0 ? (
        <p className="dr-muted dl-empty">{empty}</p>
      ) : (
        <ul className="dr-bullets">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GoalPane({
  room,
  locale,
  canSteer,
  onRoom,
  onMention,
  onFinalize,
  finalizing,
}: {
  room: DiscussionRoomState;
  locale: DiscussionLocale;
  canSteer: boolean;
  onRoom: (room: DiscussionRoomState) => void;
  onMention: (role: string) => void;
  onFinalize: () => void;
  finalizing: boolean;
}) {
  const goal = room.dialogue;
  const ended = room.status === 'concluded';
  const stepIndex = room.status === 'concluded' ? 2 : room.phase === 'converging' ? 1 : 0;
  const steps = [
    dt('phaseOrganize', locale),
    dt('phaseConverge', locale),
    dt('phaseDecided', locale),
  ];
  const teammates = room.participants.filter((p) => p.role !== 'facilitator');
  void PHASE_STEPS;

  return (
    <section className="dr-pane dl-goal" aria-label={dt('goalTitle', locale)}>
      <header className="dr-pane__head">
        <Sparkles size={16} aria-hidden />
        <h2>{dt('goalTitle', locale)}</h2>
      </header>

      <div className="dr-card dl-progress">
        <ReadinessRing value={goal.readiness} ready={goal.ready} />
        <div className="dl-progress__side">
          <div className="dr-card__title">{dt('readiness', locale)}</div>
          <ol className="dl-steps" aria-label="phase">
            {steps.map((label, index) => (
              <li
                key={label}
                data-state={
                  index < stepIndex || ended ? 'done' : index === stepIndex ? 'current' : 'todo'
                }
              >
                <span>
                  {index < stepIndex || ended ? <Check size={11} aria-hidden /> : index + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
        </div>
      </div>

      {goal.objective ? (
        <div className="dr-card dl-goal-card">
          <div className="dr-card__title">{dt('objective', locale)}</div>
          <p className="dl-objective">{goal.objective}</p>
        </div>
      ) : null}

      <GoalList
        title={dt('criteria', locale)}
        items={goal.success_criteria}
        empty={dt('nothingYet', locale)}
      />
      <GoalList
        title={dt('constraintsTitle', locale)}
        items={[...goal.constraints, ...goal.assumptions]}
        empty={dt('nothingYet', locale)}
      />
      <GoalList
        title={dt('decisionsTitle', locale)}
        items={goal.decisions}
        empty={dt('nothingYet', locale)}
      />

      {goal.questions.length > 0 ? (
        <div className="dr-card dl-goal-card">
          <div className="dr-card__title">{dt('questionsTitle', locale)}</div>
          <ul className="dl-questions">
            {goal.questions.map((question) => (
              <li key={question.id} data-status={question.status}>
                <span className="dl-questions__mark" aria-hidden>
                  {question.status === 'resolved' ? <Check size={11} /> : null}
                </span>
                <span>{question.text}</span>
                {question.blocking && question.status === 'open' ? (
                  <span className="dr-pill" data-tone="warning">
                    {dt('blockingTag', locale)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {room.decision ? (
        <OutcomesCard room={room} locale={locale} canSteer={canSteer} onRoom={onRoom} />
      ) : (
        <div className="dl-finalize" data-ready={goal.ready ? 'true' : undefined}>
          <p className="dr-muted">
            {goal.ready ? dt('draftBriefReady', locale) : dt('draftBriefEarly', locale)}
          </p>
          <button
            type="button"
            className="dr-btn dr-btn--primary dl-finalize__btn"
            disabled={!canSteer || finalizing || room.status === 'stopped'}
            onClick={onFinalize}
          >
            <FileText size={14} aria-hidden />{' '}
            {finalizing ? dt('draftingBrief', locale) : dt('draftBrief', locale)}
          </button>
        </div>
      )}

      {teammates.length > 0 && !ended ? (
        <div className="dr-card dl-goal-card">
          <div className="dr-card__title">{dt('teamConsult', locale)}</div>
          <div className="dl-team">
            {teammates.map((p) => (
              <button
                type="button"
                key={p.id}
                onClick={() => onMention(p.role)}
                disabled={!canSteer}
                title={p.name}
              >
                <Avatar role={p.role} color={participantColor(room, p.id)} size={22} />
                {roleLabel(p.role, locale)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------- help dialog -- */

function HelpDialog({ locale, onClose }: { locale: DiscussionLocale; onClose: () => void }) {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const lines = ['helpSend', 'helpEdit', 'helpStop', 'helpSlash', 'helpAttach'] as const;
  return (
    <div
      className="dr-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={dt('helpTitle', locale)}
      onClick={onClose}
    >
      <div className="dl-help" onClick={(e) => e.stopPropagation()}>
        <header>
          <strong>{dt('helpTitle', locale)}</strong>
          <button
            type="button"
            className="dr-iconbtn"
            onClick={onClose}
            aria-label={dt('closeDialog', locale)}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <ul>
          {lines.map((line) => (
            <li key={line}>{dt(line, locale)}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the view -- */

export function DialogueView({
  room,
  locale,
  canSteer,
  connection,
  onRoom,
  onOpen,
  onNew,
  onBack,
}: {
  room: DiscussionRoomState;
  locale: DiscussionLocale;
  canSteer: boolean;
  connection: string;
  onRoom: (room: DiscussionRoomState) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onBack: () => void;
}) {
  const composer = React.useRef<ComposerHandle | null>(null);
  const [help, setHelp] = React.useState(false);
  const [finalizing, setFinalizing] = React.useState(false);

  const finalize = React.useCallback(async () => {
    if (!room.dialogue.ready && !window.confirm(dt('draftBriefEarly', locale))) return;
    setFinalizing(true);
    const result = await sendDiscussionCommand(room.id, { kind: 'finalize' });
    setFinalizing(false);
    if (result.ok && result.data?.room) onRoom(result.data.room);
  }, [room.id, room.dialogue.ready, locale, onRoom]);

  // Finalizing is over once the decision (or a reopened room) shows up.
  React.useEffect(() => {
    if (room.decision) setFinalizing(false);
  }, [room.decision]);

  return (
    <div className="dl-room" data-status={room.status}>
      <div className="dl-topbar">
        <button
          type="button"
          className="dr-iconbtn"
          onClick={onBack}
          aria-label={dt('back', locale)}
          title={dt('back', locale)}
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
        <span className="dr-top__eyebrow">
          <Sparkles size={13} aria-hidden /> {dt('dialogueBadge', locale)}
          {room.scope.tenant_slug ? (
            <span className="dr-pill">{room.scope.tenant_slug}</span>
          ) : null}
          {room.scope.mission_id ? (
            <span className="dr-pill">
              {dt('missionLinked', locale)}: {room.scope.mission_id}
            </span>
          ) : null}
        </span>
        <span className="dr-status" data-status={room.status}>
          <i aria-hidden />
          {STATUS_LABELS[room.status]?.[locale] ?? room.status}
        </span>
      </div>
      <div className="dl-grid">
        <ConversationList
          activeId={room.id}
          locale={locale}
          canSteer={canSteer}
          onOpen={onOpen}
          onNew={onNew}
        />
        <ChatPane
          room={room}
          locale={locale}
          canSteer={canSteer}
          connection={connection}
          onRoom={onRoom}
          composerRef={composer}
          onHelp={() => setHelp(true)}
          onFinalize={() => void finalize()}
        />
        <GoalPane
          room={room}
          locale={locale}
          canSteer={canSteer}
          onRoom={onRoom}
          onMention={(role) => composer.current?.insertMention(role)}
          onFinalize={() => void finalize()}
          finalizing={finalizing}
        />
      </div>
      {help ? <HelpDialog locale={locale} onClose={() => setHelp(false)} /> : null}
    </div>
  );
}
