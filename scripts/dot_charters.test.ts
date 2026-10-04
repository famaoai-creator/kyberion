import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import type { DotCharter } from '@agent/core/dot/dot-charter';

const mocks = vi.hoisted(() => ({
  rootDir: 'active/shared/tmp/dot-charters-cli-tests',
  wake: vi.fn(async () => ({ dot_id: 'collision', outcome: 'delivered' })),
  install: vi.fn(),
  appendInbox: vi.fn((entry: Record<string, unknown>) => entry),
}));
vi.mock('@agent/core/dot/dot-charter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/dot/dot-charter')>();
  return {
    ...actual,
    listDotCharterSources: (rootDir?: string) =>
      actual.listDotCharterSources(rootDir ?? mocks.rootDir),
    listDotCharters: (rootDir?: string, options?: Parameters<typeof actual.listDotCharters>[1]) =>
      actual.listDotCharters(rootDir ?? mocks.rootDir, options),
    findDotCharter: (dotId: string, rootDir?: string) =>
      actual.findDotCharter(dotId, rootDir ?? mocks.rootDir),
  };
});
vi.mock('@agent/core/dot/dot-wake-orchestration', () => ({
  runDotWakeWithGoalDriver: mocks.wake,
}));
vi.mock('@agent/core/reasoning/reasoning-bootstrap', () => ({
  installReasoningBackends: mocks.install,
}));
vi.mock('@agent/core/dot/dot-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/dot/dot-inbox')>()),
  appendDotInboxEntry: mocks.appendInbox,
}));
vi.mock('./daemon_watchdog.js', () => ({ DEFAULT_DAEMONS: [] }));

import { runDotCharters } from './dot_charters.js';

const TEST_ROOT = mocks.rootDir;
const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'collision',
  version: '1.0.0',
  title: 'Collision',
  purpose: 'test',
  status: 'active',
  scope: { tier: 'public' },
  goal: { statement: 'test' },
  attention: { triggers: [{ kind: 'wake', channels: ['inbox'] }] },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'surface', channel: 'inbox' } },
  runtime: { heartbeat_id: 'dot-collision' },
};

function writeCharter(charter: DotCharter, name: string, slug?: string): string {
  if (slug) {
    const profiles = `${TEST_ROOT}/knowledge/personal/tenants`;
    safeMkdir(profiles, { recursive: true });
    safeWriteFile(
      `${profiles}/${slug}.json`,
      JSON.stringify({
        tenant_slug: slug,
        display_name: slug,
        status: 'active',
        assigned_role: 'owner',
      })
    );
  }
  const dir = slug ? `${TEST_ROOT}/knowledge/confidential/${slug}/dots` : `${TEST_ROOT}/dots`;
  safeMkdir(dir, { recursive: true });
  const filePath = `${dir}/${name}.json`;
  safeWriteFile(
    filePath,
    JSON.stringify({
      ...charter,
      ...(slug ? { scope: { tier: 'confidential', tenant_slug: slug } } : {}),
    })
  );
  return filePath;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('dot charter CLI identity resolution', () => {
  it('refuses a targeted inbox write for a duplicate identity', async () => {
    writeCharter(CHARTER, 'one');
    writeCharter(CHARTER, 'two', 'acme');
    expect(
      await runDotCharters([
        'inbox',
        'append',
        '--channel',
        'inbox',
        '--dot-id',
        'collision',
        '--json',
      ])
    ).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate dot_id 'collision'")
    );
    expect(mocks.appendInbox).not.toHaveBeenCalled();
  });

  it('refuses to wake a duplicate identity before installing a backend or running a turn', async () => {
    writeCharter(CHARTER, 'active');
    writeCharter({ ...CHARTER, status: 'paused' }, 'paused', 'acme');
    expect(await runDotCharters(['wake', 'collision', '--json', '--quiet'])).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate dot_id 'collision'")
    );
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it.each(['list', 'validate'])(
    'reports every colliding path through %s while retaining valid siblings',
    async (command) => {
      const first = writeCharter(CHARTER, 'first', 'acme');
      const second = writeCharter({ ...CHARTER, status: 'retired' }, 'second', 'globex');
      writeCharter({ ...CHARTER, dot_id: 'unique', status: 'draft' }, 'unique');
      const broken = `${TEST_ROOT}/dots/broken.json`;
      safeWriteFile(broken, '{');
      const report = await runDotCharters([command, '--all', '--json', '--quiet']);
      expect(report?.ok).toBe(false);
      const errors = (report?.errors ?? report?.schema_errors) as Array<{
        path: string;
        error: string;
      }>;
      expect(errors.map((entry) => entry.path).sort()).toEqual([first, second, broken].sort());
      for (const filePath of [first, second]) {
        expect(errors.find((entry) => entry.path === filePath)?.error).toContain(
          "Duplicate dot_id 'collision'"
        );
      }
      expect(errors.find((entry) => entry.path === broken)?.error).toMatch(/JSON/);
      expect(report?.dots ?? report?.results).toMatchObject([{ dot_id: 'unique' }]);
    }
  );

  it('still wakes a unique charter beside malformed and colliding siblings', async () => {
    writeCharter(CHARTER, 'one');
    writeCharter(CHARTER, 'two', 'acme');
    safeWriteFile(`${TEST_ROOT}/dots/broken.json`, '{');
    writeCharter({ ...CHARTER, dot_id: 'unique' }, 'unique');
    expect(await runDotCharters(['wake', 'unique', '--json', '--quiet'])).toMatchObject({
      ok: true,
    });
    expect(mocks.wake).toHaveBeenCalledWith(
      expect.objectContaining({
        charter: expect.objectContaining({ dot_id: 'unique' }),
      }),
      {}
    );
  });
});
