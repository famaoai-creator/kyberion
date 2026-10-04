import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { stubReasoningBackend, type ReasoningBackend } from '../reasoning/reasoning-backend.js';
import type { DotCharter } from './dot-charter.js';
import { readDotWakeLedger } from './dot-runtime.js';
import { runDotWakeWithGoalDriver } from './dot-wake-orchestration.js';

const TEST_ROOT = 'active/shared/tmp/dot-wake-orchestration-tests';

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'orch-dot',
  version: '1.0.0',
  title: 'Orchestration dot',
  purpose: 'Exercise the wake wiring.',
  status: 'active',
  scope: { tier: 'public' },
  goal: { statement: 'Do nothing harmful.' },
  attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-orch-dot' },
};

const loaded = { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER };

function writeCharter(): void {
  safeMkdir(`${TEST_ROOT}/dots`, { recursive: true });
  safeWriteFile(loaded.path, JSON.stringify(CHARTER));
}

afterEach(() => {
  vi.unstubAllEnvs();
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('runDotWakeWithGoalDriver', () => {
  it('passes the resolved backend explicitly into the goal driver', async () => {
    writeCharter();
    const backend: ReasoningBackend = {
      ...stubReasoningBackend,
      name: 'anthropic',
      generateWithTools: async () => ({ text: '', toolCalls: [] }) as never,
    };
    let seenBackend: unknown;
    const receipt = await runDotWakeWithGoalDriver(loaded, {
      rootDir: TEST_ROOT,
      hasRole: () => true,
      backend,
      goalDriver: (async (options: { backend?: unknown }) => {
        seenBackend = options.backend;
        return { turnsRun: 1, goal: { budgetStats: { tokensUsed: 3 } } };
      }) as never,
    });
    expect(receipt.outcome).toBe('delivered');
    expect(seenBackend).toBe(backend);
  });

  it('fails the wake instead of delivering stub output when only the stub is installed', async () => {
    vi.stubEnv('KYBERION_REASONING_BACKEND', 'claude-cli');
    writeCharter();
    const receipt = await runDotWakeWithGoalDriver(loaded, {
      rootDir: TEST_ROOT,
      hasRole: () => true,
    });
    expect(receipt.outcome).toBe('failed');
    expect(receipt.reason).toContain('no real reasoning backend');
    expect(readDotWakeLedger({ rootDir: TEST_ROOT }).map((row) => row.outcome)).toEqual(['failed']);
  });
});
