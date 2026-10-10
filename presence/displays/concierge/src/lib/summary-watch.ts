import { getFrontDeskAuthRevision, readFrontDeskRequestToken } from './front-desk-auth-token';
import {
  SELECTED_TENANT_PARAM,
  selectionFromPageUrl,
  syncSelectionCookieFromUrl,
} from './tenant-context';
const INTERVAL_MS = 30_000;
const TIMEOUT_MS = 15_000;
/** Native EventSource cannot carry a tab bearer. */
export function startSummaryWatch(input: {
  refresh: (signal: AbortSignal) => Promise<void>;
  onSummary: (event: MessageEvent) => void;
}): () => void {
  let token: string | null;
  try {
    token = readFrontDeskRequestToken();
  } catch {
    const controller = new AbortController();
    void input.refresh(controller.signal).catch(() => {});
    return () => controller.abort();
  }
  const revision = getFrontDeskAuthRevision();
  let active = true;
  let polling = Boolean(token);
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const current = () => {
    try {
      return (
        active && token === readFrontDeskRequestToken() && revision === getFrontDeskAuthRevision()
      );
    } catch {
      return false;
    }
  };
  const schedule = () => {
    if (!current() || !polling || timer || controller) return;
    timer = setTimeout(() => {
      timer = undefined;
      run();
    }, INTERVAL_MS);
  };
  const run = () => {
    if (!current() || controller) return;
    controller = new AbortController();
    const pending = controller;
    timeout = setTimeout(() => pending.abort(), TIMEOUT_MS);
    void input
      .refresh(pending.signal)
      .catch(() => {})
      .finally(() => {
        clearTimeout(timeout);
        timeout = undefined;
        controller = undefined;
        schedule();
      });
  };
  run();
  if (!token) {
    try {
      syncSelectionCookieFromUrl();
      const selection = selectionFromPageUrl();
      source = new EventSource(
        selection
          ? `/api/events?${SELECTED_TENANT_PARAM}=${encodeURIComponent(selection)}`
          : '/api/events'
      );
      source.addEventListener('summary', (event) => {
        if (current()) {
          controller?.abort();
          input.onSummary(event as MessageEvent);
        }
      });
      source.onerror = () => {
        source?.close();
        source = null;
        polling = true;
        schedule();
      };
    } catch {
      polling = true;
      schedule();
    }
  }
  return () => {
    active = false;
    source?.close();
    clearTimeout(timer);
    clearTimeout(timeout);
    controller?.abort();
  };
}
