import { getFrontDeskAuthRevision, readFrontDeskRequestToken } from './front-desk-auth-token';
import { frontDeskFetch } from './front-desk-fetch';
import { outcomeDownloadUrl, type OutcomeFile } from './outcome-files-response';

const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
type AvailableFile = Extract<OutcomeFile, { status: 'available' }>;
type RequestFile = (path: string, init?: RequestInit) => Promise<Response>;
type SaveFile = (blob: Blob, name: string, assertCurrent: () => void) => () => void;
export interface OutcomeFileDownloadState {
  busy: boolean;
  error: boolean;
  index?: number;
}
const initial = (): OutcomeFileDownloadState => ({ busy: false, error: false });

function validateFile(entryId: string, file: OutcomeFile): asserts file is AvailableFile {
  if (
    file.status !== 'available' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entryId) ||
    !/^[a-f0-9]{128}$/.test(file.id) ||
    file.download_url !== outcomeDownloadUrl(entryId, file.id) ||
    !file.name ||
    file.name.length > 240 ||
    /[\\/\x00-\x1f\x7f]/.test(file.name) ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0 ||
    file.bytes > MAX_DOWNLOAD_BYTES
  )
    throw new Error('Invalid outcome file');
}

function validateAttachment(response: Response, file: AvailableFile): string {
  const disposition = response.headers.get('Content-Disposition');
  const encodedName = encodeURIComponent(file.name).replace(
    /['()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase()
  );
  const fallbackName = file.name.replace(/[^A-Za-z0-9._-]/g, '_') || 'download';
  const expectedDisposition =
    'attachment; filename="' + fallbackName + "\"; filename*=UTF-8''" + encodedName;
  const contentType = response.headers.get('Content-Type')?.toLowerCase();
  if (
    response.status !== 200 ||
    !response.ok ||
    response.redirected ||
    disposition !== expectedDisposition ||
    response.headers.get('Content-Length') !== String(file.bytes) ||
    response.headers.get('X-Content-Type-Options')?.toLowerCase() !== 'nosniff' ||
    !contentType ||
    ![
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain; charset=utf-8',
      'application/octet-stream',
    ].includes(contentType) ||
    !response.body
  )
    throw new Error('Invalid outcome file response');
  return contentType;
}

async function readBoundedAttachment(
  response: Response,
  file: AvailableFile,
  signal: AbortSignal,
  assertCurrent: () => void
): Promise<Blob> {
  const contentType = validateAttachment(response, file);
  const reader = response.body!.getReader();
  const bytes = new Uint8Array(file.bytes);
  let received = 0;
  let complete = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      assertCurrent();
      const { done, value } = await reader.read();
      assertCurrent();
      if (done) break;
      if (
        !value ||
        value.byteLength > MAX_DOWNLOAD_BYTES - received ||
        value.byteLength > file.bytes - received
      )
        throw new Error('Outcome file exceeds expected size');
      // One bounded buffer avoids retaining large backing buffers or unbounded chunk metadata.
      bytes.set(value, received);
      received += value.byteLength;
    }
    if (received !== file.bytes) throw new Error('Incomplete outcome file');
    assertCurrent();
    complete = true;
    return new Blob([bytes], { type: contentType });
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

/** Only a local blob URL reaches the browser download link; bearer and server URLs never do. */
function saveFile(blob: Blob, name: string, assertCurrent: () => void): () => void {
  const url = URL.createObjectURL(blob);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revoked = false;
  const revoke = () => {
    if (timer) clearTimeout(timer);
    if (!revoked) {
      revoked = true;
      URL.revokeObjectURL(url);
    }
  };
  let link: HTMLAnchorElement | undefined;
  try {
    link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.appendChild(link);
    assertCurrent();
    link.click();
    // Give the browser a task to capture the URL, with bounded retention even if the card stays open.
    timer = setTimeout(revoke, 1_000);
    return revoke;
  } catch (error) {
    revoke();
    throw error;
  } finally {
    link?.remove();
  }
}

/** One cancellable download per card revision. Safe to close, refresh or unmount at any point. */
export function createOutcomeFileDownloadController(
  entryId: string,
  request: RequestFile = frontDeskFetch,
  save: SaveFile = saveFile
) {
  let state = initial();
  let generation = 0;
  let abort: AbortController | undefined;
  let release: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: OutcomeFileDownloadState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const invalidate = () => {
    generation += 1;
    abort?.abort();
    abort = undefined;
    release?.();
    release = undefined;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async download(file: OutcomeFile) {
      if (state.busy) return;
      invalidate();
      const selectedGeneration = generation;
      let token: string | null = null;
      const authRevision = getFrontDeskAuthRevision();
      const selectedAbort = new AbortController();
      abort = selectedAbort;
      const assertCurrent = () => {
        if (
          generation !== selectedGeneration ||
          selectedAbort.signal.aborted ||
          token !== readFrontDeskRequestToken() ||
          authRevision !== getFrontDeskAuthRevision()
        )
          throw new DOMException('Outcome file request context changed', 'AbortError');
      };
      publish({ busy: true, error: false, index: file.index });
      const timeout = setTimeout(() => selectedAbort.abort(), DOWNLOAD_TIMEOUT_MS);
      let response: Response | undefined;
      try {
        token = readFrontDeskRequestToken();
        validateFile(entryId, file);
        assertCurrent();
        response = await request(file.download_url, {
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
          signal: selectedAbort.signal,
        });
        assertCurrent();
        const blob = await readBoundedAttachment(
          response,
          file,
          selectedAbort.signal,
          assertCurrent
        );
        assertCurrent();
        const saved = save(blob, file.name, assertCurrent);
        try {
          assertCurrent();
        } catch (error) {
          saved();
          throw error;
        }
        release = saved;
        publish(initial());
      } catch {
        if (selectedGeneration === generation)
          publish({ busy: false, error: true, index: file.index });
      } finally {
        clearTimeout(timeout);
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        if (selectedGeneration === generation) abort = undefined;
      }
    },
    cancel() {
      invalidate();
      publish(initial());
    },
    dispose() {
      invalidate();
      listeners.clear();
      state = initial();
    },
  };
}
