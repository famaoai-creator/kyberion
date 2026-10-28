import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { I18nContext, makeI18n } from '../i18n.js';
import { CommandPalette } from './command-palette.js';

vi.hoisted(() => {
  // Yoga loads its bundled WASM with fetch(data:). Fulfil that embedded asset
  // locally while keeping the repository's HTTP/network guard in place.
  const guardedFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('data:application/octet-stream;base64,')) {
      return Promise.resolve(new Response(Buffer.from(input.split(',')[1], 'base64')));
    }
    return guardedFetch(input, init);
  });
});

afterEach(cleanup);

function palette() {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const ui = render(
    createElement(
      I18nContext.Provider,
      { value: makeI18n('en') },
      createElement(CommandPalette, { onSelect, onCancel })
    )
  );
  return { ...ui, onSelect, onCancel };
}

describe('command palette keyboard interaction', () => {
  it('filters, selects by arrow key, and opens only the selected navigation target', async () => {
    const ui = palette();
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('Command palette'));
    ui.stdin.write('schedules');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('1/1'));
    ui.stdin.write('\r');
    await vi.waitFor(() =>
      expect(ui.onSelect).toHaveBeenCalledWith({ kind: 'panel', panel: 'schedules' })
    );
    expect(ui.onCancel).not.toHaveBeenCalled();
  });

  it('scrolls into hidden entries and cancels without selecting an action', async () => {
    const ui = palette();
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('1/12'));
    ui.stdin.write('\u001b[B');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('2/12'));
    ui.stdin.write('\r');
    await vi.waitFor(() =>
      expect(ui.onSelect).toHaveBeenCalledWith({ kind: 'panel', panel: 'tasks' })
    );
    ui.stdin.write('\u001b');
    await vi.waitFor(() => expect(ui.onCancel).toHaveBeenCalledOnce());
  });

  it('keeps an unmatched query inert on Enter', async () => {
    const ui = palette();
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('Command palette'));
    ui.stdin.write('missing-command');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('No entries'));
    ui.stdin.write('\r');
    ui.stdin.write('\u001b');
    await vi.waitFor(() => expect(ui.onCancel).toHaveBeenCalledOnce());
    expect(ui.onSelect).not.toHaveBeenCalled();
  });
});
