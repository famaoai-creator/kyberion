'use client';

import * as React from 'react';
import {
  ArrowDown,
  Check,
  Copy,
  Download,
  HelpCircle,
  Mic,
  MicOff,
  Paperclip,
  Pencil,
  RefreshCw,
  Send,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  X,
} from 'lucide-react';
import { Markdown } from '../lib/markdown';
import {
  attachmentUrl,
  conversationToMarkdown,
  dt,
  patchDiscussionRoom,
  roleLabel,
  sendDiscussionCommand,
  sendMessageFeedback,
  stopDiscussionReply,
  uploadDiscussionAttachments,
  type DiscussionLocale,
  type DiscussionRoomState,
  type UploadedAttachment,
} from '../lib/discussion-client';
import { Avatar, participantColor } from './DiscussionPanes';
import './discussion-room.css';
import './dialogue-room.css';

type Message = DiscussionRoomState['messages'][number];

interface PendingMessage {
  id: string;
  text: string;
  sentAt: number;
  attachments: string[];
  status: 'sending' | 'failed';
}

function formatTime(ts: string, locale: DiscussionLocale): string {
  return new Date(ts).toLocaleTimeString(locale === 'ja' ? 'ja-JP' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function dayLabel(ts: string, locale: DiscussionLocale): string {
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return dt('today', locale);
  return date.toLocaleDateString(locale === 'ja' ? 'ja-JP' : 'en-US', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  });
}

/* ------------------------------------------------------------- messages -- */

function AttachmentChip({
  room,
  id,
  locale,
}: {
  room: DiscussionRoomState;
  id: string;
  locale: DiscussionLocale;
}) {
  const attachment = room.attachments.find((a) => a.id === id);
  if (!attachment) return null;
  const isImage = attachment.mime.startsWith('image/');
  return (
    <a
      className="dl-attachment"
      href={attachmentUrl(room.id, id)}
      target="_blank"
      rel="noopener noreferrer"
      title={
        attachment.status === 'read' ? dt('attachmentRead', locale) : dt('attachmentStored', locale)
      }
    >
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={attachmentUrl(room.id, id)} alt={attachment.name} loading="lazy" />
      ) : (
        <Paperclip size={13} aria-hidden />
      )}
      <span>{attachment.name}</span>
    </a>
  );
}

function MessageItem({
  room,
  message,
  locale,
  isLastAgent,
  canSteer,
  busy,
  onRegenerate,
  onEdit,
  onSuggestion,
}: {
  room: DiscussionRoomState;
  message: Message;
  locale: DiscussionLocale;
  isLastAgent: boolean;
  canSteer: boolean;
  busy: boolean;
  onRegenerate: () => void;
  onEdit: (message: Message) => void;
  onSuggestion: (text: string) => void;
}) {
  const human = message.kind === 'human';
  const participant = room.participants.find((p) => p.id === message.speaker);
  const color = human ? 'var(--kb-ui-accent)' : participantColor(room, message.speaker);
  const [copied, setCopied] = React.useState(false);
  const [speaking, setSpeaking] = React.useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(message.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };
  const readAloud = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(message.text.replace(/[*_`#>]/gu, ''));
    utterance.lang = locale === 'ja' ? 'ja-JP' : 'en-US';
    utterance.onend = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };
  const feedback = (value: 'up' | 'down') => {
    void sendMessageFeedback(room.id, message.id, message.feedback === value ? null : value);
  };

  return (
    <article
      className="dl-msg"
      data-kind={message.kind}
      data-superseded={message.superseded ? 'true' : undefined}
      style={{ ['--dr-color' as string]: color }}
    >
      {human ? null : <Avatar role={participant?.role} color={color} size={32} />}
      <div className="dl-msg__col">
        <header className="dl-msg__meta">
          <strong>
            {human ? dt('you', locale) : roleLabel(participant?.role ?? message.speaker, locale)}
          </strong>
          {message.consulted ? <span className="dr-pill">{dt('consultedTag', locale)}</span> : null}
          <time>{formatTime(message.ts, locale)}</time>
          {message.edited ? <span className="dr-muted">· {dt('edited', locale)}</span> : null}
        </header>
        <div className="dl-msg__bubble">
          <Markdown
            source={message.text}
            copyLabel={dt('copy', locale)}
            copiedLabel={dt('copied', locale)}
          />
          {message.attachments?.length ? (
            <div className="dl-attachments">
              {message.attachments.map((id) => (
                <AttachmentChip key={id} room={room} id={id} locale={locale} />
              ))}
            </div>
          ) : null}
        </div>
        <div className="dl-msg__actions" role="group">
          <button
            type="button"
            onClick={copy}
            title={dt('copy', locale)}
            aria-label={dt('copy', locale)}
          >
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          </button>
          {human ? (
            canSteer && !message.superseded && room.status !== 'concluded' ? (
              <button
                type="button"
                onClick={() => onEdit(message)}
                title={dt('editMessage', locale)}
                aria-label={dt('editMessage', locale)}
              >
                <Pencil size={13} aria-hidden />
              </button>
            ) : null
          ) : (
            <>
              <button
                type="button"
                onClick={readAloud}
                title={dt('readAloud', locale)}
                aria-label={dt('readAloud', locale)}
                data-active={speaking ? 'true' : undefined}
              >
                <Volume2 size={13} aria-hidden />
              </button>
              {canSteer ? (
                <>
                  <button
                    type="button"
                    onClick={() => feedback('up')}
                    title={dt('goodAnswer', locale)}
                    aria-label={dt('goodAnswer', locale)}
                    data-active={message.feedback === 'up' ? 'true' : undefined}
                  >
                    <ThumbsUp size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => feedback('down')}
                    title={dt('badAnswer', locale)}
                    aria-label={dt('badAnswer', locale)}
                    data-active={message.feedback === 'down' ? 'true' : undefined}
                  >
                    <ThumbsDown size={13} aria-hidden />
                  </button>
                  {isLastAgent && !busy && room.status !== 'concluded' ? (
                    <button
                      type="button"
                      onClick={onRegenerate}
                      title={dt('regenerate', locale)}
                      aria-label={dt('regenerate', locale)}
                    >
                      <RefreshCw size={13} aria-hidden />
                    </button>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </div>
        {isLastAgent && !busy && message.suggestions?.length && room.status === 'running' ? (
          <div className="dl-suggestions">
            {message.suggestions.map((suggestion) => (
              <button
                type="button"
                key={suggestion}
                onClick={() => onSuggestion(suggestion)}
                disabled={!canSteer}
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function EditBox({
  message,
  locale,
  onSave,
  onCancel,
}: {
  message: Message;
  locale: DiscussionLocale;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = React.useState(message.text);
  return (
    <div className="dl-editbox" data-kind="human">
      <textarea
        value={text}
        autoFocus
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) onSave(text.trim());
        }}
      />
      <div className="dl-editbox__actions">
        <button type="button" className="dr-btn" onClick={onCancel}>
          <X size={13} aria-hidden /> {dt('cancel', locale)}
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--primary"
          disabled={!text.trim()}
          onClick={() => onSave(text.trim())}
        >
          <Send size={13} aria-hidden /> {dt('saveAndResend', locale)}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- timeline -- */

export function ChatTimeline({
  room,
  locale,
  canSteer,
  pending,
  onRegenerate,
  onSuggestion,
  onEditSave,
  onRetryPending,
  editing,
  setEditing,
}: {
  room: DiscussionRoomState;
  locale: DiscussionLocale;
  canSteer: boolean;
  pending: PendingMessage[];
  onRegenerate: () => void;
  onSuggestion: (text: string) => void;
  onEditSave: (message: Message, text: string) => void;
  onRetryPending: (pending: PendingMessage) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = React.useState(true);
  const [unseen, setUnseen] = React.useState(0);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const lastKey = React.useRef('');
  const busy = Boolean(room.live) || room.speaking !== null;
  const lastAgentId = [...room.messages]
    .reverse()
    .find((m) => m.kind === 'agent' && !m.superseded && !m.consulted)?.id;

  const key = `${room.messages.length}:${room.live?.text.length ?? -1}:${pending.length}`;
  React.useEffect(() => {
    const el = scroller.current;
    if (!el || key === lastKey.current) return;
    lastKey.current = key;
    if (pinned) {
      el.scrollTo({ top: el.scrollHeight, behavior: room.live ? 'auto' : 'smooth' });
      setUnseen(0);
    } else {
      setUnseen((n) => n + 1);
    }
  }, [key, pinned, room.live]);

  // Runs of superseded messages collapse into one "earlier replies" row.
  type Row =
    | { kind: 'day'; label: string; key: string }
    | { kind: 'message'; message: Message }
    | { kind: 'collapsed'; ids: string[]; key: string };
  const rows: Row[] = [];
  let lastDay = '';
  let run: Message[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const ids = run.map((m) => m.id);
    rows.push({ kind: 'collapsed', ids, key: `c-${ids[0]}` });
    if (ids.every((id) => expanded.has(id)))
      for (const m of run) rows.push({ kind: 'message', message: m });
    run = [];
  };
  for (const message of room.messages) {
    if (message.superseded) {
      run.push(message);
      continue;
    }
    flush();
    const day = new Date(message.ts).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      rows.push({ kind: 'day', label: dayLabel(message.ts, locale), key: `d-${message.id}` });
    }
    rows.push({ kind: 'message', message });
  }
  flush();

  return (
    <div className="dl-timeline-wrap">
      <div
        className="dl-timeline"
        ref={scroller}
        aria-live="polite"
        onScroll={() => {
          const el = scroller.current;
          if (!el) return;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
          setPinned(near);
          if (near) setUnseen(0);
        }}
      >
        {rows.map((row) => {
          if (row.kind === 'day') {
            return (
              <div className="dl-day" key={row.key}>
                <span>{row.label}</span>
              </div>
            );
          }
          if (row.kind === 'collapsed') {
            const open = row.ids.every((id) => expanded.has(id));
            return (
              <button
                type="button"
                className="dl-collapsed"
                key={row.key}
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    for (const id of row.ids) {
                      if (open) next.delete(id);
                      else next.add(id);
                    }
                    return next;
                  })
                }
              >
                {dt('previousReplies', locale).replace('{n}', String(row.ids.length))}{' '}
                {open ? '▴' : '▾'}
              </button>
            );
          }
          const message = row.message;
          if (editing === message.id) {
            return (
              <EditBox
                key={message.id}
                message={message}
                locale={locale}
                onCancel={() => setEditing(null)}
                onSave={(text) => onEditSave(message, text)}
              />
            );
          }
          return (
            <MessageItem
              key={message.id}
              room={room}
              message={message}
              locale={locale}
              isLastAgent={message.id === lastAgentId}
              canSteer={canSteer}
              busy={busy}
              onRegenerate={onRegenerate}
              onEdit={(m) => setEditing(m.id)}
              onSuggestion={onSuggestion}
            />
          );
        })}

        {pending.map((item) => (
          <article className="dl-msg" data-kind="human" data-pending="true" key={item.id}>
            <div className="dl-msg__col">
              <div className="dl-msg__bubble">
                <Markdown source={item.text} />
              </div>
              {item.status === 'failed' ? (
                <div className="dl-failed">
                  {dt('sendFailed', locale)}{' '}
                  <button type="button" onClick={() => onRetryPending(item)}>
                    {dt('resend', locale)}
                  </button>
                </div>
              ) : null}
            </div>
          </article>
        ))}

        {room.live ? (
          <article
            className="dl-msg"
            data-kind="agent"
            style={{ ['--dr-color' as string]: participantColor(room, room.live.speaker) }}
          >
            <Avatar
              role={room.participants.find((p) => p.id === room.live?.speaker)?.role}
              color={participantColor(room, room.live.speaker)}
              size={32}
              speaking
            />
            <div className="dl-msg__col">
              <div className="dl-msg__bubble dl-msg__bubble--live">
                <Markdown source={room.live.text || ' '} />
                <span className="dl-caret" aria-hidden />
              </div>
            </div>
          </article>
        ) : room.speaking ? (
          <article
            className="dl-msg"
            data-kind="agent"
            style={{ ['--dr-color' as string]: participantColor(room, room.speaking) }}
          >
            <Avatar
              role={room.participants.find((p) => p.id === room.speaking)?.role}
              color={participantColor(room, room.speaking)}
              size={32}
              speaking
            />
            <div className="dl-msg__col">
              <div className="dl-msg__bubble">
                <div className="dr-dots" aria-label={dt('typing', locale)}>
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>
          </article>
        ) : null}

        {room.stalled_for && !busy ? (
          <div className="dl-stalled">
            {dt('generationStopped', locale)}
            {canSteer ? (
              <button type="button" onClick={onRegenerate}>
                <RefreshCw size={12} aria-hidden /> {dt('regenerate', locale)}
              </button>
            ) : null}
          </div>
        ) : null}
        {room.status === 'concluded' ? (
          <div className="dl-ended">{dt('dialogueEnded', locale)}</div>
        ) : null}
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
          <ArrowDown size={13} aria-hidden /> {unseen}
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- composer -- */

interface SlashCommand {
  command: string;
  hint: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

function getRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    (new () => SpeechRecognitionLike) | null;
}

export interface ComposerHandle {
  insertMention: (role: string) => void;
  focus: () => void;
}

export const Composer = React.forwardRef<
  ComposerHandle,
  {
    room: DiscussionRoomState;
    locale: DiscussionLocale;
    canSteer: boolean;
    busy: boolean;
    disabled: boolean;
    onSend: (text: string, attachments: string[]) => void;
    onSlash: (command: string, argument: string) => boolean;
    onStop: () => void;
    onEditLast: () => void;
    onHelp: () => void;
    onExport: () => void;
  }
>(function Composer(
  { room, locale, canSteer, busy, disabled, onSend, onSlash, onStop, onEditLast, onHelp, onExport },
  ref
) {
  const [text, setText] = React.useState('');
  const [files, setFiles] = React.useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [listening, setListening] = React.useState(false);
  const [menuIndex, setMenuIndex] = React.useState(0);
  const area = React.useRef<HTMLTextAreaElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const recognition = React.useRef<SpeechRecognitionLike | null>(null);
  const draftBeforeVoice = React.useRef('');

  React.useImperativeHandle(ref, () => ({
    insertMention: (role) => {
      setText((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}@${role} `);
      area.current?.focus();
    },
    focus: () => area.current?.focus(),
  }));

  React.useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const slashCommands: SlashCommand[] = [
    { command: '/brief', hint: dt('slashBrief', locale) },
    { command: '/summary', hint: dt('slashSummary', locale) },
    { command: '/consult', hint: dt('slashConsult', locale) },
    { command: '/export', hint: dt('slashExport', locale) },
    { command: '/help', hint: dt('slashHelp', locale) },
  ];
  const slashMatches =
    text.startsWith('/') && !text.includes(' ')
      ? slashCommands.filter((c) => c.command.startsWith(text.toLowerCase()))
      : [];
  const mentionMatch = /(?:^|\s)@([a-z_]*)$/u.exec(text);
  const mentionRoles = mentionMatch
    ? room.participants.filter(
        (p) => p.role !== 'facilitator' && p.role.startsWith(mentionMatch[1])
      )
    : [];
  const menuOpen = slashMatches.length > 0 || mentionRoles.length > 0;

  const upload = async (picked: File[]) => {
    if (picked.length === 0 || !canSteer) return;
    setUploading(true);
    setUploadError(null);
    const result = await uploadDiscussionAttachments(room.id, picked.slice(0, 4));
    setUploading(false);
    if (!result.ok) {
      setUploadError(`${dt('uploadFailed', locale)}: ${result.error}`);
      return;
    }
    setFiles((current) => [...current, ...result.attachments]);
  };

  const submit = () => {
    const value = text.trim();
    if ((!value && files.length === 0) || disabled) return;
    if (value.startsWith('/')) {
      const [command, ...rest] = value.split(/\s+/u);
      if (onSlash(command.toLowerCase(), rest.join(' '))) {
        setText('');
        return;
      }
    }
    onSend(
      value,
      files.map((f) => f.id)
    );
    setText('');
    setFiles([]);
  };

  const pickMenuItem = (index: number) => {
    if (slashMatches.length > 0) {
      const chosen = slashMatches[index] ?? slashMatches[0];
      if (chosen.command === '/consult') setText('/consult @');
      else {
        setText(chosen.command);
        window.setTimeout(submit, 0);
      }
      return;
    }
    const role = mentionRoles[index] ?? mentionRoles[0];
    if (role && mentionMatch) setText(text.replace(/@[a-z_]*$/u, `@${role.role} `));
  };

  const toggleVoice = () => {
    const Recognition = getRecognition();
    if (!Recognition) return;
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const instance = new Recognition();
    instance.lang = locale === 'ja' ? 'ja-JP' : 'en-US';
    instance.continuous = true;
    instance.interimResults = true;
    draftBeforeVoice.current = text;
    instance.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) transcript += event.results[i][0].transcript;
      setText(`${draftBeforeVoice.current}${draftBeforeVoice.current ? ' ' : ''}${transcript}`);
    };
    instance.onend = () => setListening(false);
    instance.onerror = () => setListening(false);
    recognition.current = instance;
    setListening(true);
    instance.start();
  };

  const voiceSupported = getRecognition() !== null;

  return (
    <div
      className="dl-composer"
      data-dragging={dragging ? 'true' : undefined}
      onDragOver={(e) => {
        if (canSteer) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(Array.from(e.dataTransfer.files));
      }}
    >
      {dragging ? <div className="dl-drop">{dt('dropFiles', locale)}</div> : null}

      {menuOpen ? (
        <ul className="dl-menu" role="listbox">
          {slashMatches.length > 0
            ? slashMatches.map((c, i) => (
                <li
                  key={c.command}
                  role="option"
                  aria-selected={i === menuIndex}
                  data-active={i === menuIndex ? 'true' : undefined}
                >
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickMenuItem(i)}
                  >
                    <code>{c.command}</code> <span>{c.hint}</span>
                  </button>
                </li>
              ))
            : mentionRoles.map((p, i) => (
                <li
                  key={p.id}
                  role="option"
                  aria-selected={i === menuIndex}
                  data-active={i === menuIndex ? 'true' : undefined}
                >
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickMenuItem(i)}
                  >
                    <code>@{p.role}</code>{' '}
                    <span>
                      {roleLabel(p.role, locale)} — {p.name}
                    </span>
                  </button>
                </li>
              ))}
        </ul>
      ) : null}

      {files.length > 0 || uploading || uploadError ? (
        <div className="dl-chips">
          {files.map((file) => (
            <span
              className="dl-chip"
              key={file.id}
              title={
                file.status === 'read'
                  ? dt('attachmentRead', locale)
                  : dt('attachmentStored', locale)
              }
            >
              <Paperclip size={12} aria-hidden /> {file.name}
              <button
                type="button"
                aria-label={dt('removeAttachment', locale)}
                onClick={() => setFiles((c) => c.filter((f) => f.id !== file.id))}
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
          {uploading ? <span className="dr-muted">{dt('uploading', locale)}</span> : null}
          {uploadError ? <span className="dl-chip dl-chip--error">{uploadError}</span> : null}
        </div>
      ) : null}

      <div className="dl-composer__row">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void upload(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <textarea
          ref={area}
          value={text}
          rows={1}
          maxLength={4000}
          disabled={disabled}
          placeholder={dt('composerPlaceholder', locale)}
          onChange={(e) => {
            setText(e.target.value);
            setMenuIndex(0);
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length > 0) {
              e.preventDefault();
              void upload(pasted);
            }
          }}
          onKeyDown={(e) => {
            // Enter while composing Japanese (IME) confirms the conversion; it must not send.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (menuOpen) {
              const count = slashMatches.length || mentionRoles.length;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMenuIndex((i) => (i + 1) % count);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMenuIndex((i) => (i - 1 + count) % count);
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                pickMenuItem(menuIndex);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setText('');
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape' && busy) {
              e.preventDefault();
              onStop();
            } else if (e.key === 'ArrowUp' && !text) {
              e.preventDefault();
              onEditLast();
            }
          }}
        />
        <div className="dl-composer__tools">
          <button
            type="button"
            className="dl-tool"
            disabled={!canSteer || disabled}
            onClick={() => fileInput.current?.click()}
            title={dt('attachFile', locale)}
            aria-label={dt('attachFile', locale)}
          >
            <Paperclip size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="dl-tool"
            disabled={!voiceSupported || disabled}
            data-active={listening ? 'true' : undefined}
            onClick={toggleVoice}
            title={
              voiceSupported
                ? listening
                  ? dt('voiceStop', locale)
                  : dt('voiceStart', locale)
                : dt('voiceUnsupported', locale)
            }
            aria-label={listening ? dt('voiceStop', locale) : dt('voiceStart', locale)}
          >
            {listening ? <MicOff size={16} aria-hidden /> : <Mic size={16} aria-hidden />}
          </button>
          <button
            type="button"
            className="dl-tool"
            onClick={onHelp}
            title={dt('helpTitle', locale)}
            aria-label={dt('helpTitle', locale)}
          >
            <HelpCircle size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="dl-tool"
            onClick={onExport}
            title={dt('exportMd', locale)}
            aria-label={dt('exportMd', locale)}
          >
            <Download size={16} aria-hidden />
          </button>
          {busy ? (
            <button
              type="button"
              className="dr-btn dl-send dl-send--stop"
              onClick={onStop}
              aria-label={dt('stopGeneration', locale)}
            >
              <Square size={14} aria-hidden /> {dt('stopGeneration', locale)}
            </button>
          ) : (
            <button
              type="button"
              className="dr-btn dr-btn--primary dl-send"
              disabled={disabled || (!text.trim() && files.length === 0)}
              onClick={submit}
              aria-label={dt('sendMessage', locale)}
            >
              <Send size={14} aria-hidden /> {dt('sendMessage', locale)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

/* --------------------------------------------------------- chat pane -- */

export function ChatPane({
  room,
  locale,
  canSteer,
  connection,
  onRoom,
  composerRef,
  onHelp,
  onFinalize,
}: {
  room: DiscussionRoomState;
  locale: DiscussionLocale;
  canSteer: boolean;
  connection: string;
  onRoom: (room: DiscussionRoomState) => void;
  composerRef: React.RefObject<ComposerHandle | null>;
  onHelp: () => void;
  onFinalize: () => void;
}) {
  const [pending, setPending] = React.useState<PendingMessage[]>([]);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState(false);
  const [title, setTitle] = React.useState(room.title);
  const busy = Boolean(room.live) || room.speaking !== null;
  const ended =
    room.status === 'concluded' || room.status === 'stopped' || room.status === 'failed';

  React.useEffect(() => setTitle(room.title), [room.title]);

  // A queued message is shown optimistically until the room reports it back.
  React.useEffect(() => {
    setPending((current) =>
      current.filter((item) => {
        if (item.status === 'failed') return true;
        const echoed = room.messages.some(
          (m) =>
            m.kind === 'human' &&
            m.text === item.text &&
            new Date(m.ts).getTime() >= item.sentAt - 3000
        );
        return !echoed && Date.now() - item.sentAt < 15000;
      })
    );
  }, [room.messages]);

  const send = async (text: string, attachments: string[]) => {
    const item: PendingMessage = {
      id: `p-${Date.now()}`,
      text,
      sentAt: Date.now(),
      attachments,
      status: 'sending',
    };
    setPending((current) => [...current, item]);
    const result = await sendDiscussionCommand(room.id, {
      kind: 'inject',
      text,
      ...(attachments.length ? { attachments } : {}),
    });
    if (!result.ok) {
      setPending((current) =>
        current.map((p) => (p.id === item.id ? { ...p, status: 'failed' } : p))
      );
      setNotice(result.error ?? dt('sendFailed', locale));
    } else if (result.data?.room) {
      onRoom(result.data.room);
    }
  };

  const command = async (
    kind: 'regenerate' | 'summarize' | 'finalize',
    extra: { target?: string } = {}
  ) => {
    const result = await sendDiscussionCommand(room.id, { kind, ...extra });
    if (!result.ok) setNotice(result.error ?? dt('sendFailed', locale));
    else if (result.data?.room) onRoom(result.data.room);
  };

  const lastHuman = [...room.messages]
    .reverse()
    .find((m) => m.kind === 'human' && !m.superseded && !m.mentions?.length);

  const onSlash = (name: string, argument: string): boolean => {
    switch (name) {
      case '/brief':
        onFinalize();
        return true;
      case '/summary':
        void command('summarize');
        return true;
      case '/help':
        onHelp();
        return true;
      case '/export':
        exportConversation();
        return true;
      case '/consult': {
        const match = /^@([a-z_]+)\s+([\s\S]+)$/u.exec(argument.trim());
        if (!match) return false;
        void sendDiscussionCommand(room.id, {
          kind: 'consult',
          target: match[1],
          text: match[2],
        }).then((r) => {
          if (!r.ok) setNotice(r.error ?? dt('sendFailed', locale));
        });
        return true;
      }
      default:
        return false;
    }
  };

  const exportConversation = () => {
    const blob = new Blob([conversationToMarkdown(room, locale)], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${room.id}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const saveTitle = async () => {
    setRenaming(false);
    const next = title.trim();
    if (!next || next === room.title) {
      setTitle(room.title);
      return;
    }
    const result = await patchDiscussionRoom(room.id, { title: next });
    if (result.ok && result.data?.room) onRoom(result.data.room);
  };

  return (
    <section className="dr-pane dl-chat" aria-label={dt('conversation', locale)}>
      <header className="dl-chat__head">
        {renaming ? (
          <input
            className="dl-title-input"
            value={title}
            autoFocus
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveTitle();
              if (e.key === 'Escape') {
                setTitle(room.title);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <h2 title={room.goal}>{room.title}</h2>
        )}
        {canSteer && !renaming ? (
          <button
            type="button"
            className="dl-tool"
            onClick={() => setRenaming(true)}
            title={dt('rename', locale)}
            aria-label={dt('rename', locale)}
          >
            <Pencil size={14} aria-hidden />
          </button>
        ) : null}
        <span className="dl-conn" data-connection={connection} aria-hidden />
      </header>

      <ChatTimeline
        room={room}
        locale={locale}
        canSteer={canSteer}
        pending={pending}
        onRegenerate={() => void command('regenerate')}
        onSuggestion={(text) => void send(text, [])}
        onEditSave={(message, text) => {
          setEditing(null);
          void sendDiscussionCommand(room.id, {
            kind: 'edit_message',
            target: message.id,
            text,
          }).then((r) => {
            if (!r.ok) setNotice(r.error ?? dt('sendFailed', locale));
          });
        }}
        onRetryPending={(item) => {
          setPending((current) => current.filter((p) => p.id !== item.id));
          void send(item.text, item.attachments);
        }}
        editing={editing}
        setEditing={setEditing}
      />

      {notice ? (
        <div
          className="dr-note dl-notice"
          data-tone="danger"
          role="alert"
          onClick={() => setNotice(null)}
        >
          {notice}
        </div>
      ) : null}

      <Composer
        ref={composerRef}
        room={room}
        locale={locale}
        canSteer={canSteer}
        busy={busy}
        disabled={!canSteer || ended}
        onSend={(text, attachments) => void send(text, attachments)}
        onSlash={onSlash}
        onStop={() => void stopDiscussionReply(room.id)}
        onEditLast={() => lastHuman && canSteer && setEditing(lastHuman.id)}
        onHelp={onHelp}
        onExport={exportConversation}
      />
    </section>
  );
}
