import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from './authority.js';
import { rootDir } from './path-resolver.js';
import * as initialIO from './secure-io.js';

/**
 * MSN-STORE-BOUNDS-3: the iMessage bridge event log rotates at write time
 * (keep 90 days, then archive — never auto-delete). Runs the real secure-io /
 * tier-guard stack on a fresh root, as the production bridge identity:
 * `SYSTEM_ROLE=imessage_bridge` (surface_runtime derives it from the surface
 * id) with the manifest's `MISSION_ROLE=surface_runtime` and persona.
 */
const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/imessage-log-rotation-' + process.pid);
const ENV_KEYS = [
  'KYBERION_ROOT',
  'SYSTEM_ROLE',
  'MISSION_ROLE',
  'KYBERION_PERSONA',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_SUDO',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let io: typeof import('./secure-io.js');
let bridge: typeof import('./imessage-bridge.js');
let store: typeof import('./append-only-store.js');
let tierGuard: typeof import('./tier-guard.js');
let lockUtils: typeof import('./foundation/lock-utils.js');

function bridgeEnv(): void {
  process.env.SYSTEM_ROLE = 'imessage_bridge';
  process.env.MISSION_ROLE = 'surface_runtime';
  process.env.KYBERION_PERSONA = 'sovereign';
  process.env.MISSION_ID = 'MSN-SYSTEM-SENSORY-HUB';
}

function logPath(): string {
  return bridge.iMessageBridgeLogPath();
}

/** Rotated `events-YYYYMMDD-HHmmss[-n].jsonl` segments next to the log. */
function segments(): string[] {
  const dir = path.dirname(logPath());
  if (!io.safeExistsSync(dir)) return [];
  return io
    .safeReaddir(dir)
    .filter((name) => /^events-\d{8}-\d{6}(-\d+)?\.jsonl$/u.test(name))
    .map((name) => path.join(dir, name));
}

function text(file: string): string {
  return io.safeExistsSync(file) ? String(io.safeReadFile(file, { encoding: 'utf8' })) : '';
}

function event(id: string): Record<string, unknown> {
  return { ts: '2026-11-02T00:00:00.000Z', platform: 'imessage', id, pad: 'x'.repeat(100) };
}

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"imessage-log-fixture"}');
    const copy = (relative: string): void => {
      for (const name of initialIO.safeReaddir(path.join(SOURCE_ROOT, relative))) {
        const file = path.join(relative, name);
        const source = path.join(SOURCE_ROOT, file);
        const stat = initialIO.safeLstat(source);
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(?:json|yaml)$/u.test(name))
          initialIO.safeWriteFile(path.join(ROOT, file), initialIO.safeReadFile(source));
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
  });
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('./secure-io.js');
  bridge = await import('./imessage-bridge.js');
  store = await import('./append-only-store.js');
  tierGuard = await import('./tier-guard.js');
  lockUtils = await import('./foundation/lock-utils.js');
  expect((await import('./path-resolver.js')).rootDir()).toBe(ROOT);
}, 120_000);

beforeEach(() => {
  for (const key of ENV_KEYS) if (key !== 'KYBERION_ROOT') delete process.env[key];
  bridgeEnv();
  store.resetAppendOnlyStoreMaintenanceState();
  bridge.setIMessageLogTuningForTests({});
});

afterEach(() => {
  bridge.setIMessageLogTuningForTests({});
  for (const key of ENV_KEYS) if (key !== 'KYBERION_ROOT') delete process.env[key];
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(path.join(ROOT, 'active/shared/runtime/imessage-bridge'), {
      recursive: true,
      force: true,
    })
  );
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
});

describe('iMessage bridge event log write-time rotation', () => {
  it('rotates under the 8 MiB default threshold constant', () => {
    expect(bridge.IMESSAGE_LOG_ROTATE_MIN_BYTES).toBe(8 * 1024 * 1024);
  });

  it('lets the bridge identity append, rename to a segment and take the store lock', () => {
    expect(logPath()).toBe(path.join(ROOT, 'active/shared/runtime/imessage-bridge/events.jsonl'));
    const segment = logPath().replace(/\.jsonl$/u, '-20261102-000000.jsonl');
    for (const target of [logPath(), segment]) {
      expect(tierGuard.validateWritePermission(target).allowed, target).toBe(true);
    }
    expect(
      tierGuard.validateWritePermission(path.join(ROOT, 'active/shared/runtime/locks/x.lock'))
        .allowed
    ).toBe(true);
  });

  it('rotates the live log to a segment once it crosses the injected threshold', () => {
    bridge.setIMessageLogTuningForTests({ rotateMinBytes: 600 });
    const ids = Array.from({ length: 6 }, (_, i) => `evt-${i}`);
    for (const id of ids) bridge.appendIMessageBridgeEvent(event(id));
    expect(segments()).toHaveLength(1);
    const all = [...segments().map(text), text(logPath())].join('');
    // Moved aside, never lost: every event is in the segment or the live log.
    for (const id of ids) expect(all).toContain(`"${id}"`);
    expect(text(segments()[0]!)).toContain('"evt-0"');
    expect(io.safeStat(segments()[0]!).size).toBeGreaterThanOrEqual(600);
    expect(text(logPath()).length).toBeLessThan(600);
  });

  it('never fails the append when rotation fails (store lock held elsewhere)', () => {
    bridge.appendIMessageBridgeEvent(event('evt-seed-1'));
    bridge.appendIMessageBridgeEvent(event('evt-seed-2'));
    expect(io.safeStat(logPath()).size).toBeGreaterThanOrEqual(200);
    bridge.setIMessageLogTuningForTests({ rotateMinBytes: 200, lockTimeoutMs: 1 });
    lockUtils.withLockSync(store.appendOnlyStoreLockId(logPath()), () => {
      expect(() => bridge.appendIMessageBridgeEvent(event('evt-during-lock'))).not.toThrow();
    });
    expect(text(logPath())).toContain('"evt-during-lock"');
    expect(segments()).toEqual([]);
  });
});
