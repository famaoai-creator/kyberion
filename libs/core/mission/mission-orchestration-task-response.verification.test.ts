import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  recordKnowledgeVerifiedRun: vi.fn(),
  recordKnowledgeUsageFeedback: vi.fn(),
}));

vi.mock('../mesh/a2a-bridge.js', () => ({ a2aBridge: { route: mocks.route } }));
vi.mock('../knowledge/knowledge-verification.js', () => ({
  recordKnowledgeVerifiedRun: mocks.recordKnowledgeVerifiedRun,
}));
vi.mock('../knowledge/knowledge-feedback-loop.js', () => ({
  recordKnowledgeUsageFeedback: mocks.recordKnowledgeUsageFeedback,
}));

import {
  obtainTaskResultResponse,
  type TaskResultResponseDeps,
} from './mission-orchestration-task-response.js';
import type { TaskResultBlock } from './mission-orchestration-worker-contracts.js';

const DELIVERED = 'knowledge/confidential/tenant-a/runbooks/deploy.md';

function run(taskResult: Partial<TaskResultBlock>, parseErrors: string[] = []) {
  mocks.route.mockResolvedValue({ payload: { text: 'ok' } });
  const result: TaskResultBlock = {
    summary: 'done',
    artifacts: [],
    verification_done: ['ran tests'],
    gaps: [],
    needs: [],
    ...taskResult,
  };
  const deps: TaskResultResponseDeps = {
    recordMissionVisiblePrompt: () => undefined,
    resolveTaskDispatchTimeoutMs: () => 1000,
    parseTaskResultResponse: () => ({ taskResult: result, parseErrors, surfaceParseErrors: [] }),
    buildNeedsKnowledgeReinforcementLines: async () => [],
    buildTaskResultRetryPrompt: () => 'retry',
    stampTaskResultProvenance: () => undefined,
  };
  return obtainTaskResultResponse(deps, {
    missionId: 'MSN-VERIFY',
    task: { task_id: 'T1', description: 'deploy' } as never,
    teamRole: 'implementer',
    agentId: 'agent-1',
    prompt: 'do it',
    deliveredKnowledgeRefs: [{ path: DELIVERED }],
    securityScope: {
      tenant_slug: 'tenant-a',
      project_id: 'PRJ-1',
      organization_id: 'org-a',
      mission_id: 'MSN-VERIFY',
      read_tiers: ['public', 'confidential'],
      write_tier: 'confidential',
      purpose: 'mission-execution',
    },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('task responses record verified knowledge runs', () => {
  it('records delivered documents a finished task reported using', async () => {
    await run({ knowledge_feedback: { used: [DELIVERED, 'knowledge/not-delivered.md'] } });
    expect(mocks.recordKnowledgeVerifiedRun).toHaveBeenCalledWith({
      documentPaths: [DELIVERED],
      scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
      projectId: 'PRJ-1',
    });
  });

  it('records nothing when the task left gaps, or nothing delivered was used', async () => {
    await run({ gaps: ['could not verify rollback'], knowledge_feedback: { used: [DELIVERED] } });
    await run({ knowledge_feedback: { used: ['knowledge/not-delivered.md'] } });
    await run({ knowledge_feedback: { not_used: [DELIVERED] } });
    expect(mocks.recordKnowledgeVerifiedRun).not.toHaveBeenCalled();
  });
});
