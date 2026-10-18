import type { DiscussionRoomState } from '@agent/core/discussion/discussion-types';
import { dt, type DiscussionLocale } from '../lib/discussion-client';
import { discussionExecutionState } from '../lib/discussion-run-contract';

export function DiscussionExecutionStatus({
  room,
  locale,
}: {
  room: DiscussionRoomState;
  locale: DiscussionLocale;
}) {
  const execution = room.execution;
  const state = discussionExecutionState(room);
  const keys = {
    unknown: 'executionUnknown',
    scripted: 'executionScripted',
    unconfirmed: 'executionUnconfirmed',
    confirmed: 'executionConfirmed',
  } as const;
  return (
    <>
      <div className="dr-note" role="status" aria-live="polite" data-execution={state}>
        <strong>{dt(keys[state], locale)}</strong>
        {execution && execution.actual_mode !== 'scripted' ? (
          <>
            <div>
              {dt('selectedProvider', locale)}: {execution.requested_provider ?? '—'}
            </div>
            <div>
              {dt('confirmedProvider', locale)}: {execution.provider ?? '—'}
            </div>
            <div>
              {dt('attemptsStarted', locale)}: {execution.attempts.length}/{execution.call_budget} ·{' '}
              {dt('attemptsSucceeded', locale)}:{' '}
              {execution.attempts.filter((attempt) => attempt.status === 'succeeded').length}
            </div>
            <div>{dt('modelUnknown', locale)}</div>
          </>
        ) : null}
      </div>
      {room.error ? (
        <div className="dr-note" data-tone="danger" role="alert">
          {room.error}
        </div>
      ) : null}
    </>
  );
}

/** A prerequisite disclosure, not a live readiness or authorization probe. */
export function DiscussionProviderPrerequisite({ locale }: { locale: DiscussionLocale }) {
  return <div role="note">{dt('providerPrerequisite', locale)}</div>;
}
