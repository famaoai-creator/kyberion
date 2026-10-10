'use client';

import * as React from 'react';
import { frontDeskFetch } from './front-desk-fetch';
import { getFrontDeskAuthRevision, readFrontDeskRequestToken } from './front-desk-auth-token';
import { TENANT_CHANGED_EVENT } from './tenant-context';
import {
  parseConciergeOutcomePreviewResponse,
  type ConciergeOutcomePreview,
} from './outcome-preview-response';
import type { ConciergeSummary } from './summary-event';

type Outcome = ConciergeSummary['outcome_feed'][number];
type Auth = { token: string | null; revision: number };
type Selection = { id: string; revision: string; auth: Auth | null };
type State = {
  id: string | null;
  data: ConciergeOutcomePreview | null;
  error: string | null;
  busy: boolean;
};
const empty = (): State => ({ id: null, data: null, error: null, busy: false });
const revisionOf = (item: Outcome) =>
  JSON.stringify([item.entry_id, item.updated_at, item.status, item.artifact_paths]);
function readAuth(): Auth | null {
  try {
    return { token: readFrontDeskRequestToken(), revision: getFrontDeskAuthRevision() };
  } catch {
    return null;
  }
}
const sameAuth = (a: Auth | null, b: Auth | null) =>
  a === null || b === null ? a === b : a.token === b.token && a.revision === b.revision;

/** One visible selection owns all result, error and loading updates, even if abort is ignored. */
export function useOutcomePreview(visibleItems: Outcome[], scope: string) {
  const [state, setState] = React.useState<State>(empty);
  const selected = React.useRef<Selection | null>(null);
  const generation = React.useRef(0);
  const active = React.useRef(false);
  const request = React.useRef<AbortController | null>(null);
  const timeout = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const context = React.useRef({ items: visibleItems, scope });
  const cancel = React.useCallback(() => {
    ++generation.current;
    request.current?.abort();
    request.current = null;
    clearTimeout(timeout.current);
    timeout.current = undefined;
  }, []);
  const close = React.useCallback(() => {
    cancel();
    selected.current = null;
    setState(empty());
  }, [cancel]);

  React.useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      cancel();
      selected.current = null;
    };
  }, [cancel]);
  React.useLayoutEffect(() => {
    const selection = selected.current;
    const item = selection && visibleItems.find((candidate) => candidate.entry_id === selection.id);
    if (
      selection &&
      (context.current.scope !== scope ||
        !item ||
        revisionOf(item) !== selection.revision ||
        !sameAuth(selection.auth, readAuth()))
    )
      close();
    context.current = { items: visibleItems, scope };
  });
  React.useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) close();
    };
    window.addEventListener('pagehide', close);
    window.addEventListener('popstate', close);
    window.addEventListener(TENANT_CHANGED_EVENT, close);
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('pagehide', close);
      window.removeEventListener('popstate', close);
      window.removeEventListener(TENANT_CHANGED_EVENT, close);
      window.removeEventListener('pageshow', restore);
    };
  }, [close]);

  const toggle = React.useCallback(
    async (item: Outcome) => {
      if (
        !active.current ||
        !context.current.items.some((current) => revisionOf(current) === revisionOf(item))
      )
        return;
      if (selected.current?.id === item.entry_id) {
        close();
        return;
      }
      cancel();
      const auth = readAuth();
      selected.current = { id: item.entry_id, revision: revisionOf(item), auth };
      if (!auth) {
        // Keep a dismissible error, never issue a credential-free fallback request.
        setState({
          id: item.entry_id,
          data: null,
          error: 'Credential storage unavailable',
          busy: false,
        });
        return;
      }
      const current = generation.current;
      const controller = new AbortController();
      request.current = controller;
      setState({ id: item.entry_id, data: null, error: null, busy: true });
      const owns = () => active.current && generation.current === current;
      const accept = () => {
        if (!owns()) return false;
        if (!sameAuth(auth, readAuth())) {
          close();
          return false;
        }
        return true;
      };
      timeout.current = setTimeout(() => {
        if (!accept()) return;
        cancel();
        setState({
          id: item.entry_id,
          data: null,
          error: 'Outcome preview timed out',
          busy: false,
        });
      }, 20_000);
      try {
        const response = await frontDeskFetch(
          `/api/outcomes/${encodeURIComponent(item.entry_id)}/preview`,
          { cache: 'no-store', signal: controller.signal }
        );
        if (!accept()) return;
        const parsed = parseConciergeOutcomePreviewResponse(await response.json());
        if (!accept()) return;
        if (!response.ok || !parsed || parsed.entry_id !== item.entry_id)
          throw new Error('Invalid outcome preview response');
        setState({ id: item.entry_id, data: parsed, error: null, busy: false });
      } catch (error) {
        if (!accept()) return;
        setState({
          id: item.entry_id,
          data: null,
          error: error instanceof Error ? error.message : String(error),
          busy: false,
        });
      } finally {
        if (owns()) {
          clearTimeout(timeout.current);
          timeout.current = undefined;
          request.current = null;
        }
      }
    },
    [cancel, close]
  );
  return { ...state, toggle, close };
}
