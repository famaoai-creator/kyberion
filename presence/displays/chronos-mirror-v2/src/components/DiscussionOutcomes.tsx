'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, ExternalLink, FileText, Flag, Rocket, X } from 'lucide-react';
import {
  dt,
  issueDiscussionMission,
  reviewDiscussionDecision,
  type DiscussionLocale,
  type DiscussionRoomState,
  type ReviewPayload,
} from '../lib/discussion-client';

const VERDICT_KEY = {
  accept: 'verdictAccept',
  'request-changes': 'verdictRequestChanges',
  reject: 'verdictReject',
} as const;

/**
 * The bridge between the room and its decision brief. The brief is an HTML
 * document in a sandboxed iframe (opaque origin, no credentials); it can only
 * `postMessage` the reviewer's edits and verdict. The host checks the message
 * really came from that frame, then performs the call as the signed-in viewer.
 */
function BriefDialog({
  room,
  locale,
  mode,
  onClose,
  onRoom,
}: {
  room: DiscussionRoomState;
  locale: DiscussionLocale;
  mode: 'view' | 'review';
  onClose: () => void;
  onRoom: (room: DiscussionRoomState) => void;
}) {
  const frame = React.useRef<HTMLIFrameElement>(null);

  React.useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as {
        source?: string;
        type?: string;
        roomId?: string;
        payload?: ReviewPayload;
      };
      if (data?.source !== 'kyberion-brief' || data.type !== 'review' || data.roomId !== room.id)
        return;
      if (!data.payload) return;
      const result = await reviewDiscussionDecision(room.id, data.payload);
      frame.current?.contentWindow?.postMessage(
        {
          source: 'kyberion-brief-host',
          type: 'result',
          ok: result.ok,
          error: result.error,
          note: result.data?.result?.mission_error,
        },
        '*'
      );
      if (result.ok && result.data?.room) {
        onRoom(result.data.room);
        window.setTimeout(onClose, 900);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [room.id, onRoom, onClose]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Portalled to <body>: the outcomes card animates with a transform, which would
  // otherwise trap a position:fixed dialog inside the card.
  return createPortal(
    <div className="dr-dialog" role="dialog" aria-modal="true" aria-label={dt('brief', locale)}>
      <div className="dr-dialog__panel">
        <header className="dr-dialog__head">
          <FileText size={16} aria-hidden />
          <strong>{dt('brief', locale)}</strong>
          <button
            type="button"
            className="dr-iconbtn"
            onClick={onClose}
            aria-label={dt('closeDialog', locale)}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <iframe
          ref={frame}
          title={dt('brief', locale)}
          // No allow-same-origin: the brief runs in an opaque origin and cannot reach Chronos.
          sandbox="allow-scripts"
          src={`/api/discussions/${encodeURIComponent(room.id)}/brief?mode=${mode}`}
        />
      </div>
    </div>,
    document.body
  );
}

export function OutcomesCard({
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
  const { proposals, minutes, brief, review, mission, work_items: created } = room.outcomes;
  const [dialog, setDialog] = React.useState<'view' | 'review' | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const close = React.useCallback(() => setDialog(null), []);

  if (proposals.length === 0 && !minutes && !brief) return null;

  const startMission = async () => {
    setBusy(true);
    setError(null);
    const result = await issueDiscussionMission(room.id);
    setBusy(false);
    if (!result.ok || !result.data) {
      setError(result.error ?? 'failed');
      return;
    }
    onRoom(result.data.room);
  };

  const missionId = room.scope.mission_id ?? mission?.mission_id;

  return (
    <div className="dr-card dr-outcomes">
      <div className="dr-card__title">
        <Flag size={14} aria-hidden /> {dt('outcomes', locale)}
      </div>

      {brief ? (
        <div className="dr-outcome-row">
          <FileText size={16} aria-hidden />
          <div className="dr-outcome-row__body">
            <strong>{dt('brief', locale)}</strong>
            <span className="dr-muted">{dt('briefHint', locale)}</span>
          </div>
        </div>
      ) : null}

      {review ? (
        <div className="dr-review-result" data-verdict={review.verdict}>
          <CheckCircle2 size={14} aria-hidden /> {dt('reviewed', locale)}:{' '}
          {dt(VERDICT_KEY[review.verdict], locale)}
          {review.note ? <span className="dr-muted"> — {review.note}</span> : null}
        </div>
      ) : null}

      {proposals.length > 0 ? (
        <ul className="dr-proposals">
          {proposals.map((proposal) => {
            const itemId = created[proposal.id];
            return (
              <li
                key={proposal.id}
                data-created={itemId ? 'true' : undefined}
                data-dropped={proposal.included === false ? 'true' : undefined}
              >
                <span className="dr-proposals__title">{proposal.title}</span>
                {proposal.priority === 'high' ? (
                  <span className="dr-pill" data-tone="warning">
                    {dt('priorityHigh', locale)}
                  </span>
                ) : null}
                {itemId ? (
                  <span className="dr-created" title={itemId}>
                    <CheckCircle2 size={13} aria-hidden /> {dt('workItemCreated', locale)}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {mission && !mission.mission_id ? (
        <div className="dr-mission" data-status={mission.approval_status}>
          {mission.approval_status === 'approved' ? (
            <>
              <span>{dt('missionApproved', locale)}</span>
              <button
                type="button"
                className="dr-btn dr-btn--primary"
                disabled={!canSteer || busy}
                onClick={startMission}
              >
                <Rocket size={14} aria-hidden />{' '}
                {busy ? dt('startingMission', locale) : dt('startMission', locale)}
              </button>
            </>
          ) : mission.approval_status === 'rejected' ? (
            <span>{dt('missionRejected', locale)}</span>
          ) : (
            <>
              <span>{dt('missionAwaiting', locale)}</span>
              <a className="dr-btn" href="/?section=approvals">
                <ExternalLink size={13} aria-hidden /> {dt('openApprovals', locale)}
              </a>
            </>
          )}
        </div>
      ) : null}

      {missionId && (mission?.mission_id || room.scope.mission_id) ? (
        <div className="dr-mission" data-status="started">
          <span>
            {dt('missionStarted', locale)}: {missionId}
          </span>
          <a className="dr-btn" href="/?section=missions">
            <ExternalLink size={13} aria-hidden /> {dt('openMissions', locale)}
          </a>
        </div>
      ) : null}

      <div className="dr-outcome-actions">
        {brief && !review && canSteer ? (
          <button
            type="button"
            className="dr-btn dr-btn--primary"
            onClick={() => setDialog('review')}
          >
            <FileText size={14} aria-hidden /> {dt('reviewAndDecide', locale)}
          </button>
        ) : null}
        {brief ? (
          <button type="button" className="dr-btn" onClick={() => setDialog('view')}>
            <ExternalLink size={13} aria-hidden /> {dt('openBrief', locale)}
          </button>
        ) : null}
        {review && review.verdict === 'accept' ? (
          <a className="dr-btn" href="/?section=work-items">
            <ExternalLink size={13} aria-hidden /> {dt('openWorkItems', locale)}
          </a>
        ) : null}
        {minutes ? (
          <a className="dr-btn" href="/?section=deliverables">
            <ExternalLink size={13} aria-hidden /> {dt('minutes', locale)}
          </a>
        ) : null}
      </div>

      {error ? (
        <div className="dr-note" data-tone="danger" role="alert">
          {error}
        </div>
      ) : null}

      {dialog ? (
        <BriefDialog room={room} locale={locale} mode={dialog} onClose={close} onRoom={onRoom} />
      ) : null}
    </div>
  );
}
