'use client';

/**
 * CD-12 drill-down: the browser side of the case and learning views — one
 * request to the viewer-scoped route, the response validated with the same
 * import-free parser the server used, and the HTTP status mapped to the state
 * the view shows (forbidden and not-built are their own states: retrying
 * does not help them).
 */
import * as React from 'react';
import {
  parseCustomerDecisionCaseResponse,
  type CustomerDecisionCaseDetailView,
} from './customer-decision-case-response';
import {
  parseCustomerDecisionLearningResponse,
  type CustomerDecisionLearningViewData,
} from './customer-decision-learning-response';

export type CustomerDecisionViewKind = 'case' | 'learning';

export interface CustomerDecisionViewValues {
  case: CustomerDecisionCaseDetailView;
  learning: CustomerDecisionLearningViewData;
}

export type CustomerDecisionViewState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  /** Retry may help (timeout, a failed child, an unexpected answer, the network). */
  | { kind: 'error'; message: string }
  /** 401 / 403: the viewer may not see this; retrying does not help. */
  | { kind: 'forbidden'; message: string }
  /** 404: the case (or the report of that date) does not exist. */
  | { kind: 'not_found'; message: string }
  /** 503 with `reason: 'not_built'`: the server's governed facade is not built. */
  | { kind: 'not_built'; message: string };

/**
 * Only the latest request may update a view: starting a request aborts the
 * previous one, and a response that lands after a newer request (or after
 * the tenant / selection changed or the view unmounted) is dropped.
 */
export function createLatestRequestGuard() {
  let controller: AbortController | null = null;
  let generation = 0;
  return {
    begin(): { signal: AbortSignal; isCurrent: () => boolean } {
      controller?.abort();
      controller = new AbortController();
      const mine = ++generation;
      return { signal: controller.signal, isCurrent: () => mine === generation };
    },
    cancel(): void {
      controller?.abort();
      controller = null;
      generation += 1;
    },
  };
}

export function customerDecisionViewUrl(
  kind: CustomerDecisionViewKind,
  tenant: string,
  arg?: string
): string {
  const params = new URLSearchParams({ tenant });
  if (kind === 'case' && arg) params.set('case', arg);
  if (kind === 'learning' && arg) params.set('date', arg);
  return `/api/customer-decisions/${kind}?${params.toString()}`;
}

function errorMessage(raw: unknown, status: number): string {
  return raw && typeof raw === 'object' && 'error' in raw && typeof raw.error === 'string'
    ? raw.error
    : `customer decisions ${status}`;
}

/**
 * One request of a view → its state. An aborted request resolves to null
 * (the caller keeps whatever newer state it has).
 */
export async function fetchCustomerDecisionView<K extends CustomerDecisionViewKind>(
  kind: K,
  tenant: string,
  arg: string | undefined,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {}
): Promise<CustomerDecisionViewState<CustomerDecisionViewValues[K]> | null> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(customerDecisionViewUrl(kind, tenant, arg), {
      cache: 'no-store',
      signal: options.signal,
    });
    const raw: unknown = await response.json().catch(() => null);
    if (options.signal?.aborted) return null;
    if (response.ok) {
      const value =
        kind === 'case'
          ? parseCustomerDecisionCaseResponse(raw, tenant, arg)
          : parseCustomerDecisionLearningResponse(raw, tenant, arg);
      if (value) return { kind: 'ready', value: value as CustomerDecisionViewValues[K] };
      return { kind: 'error', message: `customer decisions ${response.status}` };
    }
    const message = errorMessage(raw, response.status);
    if (response.status === 401 || response.status === 403) return { kind: 'forbidden', message };
    if (response.status === 404) return { kind: 'not_found', message };
    // A 503 is "not built" only when the route says so; a busy server is retryable.
    if (
      response.status === 503 &&
      raw &&
      typeof raw === 'object' &&
      'reason' in raw &&
      raw.reason === 'not_built'
    )
      return { kind: 'not_built', message };
    return { kind: 'error', message };
  } catch (error) {
    if (options.signal?.aborted) return null;
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** A view's state for `tenant` / `arg`, with a retry; refetched when either changes. */
export function useCustomerDecisionView<K extends CustomerDecisionViewKind>(
  kind: K,
  tenant: string,
  arg: string | undefined
): {
  state: CustomerDecisionViewState<CustomerDecisionViewValues[K]>;
  busy: boolean;
  retry: () => void;
} {
  const [state, setState] = React.useState<
    CustomerDecisionViewState<CustomerDecisionViewValues[K]>
  >({ kind: 'loading' });
  const [busy, setBusy] = React.useState(false);
  const guard = React.useMemo(() => createLatestRequestGuard(), []);

  const load = React.useCallback(async () => {
    const request = guard.begin();
    setBusy(true);
    const next = await fetchCustomerDecisionView(kind, tenant, arg, { signal: request.signal });
    // A response for a previous tenant / case / date never lands.
    if (!request.isCurrent()) return;
    if (next) setState(next);
    setBusy(false);
  }, [kind, tenant, arg, guard]);

  React.useEffect(() => {
    setState({ kind: 'loading' });
    void load();
    return () => guard.cancel();
  }, [load, guard]);

  return { state, busy, retry: () => void load() };
}
