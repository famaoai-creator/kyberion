import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory I/O keeps candidate preparation tests away from live mission/queue state.
const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failWrite: '',
  state: {} as Record<string, unknown>,
  llm: vi.fn(),
  enqueue: vi.fn(),
  validate: vi.fn(),
  guardrails: vi.fn(),
  dryRun: vi.fn(),
}));
const root = '/workflow-fixture';
const id = 'MSN-REUSE-TEST';
const mission = `${root}/active/missions/public/${id}`;
vi.mock('../secure-io.js', () => ({
  assertSafeRepositoryPath: (value: string) => value,
  safeExistsSync: (value: string) =>
    fixture.files.has(value) ||
    [...fixture.files.keys()].some((file) => file.startsWith(`${value}/`)),
  safeLstat: (value: string) => ({
    isFile: () => fixture.files.has(value),
    size: Buffer.byteLength(fixture.files.get(value) || ''),
  }),
  safeReaddir: (value: string) => [
    ...new Set(
      [...fixture.files.keys()]
        .filter((file) => file.startsWith(`${value}/`))
        .map((file) => file.slice(value.length + 1).split('/')[0])
    ),
  ],
  safeReadFileSnapshot: (value: string) => Buffer.from(fixture.files.get(value) || ''),
  safeMkdir: vi.fn(),
  safeWriteFile: (value: string, content: string) => {
    if (fixture.failWrite && value.endsWith(fixture.failWrite)) {
      fixture.failWrite = '';
      throw new Error('Interrupted snapshot write');
    }
    fixture.files.set(value, content);
  },
}));
vi.mock('../foundation/text.js', () => ({
  readTextFile: (value: string) => fixture.files.get(value),
}));
vi.mock('../path-resolver.js', () => ({
  pathResolver: {
    rootDir: () => '/workflow-fixture',
    rootResolve: (value: string) => path.join('/workflow-fixture', value),
    knowledge: (value: string) => path.join('/workflow-fixture/knowledge', value),
  },
  missionDir: (missionId: string, tier: string, tenant?: string) =>
    `/workflow-fixture/active/missions/${tier}/${tenant ? `${tenant}/` : ''}${missionId}`,
  archivedMissionDir: () => '/workflow-fixture/archive',
}));
vi.mock('./mission-state-reader.js', () => ({ loadMissionStateAtPath: () => fixture.state }));
vi.mock('./mission-llm.js', () => ({ runAdaptiveStructuredLlmProfile: fixture.llm }));
vi.mock('./mission-distill.js', () => ({
  loadWisdomPolicy: () => ({
    llm: { default_profile: 'heavy', profiles: { heavy: { command: 'codex', args: [] } } },
  }),
}));
vi.mock('../knowledge/memory-promotion-queue.js', () => ({
  enqueueMemoryPromotionCandidate: fixture.enqueue,
}));
vi.mock('../pipeline/pipeline-contract.js', () => ({ validatePipelineAdf: fixture.validate }));
vi.mock('../pipeline/adf-guardrails.js', () => ({
  validatePipelineGuardrails: fixture.guardrails,
}));
vi.mock('../pipeline/pipeline-dry-run.js', () => ({ assessPipelineDryRun: fixture.dryRun }));

import {
  collectWorkflowReuseEvidence,
  prepareMissionWorkflowReuse,
} from './mission-workflow-reuse.js';

const assessment = () => ({
  decision: 'prepare_pipeline',
  reason: 'Variants are requested',
  evidence_refs: ['evidence/result.md'],
  inputs: [{ name: 'topic', description: 'Requested topic' }],
  steps: [{ kind: 'reasoning', instruction: 'Evaluate the requested topic' }],
  success_conditions: ['Reviewed output'],
  pipeline_json: JSON.stringify({ action: 'pipeline', steps: [] }),
  existing_pipeline_ref: null,
});
beforeEach(() => {
  vi.clearAllMocks();
  fixture.files.clear();
  fixture.failWrite = '';
  fixture.state = {
    mission_id: id,
    tier: 'public',
    status: 'distilling',
    verification: { status: 'verified' },
    intent: { goal_summary: 'Produce variants' },
  };
  fixture.files.set(`${mission}/mission-state.json`, '{}');
  fixture.files.set(`${mission}/evidence/result.md`, 'Accepted output and requested variants');
  fixture.llm.mockResolvedValue(assessment());
  fixture.validate.mockImplementation((input: unknown) => input);
  fixture.guardrails.mockReturnValue({ findings: [] });
  fixture.dryRun.mockReturnValue({ checks: [] });
});

describe('automatic workflow reuse preparation', () => {
  it('refuses malformed pipeline JSON before queue handoff', async () => {
    fixture.llm.mockResolvedValue({ ...assessment(), pipeline_json: '{broken' });
    expect(await prepareMissionWorkflowReuse(id, mission)).toMatchObject({
      status: 'not_assessed',
    });
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it('passes governed LLM profiles into assessment invocation', async () => {
    await prepareMissionWorkflowReuse(id, mission);
    expect(fixture.llm.mock.calls[0][3].policy).toMatchObject({
      default_profile: 'heavy',
      profiles: { heavy: { command: 'codex' } },
    });
  });

  it('repairs a missing snapshot artifact after interruption before queueing', async () => {
    fixture.failWrite = '/preparation.json';
    expect(await prepareMissionWorkflowReuse(id, mission)).toMatchObject({
      status: 'not_assessed',
    });
    expect(fixture.enqueue).not.toHaveBeenCalled();
    const recovered = await prepareMissionWorkflowReuse(id, mission);
    expect(recovered.status).toBe('needs_review');
    expect(fixture.files.has(path.join(root, recovered.bundle_ref!))).toBe(true);
    expect(
      fixture.files.has(path.join(root, path.dirname(recovered.bundle_ref!), 'pipeline.json'))
    ).toBe(true);
    expect(fixture.llm).toHaveBeenCalledTimes(1);
  });

  it('does not queue a snapshot whose saved pipeline has been corrupted', async () => {
    const first = await prepareMissionWorkflowReuse(id, mission);
    fixture.files.set(
      path.join(root, path.dirname(first.bundle_ref!), 'pipeline.json'),
      'truncated'
    );
    fixture.enqueue.mockClear();
    expect(await prepareMissionWorkflowReuse(id, mission)).toMatchObject({
      status: 'not_assessed',
      reason: expect.stringContaining('WORKFLOW_REUSE_INTEGRITY'),
    });
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it('creates a fresh immutable snapshot when an existing template changes', async () => {
    const template = `${root}/pipelines/example.json`;
    fixture.files.set(template, JSON.stringify({ action: 'pipeline', name: 'first', steps: [] }));
    fixture.llm.mockResolvedValue({
      ...assessment(),
      decision: 'reuse_existing',
      existing_pipeline_ref: 'pipelines/example.json',
    });
    const first = await prepareMissionWorkflowReuse(id, mission);
    const firstPipeline = path.join(root, path.dirname(first.bundle_ref!), 'pipeline.json');
    fixture.files.set(template, JSON.stringify({ action: 'pipeline', name: 'second', steps: [] }));
    const second = await prepareMissionWorkflowReuse(id, mission);
    expect(first.status).toBe('needs_review');
    expect(second.status).toBe('needs_review');
    expect(second.candidate_id).not.toBe(first.candidate_id);
    expect(JSON.parse(fixture.files.get(firstPipeline)!)).toMatchObject({ name: 'first' });
    expect(
      JSON.parse(
        fixture.files.get(path.join(root, path.dirname(second.bundle_ref!), 'pipeline.json'))!
      )
    ).toMatchObject({ name: 'second' });
    expect(fixture.llm).toHaveBeenCalledTimes(1);
  });

  it('reuses a stable candidate and assessment on retry without changing its snapshot', async () => {
    const first = await prepareMissionWorkflowReuse(id, mission);
    const snapshot = fixture.files.get(path.join(root, first.bundle_ref!));
    const second = await prepareMissionWorkflowReuse(id, mission);
    expect(first.status).toBe('needs_review');
    expect(second.candidate_id).toBe(first.candidate_id);
    expect(fixture.llm).toHaveBeenCalledTimes(1);
    expect(fixture.files.get(path.join(root, second.bundle_ref!))).toBe(snapshot);
    expect(JSON.parse(snapshot!)).toMatchObject({
      validation: { kind: 'static_only', replay: 'not_run' },
      handoff: { approval_required: true, execution_authorized: false },
    });
    expect(fixture.enqueue.mock.calls.map(([candidate]) => candidate.candidate_id)).toEqual([
      first.candidate_id,
      first.candidate_id,
    ]);
  });

  it('blocks evidence references absent from the supplied evidence', async () => {
    fixture.llm.mockResolvedValue({
      ...assessment(),
      evidence_refs: ['../other-tenant/result.md'],
    });
    expect(await prepareMissionWorkflowReuse(id, mission)).toMatchObject({ status: 'blocked' });
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it('blocks another tenant pipeline and preserves confidential egress scope', async () => {
    const scopedMission = `${root}/active/missions/confidential/acme/${id}`;
    fixture.state = { ...fixture.state, tier: 'confidential', tenant_slug: 'acme' };
    fixture.files.set(`${scopedMission}/mission-state.json`, '{}');
    fixture.files.set(`${scopedMission}/evidence/result.md`, 'Accepted');
    fixture.llm.mockResolvedValue({
      ...assessment(),
      decision: 'reuse_existing',
      existing_pipeline_ref: 'knowledge/confidential/other/pipelines/read.json',
    });
    expect(await prepareMissionWorkflowReuse(id, scopedMission)).toMatchObject({
      status: 'blocked',
    });
    expect(fixture.llm.mock.calls[0][3]).toMatchObject({
      egress: { dataTier: 'confidential', tenantSlug: 'acme' },
    });
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it('does not assess unverified completion or mismatched mission storage', async () => {
    fixture.state.verification = { status: 'pending' };
    expect(await prepareMissionWorkflowReuse(id, mission)).toMatchObject({
      status: 'not_assessed',
    });
    fixture.state.verification = { status: 'verified' };
    fixture.state.tier = 'personal';
    expect(await prepareMissionWorkflowReuse(id, mission)).toMatchObject({
      status: 'not_assessed',
    });
    expect(fixture.llm).not.toHaveBeenCalled();
  });

  it('records unavailable reasoning as unassessed and does not enqueue a candidate', async () => {
    fixture.llm.mockRejectedValue(new Error('Backend unavailable'));
    expect(await prepareMissionWorkflowReuse(id, mission)).toMatchObject({
      status: 'not_assessed',
      reason: 'Backend unavailable',
    });
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it('retains classified validation failures without queueing or claiming replay', async () => {
    fixture.dryRun.mockReturnValue({ checks: [{ status: 'blocked', message: 'Unknown op' }] });
    const result = await prepareMissionWorkflowReuse(id, mission);
    expect(result).toMatchObject({ status: 'blocked', reason: 'Unknown op' });
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it('treats omitted oversized evidence as unchecked and blocks promotion', async () => {
    fixture.files.set(`${mission}/evidence/large.md`, 'x'.repeat(16_001));
    expect(collectWorkflowReuseEvidence(mission).omitted).toEqual(['evidence/large.md']);
    expect(await prepareMissionWorkflowReuse(id, mission)).toMatchObject({ status: 'blocked' });
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it('keeps one-off work out of the promotion queue', async () => {
    fixture.llm.mockResolvedValue({ ...assessment(), decision: 'one_off' });
    expect(await prepareMissionWorkflowReuse(id, mission)).toMatchObject({ status: 'one_off' });
    expect(fixture.validate).not.toHaveBeenCalled();
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });
});
