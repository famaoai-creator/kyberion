import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  collectFailedSchedules,
  extractHintsFromTrace,
  persistHints,
  checkScheduleHealth,
  recordPipelineResult,
  sweepFailedSchedules,
} from './feedback-loop.js';
import type { Trace } from './trace.js';
import { loadScheduleRegistry, type PipelineScheduleRegistry } from './pipeline-scheduler.js';
import { pathResolver } from '../path-resolver.js';
import { safeWriteFile } from '../secure-io.js';

const PUBLIC_HINTS = path.resolve(
  process.cwd(),
  'knowledge/public/procedures/hints/auto-learned.json'
);
const RUNTIME_HINTS_DIR = path.resolve(process.cwd(), 'active/shared/runtime/feedback-loop/hints');
const RUNTIME_HINTS = path.join(RUNTIME_HINTS_DIR, 'auto-learned.json');

function makeTrace(): Trace {
  return {
    traceId: 'trace-123',
    metadata: {
      actuator: 'browser-actuator',
      startedAt: '2026-03-25T00:00:00.000Z',
      completedAt: '2026-03-25T00:01:00.000Z',
    },
    rootSpan: {
      spanId: 'root',
      name: 'browser-pipeline',
      startTime: '2026-03-25T00:00:00.000Z',
      endTime: '2026-03-25T00:01:00.000Z',
      status: 'error',
      events: [],
      artifacts: [],
      knowledgeRefs: [],
      children: [
        {
          spanId: 'child',
          name: 'capture:screenshot',
          startTime: '2026-03-25T00:00:05.000Z',
          endTime: '2026-03-25T00:00:10.000Z',
          status: 'error',
          error: 'Failed to open /Users/example/secret.txt from active/shared/tmp/demo.png',
          events: [],
          artifacts: [
            {
              type: 'screenshot',
              path: 'active/shared/tmp/demo.png',
              timestamp: '2026-03-25T00:00:08.000Z',
            },
          ],
          knowledgeRefs: [],
          children: [],
        },
      ],
    },
  };
}

describe('feedback-loop', () => {
  beforeEach(() => {
    fs.rmSync(RUNTIME_HINTS_DIR, { recursive: true, force: true });
    if (fs.existsSync(PUBLIC_HINTS)) {
      fs.unlinkSync(PUBLIC_HINTS);
    }
  });

  afterEach(() => {
    fs.rmSync(RUNTIME_HINTS_DIR, { recursive: true, force: true });
    if (fs.existsSync(PUBLIC_HINTS)) {
      fs.unlinkSync(PUBLIC_HINTS);
    }
  });

  it('sanitizes trace-derived hints so they do not expose raw paths', () => {
    const hints = extractHintsFromTrace(makeTrace());

    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some((hint) => hint.hint.includes('/Users/example/secret.txt'))).toBe(false);
    expect(hints.some((hint) => hint.hint.includes('active/shared/tmp/demo.png'))).toBe(false);
  });

  it('suppresses low-signal success artifact hints (LC-15)', () => {
    const trace = makeTrace();
    trace.rootSpan.status = 'ok';
    trace.rootSpan.error = undefined;
    trace.rootSpan.children[0]!.status = 'ok';
    trace.rootSpan.children[0]!.error = undefined;

    expect(extractHintsFromTrace(trace)).toEqual([]);
  });

  it('persists generated hints under governed runtime paths, not public knowledge', () => {
    persistHints([
      {
        topic: 'error capture screenshot',
        hint: 'Review trace trace-123 for details.',
        source: 'trace/trace-123',
        confidence: 0.7,
        tags: ['auto-generated'],
      },
    ]);

    expect(fs.existsSync(RUNTIME_HINTS)).toBe(true);
    expect(fs.existsSync(PUBLIC_HINTS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LC-01c: failed-schedule escalation sweep — hermetic (fixture registry under
// active/shared/tmp, injected alert emitter; never the real registry or log).
// ---------------------------------------------------------------------------

function makeRegistry(
  overrides: Partial<PipelineScheduleRegistry['schedules'][number]>[]
): PipelineScheduleRegistry {
  return {
    version: '1.0',
    schedules: overrides.map((override, index) => ({
      id: `schedule-${index}`,
      name: `schedule-${index}`,
      pipelinePath: 'pipelines/daily-routine.json',
      actuator: 'run_pipeline',
      trigger: { type: 'cron' as const, cron: '0 6 * * *' },
      enabled: true,
      ...override,
    })),
  };
}

describe('failed-schedule sweep (LC-01c)', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const rootDir = tempRoots.pop();
      if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  function seedRegistryRoot(registry: PipelineScheduleRegistry): string {
    const rootDir = fs.mkdtempSync(path.join(pathResolver.sharedTmp(''), 'failed-sweep-'));
    tempRoots.push(rootDir);
    safeWriteFile(
      path.join(rootDir, 'active/shared/runtime/pipeline-schedules.json'),
      JSON.stringify(registry, null, 2)
    );
    return rootDir;
  }

  it('collectFailedSchedules finds failed lastStatus, consecutive failures, and auto-disabled entries', () => {
    const registry = makeRegistry([
      { id: 'healthy', lastStatus: 'succeeded', consecutiveFailures: 0 } as never,
      { id: 'failed-last', lastStatus: 'failed' } as never,
      { id: 'counting', lastStatus: 'succeeded', consecutiveFailures: 2 } as never,
      {
        id: 'auto-disabled',
        enabled: false,
        lastStatus: 'failed',
        consecutiveFailures: 3,
        disabledReason: 'Auto-disabled after 3 consecutive failures',
      } as never,
    ]);

    const findings = collectFailedSchedules(registry);
    expect(findings.map((finding) => finding.id)).toEqual([
      'failed-last',
      'counting',
      'auto-disabled',
    ]);
    expect(findings[2]).toMatchObject({
      enabled: false,
      consecutiveFailures: 3,
      disabledReason: 'Auto-disabled after 3 consecutive failures',
    });
  });

  it('collectFailedSchedules returns empty for a healthy or empty registry', () => {
    expect(collectFailedSchedules(makeRegistry([]))).toEqual([]);
    expect(
      collectFailedSchedules(
        makeRegistry([{ id: 'ok', lastStatus: 'succeeded', consecutiveFailures: 0 } as never])
      )
    ).toEqual([]);
  });

  it('sweepFailedSchedules emits one warn alert listing failed schedules, without mutating the registry', () => {
    const registry = makeRegistry([
      { id: 'ok', lastStatus: 'succeeded' } as never,
      { id: 'broken', lastStatus: 'failed', consecutiveFailures: 2 } as never,
    ]);
    const rootDir = seedRegistryRoot(registry);
    const registryPath = path.join(rootDir, 'active/shared/runtime/pipeline-schedules.json');
    const beforeRaw = fs.readFileSync(registryPath, 'utf8');

    const emitAlert = vi.fn().mockReturnValue({
      id: 'fake-alert',
      recorded_path: 'fake',
      webhook_attempted: false,
      webhook_delivered: false,
      suppressed: false,
    });
    const result = sweepFailedSchedules({ registryOptions: { rootDir }, emitAlert });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe('broken');
    expect(emitAlert).toHaveBeenCalledTimes(1);
    const input = emitAlert.mock.calls[0]![0];
    expect(input.severity).toBe('warning');
    expect(input.category).toBe('scheduler');
    expect(input.context.failed_schedules).toEqual(result.failed);
    expect(result.alert?.id).toBe('fake-alert');
    // read-only: the registry file is byte-identical after the sweep
    expect(fs.readFileSync(registryPath, 'utf8')).toBe(beforeRaw);
  });

  it('sweepFailedSchedules emits nothing when no schedule is failed', () => {
    const rootDir = seedRegistryRoot(
      makeRegistry([{ id: 'ok', lastStatus: 'succeeded' } as never])
    );
    const emitAlert = vi.fn();
    const result = sweepFailedSchedules({ registryOptions: { rootDir }, emitAlert });
    expect(result.failed).toEqual([]);
    expect(result.alert).toBeNull();
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('records and auto-disables failures through the governed scheduler registry', () => {
    const rootDir = seedRegistryRoot(
      makeRegistry([{ id: 'broken', lastStatus: 'succeeded' } as never])
    );

    recordPipelineResult('broken', 'failed', undefined, { rootDir });
    expect(loadScheduleRegistry({ rootDir }).schedules[0]).toMatchObject({
      consecutiveFailures: 1,
      lastStatus: 'failed',
    });

    expect(checkScheduleHealth('broken', 1, { rootDir })).toMatchObject({
      healthy: false,
      action: 'disabled',
    });
    expect(loadScheduleRegistry({ rootDir }).schedules[0]).toMatchObject({
      enabled: false,
      disabledReason: 'Auto-disabled after 1 consecutive failures',
    });
  });
});
