import { describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile } from '../secure-io.js';
import {
  assertScheduledContextAdmissible,
  RUNNER_DERIVED_CONTEXT_KEYS,
  runnerDerivedContextKeys,
} from './pipeline-scheduler.js';

describe('pipeline caller context', () => {
  it('names the runner-derived keys a caller context sets', () => {
    expect(
      runnerDerivedContextKeys({
        topic: 'weekly',
        tenant_slug: 'alpha-team',
        mission_id: 'MSN-1',
        mission_tier: 'confidential',
        _knowledge_scope: { tiers: ['confidential'] },
        __private: 1,
      })
    ).toEqual(['__private', '_knowledge_scope', 'mission_tier']);
    expect(runnerDerivedContextKeys({ topic: 'weekly', mission_id: 'MSN-1' })).toEqual([]);
    expect(runnerDerivedContextKeys(undefined)).toEqual([]);
  });

  it('does not count a key the pipeline declares in its own context', () => {
    const declared = { mission_evidence_dir: 'active/shared/tmp/evidence' };
    expect(runnerDerivedContextKeys({ mission_evidence_dir: 'x' }, declared)).toEqual([]);
    expect(runnerDerivedContextKeys({ mission_dir: 'x' }, declared)).toEqual(['mission_dir']);
  });

  it('refuses a stored schedule context that sets runner-derived keys', () => {
    expect(() =>
      assertScheduledContextAdmissible('nightly', { _knowledge_scope: {}, mission_dir: 'x' })
    ).toThrow(
      /\[SCHEDULE_CONTEXT_RESERVED\] schedule 'nightly' was not run — .* \| next: .* \| evidence: keys=_knowledge_scope,mission_dir/u
    );
    expect(() => assertScheduledContextAdmissible('nightly', { topic: 'weekly' })).not.toThrow();
    expect(() => assertScheduledContextAdmissible('nightly', undefined)).not.toThrow();
    // A sync-managed schedule carries its pipeline's own context: admitted.
    expect(() =>
      assertScheduledContextAdmissible(
        'followup',
        { mission_evidence_dir: 'evidence' },
        { mission_evidence_dir: 'evidence' }
      )
    ).not.toThrow();
  });

  it('covers every key the pipeline engine lists as engine-internal', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/pipeline-execution-part-control.ts'), {
        encoding: 'utf8',
      })
    );
    const block = source.match(
      /ENGINE_INTERNAL_CONTEXT_KEYS: ReadonlySet<string> = new Set\(\[([^\]]+)\]\)/u
    );
    expect(block).not.toBeNull();
    const engineKeys = [...block![1].matchAll(/'([^']+)'/gu)].map((match) => match[1]);
    expect(engineKeys.length).toBeGreaterThan(5);
    for (const key of engineKeys) expect(RUNNER_DERIVED_CONTEXT_KEYS.has(key), key).toBe(true);
  });
});
