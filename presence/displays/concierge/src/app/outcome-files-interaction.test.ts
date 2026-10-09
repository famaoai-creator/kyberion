import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutcomeFilesState } from '../lib/outcome-files-client';
import type { OutcomeFileDownloadState } from '../lib/outcome-file-download';
const harness = vi.hoisted(() => ({
  list: {
    state: {} as OutcomeFilesState,
    getSnapshot: vi.fn(),
    subscribe: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    loadMore: vi.fn(),
    dispose: vi.fn(),
  },
  download: {
    state: {} as OutcomeFileDownloadState,
    getSnapshot: vi.fn(),
    subscribe: vi.fn(),
    download: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  },
  focus: { begin: vi.fn(), cancel: vi.fn(), complete: vi.fn() },
  cleanups: [] as (() => void)[],
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useId: () => 'fixture',
  useMemo: (factory: () => unknown) => factory(),
  useRef: () => ({ current: null }),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useLayoutEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) harness.cleanups.push(cleanup);
  },
  useEffect: () => {},
}));
vi.mock('../lib/outcome-files-client', () => ({
  createOutcomeFilesController: () => harness.list,
}));
vi.mock('../lib/outcome-file-download', () => ({
  createOutcomeFileDownloadController: () => harness.download,
}));
vi.mock('../lib/outcome-files-focus', () => ({
  createOutcomeFilesFocus: () => harness.focus,
}));
vi.mock('../lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ t: (key: string) => key }),
}));
import { OutcomeFiles } from './outcome-files';
type Element = React.ReactElement<Record<string, unknown>>;
function elements(value: React.ReactNode): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!React.isValidElement(value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children as React.ReactNode)];
}
function button(tree: React.ReactNode, label: string) {
  const found = elements(tree).find(
    (element) => element.type === 'button' && element.props.children === label
  );
  expect(found).toBeTruthy();
  return found!;
}
function click(element: Element, source = {}) {
  (element.props.onClick as (event: { currentTarget: unknown }) => void)({
    currentTarget: source,
  });
}
function render() {
  return OutcomeFiles({ entryId: 'INBOX-TEST', revision: '1' });
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.cleanups.length = 0;
  harness.list.state = {
    open: true,
    busy: false,
    error: false,
    total: 12,
    nextCursor: '10.fixture',
    files: [
      {
        index: 0,
        status: 'available',
        name: 'report.pdf',
        id: 'a'.repeat(128),
        bytes: 3,
        download_url: '/fixture',
      },
    ],
  };
  harness.download.state = { busy: false, error: false };
  harness.list.getSnapshot.mockImplementation(() => harness.list.state);
  harness.download.getSnapshot.mockImplementation(() => harness.download.state);
});
/** Hook and DOM doubles verify event wiring only; actual browser focus and React commits are separate QA. */
describe('outcome file control wiring', () => {
  it.each(['list', 'download'] as const)(
    'guards Download while %s is busy, including before rerender',
    (owner) => {
      const ready = button(render(), 'home.files_download');
      harness[owner].state = { ...harness[owner].state, busy: true };
      click(ready);
      expect(harness.download.download).not.toHaveBeenCalled();
      const busy = button(render(), 'home.files_download');
      expect(busy.props['aria-disabled']).toBe(true);
      click(busy);
      expect(harness.download.download).not.toHaveBeenCalled();
    }
  );
  it('starts the selected available file and exposes the active-download status', () => {
    click(button(render(), 'home.files_download'));
    expect(harness.download.download).toHaveBeenCalledExactlyOnceWith(harness.list.state.files[0]);
    harness.download.state = { busy: true, error: false, index: 0 };
    expect(button(render(), 'home.files_download').props['aria-busy']).toBe(true);
  });
  it('cancels active downloads and request-owned focus on close', () => {
    click(button(render(), 'home.files_hide'));
    expect(harness.focus.cancel).toHaveBeenCalledOnce();
    expect(harness.download.cancel).toHaveBeenCalledOnce();
    expect(harness.list.close).toHaveBeenCalledOnce();
  });
  it('cancels a download and records the appended-file focus destination before loading more', () => {
    const source = {};
    click(button(render(), 'home.files_more'), source);
    expect(harness.download.cancel).toHaveBeenCalledOnce();
    expect(harness.focus.begin).toHaveBeenCalledWith(harness.list, source, 1);
    expect(harness.list.loadMore).toHaveBeenCalledOnce();
  });
  it('does not allow stale pagination controls to cancel a download or issue another request', () => {
    const more = button(render(), 'home.files_more');
    harness.list.state = { ...harness.list.state, busy: true };
    click(more);
    expect(harness.list.loadMore).not.toHaveBeenCalled();
    expect(harness.download.cancel).not.toHaveBeenCalled();
    expect(harness.focus.begin).not.toHaveBeenCalled();
  });
  it('starts a fresh list retry with a focus target of index zero', () => {
    harness.list.state = {
      ...harness.list.state,
      error: true,
      files: [],
      nextCursor: undefined,
    };
    const source = {};
    click(button(render(), 'home.files_retry'), source);
    expect(harness.download.cancel).toHaveBeenCalledOnce();
    expect(harness.focus.begin).toHaveBeenCalledWith(harness.list, source, 0);
    expect(harness.list.open).toHaveBeenCalledOnce();
  });
  it('disposes list and download requests and clears focus on unmount or revision replacement', () => {
    render();
    for (const cleanup of harness.cleanups) cleanup();
    expect(harness.list.dispose).toHaveBeenCalledOnce();
    expect(harness.download.dispose).toHaveBeenCalledOnce();
    expect(harness.focus.cancel).toHaveBeenCalledOnce();
  });
  it('keeps unavailable files focusable for keyboard pagination without offering a download', () => {
    harness.list.state.files = [{ index: 0, status: 'unavailable', name: 'gone.pdf' }];
    const tree = elements(render());
    expect(
      tree.some(
        (element) => element.type === 'button' && element.props.children === 'home.files_download'
      )
    ).toBe(false);
    expect(tree.some((element) => element.type === 'span' && element.props.tabIndex === -1)).toBe(
      true
    );
  });
});
