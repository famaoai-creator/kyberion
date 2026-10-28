import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const selected = vi.hoisted(() => ({
  scope: { tier: 'public' } as {
    tier: 'public' | 'confidential';
    tenant_slug?: string;
    mission_id?: string;
  },
  prepare: vi.fn(() => ({
    plan: {
      decision: 'create_new',
      destination: 'knowledge',
      reason: 'Review a reusable change',
      next_steps: ['Human review required'],
    },
    persisted: false,
  })),
  queue: vi.fn(() => ({
    memory_candidate_id: 'MEM-LEARN-example',
    queued: true,
    next_steps: ['pnpm mission memory-review MEM-LEARN-example'],
  })),
}));
vi.mock('@agent/core/scope-context', () => ({ currentScope: () => selected.scope }));
vi.mock('@agent/core/knowledge/reusable-learning', () => ({
  prepareReusableLearning: selected.prepare,
  queueReusableLearning: selected.queue,
}));
import * as io from '@agent/core/secure-io';
import { runLearningPrepare, resolveLearningSource } from './learning_prepare.js';

beforeEach(() => {
  vi.clearAllMocks();
  selected.scope = { tier: 'public' };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('learning prepare facade', () => {
  it('handles help and rejects misspelled flags without preparing or publishing anything', async () => {
    await runLearningPrepare(['--help']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('learning prepare'));
    expect(selected.prepare).not.toHaveBeenCalled();
    await runLearningPrepare(['--input', 'material.md', '--approve']);
    expect(selected.prepare).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it('uses the shared flag grammar, passes dry-run, and preserves the authoritative current scope', async () => {
    selected.scope = { tier: 'confidential', tenant_slug: 'synthetic-learn' };
    await runLearningPrepare([
      '--input=active/shared/tmp/confidential/synthetic-learn/material.md',
      '--intent=Reusable preparation',
      '--title=Preparation',
      '--destination=skill',
      '--reuse-when=When the same task repeats',
      '--verify=pnpm check',
      '--dry-run',
      '--json',
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(selected.prepare).toHaveBeenCalledWith(
      {
        sourceRef: 'active/shared/tmp/confidential/synthetic-learn/material.md',
        scope: selected.scope,
        intent: 'Reusable preparation',
        title: 'Preparation',
        destination: 'skill',
        reuseCondition: 'When the same task repeats',
        verificationCommand: 'pnpm check',
        replaceTarget: undefined,
      },
      { dryRun: true }
    );
  });

  it('selects the existing run promotion lane without claiming success or accepting scope overrides', async () => {
    await runLearningPrepare([
      '--run',
      'active/shared/tmp/public/shared/job/run.json',
      '--intent',
      'Reuse run',
      '--title',
      'Run',
      '--reuse-when',
      'Repeat request',
      '--verify',
      'pnpm pipeline',
      '--dry-run',
    ]);
    expect(selected.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ destination: 'pipeline' }),
      { dryRun: true }
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('does not approve or publish')
    );
    selected.prepare.mockClear();
    await runLearningPrepare(['--scope-json', '{"tier":"public"}']);
    expect(selected.prepare).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it('reads mission evidence only from the active tenant and refuses switching an already bound mission', () => {
    const exists = vi
      .spyOn(io, 'safeExistsSync')
      .mockImplementation((ref) =>
        String(ref).endsWith(
          '/active/missions/confidential/synthetic-learn/MSN-LEARN/evidence/distillation.md'
        )
      );
    const source = resolveLearningSource(
      { '--mission': 'MSN-LEARN' },
      { tier: 'confidential', tenant_slug: 'synthetic-learn' }
    );
    expect(source).toEqual({
      sourceRef: 'active/missions/confidential/synthetic-learn/MSN-LEARN/evidence/distillation.md',
      scope: { tier: 'confidential', tenant_slug: 'synthetic-learn', mission_id: 'MSN-LEARN' },
    });
    const reads = exists.mock.calls.length;
    expect(() =>
      resolveLearningSource(
        { '--mission': 'MSN-OTHER' },
        { tier: 'confidential', tenant_slug: 'synthetic-learn', mission_id: 'MSN-LEARN' }
      )
    ).toThrow('LEARNING_SOURCE_SCOPE');
    expect(exists.mock.calls).toHaveLength(reads);
  });

  it('hands off only the explicitly selected candidate into review and does not accept a new source while queueing', async () => {
    await runLearningPrepare([
      '--queue',
      '--candidate',
      'DSC-LEARN-example',
      '--dry-run',
      '--json',
    ]);
    expect(selected.queue).toHaveBeenCalledWith(
      'DSC-LEARN-example',
      { tier: 'public' },
      { dryRun: true }
    );
    expect(selected.prepare).not.toHaveBeenCalled();
    selected.queue.mockClear();
    await runLearningPrepare([
      '--queue',
      '--candidate',
      'DSC-LEARN-example',
      '--input',
      'material.md',
    ]);
    expect(selected.queue).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('requires exactly one material source', () => {
    expect(() => resolveLearningSource({}, { tier: 'public' })).toThrow('exactly one');
    expect(() =>
      resolveLearningSource({ '--input': 'a', '--run': 'b' }, { tier: 'public' })
    ).toThrow('exactly one');
  });
});
