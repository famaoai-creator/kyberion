'use client';

import * as React from 'react';
import { frontDeskFetch } from './front-desk-fetch';
import { loadErrorFromStatus, type WorkspaceLoadError } from './workspace-view';

export type WorkspaceResource<T> =
  | { state: 'loading'; data?: undefined; error?: undefined }
  | { state: 'ready'; data: T; error?: undefined }
  | { state: 'error'; data?: undefined; error: WorkspaceLoadError };

/**
 * GET one `/api/v1/workspace/*` path through the member transport and unwrap
 * `{ ok, data }`. A newer path (or unmount) aborts the older request, so a
 * fast typist never sees results for an earlier query.
 */
export function useWorkspaceResource<T>(path: string | null): WorkspaceResource<T> & {
  reload: () => void;
} {
  const [resource, setResource] = React.useState<WorkspaceResource<T>>({ state: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setResource({ state: 'loading' });
    frontDeskFetch(path, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as {
          ok?: boolean;
          data?: T;
        } | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !body?.ok || body.data === undefined) {
          setResource({
            state: 'error',
            error: loadErrorFromStatus(response.ok ? 500 : response.status),
          });
          return;
        }
        setResource({ state: 'ready', data: body.data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResource({ state: 'error', error: 'failed' });
      });
    return () => controller.abort();
  }, [path, attempt]);
  const reload = React.useCallback(() => setAttempt((n) => n + 1), []);
  return { ...resource, reload };
}
