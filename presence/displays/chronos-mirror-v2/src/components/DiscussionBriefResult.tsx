import type { DiscussionRoomState } from '@agent/core/discussion/discussion-types';
import { dt, type DiscussionLocale } from '../lib/discussion-client';

/** The generated decision remains readable even when saved-file publication fails. */
export function DiscussionBriefResult({
  room,
  locale,
}: {
  room: DiscussionRoomState;
  locale: DiscussionLocale;
}) {
  const decision = room.decision;
  return (
    <section className="dr-note" aria-label={dt('briefResult', locale)}>
      <h2>{dt('briefResult', locale)}</h2>
      <p className="dr-muted">{dt('singleBriefNotice', locale)}</p>
      {decision ? (
        <>
          <p>{decision.summary}</p>
          {decision.dissent.length ? (
            <>
              <h3>{dt('dissent', locale)}</h3>
              <ul>
                {decision.dissent.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </>
          ) : null}
          {decision.next_steps.length ? (
            <>
              <h3>{dt('nextSteps', locale)}</h3>
              <ol>
                {decision.next_steps.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ol>
            </>
          ) : null}
        </>
      ) : (
        <p>{dt('briefResultPending', locale)}</p>
      )}
    </section>
  );
}
