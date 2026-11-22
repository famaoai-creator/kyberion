import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as io from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { loadKnowledgeUsageAggregate } from '../knowledge/knowledge-feedback-loop.js';
import { knowledgeTextSha256 } from '../knowledge/knowledge-delivery-snapshot.js';
import {
  printPromotedKnowledgeForActiveMission,
  recordOperatorKnowledgeUsage,
  surfacePromotedKnowledgeForOperator,
} from './mission-operator-knowledge-surface.js';
import { loadState } from './mission-state.js';
import { inspectInstalledPersonalRuntime } from '../organization/personal-runtime-identity.js';
import { detectAgentExecutionContext } from '../agent/agent-execution-context.js';
import { findRelevantPromotedKnowledge } from '../knowledge/promoted-knowledge-retrieval.js';

vi.mock('./mission-state.js', () => ({ loadState: vi.fn() }));
vi.mock('../organization/personal-runtime-identity.js', () => ({
  inspectInstalledPersonalRuntime: vi.fn(),
}));
vi.mock('../agent/agent-execution-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/agent-execution-context.js')>()),
  detectAgentExecutionContext: vi.fn(() => ({ isAgent: false })),
}));
vi.mock('../knowledge/promoted-knowledge-retrieval.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../knowledge/promoted-knowledge-retrieval.js')>();
  return { ...actual, findRelevantPromotedKnowledge: vi.fn(actual.findRelevantPromotedKnowledge) };
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) io.safeRmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function fixtureRoot(): string {
  const root = pathResolver.sharedTmp('operator-surface-' + randomUUID());
  roots.push(root);
  const documentPath = 'knowledge/public/common/wisdom/generated/mem-surface-test.md';
  const absolute = path.join(root, documentPath);
  io.safeMkdir(path.dirname(absolute), { recursive: true });
  io.safeWriteFile(
    absolute,
    [
      '---',
      'record_id: mem-surface-test',
      'kind: wisdom',
      'tier: public',
      '---',
      '',
      '# Mission evidence recording needs positional arguments',
      '',
      'Lessons about mission evidence: record-evidence takes positional task ids,',
      'and flag forms do not close the task even when they print recorded.',
      '',
    ].join('\n')
  );
  return root;
}

describe('surfacePromotedKnowledgeForOperator', () => {
  it('returns display lines and records delivery for a matching promoted record', async () => {
    const lines = await surfacePromotedKnowledgeForOperator({
      missionId: 'MSN-TEST-SURFACE',
      topic: 'mission evidence recording positional arguments',
      scope: { tier: 'public', mission_id: 'MSN-TEST-SURFACE' },
      rootDir: fixtureRoot(),
    });
    expect(lines.join('\n')).toContain('mem-surface-test');
    const delivered = loadKnowledgeUsageAggregate({ tier: 'public' }).some(
      (entry) => entry.document_path.endsWith('mem-surface-test.md') && entry.delivered_count > 0
    );
    expect(delivered).toBe(true);
  });

  it('returns [] for a blank topic without touching the aggregate', async () => {
    const lines = await surfacePromotedKnowledgeForOperator({
      missionId: 'MSN-TEST-SURFACE',
      topic: '   ',
      scope: { tier: 'public' },
      rootDir: fixtureRoot(),
    });
    expect(lines).toEqual([]);
  });

  it('fails open when the knowledge base is absent', async () => {
    const empty = pathResolver.sharedTmp('operator-surface-empty-' + randomUUID());
    roots.push(empty);
    io.safeMkdir(empty, { recursive: true });
    const lines = await surfacePromotedKnowledgeForOperator({
      missionId: 'MSN-TEST-SURFACE',
      topic: 'anything',
      scope: { tier: 'public' },
      rootDir: empty,
    });
    expect(lines).toEqual([]);
  });
});

describe('personal operator knowledge usage', () => {
  it('delivers and records usage in the installed owner partition', async () => {
    const missionId = 'MSN-TEST-PERSONAL-SURFACE';
    const owner = `kyberion://agent/_/_/owner-${randomUUID()}`;
    const another = `kyberion://agent/_/_/owner-${randomUUID()}`;
    const scope = { tier: 'personal' as const, mission_id: missionId, owner_nhi: owner };
    const reference = 'knowledge/public/common/wisdom/generated/mem-surface-test.md';
    roots.push(pathResolver.rootResolve('active/personal/owners', knowledgeTextSha256(owner)));
    vi.mocked(loadState).mockReturnValue({
      tier: 'personal',
      status: 'active',
      intent: { goal_summary: 'mission evidence' },
    } as ReturnType<typeof loadState>);
    const installed = {
      ready: true,
      ownerId: 'user:owner',
      agentId: owner,
      agentActive: true,
      scope: { kind: 'person' },
    } as const;
    vi.mocked(inspectInstalledPersonalRuntime).mockReturnValue(installed);
    vi.mocked(findRelevantPromotedKnowledge).mockResolvedValueOnce([
      {
        path: reference,
        title: 'Mission evidence',
        excerpt: 'Record the evidence.',
        tags: [],
        score: 1,
      },
    ]);
    const emit = vi.fn();
    await printPromotedKnowledgeForActiveMission(missionId, emit);
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('Usage reference:'));

    expect(recordOperatorKnowledgeUsage(missionId, 'T1', [reference])).toEqual([
      { reference, status: 'recorded' },
    ]);
    expect(loadKnowledgeUsageAggregate(scope)[0]?.used_count).toBe(1);

    vi.mocked(inspectInstalledPersonalRuntime).mockReturnValueOnce({
      ...installed,
      agentId: another,
    });
    expect(recordOperatorKnowledgeUsage(missionId, 'T2', [reference])).toEqual([
      { reference, status: 'not_delivered' },
    ]);
    expect(loadKnowledgeUsageAggregate({ ...scope, owner_nhi: another })).toEqual([]);
  });

  it('refuses to resolve installation ownership from an agent session', () => {
    vi.mocked(loadState).mockReturnValue({ tier: 'personal' } as ReturnType<typeof loadState>);
    vi.mocked(detectAgentExecutionContext).mockReturnValueOnce({
      isAgent: true,
      principal: 'agent:test',
      harnesses: [],
      signals: [],
    });
    const reference = 'knowledge/public/common/wisdom/generated/mem-surface-test.md';
    expect(recordOperatorKnowledgeUsage('MSN-TEST-PERSONAL-SURFACE', 'T1', [reference])).toEqual([
      { reference, status: 'personal_owner_required' },
    ]);
    expect(inspectInstalledPersonalRuntime).not.toHaveBeenCalled();
  });
});
