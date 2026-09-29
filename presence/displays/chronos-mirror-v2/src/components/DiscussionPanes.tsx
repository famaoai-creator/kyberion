'use client';

import * as React from 'react';
import {
  Bot,
  CheckCircle2,
  Compass,
  CornerDownRight,
  Flag,
  Flame,
  Gavel,
  ListChecks,
  NotebookPen,
  Pause,
  Play,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Target,
  User,
  Users,
  Vote,
  Wrench,
} from 'lucide-react';
import {
  dt,
  roleLabel,
  sendDiscussionCommand,
  STATUS_LABELS,
  type DiscussionLocale,
  type DiscussionRoomState,
} from '../lib/discussion-client';
import './discussion-room.css';

type Participant = DiscussionRoomState['participants'][number];
type Message = DiscussionRoomState['messages'][number];

const ROLE_ICONS: Record<
  string,
  React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>
> = {
  facilitator: Compass,
  researcher: Search,
  devils_advocate: Flame,
  scribe: NotebookPen,
  planner: ListChecks,
  reviewer: ShieldCheck,
  implementer: Wrench,
  tester: CheckCircle2,
};

export function participantColor(room: DiscussionRoomState, participantId: string): string {
  const index = room.participants.findIndex((p) => p.id === participantId);
  return `var(--kb-ui-viz-cat-${((index < 0 ? 0 : index) % 8) + 1})`;
}

export function Avatar({
  role,
  color,
  size = 36,
  speaking,
  human,
}: {
  role?: string;
  color: string;
  size?: number;
  speaking?: boolean;
  human?: boolean;
}) {
  const Icon = human ? User : (role && ROLE_ICONS[role]) || Bot;
  return (
    <span
      className="dr-avatar"
      data-speaking={speaking ? 'true' : undefined}
      style={{ ['--dr-color' as string]: color, width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.5)} aria-hidden />
    </span>
  );
}

function stanceLabel(stance: string | undefined, locale: DiscussionLocale): string {
  switch (stance) {
    case 'support':
      return dt('stancesSupport', locale);
    case 'oppose':
      return dt('stancesOppose', locale);
    case 'question':
      return dt('stancesQuestion', locale);
    default:
      return dt('stancesNeutral', locale);
  }
}

function speakerName(room: DiscussionRoomState, id: string, locale: DiscussionLocale): string {
  const participant = room.participants.find((p) => p.id === id);
  return participant ? roleLabel(participant.role, locale) : id;
}

/* ------------------------------------------------------------ roster -- */

export function RosterPane({
  room,
  locale,
}: {
  room: DiscussionRoomState;
  locale: DiscussionLocale;
}) {
  return (
    <aside className="dr-pane dr-roster" aria-label={dt('team', locale)}>
      <header className="dr-pane__head">
        <Users size={16} aria-hidden />
        <h2>{dt('team', locale)}</h2>
        <span className="dr-pane__count">{room.participants.length}</span>
      </header>
      {room.participants.length === 0 ? (
        <div className="dr-forming" role="status">
          <span className="dr-forming__pulse" />
          <p>{STATUS_LABELS.forming[locale]}</p>
        </div>
      ) : (
        <ul className="dr-roster__list">
          {room.participants.map((p) => (
            <RosterCard key={p.id} room={room} participant={p} locale={locale} />
          ))}
        </ul>
      )}
      {room.staffing_gaps.length > 0 ? (
        <div className="dr-note" data-tone="warning">
          <strong>{dt('gaps', locale)}</strong>
          <ul>
            {room.staffing_gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <AgendaList room={room} locale={locale} />
    </aside>
  );
}

function RosterCard({
  room,
  participant,
  locale,
}: {
  room: DiscussionRoomState;
  participant: Participant;
  locale: DiscussionLocale;
}) {
  const color = participantColor(room, participant.id);
  const speaking = room.speaking === participant.id;
  const stance = room.stance_by_speaker[participant.id];
  return (
    <li
      className="dr-member"
      data-speaking={speaking ? 'true' : undefined}
      style={{ ['--dr-color' as string]: color }}
    >
      <Avatar role={participant.role} color={color} speaking={speaking} />
      <div className="dr-member__body">
        <div className="dr-member__role">{roleLabel(participant.role, locale)}</div>
        <div className="dr-member__agent" title={participant.rationale}>
          {participant.name}
        </div>
        <div className="dr-member__meta">
          {speaking ? (
            <span className="dr-typing-label">{dt('thinking', locale)}</span>
          ) : stance ? (
            <span className="dr-stance" data-stance={stance}>
              {stanceLabel(stance, locale)}
            </span>
          ) : (
            <span className="dr-muted">
              {dt('fit', locale)} {Math.round(participant.fit * 100)}%
            </span>
          )}
          <span className="dr-muted dr-member__count">
            {room.message_counts[participant.id] ?? 0}
          </span>
        </div>
      </div>
    </li>
  );
}

function AgendaList({ room, locale }: { room: DiscussionRoomState; locale: DiscussionLocale }) {
  if (room.agenda.length === 0) return null;
  return (
    <section className="dr-agenda">
      <header className="dr-pane__head dr-pane__head--sub">
        <Target size={15} aria-hidden />
        <h3>{dt('agenda', locale)}</h3>
      </header>
      <ol>
        {room.agenda.map((item) => (
          <li key={item.id} data-status={item.status}>
            <span className="dr-agenda__dot" aria-hidden />
            <span>{item.title}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------ conversation -- */

type TimelineItem =
  | { kind: 'message'; ts: string; message: Message }
  | { kind: 'summary'; ts: string; round: number; summary: string };

function buildTimeline(room: DiscussionRoomState): TimelineItem[] {
  const items: TimelineItem[] = [
    ...room.messages.map((message) => ({ kind: 'message' as const, ts: message.ts, message })),
    ...room.summaries.map((s) => ({
      kind: 'summary' as const,
      ts: s.ts,
      round: s.round,
      summary: s.summary,
    })),
  ];
  return items.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function ConversationPane({
  room,
  locale,
}: {
  room: DiscussionRoomState;
  locale: DiscussionLocale;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = React.useState(true);
  const [unseen, setUnseen] = React.useState(0);
  const timeline = React.useMemo(() => buildTimeline(room), [room]);
  const lastCount = React.useRef(0);
  const byId = React.useMemo(() => new Map(room.messages.map((m) => [m.id, m])), [room.messages]);

  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const added = timeline.length - lastCount.current;
    lastCount.current = timeline.length;
    if (pinned) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      setUnseen(0);
    } else if (added > 0) {
      setUnseen((n) => n + added);
    }
  }, [timeline.length, room.speaking, pinned]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setPinned(near);
    if (near) setUnseen(0);
  };

  let lastRound = 0;
  return (
    <section className="dr-pane dr-convo" aria-label={dt('conversation', locale)}>
      <header className="dr-pane__head">
        <Sparkles size={16} aria-hidden />
        <h2>{dt('conversation', locale)}</h2>
        <span className="dr-pane__count">{room.messages.length}</span>
      </header>
      <div className="dr-convo__scroll" ref={scroller} onScroll={onScroll} aria-live="polite">
        {timeline.length === 0 && !room.speaking ? (
          <div className="dr-forming" role="status">
            <span className="dr-forming__pulse" />
            <p>{STATUS_LABELS[room.status]?.[locale] ?? room.status}</p>
          </div>
        ) : null}
        {timeline.map((item) => {
          if (item.kind === 'summary') {
            return (
              <div className="dr-summary" key={`s-${item.round}-${item.ts}`}>
                <div className="dr-summary__label">
                  <Flag size={13} aria-hidden /> {dt('roundSummary', locale)} ·{' '}
                  {dt('round', locale)} {item.round}
                </div>
                <p>{item.summary}</p>
              </div>
            );
          }
          const m = item.message;
          const showRound = m.round !== lastRound;
          lastRound = m.round;
          return (
            <React.Fragment key={m.id}>
              {showRound ? (
                <div className="dr-round-divider" role="separator">
                  <span>
                    {dt('round', locale)} {m.round}
                  </span>
                </div>
              ) : null}
              <Bubble
                room={room}
                message={m}
                locale={locale}
                quoted={m.reply_to ? byId.get(m.reply_to) : undefined}
              />
            </React.Fragment>
          );
        })}
        {room.speaking ? (
          <TypingBubble room={room} speaker={room.speaking} locale={locale} />
        ) : null}
        {room.decision ? <DecisionBanner locale={locale} /> : null}
      </div>
      {unseen > 0 ? (
        <button
          type="button"
          className="dr-jump"
          onClick={() => {
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
            setPinned(true);
          }}
        >
          ↓ {unseen}
        </button>
      ) : null}
    </section>
  );
}

function Bubble({
  room,
  message,
  locale,
  quoted,
}: {
  room: DiscussionRoomState;
  message: Message;
  locale: DiscussionLocale;
  quoted?: Message;
}) {
  const human = message.kind === 'human';
  const participant = room.participants.find((p) => p.id === message.speaker);
  const color = human ? 'var(--kb-ui-accent)' : participantColor(room, message.speaker);
  const time = new Date(message.ts).toLocaleTimeString(locale === 'ja' ? 'ja-JP' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <article
      className="dr-bubble"
      data-kind={message.kind}
      data-stance={message.stance}
      style={{ ['--dr-color' as string]: color }}
    >
      <Avatar role={participant?.role} color={color} human={human} />
      <div className="dr-bubble__main">
        <header className="dr-bubble__meta">
          <strong>
            {human ? dt('you', locale) : roleLabel(participant?.role ?? message.speaker, locale)}
          </strong>
          {participant ? <span className="dr-muted">{participant.name}</span> : null}
          {message.stance ? (
            <span className="dr-stance" data-stance={message.stance}>
              {stanceLabel(message.stance, locale)}
            </span>
          ) : null}
          {message.performative ? <span className="dr-perf">{message.performative}</span> : null}
          <time className="dr-muted">{time}</time>
        </header>
        {quoted ? (
          <div className="dr-quote">
            <CornerDownRight size={12} aria-hidden />
            <span>
              {quoted.kind === 'human'
                ? dt('you', locale)
                : speakerName(room, quoted.speaker, locale)}
              :
            </span>
            <span className="dr-quote__text">{quoted.text}</span>
          </div>
        ) : null}
        <p className="dr-bubble__text">{message.text}</p>
        {message.mentions?.length ? (
          <div className="dr-mentions">
            {message.mentions.map((id) => (
              <span key={id}>@{speakerName(room, id, locale)}</span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function TypingBubble({
  room,
  speaker,
  locale,
}: {
  room: DiscussionRoomState;
  speaker: string;
  locale: DiscussionLocale;
}) {
  const participant = room.participants.find((p) => p.id === speaker);
  const color = participantColor(room, speaker);
  return (
    <article className="dr-bubble dr-bubble--typing" style={{ ['--dr-color' as string]: color }}>
      <Avatar role={participant?.role} color={color} speaking />
      <div className="dr-bubble__main">
        <header className="dr-bubble__meta">
          <strong>{roleLabel(participant?.role ?? speaker, locale)}</strong>
          <span className="dr-muted">{dt('thinking', locale)}</span>
        </header>
        <div className="dr-dots" aria-hidden>
          <i />
          <i />
          <i />
        </div>
      </div>
    </article>
  );
}

function DecisionBanner({ locale }: { locale: DiscussionLocale }) {
  return (
    <div className="dr-decision-banner">
      <Gavel size={16} aria-hidden /> {dt('decision', locale)} → {dt('situation', locale)}
    </div>
  );
}

/* --------------------------------------------------------- situation -- */

function ConsensusGauge({ value, threshold }: { value: number; threshold: number }) {
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const arc = circumference * 0.75; // 270° gauge
  const filled = arc * Math.max(0, Math.min(1, value));
  const tickAngle = 135 + 270 * threshold;
  const rad = (tickAngle * Math.PI) / 180;
  const tick = {
    x1: 60 + (radius - 7) * Math.cos(rad),
    y1: 60 + (radius - 7) * Math.sin(rad),
    x2: 60 + (radius + 7) * Math.cos(rad),
    y2: 60 + (radius + 7) * Math.sin(rad),
  };
  return (
    <svg
      viewBox="0 0 120 120"
      className="dr-gauge"
      role="img"
      aria-label={`${Math.round(value * 100)}%`}
    >
      <circle
        cx="60"
        cy="60"
        r={radius}
        className="dr-gauge__track"
        strokeDasharray={`${arc} ${circumference}`}
        transform="rotate(135 60 60)"
      />
      <circle
        cx="60"
        cy="60"
        r={radius}
        className="dr-gauge__fill"
        strokeDasharray={`${filled} ${circumference}`}
        transform="rotate(135 60 60)"
        data-reached={value >= threshold ? 'true' : undefined}
      />
      <line {...tick} className="dr-gauge__tick" />
      <text x="60" y="64" textAnchor="middle" className="dr-gauge__value">
        {Math.round(value * 100)}
        <tspan className="dr-gauge__unit">%</tspan>
      </text>
    </svg>
  );
}

function Trend({ points, max }: { points: Array<{ round: number; value: number }>; max: number }) {
  if (points.length === 0) return <div className="dr-trend dr-trend--empty" />;
  const width = 220;
  const height = 56;
  const pad = 8;
  const xs = (i: number) =>
    points.length === 1
      ? width / 2
      : pad + (i * (width - pad * 2)) / (Math.max(max, points.length) - 1 || 1);
  const ys = (v: number) => height - pad - v * (height - pad * 2);
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`)
    .join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="dr-trend" role="img">
      <line x1={pad} x2={width - pad} y1={ys(0.8)} y2={ys(0.8)} className="dr-trend__threshold" />
      <path d={path} className="dr-trend__line" />
      {points.map((p, i) => (
        <circle key={p.round} cx={xs(i)} cy={ys(p.value)} r="3.5" className="dr-trend__dot" />
      ))}
    </svg>
  );
}

export function SituationPane({
  room,
  locale,
}: {
  room: DiscussionRoomState;
  locale: DiscussionLocale;
}) {
  const voters = room.participants.filter((p) => p.role !== 'facilitator' && p.role !== 'scribe');
  const decisionRef = React.useRef<HTMLDivElement>(null);
  const decided = Boolean(room.decision);
  React.useEffect(() => {
    if (decided) decisionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [decided]);
  return (
    <section className="dr-pane dr-situation" aria-label={dt('situation', locale)}>
      <header className="dr-pane__head">
        <Target size={16} aria-hidden />
        <h2>{dt('situation', locale)}</h2>
      </header>

      {room.decision ? (
        <div className="dr-card dr-decision" data-tone="success" ref={decisionRef}>
          <div className="dr-card__title">
            <Gavel size={14} aria-hidden /> {dt('decision', locale)}
          </div>
          <p className="dr-decision__summary">{room.decision.summary}</p>
          <DecisionList title={dt('agreements', locale)} items={room.decision.agreements} />
          <DecisionList
            title={dt('dissent', locale)}
            items={room.decision.dissent}
            tone="warning"
          />
          <DecisionList title={dt('nextSteps', locale)} items={room.decision.next_steps} ordered />
        </div>
      ) : null}

      <div className="dr-card dr-consensus">
        <div className="dr-card__title">{dt('consensus', locale)}</div>
        <div className="dr-consensus__body">
          <ConsensusGauge value={room.consensus} threshold={room.config.consensus_threshold} />
          <div className="dr-consensus__side">
            <Trend points={room.consensus_history} max={room.config.max_rounds} />
            <div className="dr-muted dr-consensus__cap">{dt('consensusTrend', locale)}</div>
          </div>
        </div>
      </div>

      <div className="dr-card">
        <div className="dr-card__title">{dt('stanceMap', locale)}</div>
        <ul className="dr-stance-map">
          {voters.map((p) => {
            const stance = room.stance_by_speaker[p.id];
            return (
              <li key={p.id}>
                <span className="dr-dot" style={{ background: participantColor(room, p.id) }} />
                <span className="dr-stance-map__name">{roleLabel(p.role, locale)}</span>
                <span className="dr-stance" data-stance={stance ?? 'none'}>
                  {stance ? stanceLabel(stance, locale) : '—'}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {room.open_issues.length > 0 ? (
        <div className="dr-card" data-tone="warning">
          <div className="dr-card__title">{dt('openIssues', locale)}</div>
          <ul className="dr-bullets">
            {room.open_issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {room.agreements.length > 0 ? (
        <div className="dr-card" data-tone="success">
          <div className="dr-card__title">{dt('agreements', locale)}</div>
          <ul className="dr-bullets">
            {room.agreements.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {room.votes.length > 0 ? <VoteCards room={room} locale={locale} /> : null}

      {room.error ? (
        <div className="dr-card" data-tone="danger">
          <div className="dr-card__title">{dt('errorTitle', locale)}</div>
          <p>{room.error}</p>
        </div>
      ) : null}
    </section>
  );
}

function DecisionList({
  title,
  items,
  ordered,
  tone,
}: {
  title: string;
  items: string[];
  ordered?: boolean;
  tone?: 'warning';
}) {
  if (items.length === 0) return null;
  const List = ordered ? 'ol' : 'ul';
  return (
    <div className="dr-decision__group" data-tone={tone}>
      <div className="dr-decision__label">{title}</div>
      <List className="dr-bullets">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </List>
    </div>
  );
}

function VoteCards({ room, locale }: { room: DiscussionRoomState; locale: DiscussionLocale }) {
  return (
    <>
      {room.votes.map((vote) => {
        const total = Object.values(vote.tally).reduce((a, b) => a + b, 0) || 1;
        return (
          <div className="dr-card" key={vote.id} data-status={vote.status}>
            <div className="dr-card__title">
              <Vote size={14} aria-hidden /> {dt('votes', locale)}
              <span className="dr-pill">
                {vote.status === 'open' ? dt('live', locale) : dt('ended', locale)}
              </span>
            </div>
            <p className="dr-vote__q">{vote.question}</p>
            {vote.options.map((option) => {
              const count = vote.tally[option] ?? 0;
              return (
                <div
                  className="dr-bar"
                  key={option}
                  data-winner={vote.winner === option ? 'true' : undefined}
                >
                  <div className="dr-bar__label">
                    <span>{option}</span>
                    <span>{count}</span>
                  </div>
                  <div className="dr-bar__track">
                    <div className="dr-bar__fill" style={{ width: `${(count / total) * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

/* ---------------------------------------------------- command center -- */

type Mode = 'inject' | 'ask' | 'redirect' | 'vote';

export function CommandCenter({
  room,
  locale,
  canSteer,
  onRoom,
}: {
  room: DiscussionRoomState;
  locale: DiscussionLocale;
  canSteer: boolean;
  onRoom: (room: DiscussionRoomState) => void;
}) {
  const [mode, setMode] = React.useState<Mode>('inject');
  const [text, setText] = React.useState('');
  const [target, setTarget] = React.useState('');
  const [next, setNext] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmStop, setConfirmStop] = React.useState(false);
  const ended =
    room.status === 'concluded' || room.status === 'stopped' || room.status === 'failed';
  const paused = room.status === 'paused';
  const disabled = !canSteer || ended || busy;
  const openVote = [...room.votes].reverse().find((v) => v.status === 'open');
  const humanVoted = Boolean(openVote?.ballots.human);

  const send = async (command: Parameters<typeof sendDiscussionCommand>[1]) => {
    setBusy(true);
    setError(null);
    const result = await sendDiscussionCommand(room.id, command);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'failed');
      return false;
    }
    if (result.data?.room) onRoom(result.data.room);
    return true;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;
    const ok = await send({
      kind: mode === 'vote' ? 'open_vote' : mode,
      text: body,
      ...(mode === 'ask' || (mode === 'inject' && target) ? { target: target || undefined } : {}),
    });
    if (ok) setText('');
  };

  const placeholders: Record<Mode, string> = {
    inject: dt('messagePlaceholderInject', locale),
    ask: dt('messagePlaceholderAsk', locale),
    redirect: dt('messagePlaceholderRedirect', locale),
    vote: dt('messagePlaceholderVote', locale),
  };
  const modes: Array<{ id: Mode; label: string }> = [
    { id: 'inject', label: dt('modeInject', locale) },
    { id: 'ask', label: dt('modeAsk', locale) },
    { id: 'redirect', label: dt('modeRedirect', locale) },
    { id: 'vote', label: dt('modeVote', locale) },
  ];
  const targetable = room.participants;

  return (
    <section className="dr-pane dr-command" aria-label={dt('command', locale)}>
      <header className="dr-pane__head">
        <Gavel size={16} aria-hidden />
        <h2>{dt('command', locale)}</h2>
        {room.pending_commands.length > 0 ? (
          <span className="dr-pill" data-tone="warning">
            {room.pending_commands.length}
          </span>
        ) : null}
      </header>

      {!canSteer ? <div className="dr-note">{dt('readOnly', locale)}</div> : null}

      <div className="dr-controls">
        <button
          type="button"
          className="dr-btn"
          disabled={disabled}
          onClick={() => send({ kind: paused ? 'resume' : 'pause' })}
        >
          {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
          {paused ? dt('resume', locale) : dt('pause', locale)}
        </button>
        <button
          type="button"
          className="dr-btn"
          disabled={disabled}
          onClick={() => send({ kind: 'conclude' })}
        >
          <Flag size={14} aria-hidden /> {dt('conclude', locale)}
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--danger"
          disabled={disabled}
          onClick={async () => {
            if (!confirmStop) {
              setConfirmStop(true);
              setTimeout(() => setConfirmStop(false), 3000);
              return;
            }
            setConfirmStop(false);
            await send({ kind: 'stop' });
          }}
        >
          <Square size={14} aria-hidden />{' '}
          {confirmStop ? `${dt('stop', locale)}?` : dt('stop', locale)}
        </button>
      </div>

      {openVote && !humanVoted ? (
        <div className="dr-vote-call">
          <div className="dr-card__title">
            <Vote size={14} aria-hidden /> {dt('castVote', locale)}
          </div>
          <p>{openVote.question}</p>
          <div className="dr-vote-call__options">
            {openVote.options.map((option) => (
              <button
                type="button"
                className="dr-btn dr-btn--primary"
                key={option}
                disabled={disabled}
                onClick={() => send({ kind: 'cast_vote', choice: option })}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="dr-modes" role="tablist">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            data-active={mode === m.id ? 'true' : undefined}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <form className="dr-compose" onSubmit={submit}>
        {mode === 'ask' || mode === 'inject' ? (
          <label className="dr-field">
            <span>{dt('target', locale)}</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={disabled}>
              {mode === 'inject' ? <option value="">{dt('everyone', locale)}</option> : null}
              {targetable.map((p) => (
                <option key={p.id} value={p.id}>
                  {roleLabel(p.role, locale)} — {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholders[mode]}
          rows={2}
          maxLength={1000}
          disabled={disabled}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit(e);
          }}
        />
        <button
          type="submit"
          className="dr-btn dr-btn--primary"
          disabled={disabled || !text.trim()}
        >
          <Send size={14} aria-hidden /> {dt('send', locale)}
        </button>
      </form>

      <div className="dr-speaknext">
        <select
          value={next}
          onChange={(e) => setNext(e.target.value)}
          disabled={disabled}
          aria-label={dt('speakNext', locale)}
        >
          <option value="">{dt('speakNext', locale)}…</option>
          {targetable.map((p) => (
            <option key={p.id} value={p.id}>
              {roleLabel(p.role, locale)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="dr-btn"
          disabled={disabled || !next}
          onClick={async () => {
            if (await send({ kind: 'set_speaker', target: next })) setNext('');
          }}
        >
          <Play size={14} aria-hidden />
        </button>
      </div>

      {error ? (
        <div className="dr-note" data-tone="danger" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}
