import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryPromotionCandidate } from './memory-promotion-queue.js';
import {
  runKnowledgeValidationSweep,
  runTaskModelRoutingSummary,
  writeTaskRoutingSummary,
} from './report-ops.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { resetCurrentScope } from './scope-context.js';

describe('runKnowledgeValidationSweep', () => {
  const root = pathResolver.sharedTmp(`knowledge-validation-sweep/${process.pid}`);
  const queuePath = `${root}/promotion-queue.jsonl`;
  const envKey = 'KYBERION_MEMORY_QUEUE_PATH';
  let originalQueuePath: string | undefined;

  beforeEach(() => {
    originalQueuePath = process.env[envKey];
    process.env[envKey] = queuePath;
    safeRmSync(root, { recursive: true, force: true });
    safeMkdir(root, { recursive: true });
  });

  afterEach(() => {
    safeRmSync(root, { recursive: true, force: true });
    if (originalQueuePath === undefined) delete process.env[envKey];
    else process.env[envKey] = originalQueuePath;
  });

  it('reports legacy records and only exposes the requested tenant', () => {
    const tenantCandidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-TENANT-A',
      sourceType: 'incident',
      sourceRef: 'heuristic:tenant-a',
      proposedMemoryKind: 'heuristic',
      summary: 'tenant a lesson',
      evidenceRefs: ['knowledge/confidential/tenant-a/lesson.md'],
      sensitivityTier: 'confidential',
      scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
    });
    const tenantB = createMemoryPromotionCandidate({
      candidateId: 'MEM-TENANT-B',
      sourceType: 'incident',
      sourceRef: 'heuristic:tenant-b',
      proposedMemoryKind: 'heuristic',
      summary: 'tenant b lesson',
      evidenceRefs: ['knowledge/confidential/tenant-b/lesson.md'],
      sensitivityTier: 'confidential',
      scope: { tier: 'confidential', tenant_slug: 'tenant-b' },
    });
    const legacy = createMemoryPromotionCandidate({
      candidateId: 'MEM-LEGACY',
      sourceType: 'incident',
      sourceRef: 'heuristic:legacy',
      proposedMemoryKind: 'heuristic',
      summary: 'legacy lesson',
      evidenceRefs: ['knowledge/product/legacy.md'],
      sensitivityTier: 'confidential',
    });
    safeWriteFile(
      queuePath,
      [tenantCandidate, tenantB, legacy].map(JSON.stringify).join('\n') + '\n'
    );

    const result = runKnowledgeValidationSweep({
      scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
    });

    expect(result.status).toBe('ok');
    expect(result.promotion_queue.visible_count).toBe(1);
    expect(result.promotion_queue.scoped_count).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('marks unscoped queue records as attention for an operator review', () => {
    const legacy = createMemoryPromotionCandidate({
      candidateId: 'MEM-LEGACY-ATTENTION',
      sourceType: 'incident',
      sourceRef: 'heuristic:legacy-attention',
      proposedMemoryKind: 'heuristic',
      summary: 'legacy lesson',
      evidenceRefs: ['knowledge/product/legacy.md'],
      sensitivityTier: 'confidential',
    });
    safeWriteFile(queuePath, `${JSON.stringify(legacy)}\n`);

    const result = runKnowledgeValidationSweep();

    expect(result.status).toBe('ok');
    expect(result.promotion_queue.legacy_unscoped_count).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'legacy_unscoped_candidate',
        severity: 'warning',
      }),
    ]);
  });

  it('rejects report input and output paths outside the repository root', () => {
    expect(() =>
      runTaskModelRoutingSummary({ task_events_path: '../../outside-events.jsonl' })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
    expect(() =>
      writeTaskRoutingSummary({ samples: [], rows: [], outputPath: '../../outside-report.json' })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('filters shared routing telemetry to the authoritative tenant scope', () => {
    const suffix = `report-ops-tenant-${process.pid}`;
    const taskEventsPath = pathResolver.sharedTmp(`${suffix}-tasks.jsonl`);
    const supervisorEventsPath = pathResolver.sharedTmp(`${suffix}-runtime.jsonl`);
    const previousTenant = process.env.KYBERION_TENANT;
    const previousScopeEnvPath = process.env.KYBERION_SCOPE_ENV_PATH;
    process.env.KYBERION_TENANT = 'tenant-a';
    process.env.KYBERION_SCOPE_ENV_PATH = pathResolver.sharedTmp(`${suffix}-scope.env`);
    resetCurrentScope();
    const issue = (tenant_slug?: string) => ({
      event_type: 'task_issued',
      mission_id: `MSN-${tenant_slug || 'legacy'}`,
      task_id: `task-${tenant_slug || 'legacy'}`,
      agent_id: `agent-${tenant_slug || 'legacy'}`,
      team_role: 'implementer',
      ...(tenant_slug ? { scope: { tenant_slug } } : {}),
      payload: {
        task_model_hint: {
          tier: 'small',
          effort: 'low',
          model_id: 'openai:gpt-5.4-mini',
        },
      },
    });
    const completion = (tenant_slug?: string) => ({
      decision: 'agent_runtime_ask_completed',
      agent_id: `agent-${tenant_slug || 'legacy'}`,
      model_id: 'openai:gpt-5.5',
      duration_ms: 100,
      input_tokens: 10,
      output_tokens: 5,
      ...(tenant_slug ? { scope: { tenant_slug } } : {}),
    });
    safeWriteFile(
      taskEventsPath,
      [issue('tenant-a'), issue('tenant-b'), issue()].map(JSON.stringify).join('\n') +
        '\nnot-json\n[]\n'
    );
    safeWriteFile(
      supervisorEventsPath,
      [completion('tenant-a'), completion('tenant-b'), completion()]
        .map(JSON.stringify)
        .join('\n') + '\n{"agent_id":7}\n'
    );
    try {
      const result = runTaskModelRoutingSummary({
        task_events_path: taskEventsPath,
        supervisor_events_path: supervisorEventsPath,
      });
      expect(result.samples).toHaveLength(1);
      expect(result.samples[0]?.mission_id).toBe('MSN-tenant-a');
    } finally {
      resetCurrentScope();
      if (previousTenant === undefined) delete process.env.KYBERION_TENANT;
      else process.env.KYBERION_TENANT = previousTenant;
      if (previousScopeEnvPath === undefined) delete process.env.KYBERION_SCOPE_ENV_PATH;
      else process.env.KYBERION_SCOPE_ENV_PATH = previousScopeEnvPath;
      safeRmSync(taskEventsPath, { force: true });
      safeRmSync(supervisorEventsPath, { force: true });
      safeRmSync(pathResolver.sharedTmp(`${suffix}-scope.env`), { force: true });
    }
  });
});
