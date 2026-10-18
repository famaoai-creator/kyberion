'use client';

import { useRef, useState } from 'react';
import {
  dt,
  sendDiscussionCommand,
  type DiscussionLocale,
  type DiscussionRoomState,
} from '../lib/discussion-client';

/** The single invocation accepts cancellation only, never queued panel steering. */
export function DiscussionBriefControls({
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const ended = ['concluded', 'stopped', 'failed'].includes(room.status);
  const stop = async () => {
    if (!canSteer || ended || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const result = await sendDiscussionCommand(room.id, { kind: 'stop' });
    submitting.current = false;
    setBusy(false);
    if (result.ok && result.data) onRoom(result.data.room);
    else setError(result.error ?? dt('commandFailed', locale));
  };
  return (
    <div className="dr-note">
      <p>{dt('singleBriefNotice', locale)}</p>
      {!ended ? (
        <button
          className="dr-btn"
          type="button"
          disabled={!canSteer || busy}
          onClick={() => void stop()}
        >
          {dt('stop', locale)}
        </button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
