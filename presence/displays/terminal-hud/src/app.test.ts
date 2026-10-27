import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from './app.js';

const fake = vi.hoisted(() => {
  const guardedFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('data:application/octet-stream;base64,')) {
      return Promise.resolve(new Response(Buffer.from(input.split(',')[1], 'base64')));
    }
    return guardedFetch(input, init);
  });
  return { ask: vi.fn() };
});

vi.mock('./store/use-poll-watch.js', () => ({ usePollWatch: () => ({ loading: false }) }));
vi.mock('./store/operator-home.js', () => ({
  loadOperatorHome: vi.fn(),
  operatorHomeWatchPaths: () => [],
}));
vi.mock('./voice/use-voice-input.js', () => ({
  useVoiceInput: () => ({ state: undefined, toggle: vi.fn() }),
}));
vi.mock('./actions/ask.js', () => ({ askKyberion: fake.ask }));
vi.mock('@agent/core/scope-context', () => ({ currentScope: () => ({ tier: 'public' }) }));
vi.mock('@agent/core/intent/intent-resolution-contract', () => ({
  resolveIntentResolutionContract: () => undefined,
}));
vi.mock('./panels/missions-panel.js', async () => {
  const { createElement, useState } = await import('react');
  const { Text, useInput } = await import('ink');
  return {
    MissionsPanel: ({ isActive }: { isActive: boolean }) => {
      const [selection, setSelection] = useState(0);
      useInput(
        (input) => {
          if (input === 'j') setSelection((value) => value + 1);
        },
        { isActive }
      );
      return createElement(Text, null, `missions-selection:${selection} active:${isActive}`);
    },
  };
});
vi.mock('./panels/settings-panel.js', async () => {
  const { createElement } = await import('react');
  const { Text } = await import('ink');
  return { SettingsPanel: () => createElement(Text, null, 'settings-panel') };
});

afterEach(() => {
  cleanup();
  fake.ask.mockReset();
});

describe('terminal command picker and composer', () => {
  it('restores the focused draft after cancelling a picker and after panel navigation', async () => {
    const ui = render(createElement(App, { initialLocale: 'en' }));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('missions-selection:0'));
    ui.stdin.write('keep-this-draft');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('keep-this-draft'));
    ui.stdin.write('\u0010');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('Search panels and actions'));
    ui.stdin.write('connections');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('Service connections'));
    ui.stdin.write('\u001b');
    await vi.waitFor(() => expect(ui.lastFrame()).not.toContain('Command palette'));
    ui.stdin.write('-continued');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('keep-this-draft-continued'));
    ui.stdin.write('\u0010');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('Command palette'));
    ui.stdin.write('connections');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('Service connections'));
    ui.stdin.write('\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('settings-panel'));
    expect(ui.lastFrame()).toContain('keep-this-draft-continued');
    expect(fake.ask).not.toHaveBeenCalled();
  });

  it('preserves panel selection across the modal and ignores panel keys during search', async () => {
    const ui = render(createElement(App, { initialLocale: 'en' }));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('missions-selection:0'));
    ui.stdin.write('\u001b');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('missions-selection:0 active:true'));
    ui.stdin.write('j');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('missions-selection:1'));
    ui.stdin.write('\u0010');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('Search panels and actions'));
    ui.stdin.write('j');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('No entries'));
    ui.stdin.write('\u001b');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('missions-selection:1'));
    ui.stdin.write('j');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('missions-selection:2'));
  });

  it('keeps a second draft editable during inference without dispatching it or claiming it is queued', async () => {
    let resolveReply: (reply: { text: string }) => void = () => undefined;
    fake.ask.mockReturnValue(
      new Promise((resolve) => {
        resolveReply = resolve;
      })
    );
    const ui = render(createElement(App, { initialLocale: 'en' }));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('missions-selection:0'));
    ui.stdin.write('first question');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('first question'));
    ui.stdin.write('\r');
    await vi.waitFor(() => expect(fake.ask).toHaveBeenCalledTimes(1));
    ui.stdin.write('second draft');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('second draft'));
    expect(ui.lastFrame()).toContain('Your draft is kept');
    ui.stdin.write('\r');
    expect(fake.ask).toHaveBeenCalledTimes(1);
    expect(ui.lastFrame()).toContain('second draft');
    resolveReply({ text: 'first reply' });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('first reply'));
    expect(ui.lastFrame()).toContain('second draft');
    expect(ui.lastFrame()).not.toContain('Your draft is kept');
    expect(fake.ask).toHaveBeenCalledTimes(1);
  });

  it('admits only one inference when Enter is repeated before a busy repaint', async () => {
    let resolveReply: (reply: { text: string }) => void = () => undefined;
    fake.ask.mockReturnValue(
      new Promise((resolve) => {
        resolveReply = resolve;
      })
    );
    const ui = render(createElement(App, { initialLocale: 'en' }));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('missions-selection:0'));
    ui.stdin.write('first question');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('first question'));
    ui.stdin.write('\r');
    ui.stdin.write('\r');
    await vi.waitFor(() => expect(fake.ask).toHaveBeenCalledTimes(1));
    resolveReply({ text: 'one reply' });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('one reply'));
    expect(fake.ask).toHaveBeenCalledTimes(1);
  });
});
