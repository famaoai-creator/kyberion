import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { safeReadFile } from '@agent/core/secure-io';
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
function harness(query = '?correction=entry-1&artifact=artifact-1&tenant=alpha') {
  const elements = new Map(
    ['ask-correction-status', 'ask-correction-text', 'ask-correction-retry'].map((id) => [
      id,
      {
        hidden: true,
        textContent: '',
        disabled: false,
        setAttribute: vi.fn(),
        addEventListener: vi.fn(),
      },
    ])
  );
  const state = {
    historyState: 'ready',
    sending: false,
    storageVerified: true,
    conversationId: 'concierge-' + 'a'.repeat(64),
    vocab: {},
    pendingRequest: { id: 'pending' },
  };
  const location = { pathname: '/ask', search: query, hash: '' };
  const ready = Promise.resolve();
  const listeners: Record<string, () => void> = {};
  type CorrectionHelper = { apply: () => Promise<boolean>; mount: () => void };
  type CorrectionOptions = {
    state: typeof state;
    fetchJson: (url: string) => Promise<unknown>;
    scopedUrl: (path: string) => string;
    proposeDraft: (
      text: string,
      current: () => boolean,
      accepted: () => void,
      dismissed: () => void
    ) => boolean;
    vt: (vocabulary: unknown, key: string) => string;
  };
  const window = {
    location,
    FrontDeskRail: { ready },
    KyberionAskCorrection: undefined as
      undefined | { create: (options: CorrectionOptions) => CorrectionHelper },
    history: {
      state: null,
      replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
        const next = new URL(url, 'http://localhost');
        location.pathname = next.pathname;
        location.search = next.search;
        location.hash = next.hash;
      }),
    },
    addEventListener: (key: string, callback: () => void) => {
      listeners[key] = callback;
    },
  };
  const payload = {
    ok: true,
    body: {
      ok: true,
      viewer_scope_id: 'a'.repeat(64),
      context: {
        entry_id: 'entry-1',
        artifact_id: 'artifact-1',
        title: 'Report',
        note: 'Keep exact\ncomment <text>',
        status: 'changes_requested',
      },
    },
  };
  const fetchJson = vi.fn().mockResolvedValue(payload);
  let scope = 'alpha';
  const scopedUrl = (path: string) => path + (path.includes('?') ? '&' : '?') + 'tenant=' + scope;
  const proposeDraft = vi.fn(
    (_text: string, _current: () => boolean, accepted: () => void, _dismissed: () => void) => {
      accepted();
      return true;
    }
  );
  runInNewContext(
    String(
      safeReadFile('presence/displays/presence-studio/static/ask-correction.js', {
        encoding: 'utf8',
      })
    ),
    { window, document: { getElementById: (id: string) => elements.get(id) }, URLSearchParams }
  );
  if (!window.KyberionAskCorrection) throw new Error('Correction helper was not loaded');
  const helper = window.KyberionAskCorrection.create({
    state,
    fetchJson,
    scopedUrl,
    proposeDraft,
    vt: (_: unknown, key: string) => key,
  });
  helper.mount();
  return {
    helper,
    window,
    state,
    payload,
    fetchJson,
    proposeDraft,
    elements,
    listeners,
    scope: (next: string) => {
      scope = next;
    },
  };
}
describe('Ask recorded correction handoff (read-only client)', () => {
  it('reads the scoped exact IDs and proposes recorded content without a mutation', async () => {
    const h = harness();
    await h.helper.apply();
    expect(h.fetchJson).toHaveBeenCalledWith(
      '/api/progress/artifact-1/correction-context?entry=entry-1&tenant=alpha'
    );
    const draft = h.proposeDraft.mock.calls[0][0];
    expect(draft).toContain('entry-1');
    expect(draft).toContain('artifact-1');
    expect(draft).toContain(h.payload.body.context.note);
    expect(h.state.pendingRequest).toEqual({ id: 'pending' });
    expect(h.window.history.replaceState.mock.calls[0][2]).toBe('/ask?tenant=alpha');
  });
  it('rejects context from a principal different from verified history without proposing its note', async () => {
    const h = harness();
    h.payload.body.viewer_scope_id = 'b'.repeat(64);
    await h.helper.apply();
    expect(h.proposeDraft).not.toHaveBeenCalled();
    expect(h.window.history.replaceState).not.toHaveBeenCalled();
    expect(h.elements.get('ask-correction-text')!.textContent).not.toContain(
      h.payload.body.context.note
    );
    expect(h.elements.get('ask-correction-retry')!.hidden).toBe(false);
  });
  it('preserves a valid recorded rejection with an empty note for user review', async () => {
    const h = harness();
    h.payload.body.context.note = '';
    h.payload.body.context.status = 'rejected';
    await h.helper.apply();
    expect(h.proposeDraft).toHaveBeenCalledTimes(1);
    expect(h.proposeDraft.mock.calls[0][0]).toContain('artifact-1');
    expect(h.proposeDraft.mock.calls[0][0]).toMatch(/front_desk:ask_correction_note:\n$/);
  });
  it('requires verified history and gives request resume priority', async () => {
    const h = harness('?request=req&correction=entry-1&artifact=artifact-1&send=1&mic=1');
    await h.helper.apply();
    expect(h.fetchJson).not.toHaveBeenCalled();
    const blocked = harness();
    blocked.state.storageVerified = false;
    await blocked.helper.apply();
    expect(blocked.fetchJson).not.toHaveBeenCalled();
  });
  it('single-flights reads and ignores navigation, scope and history changes', async () => {
    for (const change of ['url', 'scope', 'history', 'shell', 'unready', 'storage']) {
      const h = harness();
      let resolve!: (value: unknown) => void;
      h.fetchJson.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        })
      );
      const pending = h.helper.apply();
      h.helper.apply();
      await flush();
      expect(h.fetchJson).toHaveBeenCalledTimes(1);
      if (change === 'url') h.window.location.search += '&artifact=other';
      if (change === 'scope') h.scope('beta');
      if (change === 'history') h.state.conversationId = 'session-2';
      if (change === 'unready') h.state.historyState = 'failed';
      if (change === 'storage') h.state.storageVerified = false;
      if (change === 'shell') h.window.FrontDeskRail.ready = Promise.resolve();
      resolve(h.payload);
      await pending;
      expect(h.proposeDraft).not.toHaveBeenCalled();
      expect(h.window.history.replaceState).not.toHaveBeenCalled();
    }
  });
  it('offers explicit retry on denied, invalid or failed reads without consuming the URL', async () => {
    for (const result of [
      { ok: false, status: 403 },
      { ok: true, body: {} },
      {
        ...harness().payload,
        body: { ok: true, viewer_scope_id: 'scope', context: { entry_id: 'other' } },
      },
    ]) {
      const h = harness();
      h.fetchJson.mockResolvedValueOnce(result);
      await h.helper.apply();
      expect(h.proposeDraft).not.toHaveBeenCalled();
      expect(h.window.history.replaceState).not.toHaveBeenCalled();
      expect(h.elements.get('ask-correction-retry')!.hidden).toBe(false);
      await h.helper.apply();
      expect(h.proposeDraft).toHaveBeenCalledTimes(1);
    }
    const h = harness();
    h.fetchJson.mockRejectedValueOnce(new Error('timeout'));
    await h.helper.apply();
    expect(h.elements.get('ask-correction-retry')!.hidden).toBe(false);
  });
  it('rejects incomplete, repeated or mismatched IDs and non-recorded contexts', async () => {
    for (const query of [
      '?correction=entry-1',
      '?correction=entry-1&artifact=artifact-1&correction=entry-2',
    ]) {
      const h = harness(query);
      await h.helper.apply();
      expect(h.fetchJson).not.toHaveBeenCalled();
      expect(h.proposeDraft).not.toHaveBeenCalled();
    }
    for (const patch of [
      { entry_id: 'wrong' },
      { artifact_id: 'wrong' },
      { note: null },
      { status: 'accepted' },
    ]) {
      const h = harness();
      Object.assign(h.payload.body.context, patch);
      await h.helper.apply();
      expect(h.proposeDraft).not.toHaveBeenCalled();
    }
  });
  it('keeps URL while draft choice is unresolved; strips unsafe flags only on acceptance', async () => {
    const h = harness('?correction=entry-1&artifact=artifact-1&tenant=alpha&ask=evil&send=1&mic=1');
    h.proposeDraft.mockImplementation(() => true);
    await h.helper.apply();
    expect(h.window.history.replaceState).not.toHaveBeenCalled();
    h.proposeDraft.mock.calls[0][2]();
    expect(h.window.history.replaceState.mock.calls[0][2]).toBe('/ask?tenant=alpha');
  });
  it('does not consume or replace a late conflict after navigation', async () => {
    const h = harness();
    h.proposeDraft.mockImplementation(() => true);
    await h.helper.apply();
    h.scope('beta');
    expect(h.proposeDraft.mock.calls[0][1]()).toBe(false);
    h.proposeDraft.mock.calls[0][2]();
    expect(h.window.history.replaceState).not.toHaveBeenCalled();
  });
  it('settles a dismissed correction once, preserves unrelated parameters, and allows a future explicit handoff', async () => {
    const h = harness(
      '?correction=entry-1&artifact=artifact-1&tenant=alpha&view=compact&ask=unsafe&send=1&mic=1'
    );
    h.proposeDraft.mockImplementation(() => true);
    await h.helper.apply();
    const dismissed = h.proposeDraft.mock.calls[0][3];
    dismissed();
    dismissed();
    expect(h.window.history.replaceState).toHaveBeenCalledTimes(1);
    expect(h.window.location.search).toBe('?tenant=alpha&view=compact');
    expect(h.elements.get('ask-correction-status')!.hidden).toBe(true);
    expect(h.state.pendingRequest).toEqual({ id: 'pending' });
    await h.helper.apply();
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
    h.window.location.search = '?correction=entry-2&artifact=artifact-2&tenant=alpha';
    h.payload.body.context.entry_id = 'entry-2';
    h.payload.body.context.artifact_id = 'artifact-2';
    await h.helper.apply();
    expect(h.proposeDraft).toHaveBeenCalledTimes(2);
    dismissed();
    expect(h.window.location.search).toContain('entry-2');
    expect(h.elements.get('ask-correction-status')!.hidden).toBe(false);
    h.proposeDraft.mock.calls[1][2]();
    expect(h.window.location.search).toBe('?tenant=alpha');
  });
  it('never consumes a stale dismissal after navigation, scope, shell, readiness or active sending changes', async () => {
    for (const change of [
      'url',
      'scope',
      'history',
      'shell',
      'unready',
      'storage',
      'sending',
      'popstate',
      'pagehide',
    ]) {
      const h = harness();
      h.proposeDraft.mockImplementation(() => true);
      await h.helper.apply();
      if (change === 'url') h.window.location.search = '?correction=new&artifact=new&tenant=alpha';
      if (change === 'scope') h.scope('beta');
      if (change === 'history') h.state.conversationId = 'another-viewer';
      if (change === 'shell') h.window.FrontDeskRail.ready = Promise.resolve();
      if (change === 'unready') h.state.historyState = 'failed';
      if (change === 'storage') h.state.storageVerified = false;
      if (change === 'sending') h.state.sending = true;
      if (change === 'popstate' || change === 'pagehide') h.listeners[change]();
      const queryBefore = h.window.location.search;
      h.proposeDraft.mock.calls[0][3]();
      expect(h.window.history.replaceState).not.toHaveBeenCalled();
      expect(h.window.location.search).toBe(queryBefore);
      expect(h.state.pendingRequest).toEqual({ id: 'pending' });
    }
  });
  it('blocks unsafe prefill even if the correction helper is unavailable', () => {
    const source = safeReadFile('presence/displays/presence-studio/static/ask.js', {
      encoding: 'utf8',
    }) as string;
    expect(source.indexOf("params.has('correction')")).toBeLessThan(
      source.indexOf("var ask = params.get('ask')")
    );
    expect(source).toContain('state.proposedDraft.isCurrent');
    const html = safeReadFile('presence/displays/presence-studio/static/ask.html', {
      encoding: 'utf8',
    }) as string;
    expect(html.indexOf('/ask-correction.js')).toBeLessThan(html.indexOf('/ask.js'));
  });
});
