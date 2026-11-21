import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { Key } from 'ink';

// Ink loads its Yoga wasm through a data: URL fetch; serve it locally so the
// network guard does not see egress (same stub as terminal-hud's app test).
vi.hoisted(() => {
  const guardedFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('data:application/octet-stream;base64,')) {
      return Promise.resolve(new Response(Buffer.from(input.split(',')[1]!, 'base64')));
    }
    return guardedFetch(input, init);
  });
});

vi.mock('@agent/core/scope-context', () => ({ currentScope: () => ({ tier: 'public' }) }));
vi.mock('@agent/core/intent/intent-resolution-contract', () => ({
  resolveIntentResolutionContract: () => ({
    normalized_intent: 'review the release',
    resolution_shape: 'task_session',
    missing_inputs: [],
  }),
}));

import { App } from './app.js';
import { DeckController, oscPayload } from './controller.js';
import { hintKey } from './app.js';
import { artifactTitle, humanize, outcomeLabel, shapeLabel } from './ui/labels.js';
import { withTimeout } from './actions/effects.js';
import { DeckStore, initialDeckState } from './store/deck-store.js';
import { makeI18n } from './i18n.js';
import { snapshotLines } from './snapshot.js';
import { previewIntent } from './ui/composer.js';
import { questionLines } from './ui/panes.js';
import type { DeckHost } from './data/host.js';
import type { HostRequest, HostResponseValue } from './data/protocol.js';
import { EMPTY_SNAPSHOT, type DeckSnapshot } from './model/types.js';

export const FIXTURE_SNAPSHOT: DeckSnapshot = {
  ...EMPTY_SNAPSHOT,
  generatedAt: '2026-11-20T00:00:00Z',
  scopeLabel: 'public',
  statusLabel: 'ok',
  agentsAvailable: true,
  decisions: [
    {
      id: 'req-1',
      title: 'Publish release notes',
      question: 'Publish now?',
      recommendation: 'Approve',
      reasons: ['reviewed'],
      ifNoResponse: 'Nothing is published',
      reversible: false,
      level: 'decide',
      requestedAt: '2026-11-19T10:00:00Z',
      missionId: 'MSN-A',
      cardLines: [],
    },
  ],
  missions: [
    {
      id: 'MSN-A',
      status: 'active',
      tier: 'public',
      goal: 'Ship the deck',
      checkpoints: 2,
      artifactCount: 1,
      updatedAt: '2026-11-19',
    },
    {
      id: 'MSN-B',
      status: 'validating',
      tier: 'public',
      goal: 'Review docs',
      checkpoints: 1,
      artifactCount: 0,
    },
  ],
  agents: [
    {
      target: 'pane-1',
      name: 'claude',
      provider: 'claude',
      state: 'working',
      missionId: 'MSN-A',
      tail: ['compiling…'],
    },
    {
      target: 'pane-2',
      name: 'codex',
      provider: 'codex',
      state: 'blocked',
      tail: ['Proceed? [y/n]'],
    },
  ],
};

export function fakeHost(
  respond: (request: HostRequest) => HostResponseValue = () => ({ ok: true, message: 'ok' })
): DeckHost & {
  requests: HostRequest[];
  emit: (s: DeckSnapshot) => void;
  refresh: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<(s: DeckSnapshot) => void>();
  const requests: HostRequest[] = [];
  return {
    mode: 'inline',
    requests,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (snapshot) => {
      for (const listener of listeners) listener(snapshot);
    },
    request: async (request) => {
      requests.push(request);
      return respond(request);
    },
    refresh: vi.fn(),
    setLocale: vi.fn(),
    stop: () => undefined,
  };
}

const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
} as Key;
const key = (patch: Partial<Key> = {}): Key => ({ ...NO_KEY, ...patch });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(locale: 'en' | 'ja' = 'en') {
  const store = new DeckStore(initialDeckState({ threadTs: 't-test' }));
  const host = fakeHost((request) =>
    request.op === 'missionDetail'
      ? { id: request.id, phase: 'executing', tasks: [], evidence: [], history: [], context: [] }
      : request.op === 'ask'
        ? {
            ok: true,
            message: 'Here is the plan.',
            intent: { understood: 'plan', shape: 'task_session' },
          }
        : { ok: true, message: 'ok' }
  );
  const exit = vi.fn();
  const toggleLocale = vi.fn();
  const signals = { title: vi.fn(), notify: vi.fn() };
  const controller = new DeckController(store, host, () => makeI18n(locale), signals, {
    exit,
    toggleLocale,
  });
  return { store, host, controller, exit, toggleLocale, signals };
}

describe('DeckController', () => {
  it('selects the first decision, announces it once and sets the terminal title', () => {
    const { store, controller, signals } = setup();
    controller.onSnapshot(FIXTURE_SNAPSHOT);
    const state = store.getState();
    expect(state.loaded).toBe(true);
    expect(state.railKey).toBe('decision:req-1');
    expect(state.transcript.map((t) => t.decisionId).filter(Boolean)).toEqual(['req-1']);
    expect(signals.title).toHaveBeenLastCalledWith('◆2 Kyberion Deck');
    expect(signals.notify).not.toHaveBeenCalled();

    // A decision arriving after launch is announced via OSC 9 — and only once.
    const next = {
      ...FIXTURE_SNAPSHOT,
      decisions: [
        ...FIXTURE_SNAPSHOT.decisions,
        { ...FIXTURE_SNAPSHOT.decisions[0]!, id: 'req-2', title: 'Merge PR' },
      ],
    };
    controller.onSnapshot(next);
    controller.onSnapshot(next);
    expect(signals.notify).toHaveBeenCalledTimes(1);
    expect(signals.notify).toHaveBeenCalledWith('Kyberion: Merge PR');
  });

  it('keeps the cursor on the same item across refreshes', () => {
    const { store, controller } = setup();
    controller.onSnapshot(FIXTURE_SNAPSHOT);
    store.set({ focus: 'rail' });
    controller.handleKey('j', key());
    controller.handleKey('j', key());
    const selected = store.getState().railKey;
    controller.onSnapshot({ ...FIXTURE_SNAPSHOT, generatedAt: 'later' });
    expect(store.getState().railKey).toBe(selected);
  });

  it('approves only after confirmation, by handing off to the governed CLI', async () => {
    const { store, controller, exit } = setup();
    controller.onSnapshot(FIXTURE_SNAPSHOT);
    store.set({ focus: 'rail' });
    controller.handleKey('a', key());
    expect(store.getState().overlay.kind).toBe('confirm');
    expect(store.getState().handoff).toBeUndefined();
    controller.handleKey('n', key());
    expect(store.getState().overlay.kind).toBe('none');

    controller.handleKey('a', key());
    controller.handleKey('y', key());
    await tick();
    const handoff = store.getState().handoff;
    expect(handoff?.kind).toBe('approval');
    expect(handoff?.args.slice(1)).toEqual(['approvals', '--approve', 'req-1']);
    expect(exit).toHaveBeenCalled();
  });

  it('steers the selected mission through the queue with its scope', async () => {
    const { store, host, controller } = setup();
    controller.onSnapshot(FIXTURE_SNAPSHOT);
    store.set({ focus: 'rail' });
    controller.handleKey('s', key()); // decision linked to MSN-A
    const overlay = store.getState().overlay;
    expect(overlay).toMatchObject({
      kind: 'steer',
      target: { kind: 'mission', missionId: 'MSN-A' },
    });
    await controller.submitSteer('focus on tests');
    expect(host.requests.at(-1)).toEqual({
      op: 'steer',
      missionId: 'MSN-A',
      text: 'focus on tests',
      delivery: 'steer',
      tier: 'public',
    });
    expect(store.getState().toast?.ok).toBe(true);
  });

  it('interrupts an agent only after confirmation', async () => {
    const { store, host, controller } = setup();
    controller.onSnapshot(FIXTURE_SNAPSHOT);
    store.set({ focus: 'agents', agentIndex: 1 });
    controller.handleKey('!', key());
    expect(store.getState().overlay).toMatchObject({
      kind: 'confirm',
      action: { kind: 'interrupt', target: 'pane-2' },
    });
    expect(host.requests.some((r) => r.op === 'agentInterrupt')).toBe(false);
    controller.handleKey('y', key());
    await tick();
    expect(host.requests.at(-1)).toEqual({ op: 'agentInterrupt', target: 'pane-2' });
  });

  it('attaches to the focused agent on Enter', () => {
    const { store, controller } = setup();
    controller.onSnapshot(FIXTURE_SNAPSHOT);
    store.set({ focus: 'agents', agentIndex: 0 });
    controller.handleKey('', key({ return: true }));
    expect(store.getState().handoff).toMatchObject({
      kind: 'attach',
      args: ['agent', 'attach', 'pane-1'],
    });
  });

  it('sends conversation turns and records the reply with its intent', async () => {
    const { store, host, controller } = setup();
    controller.onSnapshot(FIXTURE_SNAPSHOT);
    await controller.submitConversation('  plan the release  ');
    expect(host.requests.at(-1)).toMatchObject({
      op: 'ask',
      text: 'plan the release',
      threadTs: 't-test',
      locale: 'en',
    });
    const turns = store.getState().transcript.slice(-2);
    expect(turns.map((t) => t.who)).toEqual(['you', 'kyb']);
    expect(turns[1]!.intent).toEqual({ understood: 'plan', shape: 'task_session' });
    expect(store.getState().busy).toBe(false);
  });

  it('routes views, focus, help, palette and quit keys', () => {
    const { store, controller, exit, toggleLocale } = setup();
    controller.onSnapshot(FIXTURE_SNAPSHOT);
    controller.handleKey('', key({ escape: true }));
    expect(store.getState().focus).toBe('rail');
    controller.handleKey('3', key());
    expect(store.getState()).toMatchObject({ view: 'terminals', focus: 'agents' });
    controller.handleKey('?', key());
    expect(store.getState().overlay.kind).toBe('help');
    controller.handleKey('x', key());
    expect(store.getState().overlay.kind).toBe('none');
    controller.handleKey('p', key({ ctrl: true }));
    expect(store.getState().overlay.kind).toBe('palette');
    controller.handleKey('', key({ escape: true }));
    controller.handleKey('L', key());
    expect(toggleLocale).toHaveBeenCalled();
    controller.handleKey('q', key());
    expect(store.getState().quitting).toBe(true);
    expect(exit).toHaveBeenCalled();
  });

  it('g jumps to the first waiting item', () => {
    const { store, controller } = setup();
    controller.onSnapshot(FIXTURE_SNAPSHOT);
    store.set({ focus: 'rail' });
    controller.handleKey('j', key());
    controller.handleKey('j', key());
    controller.handleKey('g', key());
    expect(store.getState().railKey).toBe('decision:req-1');
  });
});

describe('App (Ink)', () => {
  afterEach(() => cleanup());

  it('renders rail, conversation card and agents in three columns (ink-testing-library stdout is 100 columns)', async () => {
    const store = new DeckStore(initialDeckState());
    const host = fakeHost();
    const { lastFrame } = render(
      createElement(App, { store, host, locale: 'en', size: { columns: 100, rows: 34 } })
    );
    host.emit(FIXTURE_SNAPSHOT);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Needs your decision');
    expect(frame).toContain('Publish release notes');
    expect(frame).toContain('Cannot be undone');
    expect(frame).toContain('codex');
    expect(frame).toContain('KYBERION');
    expect(frame).not.toMatch(/deck:[a-z_]+/);
  });

  it('renders Japanese labels and stays within a compact width', async () => {
    const store = new DeckStore(initialDeckState());
    const host = fakeHost();
    const { lastFrame } = render(
      createElement(App, { store, host, locale: 'ja', size: { columns: 80, rows: 24 } })
    );
    host.emit(FIXTURE_SNAPSHOT);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('判断');
    expect(frame).not.toMatch(/deck:[a-z_]+/);
  });
});

describe('snapshot + intent preview', () => {
  it('prints a plain-text frame without raw keys', () => {
    const lines = snapshotLines(FIXTURE_SNAPSHOT, 'en');
    expect(lines[0]).toBe('KYBERION Mission Deck ▸ public');
    expect(lines.join('\n')).toContain('Needs your decision (2)');
    expect(lines.join('\n')).toContain('? codex');
    expect(lines.join('\n')).not.toContain('codex · codex');
    expect(lines.join('\n')).not.toMatch(/deck:[a-z_]+/);
  });

  it('reports degraded sources', () => {
    const lines = snapshotLines(
      { ...FIXTURE_SNAPSHOT, health: [{ source: 'approvals', ok: false, detail: 'unreadable' }] },
      'en'
    );
    expect(lines).toContain('  approvals: unreadable');
  });

  it('previews the intent without sending anything', () => {
    expect(previewIntent('')).toBeUndefined();
    expect(previewIntent(':cmd')).toBeUndefined();
    expect(
      previewIntent(
        'x',
        {},
        () => ({ normalized_intent: 'do x', resolution_shape: 'mission' }) as never
      )
    ).toMatchObject({ understood: 'do x', shape: 'mission', missing: [] });
    expect(
      previewIntent('x', {}, () => {
        throw new Error('nope');
      })
    ).toBeUndefined();
  });

  it('clamps long approval questions for inline cards', () => {
    expect(questionLines('Task: x\n\nResult:\n- a\n- b', 2)).toEqual(['Task: x', 'Result: …']);
    expect(questionLines('one line', 2)).toEqual(['one line']);
    expect(questionLines(undefined, 2)).toEqual([]);
  });
});

describe('review fixes', () => {
  it('strips C1/DEL control bytes and caps OSC payloads', () => {
    const payload = oscPayload(`Merge\u009b31m\u007f now\n${'x'.repeat(500)}`);
    expect(payload).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(payload.startsWith('Merge')).toBe(true);
    expect(payload.length).toBeLessThanOrEqual(200);
  });

  it('! only interrupts an explicitly selected agent', () => {
    const { store, controller } = setup();
    controller.onSnapshot(FIXTURE_SNAPSHOT);
    store.set({ focus: 'rail', railKey: 'mission:MSN-A' });
    controller.handleKey('!', key());
    expect(store.getState().overlay.kind).toBe('none');
    expect(store.getState().toast?.text).toContain('Select an agent first');
  });

  it('approval confirmation states reversibility and the screen handoff', () => {
    const { store, controller } = setup();
    controller.onSnapshot(FIXTURE_SNAPSHOT);
    store.set({ focus: 'rail' });
    controller.handleKey('d', key());
    const overlay = store.getState().overlay;
    expect(overlay.kind === 'confirm' && overlay.text).toContain('Cannot be undone');
    expect(overlay.kind === 'confirm' && overlay.text).toContain('approval screen');
  });

  it('turns failed and rejected effects into localized what — why | next toasts', async () => {
    const store = new DeckStore(initialDeckState());
    const host = fakeHost((request) => {
      if (request.op === 'steer') return { ok: false, message: 'queue locked' };
      if (request.op === 'agentPrompt') throw new Error('worker gone');
      return { ok: true, message: 'ok' };
    });
    const controller = new DeckController(store, host, () => makeI18n('en'));
    controller.onSnapshot(FIXTURE_SNAPSHOT);
    store.set({
      overlay: { kind: 'steer', target: { kind: 'mission', missionId: 'MSN-A' }, draft: '' },
    });
    await controller.submitSteer('x');
    expect(store.getState().toast).toMatchObject({
      ok: false,
      text: 'The note was not queued — queue locked. Press r to refresh and try again.',
    });
    store.set({ overlay: { kind: 'peek', target: 'pane-1', draft: '' } });
    await expect(controller.submitPeek('hi')).resolves.toBeUndefined();
    expect(store.getState().toast?.text).toContain(
      'The message did not reach the agent — worker gone'
    );
  });

  it('picks footer hints from what is selected', () => {
    expect(hintKey('conversation', 'rail', 'decision')).toBe('deck:hint_rail_decision');
    expect(hintKey('conversation', 'rail', 'mission')).toBe('deck:hint_rail_mission');
    expect(hintKey('missions', 'main')).toBe('deck:hint_main_missions');
    expect(hintKey('terminals', 'agents')).toBe('deck:hint_terminals');
    expect(hintKey('conversation', 'composer', 'decision')).toBe('deck:hint_composer');
  });

  it('shows plain labels instead of machine values', () => {
    const { tr } = makeI18n('en');
    expect(shapeLabel('task_session', tr)).not.toContain('task_session');
    expect(shapeLabel('something_new', tr)).toBe('something new');
    expect(outcomeLabel('artifact', makeI18n('ja').tr)).not.toBe('artifact');
    expect(humanize('generate-report')).toBe('generate report');
    expect(artifactTitle('evidence/implementation-report.md')).toBe('implementation report');
  });

  it('times out a hung reply', async () => {
    await expect(withTimeout(new Promise(() => undefined), 10, 'reply')).rejects.toThrow(
      'reply timed out'
    );
  });

  it('warns in the header when sources failed and marks the active card', async () => {
    const store = new DeckStore(initialDeckState());
    const host = fakeHost();
    const { lastFrame } = render(
      createElement(App, { store, host, locale: 'en', size: { columns: 100, rows: 34 } })
    );
    host.emit({ ...FIXTURE_SNAPSHOT, health: [{ source: 'approvals', ok: false, detail: 'x' }] });
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 source(s) unavailable');
    expect(frame).toContain('KYBERION');
    expect(frame).toContain('2 to decide');
    expect(frame).toContain('▶ ◆ Publish release notes');
    cleanup();
  });
});
