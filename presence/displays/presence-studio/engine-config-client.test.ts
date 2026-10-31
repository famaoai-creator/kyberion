import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { safeReadFile } from '@agent/core/secure-io';

type Control = {
  value: string;
  disabled: boolean;
  textContent: string;
  dataset: Record<string, string>;
  focus: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
  listeners: Map<string, (...args: unknown[]) => void>;
  addEventListener: (name: string, listener: (...args: unknown[]) => void) => void;
};
function element(): Control {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    value: '',
    disabled: false,
    textContent: '',
    dataset: {},
    focus: vi.fn(),
    setAttribute: vi.fn(),
    listeners,
    addEventListener: (name, listener) => {
      listeners.set(name, listener);
    },
  };
}
const revisionA = 'a'.repeat(64),
  revisionB = 'b'.repeat(64);
function payload(preferences: Record<string, string> = {}, revision = revisionA) {
  return {
    ok: true,
    preferences: { version: '1.0.0', ...preferences },
    profile: { kind: 'personal', id: 'personal' },
    revision,
  };
}
function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(fetchImpl = vi.fn()) {
  const html = String(
    safeReadFile('presence/displays/presence-studio/static/engine-config.html', {
      encoding: 'utf8',
    })
  );
  const controls = new Map(
    [...html.matchAll(/name="([a-z_]+)"/g)].map((match) => [match[1], element()])
  );
  const nodes = new Map(
    [
      'engine-form',
      'engine-fields',
      'engine-save',
      'engine-reload',
      'engine-status',
      'engine-profile',
    ].map((id) => [id, element()])
  );
  const form = Object.assign(nodes.get('engine-form')!, {
    querySelector: (selector: string) => controls.get(selector.match(/name="([a-z_]+)"/)![1]),
  });
  const root = {
    querySelector: (selector: string) =>
      selector.startsWith('#')
        ? nodes.get(selector.slice(1))
        : { textContent: selector.match(/data-message="([a-z_]+)"/)![1] },
  };
  const source = String(
    safeReadFile('presence/displays/presence-studio/static/engine-config.js', { encoding: 'utf8' })
  ).replace('export function mountEngineConfig', 'function mountEngineConfig');
  type Controller = {
    load: () => Promise<boolean>;
    save: () => Promise<boolean>;
    ready: Promise<boolean>;
  };
  const context = {
    mount: undefined as undefined | ((root: unknown, fetchImpl: unknown) => Controller),
  };
  runInNewContext(source + '\nthis.mount=mountEngineConfig;', context);
  const controller = context.mount!(root, fetchImpl);
  return {
    controls,
    nodes,
    form,
    controller,
    fetchImpl,
    status: () => nodes.get('engine-status')!.textContent,
    input: (key: string, value: string) => {
      controls.get(key)!.value = value;
      form.listeners.get('input')!();
    },
  };
}

describe('engine settings editor', () => {
  it('locks editing until load succeeds and prevents overlapping requests', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    const fetchImpl = vi.fn(() => pending.promise);
    const h = harness(fetchImpl);
    expect(h.nodes.get('engine-fields')!.disabled).toBe(true);
    expect(h.nodes.get('engine-reload')!.disabled).toBe(true);
    expect(await h.controller.save()).toBe(false);
    expect(await h.controller.load()).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    pending.resolve(response(payload({ ffmpeg_bin: '/tools/ffmpeg' })));
    expect(await h.controller.ready).toBe(true);
    expect(h.controls.get('ffmpeg_bin')!.value).toBe('/tools/ffmpeg');
    expect(h.nodes.get('engine-fields')!.disabled).toBe(false);
    expect(h.nodes.get('engine-save')!.disabled).toBe(true);
    expect(h.nodes.get('engine-profile')!.textContent).toBe('profile_personal · personal');
  });

  it('sends only dirty fields and explicit clears, preserving unrelated changes and applying normalized values', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          payload({ ffmpeg_bin: '/old', python_bin: 'python-old', streaming_stt_bridge: 'shell' })
        )
      )
      .mockImplementationOnce(() => pending.promise);
    const h = harness(fetchImpl);
    await h.controller.ready;
    h.input('ffmpeg_bin', '  /new  ');
    h.input('python_bin', '');
    expect(h.nodes.get('engine-save')!.disabled).toBe(false);
    const saving = h.controller.save();
    expect(await h.controller.save()).toBe(false);
    expect(await h.controller.load()).toBe(false);
    const options = fetchImpl.mock.calls[1][1];
    expect(JSON.parse(options.body)).toEqual({
      patch: { ffmpeg_bin: '/new' },
      unset: ['python_bin'],
      expected_revision: revisionA,
    });
    expect(options.credentials).toBe('same-origin');
    pending.resolve(
      response(
        payload(
          { ffmpeg_bin: '/normalized', streaming_stt_bridge: 'externally-updated' },
          revisionB
        )
      )
    );
    expect(await saving).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.controls.get('ffmpeg_bin')!.value).toBe('/normalized');
    expect(h.controls.get('streaming_stt_bridge')!.value).toBe('externally-updated');
    expect(h.controls.get('python_bin')!.value).toBe('');
    expect(h.nodes.get('engine-save')!.disabled).toBe(true);
    expect(h.status()).toBe('saved');
  });

  it.each(['network', 'non-json', 'forbidden', 'http-error', 'malformed'])(
    'shows an actionable load failure and keeps editing disabled: %s',
    async (kind) => {
      const fetchImpl = vi.fn(async () => {
        if (kind === 'network') throw new Error('network');
        if (kind === 'non-json')
          return {
            ok: false,
            status: 502,
            json: async () => {
              throw new Error('not json');
            },
          };
        if (kind === 'forbidden') return response({ ok: false, error: 'viewer_required' }, 403);
        if (kind === 'malformed') return response({ ...payload(), revision: undefined });
        return response({ ok: false }, 500);
      });
      const h = harness(fetchImpl);
      expect(await h.controller.ready).toBe(false);
      expect(h.nodes.get('engine-fields')!.disabled).toBe(true);
      expect(h.nodes.get('engine-save')!.disabled).toBe(true);
      expect(h.nodes.get('engine-reload')!.disabled).toBe(false);
      expect(h.status()).toBe(kind === 'forbidden' ? 'denied' : 'load_failed');
      expect(h.nodes.get('engine-status')!.focus).toHaveBeenCalled();
    }
  );

  it.each([400, 403, 500])('keeps edited values and reports save errors: %s', async (status) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(payload({ ffmpeg_bin: '/old' })))
      .mockResolvedValueOnce(response({ ok: false }, status));
    const h = harness(fetchImpl);
    await h.controller.ready;
    h.input('ffmpeg_bin', '/unsaved');
    expect(await h.controller.save()).toBe(false);
    expect(h.controls.get('ffmpeg_bin')!.value).toBe('/unsaved');
    expect(h.status()).toBe(status === 400 ? 'invalid' : status === 403 ? 'denied' : 'save_failed');
    expect(h.nodes.get('engine-save')!.disabled).toBe(false);
  });

  it('requires a deliberate reload after a revision conflict before another save', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(payload({ ffmpeg_bin: '/old' })))
      .mockResolvedValueOnce(response({ ok: false, error: 'engine_config_conflict' }, 409))
      .mockResolvedValueOnce(response(payload({ ffmpeg_bin: '/external' }, revisionB)))
      .mockResolvedValueOnce(response(payload({ ffmpeg_bin: '/final' }, revisionA)));
    const h = harness(fetchImpl);
    await h.controller.ready;
    h.input('ffmpeg_bin', '/draft');
    expect(await h.controller.save()).toBe(false);
    expect(h.status()).toBe('conflict');
    expect(h.controls.get('ffmpeg_bin')!.value).toBe('/draft');
    expect(h.nodes.get('engine-save')!.disabled).toBe(true);
    h.input('ffmpeg_bin', '/another-draft');
    expect(await h.controller.save()).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await h.controller.load();
    expect(h.controls.get('ffmpeg_bin')!.value).toBe('/external');
    h.input('ffmpeg_bin', '/final');
    await h.controller.save();
    expect(JSON.parse(fetchImpl.mock.calls[3][1].body).expected_revision).toBe(revisionB);
  });

  it('does not turn an already empty field into a reset request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(payload()));
    const h = harness(fetchImpl);
    await h.controller.ready;
    h.input('python_bin', '   ');
    expect(await h.controller.save()).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.status()).toBe('unchanged');
  });
});

it.each(['network', 'non-json'])(
  'retains unsaved changes after a save transport failure: %s',
  async (kind) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(payload({ python_bin: '/old' })))
      .mockImplementationOnce(async () => {
        if (kind === 'network') throw new Error('offline');
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('invalid json');
          },
        };
      });
    const h = harness(fetchImpl);
    await h.controller.ready;
    h.input('python_bin', '/draft');
    expect(await h.controller.save()).toBe(false);
    expect(h.controls.get('python_bin')!.value).toBe('/draft');
    expect(h.status()).toBe('save_failed');
    expect(h.nodes.get('engine-save')!.disabled).toBe(false);
  }
);
