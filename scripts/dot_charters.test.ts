import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import type { DotCharter } from '@agent/core/dot/dot-charter';

const mocks = vi.hoisted(() => ({
  rootDir: 'active/shared/tmp/dot-charters-cli-tests',
  wake: vi.fn(async () => ({ dot_id: 'collision', outcome: 'delivered' })),
  install: vi.fn(),
  appendInbox: vi.fn((entry: Record<string, unknown>) => entry),
  release: vi.fn(() => ({
    request: { id: 'apr-1', expiresAt: '2026-10-08T00:00:00.000Z' },
    reused: false,
  })),
}));
vi.mock('@agent/core/dot/dot-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/dot/dot-executor')>()),
  requestDotWorkItemRelease: mocks.release,
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
vi.mock('@agent/core/dot/dot-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/dot/dot-lifecycle')>();
  return {
    ...actual,
    createDraftDotCharter: (
      input: unknown,
      deps: Parameters<typeof actual.createDraftDotCharter>[1]
    ) => actual.createDraftDotCharter(input, { ...deps, rootDir: mocks.rootDir }),
    configureDotDelegationCapacity: (
      dotId: string,
      limit: number | undefined,
      deps: Parameters<typeof actual.configureDotDelegationCapacity>[2]
    ) => actual.configureDotDelegationCapacity(dotId, limit, { ...deps, rootDir: mocks.rootDir }),
    enableDotEventContinuation: (
      dotId: string,
      deps: Parameters<typeof actual.enableDotEventContinuation>[1]
    ) => actual.enableDotEventContinuation(dotId, { ...deps, rootDir: mocks.rootDir }),
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
vi.mock('@agent/core/dot/dot-action-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/dot/dot-action-ledger')>();
  return {
    ...actual,
    observeDotActions: (dotId: string, deps?: Parameters<typeof actual.observeDotActions>[1]) =>
      actual.observeDotActions(dotId, { ...deps, rootDir: mocks.rootDir }),
  };
});
vi.mock('@agent/core/dot/dot-dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/dot/dot-dispatch')>();
  return {
    ...actual,
    dotDelegationCapacity: (
      charter: Parameters<typeof actual.dotDelegationCapacity>[0],
      deps?: Parameters<typeof actual.dotDelegationCapacity>[1]
    ) => actual.dotDelegationCapacity(charter, { ...deps, rootDir: mocks.rootDir }),
  };
});
vi.mock('./daemon_watchdog.js', () => ({ DEFAULT_DAEMONS: [] }));

import { runDotCharters } from './dot_charters.js';
import { DOT_STATUS_SECTIONS } from '@agent/core/dot/dot-extension-registry';
import {
  appendActionRecord,
  DOT_ACTION_LEDGER_PATH,
  type DotActionRecord,
} from '@agent/core/dot/dot-action-ledger';
import { appendJsonLine } from '@agent/core/foundation/json';

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
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('dot charter CLI identity resolution', () => {
  it('keeps every authorization scope field visible in long text inventory rows', async () => {
    const scope = {
      tier: 'public' as const,
      organization_id: 'org-' + 'o'.repeat(180),
      project_id: 'project-' + 'p'.repeat(180),
      owner_nhi: 'owner-must-remain-visible',
    };
    writeCharter({ ...CHARTER, scope }, 'long-scope');
    const result = await runDotCharters(['list']);
    expect(result).toMatchObject({ dots: [expect.objectContaining({ scope })] });
    const lines = vi.mocked(console.log).mock.calls.map((args) => String(args[0]));
    expect(lines).toContain('    scope: ' + JSON.stringify(scope));
  });
  it('previews a paused dot capacity and applies or inherits only on explicit request', async () => {
    writeCharter({ ...CHARTER, status: 'paused' }, 'capacity');
    const preview = await runDotCharters([
      'capacity',
      CHARTER.dot_id,
      '--limit',
      '100',
      '--json',
      '--quiet',
    ]);
    expect(preview).toMatchObject({ ok: true, applied: false, effective_limit: 100 });
    expect(
      await runDotCharters([
        'capacity',
        CHARTER.dot_id,
        '--limit',
        '100',
        '--apply',
        '--json',
        '--quiet',
      ])
    ).toMatchObject({ ok: true, applied: true, effective_limit: 100 });
    expect(
      await runDotCharters([
        'capacity',
        CHARTER.dot_id,
        '--inherit',
        '--apply',
        '--json',
        '--quiet',
      ])
    ).toMatchObject({ ok: true, applied: true });
  });
  it('previews a reviewed draft without writing, then creates only on explicit apply', async () => {
    const file = `${TEST_ROOT}/reviewed.json`;
    safeMkdir(TEST_ROOT, { recursive: true });
    safeWriteFile(file, JSON.stringify({ ...CHARTER, status: 'draft' }));
    expect(await runDotCharters(['create', '--file', file, '--json', '--quiet'])).toMatchObject({
      ok: true,
      applied: false,
      status: 'draft',
    });
    expect(
      await runDotCharters(['create', '--file', file, '--apply', '--json', '--quiet'])
    ).toMatchObject({ ok: true, applied: true, status: 'draft' });
    expect(
      await runDotCharters(['create', '--file', file, '--apply', '--json', '--quiet'])
    ).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });
  it('refuses a targeted inbox write for a duplicate identity', async () => {
    // Two repo charters share the ID: same-scope duplicates have no owner.
    writeCharter(CHARTER, 'one');
    writeCharter(CHARTER, 'two');
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
    writeCharter({ ...CHARTER, status: 'paused' }, 'paused');
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
      // Two established tenant charters across tenants: the earliest-activated
      // (no lifecycle history: file age, then path) keeps the id.
      const second = writeCharter({ ...CHARTER, status: 'paused' }, 'second', 'globex');
      writeCharter({ ...CHARTER, dot_id: 'unique', status: 'draft' }, 'unique');
      const broken = `${TEST_ROOT}/dots/broken.json`;
      safeWriteFile(broken, '{');
      const report = await runDotCharters([command, '--all', '--json', '--quiet']);
      expect(report?.ok).toBe(false);
      const errors = (report?.errors ?? report?.schema_errors) as Array<{
        path: string;
        error: string;
      }>;
      // A caller's default inventory does not disclose another tenant's paths.
      expect(errors.map((entry) => entry.path).sort()).toEqual([broken]);
      expect(errors.find((entry) => entry.path === second)).toBeUndefined();
      expect(errors.find((entry) => entry.path === broken)?.error).toMatch(/JSON/);
      const listed = (report?.dots ?? report?.results) as Array<{ dot_id: string }>;
      expect(listed.map((entry) => entry.dot_id).sort()).toEqual(['unique']);
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

describe('dot release', () => {
  it('only requests a human-approved release for the resolved charter', async () => {
    writeCharter(CHARTER, 'one');
    const report = await runDotCharters([
      'release',
      'collision',
      'wi-1',
      '--reason',
      'verified no partial effect',
      '--by',
      'user:ops',
      '--json',
      '--quiet',
    ]);
    expect(report).toMatchObject({
      ok: true,
      release_requested: {
        dot_id: 'collision',
        work_item_id: 'wi-1',
        approval_request_id: 'apr-1',
        reused: false,
        next: expect.stringContaining('pnpm kyberion approvals --approve apr-1'),
      },
    });
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ dot_id: 'collision' }), {
      workItemId: 'wi-1',
      reason: 'verified no partial effect',
      by: 'user:ops',
    });
  });

  it('refuses a release without --reason', async () => {
    writeCharter(CHARTER, 'one');
    expect(await runDotCharters(['release', 'collision', 'wi-1', '--json'])).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--reason'));
    expect(mocks.release).not.toHaveBeenCalled();
  });
});

describe('dot execution diagnostic CLI presentation', () => {
  it('keeps exact evidence and full recovery guidance in JSON and plain text', async () => {
    writeCharter(CHARTER, 'status');
    const section = DOT_STATUS_SECTIONS.find((s) => s.id === 'executor')!;
    const next =
      'Verify stopped execution and reconcile partial effects before requesting human approval. ' +
      'Evidence must remain intact. '.repeat(15);
    const execution = {
      inventory: 'observed',
      reason: 'Current scoped evidence',
      scheduling: {
        state: 'blocked',
        reason: 'Invalid cursor shape',
        next: 'Operator inspects executor-schedule.json',
      },
      items: [
        {
          state: 'blocked',
          work_item_id: 'exact-item',
          item_status: 'archived',
          reason_code: 'retained_effect_hold',
          current_attempt_id: 'new-run',
          latest_recorded_attempt_id: 'new-run',
          held_attempt_id: 'old-run',
          age_ms: 1234,
          reason: 'Retained old attempt ownership',
          next,
        },
      ],
      items_omitted: 0,
      limitations: 'Read-only evidence, no liveness guarantee',
    };
    vi.spyOn(section, 'collect').mockReturnValue({
      execution,
      history_status: 'historical',
      results_total: 1,
    });
    const result = await runDotCharters(['status', 'collision', '--json', '--quiet']);
    expect(result).toMatchObject({ dots: [{ sections: { executor: { execution } } }] });
    await runDotCharters(['status', 'collision']);
    const lines = vi.mocked(console.log).mock.calls.map((args) => String(args[0]));
    expect(lines).toContain('        next: ' + next);
    expect(
      lines.some((line) =>
        line.includes(
          'current_attempt=new-run latest_recorded_attempt=new-run held_attempt=old-run age_ms=1234'
        )
      )
    ).toBe(true);
    expect(lines.some((line) => line.includes('scheduling blocked: Invalid cursor shape'))).toBe(
      true
    );
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.appendInbox).not.toHaveBeenCalled();
  });
});

describe('dot status action-ledger integrity (R07)', () => {
  const action = (overrides: Partial<DotActionRecord> = {}): DotActionRecord => ({
    scope: { tier: 'public' },
    action_ref: 'ref-ok',
    dot_id: CHARTER.dot_id,
    actor_id: `dot:${CHARTER.dot_id}`,
    action_id: 'repair',
    title: 'visible-title',
    objective: 'visible-objective',
    work_shape: 'pipeline',
    status: 'admitted',
    proposal_hash: 'hash',
    at: '2026-10-26T00:00:00Z',
    ...overrides,
  });

  it('reports permitted sections beside one corrupt row instead of dying', async () => {
    writeCharter(CHARTER, 'status-integrity');
    appendActionRecord(action(), { rootDir: TEST_ROOT });
    appendJsonLine(`${TEST_ROOT}/${DOT_ACTION_LEDGER_PATH}`, {
      dot_id: CHARTER.dot_id,
      action_ref: 'ref-corrupt',
      private_content_hash: 'not-a-hex-digest',
      scope: { tier: 'confidential', tenant_slug: 'acme' },
      actor_id: `dot:${CHARTER.dot_id}`,
      action_id: 'repair',
      work_shape: 'pipeline',
      status: 'admitted',
      proposal_hash: 'hash',
      at: '2026-10-26T00:01:00Z',
    });
    const report = await runDotCharters(['status', CHARTER.dot_id, '--json', '--quiet']);
    expect(report).toMatchObject({
      ok: false,
      integrity: 'integrity_error',
      dots: [
        {
          dot_id: CHARTER.dot_id,
          action_integrity: 'integrity_error',
          action_anomalies: { malformed_rows: 1 },
          actions: { admitted: 1 },
        },
      ],
    });
    expect(process.exitCode).toBe(1);
    const dot = (report?.dots as Array<Record<string, unknown>>)[0];
    // Capacity derives from the strict hydrate — degraded, never a crash.
    expect(dot.delegation_capacity).toMatchObject({ status: 'unavailable' });
    // The corrupt row contributes no content and no fabricated success.
    expect(JSON.stringify(report)).not.toContain('ref-corrupt');
  });

  it('marks rows in an invisible scope partial and keeps them out of the payload', async () => {
    writeCharter(CHARTER, 'status-partial');
    appendActionRecord(action(), { rootDir: TEST_ROOT });
    vi.stubEnv('KYBERION_NHI_ID', 'owner-a');
    appendActionRecord(
      action({
        scope: { tier: 'personal', owner_nhi: 'owner-a' },
        action_ref: 'ref-personal',
        title: 'personal-secret',
      }),
      { rootDir: TEST_ROOT }
    );
    vi.stubEnv('KYBERION_NHI_ID', 'owner-b');
    const report = await runDotCharters(['status', CHARTER.dot_id, '--json', '--quiet']);
    expect(report).toMatchObject({
      ok: true,
      integrity: 'partial',
      dots: [
        {
          action_integrity: 'partial',
          action_anomalies: { not_visible: 1 },
          actions: { admitted: 1 },
        },
      ],
    });
    expect(process.exitCode).not.toBe(1);
    expect(JSON.stringify(report)).not.toContain('personal-secret');
    expect(JSON.stringify(report)).not.toContain('ref-personal');
  });
});

describe('forward event continuation CLI', () => {
  it('requires explicit quiescence and adopts only the paused fixture', async () => {
    writeCharter(
      {
        ...CHARTER,
        status: 'paused',
        attention: { triggers: [{ kind: 'event', sources: ['fixture'] }] },
      },
      'fixture'
    );
    expect(
      await runDotCharters(['event', 'continue', 'collision', '--json', '--quiet'])
    ).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    const result = await runDotCharters([
      'event',
      'continue',
      'collision',
      '--confirm-quiescent',
      '--json',
      '--quiet',
    ]);
    expect(result, JSON.stringify(vi.mocked(console.error).mock.calls)).toMatchObject({
      ok: true,
      status: 'paused',
    });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
  });
});
