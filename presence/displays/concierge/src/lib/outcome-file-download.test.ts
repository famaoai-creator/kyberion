import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOutcomeFileDownloadController } from './outcome-file-download';
import { outcomeDownloadUrl, type OutcomeFile } from './outcome-files-response';
import { clearFrontDeskToken, storeFrontDeskToken } from './front-desk-auth-token';
const entryId = 'INBOX-TEST';
const id = 'a'.repeat(128);
const file: Extract<OutcomeFile, { status: 'available' }> = {
  index: 0,
  status: 'available',
  id,
  name: 'report.pdf',
  bytes: 3,
  download_url: outcomeDownloadUrl(entryId, id),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function attachment(
  body: BodyInit = new Uint8Array([1, 2, 3]),
  selected = file,
  overrides: HeadersInit = {}
) {
  const encoded = encodeURIComponent(selected.name).replace(
    /['()*]/g,
    (value) => '%' + value.charCodeAt(0).toString(16).toUpperCase()
  );
  return new Response(body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(selected.bytes),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition':
        'attachment; filename="' +
        selected.name.replace(/[^A-Za-z0-9._-]/g, '_') +
        "\"; filename*=UTF-8''" +
        encoded,
      ...overrides,
    },
  });
}
function streamAttachment(selected = file) {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = attachment(
    new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
      cancel,
    }),
    selected
  );
  return { response, stream, cancel };
}
async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });
  vi.stubGlobal('document', { cookie: '' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('bounded authenticated outcome file download', () => {
  it('fails closed if credential storage becomes unavailable during a cookie-session stream', async () => {
    const pending = streamAttachment();
    const save = vi.fn((_blob: Blob, _name: string, _assert: () => void) => vi.fn());
    const model = createOutcomeFileDownloadController(entryId, async () => pending.response, save);
    const download = model.download(file);
    await flush();
    vi.stubGlobal('window', {
      get sessionStorage() {
        throw new Error('blocked');
      },
    });
    pending.stream.enqueue(new Uint8Array([1, 2, 3]));
    await download;
    expect(save).not.toHaveBeenCalled();
    expect(model.getSnapshot().error).toBe(true);
    model.dispose();
  });
  it('uses the exact member route and private request options, then saves the bounded bytes and safe name', async () => {
    const request = vi.fn(async () => attachment());
    const save = vi.fn((_blob: Blob, _name: string, _assertCurrent: () => void) => vi.fn());
    const model = createOutcomeFileDownloadController(entryId, request, save);
    expect(model.getSnapshot()).toEqual({ busy: false, error: false });
    const pending = model.download(file);
    expect(model.getSnapshot()).toEqual({ busy: true, error: false, index: 0 });
    await pending;
    expect(request).toHaveBeenCalledWith(file.download_url, {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(save).toHaveBeenCalledWith(expect.any(Blob), file.name, expect.any(Function));
    expect([...new Uint8Array(await save.mock.calls[0][0].arrayBuffer())]).toEqual([1, 2, 3]);
    expect(model.getSnapshot()).toEqual({ busy: false, error: false });
    model.dispose();
  });
  it.each([
    { download_url: 'https://example.test/file' },
    { download_url: '//example.test/file' },
    { download_url: file.download_url + '?token=fixture' },
    { download_url: outcomeDownloadUrl('OTHER', id) },
    { id: 'b'.repeat(128) },
    { id: 'A'.repeat(128) },
    { status: 'unavailable' },
    { name: '' },
    { name: 'x'.repeat(241) },
    { name: '../report.pdf' },
    { name: 'x\\report.pdf' },
    { name: 'x\n.pdf' },
    { bytes: -1 },
    { bytes: 1.5 },
    { bytes: NaN },
    { bytes: 16 * 1024 * 1024 + 1 },
  ])('rejects invalid file metadata before requesting: %j', async (change) => {
    const request = vi.fn(),
      save = vi.fn();
    const model = createOutcomeFileDownloadController(entryId, request, save);
    await model.download({ ...file, ...change } as OutcomeFile);
    expect(request).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(model.getSnapshot()).toMatchObject({ busy: false, error: true });
  });
  it.each(['../entry', '', 'a'.repeat(129)])('rejects invalid entry IDs %s', async (invalidId) => {
    const request = vi.fn();
    const model = createOutcomeFileDownloadController(invalidId, request, vi.fn());
    await model.download({
      ...file,
      download_url: outcomeDownloadUrl(invalidId, id),
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    ['Content-Disposition', 'inline'],
    ['Content-Disposition', 'attachment; filename="other.pdf"'],
    ['Content-Length', '4'],
    ['Content-Length', '03'],
    ['Content-Length', ''],
    ['Content-Type', 'text/html'],
    ['X-Content-Type-Options', ''],
  ])('rejects mismatched attachment header %s=%s and cancels the body', async (header, value) => {
    const streamed = streamAttachment();
    streamed.response.headers.set(header, value);
    const save = vi.fn();
    const model = createOutcomeFileDownloadController(entryId, async () => streamed.response, save);
    await model.download(file);
    expect(save).not.toHaveBeenCalled();
    expect(streamed.cancel).toHaveBeenCalledOnce();
    expect(model.getSnapshot()).toMatchObject({ error: true });
  });
  it.each([401, 403, 404, 409, 500, 206])(
    'does not retry or save HTTP status %s',
    async (status) => {
      const response = attachment();
      Object.defineProperties(response, {
        status: { value: status },
        ok: { value: status === 206 },
      });
      const request = vi.fn(async () => response),
        save = vi.fn();
      const model = createOutcomeFileDownloadController(entryId, request, save);
      await model.download(file);
      expect(request).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
      expect(model.getSnapshot()).toMatchObject({ error: true });
    }
  );
  it('rejects redirected responses and missing bodies', async () => {
    const redirected = attachment();
    Object.defineProperty(redirected, 'redirected', { value: true });
    const missing = new Response(null, { headers: attachment().headers });
    const save = vi.fn();
    for (const response of [redirected, missing]) {
      const model = createOutcomeFileDownloadController(entryId, async () => response, save);
      await model.download(file);
      expect(model.getSnapshot().error).toBe(true);
    }
    expect(save).not.toHaveBeenCalled();
  });
  it('accepts the exact Unicode filename contract and zero-byte files', async () => {
    const selected = { ...file, bytes: 0, name: 'résumé (final).pdf' };
    const save = vi.fn((_blob: Blob, _name: string, _assertCurrent: () => void) => vi.fn());
    const model = createOutcomeFileDownloadController(
      entryId,
      async () => attachment(new Uint8Array(), selected),
      save
    );
    await model.download(selected);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ size: 0 }),
      selected.name,
      expect.any(Function)
    );
    model.dispose();
  });
  it('accepts exactly 16 MiB, rejects oversized chunks and truncated bodies', async () => {
    const selected = { ...file, bytes: 16 * 1024 * 1024 };
    const save = vi.fn((_blob: Blob, _name: string, _assertCurrent: () => void) => vi.fn());
    const model = createOutcomeFileDownloadController(
      entryId,
      async () => attachment(new Uint8Array(selected.bytes), selected),
      save
    );
    await model.download(selected);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ size: selected.bytes }),
      file.name,
      expect.any(Function)
    );
    model.dispose();
    for (const length of [2, 4]) {
      const rejectSave = vi.fn();
      const rejected = createOutcomeFileDownloadController(
        entryId,
        async () => attachment(new Uint8Array(length)),
        rejectSave
      );
      await rejected.download(file);
      expect(rejectSave).not.toHaveBeenCalled();
      expect(rejected.getSnapshot().error).toBe(true);
    }
  });
  it('assembles small views without retaining their much larger backing buffer', async () => {
    const streamed = streamAttachment();
    const backing = new Uint8Array(1024 * 1024);
    backing.set([1, 2, 3]);
    streamed.stream.enqueue(backing.subarray(0, 1));
    streamed.stream.enqueue(backing.subarray(1, 3));
    streamed.stream.close();
    const save = vi.fn((_blob: Blob, _name: string, _assertCurrent: () => void) => vi.fn());
    const model = createOutcomeFileDownloadController(entryId, async () => streamed.response, save);
    await model.download(file);
    expect(save.mock.calls[0][0].size).toBe(3);
    model.dispose();
  });
  it('ignores double clicks; cancel and reopen cannot save a late older response', async () => {
    const first = deferred<Response>(),
      second = deferred<Response>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const save = vi.fn((_blob: Blob, _name: string, _assertCurrent: () => void) => vi.fn());
    const model = createOutcomeFileDownloadController(entryId, request, save);
    const old = model.download(file);
    await model.download(file);
    expect(request).toHaveBeenCalledOnce();
    model.cancel();
    expect(request.mock.calls[0][1]!.signal!.aborted).toBe(true);
    const current = model.download(file);
    second.resolve(attachment());
    await current;
    const snapshot = model.getSnapshot();
    const late = streamAttachment();
    first.resolve(late.response);
    await old;
    expect(save).toHaveBeenCalledOnce();
    expect(late.cancel).toHaveBeenCalledOnce();
    expect(model.getSnapshot()).toBe(snapshot);
    model.dispose();
  });
  it.each(['cancel', 'dispose'] as const)(
    '%s aborts streaming, prevents save and suppresses stale notification',
    async (method) => {
      const streamed = streamAttachment(),
        save = vi.fn(),
        listener = vi.fn();
      const request = vi.fn(async (_path: string, _init?: RequestInit) => streamed.response);
      const model = createOutcomeFileDownloadController(entryId, request, save);
      model.subscribe(listener);
      const pending = model.download(file);
      await flush();
      model[method]();
      const calls = listener.mock.calls.length;
      await pending;
      expect(request.mock.calls[0][1]!.signal!.aborted).toBe(true);
      expect(streamed.cancel).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalledTimes(calls);
      expect(model.getSnapshot()).toEqual({ busy: false, error: false });
    }
  );
  it.each(['token replacement', 'same token revision', 'clear then restore'])(
    'fences streaming after %s',
    async (change) => {
      storeFrontDeskToken('fixture-a');
      const streamed = streamAttachment(),
        save = vi.fn();
      const model = createOutcomeFileDownloadController(
        entryId,
        async () => streamed.response,
        save
      );
      const pending = model.download(file);
      await flush();
      if (change === 'clear then restore') {
        clearFrontDeskToken();
        storeFrontDeskToken('fixture-a');
      } else storeFrontDeskToken(change === 'token replacement' ? 'fixture-b' : 'fixture-a');
      streamed.stream.enqueue(new Uint8Array([1, 2, 3]));
      await pending;
      expect(save).not.toHaveBeenCalled();
      expect(streamed.cancel).toHaveBeenCalledOnce();
      expect(model.getSnapshot()).toMatchObject({ busy: false, error: true });
    }
  );
  it('rejects token changes while awaiting response headers', async () => {
    const waiting = deferred<Response>(),
      save = vi.fn();
    const model = createOutcomeFileDownloadController(entryId, () => waiting.promise, save);
    const pending = model.download(file);
    storeFrontDeskToken('changed');
    const streamed = streamAttachment();
    waiting.resolve(streamed.response);
    await pending;
    expect(save).not.toHaveBeenCalled();
    expect(streamed.cancel).toHaveBeenCalledOnce();
  });
  it('times out an abort-aware request, then allows an explicit successful retry', async () => {
    vi.useFakeTimers();
    const save = vi.fn((_blob: Blob, _name: string, _assertCurrent: () => void) => vi.fn());
    const request = vi
      .fn()
      .mockImplementationOnce(
        (_path: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener(
              'abort',
              () => reject(new DOMException('timeout', 'AbortError')),
              { once: true }
            );
          })
      )
      .mockResolvedValueOnce(attachment());
    const model = createOutcomeFileDownloadController(entryId, request, save);
    const pending = model.download(file);
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(model.getSnapshot()).toMatchObject({ busy: false, error: true });
    expect(save).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    await model.download(file);
    expect(model.getSnapshot()).toEqual({ busy: false, error: false });
    expect(save).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    model.dispose();
  });
  it('times out a stalled body and cancels its reader', async () => {
    vi.useFakeTimers();
    const streamed = streamAttachment(),
      save = vi.fn();
    const model = createOutcomeFileDownloadController(entryId, async () => streamed.response, save);
    const pending = model.download(file);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(streamed.cancel).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(model.getSnapshot()).toMatchObject({ busy: false, error: true });
  });
  it('unsubscribes observers and releases prior saves on retry, cancel and dispose', async () => {
    const releases = [vi.fn(), vi.fn(), vi.fn()];
    const save = vi
      .fn()
      .mockReturnValueOnce(releases[0])
      .mockReturnValueOnce(releases[1])
      .mockReturnValueOnce(releases[2]);
    const model = createOutcomeFileDownloadController(entryId, async () => attachment(), save);
    const listener = vi.fn(),
      unsubscribe = model.subscribe(listener);
    unsubscribe();
    await model.download(file);
    await model.download(file);
    expect(releases[0]).toHaveBeenCalledOnce();
    model.cancel();
    expect(releases[1]).toHaveBeenCalledOnce();
    await model.download(file);
    model.dispose();
    expect(releases[2]).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });
  it('releases a save if auth changes before the controller commits it', async () => {
    const release = vi.fn();
    const model = createOutcomeFileDownloadController(
      entryId,
      async () => attachment(),
      () => {
        storeFrontDeskToken('changed');
        return release;
      }
    );
    await model.download(file);
    expect(release).toHaveBeenCalledOnce();
    expect(model.getSnapshot().error).toBe(true);
  });
});
describe('browser download URL lifecycle (DOM doubles)', () => {
  function browser(click = vi.fn()) {
    const link = {
      href: '',
      download: '',
      hidden: false,
      click,
      remove: vi.fn(),
    };
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const appendChild = vi.fn();
    vi.stubGlobal('document', {
      cookie: '',
      createElement: vi.fn(() => link),
      body: { appendChild },
    });
    return { link, create, revoke, appendChild };
  }
  it('clicks only a local blob URL, removes the link and revokes after one second or disposal', async () => {
    vi.useFakeTimers();
    const dom = browser();
    const model = createOutcomeFileDownloadController(entryId, async () => attachment());
    await model.download(file);
    expect(dom.link).toMatchObject({
      href: 'blob:fixture',
      download: file.name,
      hidden: true,
    });
    expect(dom.link.click).toHaveBeenCalledOnce();
    expect(dom.link.remove).toHaveBeenCalledOnce();
    expect(dom.revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(dom.revoke).toHaveBeenCalledExactlyOnceWith('blob:fixture');
    model.dispose();
    expect(dom.revoke).toHaveBeenCalledOnce();
    await model.download(file);
    model.cancel();
    expect(dom.revoke).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('revokes and removes the link if the browser click throws, then permits retry', async () => {
    const click = vi.fn().mockImplementationOnce(() => {
      throw new Error('blocked');
    });
    const dom = browser(click);
    const model = createOutcomeFileDownloadController(entryId, async () => attachment());
    await model.download(file);
    expect(dom.revoke).toHaveBeenCalledOnce();
    expect(dom.link.remove).toHaveBeenCalledOnce();
    expect(model.getSnapshot().error).toBe(true);
    await model.download(file);
    expect(click).toHaveBeenCalledTimes(2);
    model.dispose();
  });
  it('checks the current auth context immediately before clicking', async () => {
    const dom = browser();
    dom.appendChild.mockImplementation(() => storeFrontDeskToken('changed'));
    const model = createOutcomeFileDownloadController(entryId, async () => attachment());
    await model.download(file);
    expect(dom.link.click).not.toHaveBeenCalled();
    expect(dom.revoke).toHaveBeenCalledOnce();
    expect(dom.link.remove).toHaveBeenCalledOnce();
    expect(model.getSnapshot().error).toBe(true);
  });
});
