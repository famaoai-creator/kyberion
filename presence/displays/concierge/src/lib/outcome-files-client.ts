import { frontDeskFetch } from './front-desk-fetch';
import { parseOutcomeFilesResponse, type OutcomeFile } from './outcome-files-response';
export interface OutcomeFilesState {
  open: boolean;
  busy: boolean;
  error: boolean;
  files: OutcomeFile[];
  total: number;
  nextCursor?: string;
}
const initial = (): OutcomeFilesState => ({
  open: false,
  busy: false,
  error: false,
  files: [],
  total: 0,
});
/** Owns one card revision. Closing, refresh and unmount invalidate every outstanding response. */
export function createOutcomeFilesController(
  entryId: string,
  request: (path: string, init?: RequestInit) => Promise<Response> = frontDeskFetch
) {
  let state = initial();
  let generation = 0;
  let abort: AbortController | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: OutcomeFilesState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const cancel = () => {
    generation += 1;
    abort?.abort();
    abort = undefined;
  };
  const load = async (append: boolean) => {
    if (state.busy) return;
    const prior = append ? state : { ...initial(), open: true };
    if (append && !prior.nextCursor) return;
    cancel();
    const selectedGeneration = generation;
    abort = new AbortController();
    publish({ ...prior, open: true, busy: true, error: false });
    try {
      const url =
        '/api/outcomes/' +
        encodeURIComponent(entryId) +
        '/files' +
        (append ? '?cursor=' + encodeURIComponent(prior.nextCursor!) : '');
      const response = await request(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: abort.signal,
      });
      const page = parseOutcomeFilesResponse(await response.json(), entryId);
      if (selectedGeneration !== generation) return;
      if (
        !response.ok ||
        !page ||
        page.offset !== (append ? prior.files.length : 0) ||
        (append && page.total !== prior.total)
      )
        throw new Error('Invalid file list');
      publish({
        open: true,
        busy: false,
        error: false,
        total: page.total,
        files: append ? [...prior.files, ...page.files] : page.files,
        nextCursor: page.next_cursor,
      });
    } catch {
      if (selectedGeneration !== generation) return;
      // Even a pagination failure drops old links. Retry starts from a fresh authorization/listing.
      publish({ ...initial(), open: true, error: true });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: () => load(false),
    loadMore: () => load(true),
    close: () => {
      cancel();
      publish(initial());
    },
    dispose: () => {
      cancel();
      listeners.clear();
      state = initial();
    },
  };
}
