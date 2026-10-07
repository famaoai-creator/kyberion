import { describe, expect, it, vi } from 'vitest';
import { createOutcomeFilesController } from './outcome-files-client';
import { outcomeDownloadUrl } from './outcome-files-response';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function response(entryId = 'INBOX-TEST', offset = 0, count = 1, total = count, status = 200) {
  return new Response(
    JSON.stringify({
      ok: true,
      files: {
        entry_id: entryId,
        total,
        offset,
        files: Array.from({ length: count }, (_, position) => {
          const index = offset + position;
          const id = index.toString(16).padStart(128, '0');
          return {
            index,
            name: index + '.pdf',
            status: 'available',
            id,
            bytes: 12,
            download_url: outcomeDownloadUrl(entryId, id),
          };
        }),
        ...(offset + count < total ? { next_cursor: offset + count + '.' + 'a'.repeat(64) } : {}),
      },
    }),
    { status }
  );
}
describe('outcome file card request lifecycle', () => {
  it('is idle initially; close and reopen cannot resurrect the earlier pending response', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const model = createOutcomeFilesController('INBOX-TEST', fetcher);
    expect(model.getSnapshot()).toMatchObject({ open: false, files: [] });
    expect(fetcher).not.toHaveBeenCalled();
    const opening = model.open();
    model.close();
    const reopening = model.open();
    second.resolve(response());
    await reopening;
    const current = model.getSnapshot();
    first.resolve(response('OTHER'));
    await opening;
    expect(model.getSnapshot()).toBe(current);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('close while pending leaves no links and repeated open/loadMore cannot duplicate requests', async () => {
    const waiting = deferred<Response>();
    const fetcher = vi.fn(() => waiting.promise);
    const model = createOutcomeFilesController('INBOX-TEST', fetcher);
    const pending = model.open();
    await model.open();
    await model.loadMore();
    expect(fetcher).toHaveBeenCalledTimes(1);
    model.close();
    waiting.resolve(response());
    await pending;
    expect(model.getSnapshot()).toMatchObject({ open: false, files: [] });
  });
  it('disposing on another entry or refreshed revision invalidates pending state and notifications', async () => {
    const waiting = deferred<Response>();
    const notify = vi.fn();
    const old = createOutcomeFilesController(
      'INBOX-OLD',
      vi.fn(() => waiting.promise)
    );
    old.subscribe(notify);
    const pending = old.open();
    old.dispose();
    const callCount = notify.mock.calls.length;
    const current = createOutcomeFilesController(
      'INBOX-NEW',
      vi.fn(async () => response('INBOX-NEW'))
    );
    await current.open();
    waiting.resolve(response('INBOX-OLD'));
    await pending;
    expect(notify).toHaveBeenCalledTimes(callCount);
    expect(old.getSnapshot().files).toEqual([]);
    expect(current.getSnapshot().files[0]).toMatchObject({ name: '0.pdf' });
  });
  it('appends further pages, including the sixth file, only at the exact expected offset', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response('INBOX-TEST', 0, 10, 12))
      .mockResolvedValueOnce(response('INBOX-TEST', 10, 2, 12));
    const model = createOutcomeFilesController('INBOX-TEST', fetcher);
    await model.open();
    await model.loadMore();
    expect(model.getSnapshot().files).toHaveLength(12);
    expect(fetcher.mock.calls[1][0]).toContain('/files?cursor=10.');
    expect(model.getSnapshot().nextCursor).toBeUndefined();
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
  });
  it.each([403, 404, 409, 500])(
    'clears old links after pagination error %s; retry starts fresh',
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(response('INBOX-TEST', 0, 10, 12))
        .mockResolvedValueOnce(response('INBOX-TEST', 10, 2, 12, status))
        .mockResolvedValueOnce(response());
      const model = createOutcomeFilesController('INBOX-TEST', fetcher);
      await model.open();
      await model.loadMore();
      expect(model.getSnapshot()).toMatchObject({ open: true, error: true, files: [] });
      await model.open();
      expect(fetcher.mock.calls[2][0]).toBe('/api/outcomes/INBOX-TEST/files');
      expect(model.getSnapshot()).toMatchObject({ error: false, files: [expect.any(Object)] });
    }
  );
  it('drops links for wrong-entry, malformed/redirected responses or changed pagination totals', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response('OTHER'))
      .mockResolvedValueOnce(new Response('<html>login</html>'))
      .mockResolvedValueOnce(response('INBOX-TEST', 0, 10, 12))
      .mockResolvedValueOnce(response('INBOX-TEST', 10, 1, 11));
    const model = createOutcomeFilesController('INBOX-TEST', fetcher);
    await model.open();
    expect(model.getSnapshot().error).toBe(true);
    await model.open();
    expect(model.getSnapshot().files).toEqual([]);
    await model.open();
    await model.loadMore();
    expect(model.getSnapshot()).toMatchObject({ error: true, files: [] });
  });
});
