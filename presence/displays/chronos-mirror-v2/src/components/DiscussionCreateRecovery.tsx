'use client';

import * as React from 'react';
import {
  createDiscussion,
  fetchDiscussionRequest,
  fetchDiscussionRequestContext,
  dt,
  type DiscussionCreateInput,
  type DiscussionLocale,
} from '../lib/discussion-client';
import {
  createDiscussionRecoveryController,
  discussionCreationBlocked,
  DISCUSSION_PENDING_PREFIX,
  type DiscussionRecoveryState,
} from '../lib/discussion-create-recovery';

export function useDiscussionCreateRecovery() {
  const [state, setState] = React.useState<DiscussionRecoveryState>({
    phase: 'loading',
    pending: [],
    confirmedRoomId: null,
  });
  const controller = React.useRef<ReturnType<typeof createDiscussionRecoveryController> | null>(
    null
  );
  React.useEffect(() => {
    const current = createDiscussionRecoveryController({
      storage: () => window.localStorage,
      uuid: () => window.crypto.randomUUID(),
      context: (routing, signal) => fetchDiscussionRequestContext(routing, { signal }),
      post: (body, signal) => createDiscussion(body, { signal }),
      lookup: (handle, signal) => fetchDiscussionRequest(handle, { signal }),
      onChange: setState,
    });
    controller.current = current;
    if (current.sync()) void current.check();
    const storageChanged = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(DISCUSSION_PENDING_PREFIX)) current.sync();
    };
    window.addEventListener('storage', storageChanged);
    return () => {
      controller.current = null;
      window.removeEventListener('storage', storageChanged);
      current.dispose();
    };
  }, []);
  return {
    state,
    blocked: discussionCreationBlocked(state),
    busy: ['resolving', 'submitting', 'checking'].includes(state.phase),
    start: async (input: DiscussionCreateInput) => {
      const current = controller.current;
      const result = await current?.start(input);
      // Caller state/readiness callbacks must not touch a replacement launcher.
      return current === controller.current ? result : null;
    },
    check: (requestId?: string) => void controller.current?.check(requestId),
  };
}

export function DiscussionCreateRecovery({
  state,
  locale,
  onCheck,
  onOpen,
}: {
  state: DiscussionRecoveryState;
  locale: DiscussionLocale;
  onCheck: (requestId?: string) => void;
  onOpen: (id: string) => void;
}) {
  const busy = ['resolving', 'submitting', 'checking'].includes(state.phase);
  const pending = state.pending.length > 0;
  if (
    !pending &&
    !state.confirmedRoomId &&
    !['storage-error', 'rejected', 'resolving', 'context-error', 'invalid-input'].includes(
      state.phase
    )
  )
    return null;
  return (
    <section
      id="dr-create-recovery"
      className="dr-note"
      role="status"
      aria-live="polite"
      aria-busy={busy}
    >
      {state.phase === 'resolving' ? <p>{dt('createContextResolving', locale)}</p> : null}
      {state.phase === 'context-error' ? <p>{dt('createContextFailed', locale)}</p> : null}
      {state.phase === 'invalid-input' ? <p>{dt('createInputInvalid', locale)}</p> : null}
      {state.phase === 'storage-error' ? <p>{dt('createStorageUnavailable', locale)}</p> : null}
      {pending ? (
        <>
          <p>{dt(busy ? 'createRequestChecking' : 'createRequestUnconfirmed', locale)}</p>
          <p>{dt('createRequestNoRetry', locale)}</p>
          {state.pending.map((handle) => (
            <div key={handle.request_id}>
              {dt('createRequestId', locale)}: {handle.request_id}{' '}
              <button
                type="button"
                className="dr-btn"
                disabled={busy}
                onClick={() => onCheck(handle.request_id)}
              >
                {dt('createRequestCheck', locale)}
              </button>
            </div>
          ))}
        </>
      ) : null}
      {state.phase === 'storage-error' && !pending ? (
        <button type="button" className="dr-btn" onClick={() => onCheck()}>
          {dt('createRequestCheck', locale)}
        </button>
      ) : null}
      {state.phase === 'rejected' ? <p>{dt('createRequestRejected', locale)}</p> : null}
      {state.confirmedRoomId ? (
        <button type="button" className="dr-btn" onClick={() => onOpen(state.confirmedRoomId!)}>
          {dt('createRequestOpen', locale)}
        </button>
      ) : null}
    </section>
  );
}
