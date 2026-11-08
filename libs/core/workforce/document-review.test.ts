import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  unknownSources: new Set<string>(),
  sourceScopes: new Map<
    string,
    { tier: 'public' | 'confidential' | 'personal'; tenant?: string }
  >(),
  generate: vi.fn(),
  egress: vi.fn(),
  envelope: undefined as
    | undefined
    | {
        policy: {
          read_tiers: string[];
          external_egress?: string;
          allowed_reasoning_backends?: string[];
        };
      },
}));
vi.mock('../path-resolver.js', () => ({
  pathResolver: {
    rootDir: () => '/fixture',
    toRepoRelative: (value: string) => value.slice('/fixture/'.length),
  },
}));
vi.mock('../secure-io.js', () => ({
  assertSafeRepositoryPath: (value: string) => {
    if (!value.startsWith('/fixture/')) throw new Error('Outside repository');
    return value;
  },
  safeRealpath: (value: string) =>
    value.endsWith('link.md') ? '/fixture/knowledge/personal/secret.md' : value,
  safeReadFileSnapshot: (value: string, maxBytes: number) => {
    const text = mocks.files.get(value);
    if (text === undefined) throw new Error('Read denied');
    const raw = Buffer.from(text);
    if (raw.length > maxBytes) throw new Error('Input too large');
    return raw;
  },
}));
vi.mock('../tier-guard.js', () => ({
  detectTier: (value: string) =>
    value.includes('/personal/')
      ? 'personal'
      : value.includes('/confidential/')
        ? 'confidential'
        : 'public',
}));
vi.mock('../storage/scratch-promotion.js', () => ({
  isUnknownTierSource: (value: string) => mocks.unknownSources.has(value),
  classifyPromotionSourceScope: (value: string) => {
    if (mocks.sourceScopes.has(value)) return mocks.sourceScopes.get(value);
    const match = /^knowledge\/(personal|confidential)\/([^/]+)\//iu.exec(value);
    return match
      ? {
          tier: match[1].toLowerCase(),
          tenant: match[1].toLowerCase() === 'confidential' ? match[2] : undefined,
        }
      : null;
  },
}));
vi.mock('../storage-layout.js', () => ({ tenantRuntimePartitionOf: () => undefined }));
vi.mock('../scope-envelope.js', () => ({ currentScopeEnvelope: () => mocks.envelope }));
vi.mock('../provider/isolated-text-generator.js', () => ({
  resolveIsolatedTextGenerator: (id: string) => {
    if (id !== 'claude') throw new Error('Unregistered generator');
    return {
      id,
      reasoningBackend: 'claude-agent',
      isolation: 'structural',
      generate: mocks.generate,
    };
  },
}));
vi.mock('../reasoning/reasoning-egress-scope.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const storage = new AsyncLocalStorage();
  return {
    assertReasoningEgressAllowed: mocks.egress,
    getReasoningPayloadScope: () => storage.getStore(),
    withReasoningPayloadScope: (scope: unknown, fn: () => unknown) => storage.run(scope, fn),
  };
});
import { runDocumentReview } from './document-review.js';
import {
  getReasoningPayloadScope,
  withReasoningPayloadScope,
} from '../reasoning/reasoning-egress-scope.js';

function result(input: { userPrompt: string }) {
  const { reviewer, snapshots } = JSON.parse(input.userPrompt);
  const criteria: Record<string, string[]> = {
    readiness: [
      'file_boundaries',
      'interfaces',
      'invariants',
      'errors',
      'incremental_phases',
      'acceptance_tests',
    ],
    drift: ['requirement_coverage', 'implementation_consistency'],
  };
  const evidence = snapshots[snapshots.length - 1];
  return {
    findings: [],
    ...(criteria[reviewer]
      ? {
          checks: criteria[reviewer].map((criterion) => ({
            criterion,
            status: 'verified',
            explanation: 'Verified against the supplied snapshot.',
            finding_issue_keys: [],
            citations: [{ path: evidence.path, sha256: evidence.sha256, quote: evidence.content }],
          })),
        }
      : {}),
    ...(reviewer === 'comprehension'
      ? {
          paraphrase: {
            proposal: 'Adds delivery retries.',
            current_system: 'Currently returns failures.',
          },
        }
      : {}),
    ...(reviewer === 'code_contract'
      ? {
          contracts: snapshots.map((item: { path: string; sha256: string; content: string }) => ({
            path: item.path,
            summary: 'A handler.',
            interface: ['handle'],
            invariants: [],
            side_effects: [],
            citations: [{ path: item.path, sha256: item.sha256, quote: item.content }],
          })),
        }
      : {}),
  };
}
function finding(input: { userPrompt: string }, changes: Record<string, unknown> = {}) {
  const item = JSON.parse(input.userPrompt).snapshots[0];
  return {
    severity: 'blocking',
    category: 'comprehension',
    description: 'Retry exhaustion is undefined.',
    semantic_scope: 'Delivery',
    issue_key: 'exhaustion',
    citations: [{ path: item.path, sha256: item.sha256, quote: 'delivery' }],
    ...changes,
  };
}
beforeEach(() => {
  mocks.files.clear();
  mocks.unknownSources.clear();
  mocks.sourceScopes.clear();
  mocks.generate.mockReset();
  mocks.egress.mockReset();
  mocks.envelope = undefined;
  mocks.files.set('/fixture/spec.md', 'Add delivery retries. Current system returns failures.');
  mocks.files.set('/fixture/reference.md', 'Domain: delivery means sending one event.');
  mocks.files.set('/fixture/source.ts', 'export function handle() { return false; }');
  mocks.generate.mockImplementation(async (input) => result(input));
});
afterEach(() => vi.useRealTimers());

describe('bounded document review', () => {
  it('injects only explicit document/reference snapshots into comprehension, never sources or parent history', async () => {
    const report = await runDocumentReview({
      target: 'spec.md',
      references: ['reference.md'],
      sources: ['source.ts'],
    });
    expect(report.status).toBe('completed');
    expect(report.verdict).toBe('reviewed');
    expect(report.rounds.consecutive_clean_rounds).toBe(1);
    expect(report.reviewers[0]).toMatchObject({
      status: 'completed',
      evidence_kind: 'host_snapshot_injected',
      native_read_evidence: 'not_applicable',
      parent_history: 'not_supplied',
      isolation_probe: 'not_run',
    });
    const prompt = mocks.generate.mock.calls[0][0].userPrompt;
    expect(JSON.parse(prompt).snapshots.map((item: { path: string }) => item.path)).toEqual([
      'spec.md',
      'reference.md',
    ]);
    expect(prompt).not.toContain('source.ts');
    expect(prompt).not.toContain('Mission context');
    expect(report.artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
  it('records cited gaps as blocking without turning completion into approval', async () => {
    mocks.generate.mockImplementation(async (input) => ({
      ...result(input),
      findings: [finding(input)],
    }));
    const report = await runDocumentReview({ target: 'spec.md' });
    expect(Object.keys(report.findings[0]).sort()).toEqual(['category', 'description', 'severity']);
    expect(report.verdict).toBe('changes_requested');
    expect(report.rounds.open_findings).toHaveLength(1);
  });
  it.each(['missing paraphrase', 'wrong hash', 'unread quote', 'unknown path', 'duplicate issue'])(
    'fails closed on %s',
    async (kind) => {
      mocks.generate.mockImplementation(async (input) => {
        const output = result(input);
        if (kind === 'missing paraphrase') return { findings: [] };
        const gap = finding(input);
        if (kind === 'wrong hash') gap.citations[0].sha256 = 'a'.repeat(64);
        if (kind === 'unread quote') gap.citations[0].quote = 'parent-only-secret';
        if (kind === 'unknown path') gap.citations[0].path = 'elsewhere.md';
        return { ...output, findings: kind === 'duplicate issue' ? [gap, gap] : [gap] };
      });
      const run = runDocumentReview({ target: 'spec.md' });
      {
        const report = await run;
        expect(report.status).toBe('incomplete');
        expect(report.reviewers[0].status).toBe('not_run');
        expect(report.reviewers[0].findings).toEqual([]);
        expect(report.rounds.clean).toBe(false);
      }
    }
  );
  it('does not count a throwing or empty provider as a zero-finding reviewer', async () => {
    for (const value of [undefined, '']) {
      mocks.generate.mockResolvedValue(value);
      const report = await runDocumentReview({ target: 'spec.md' });
      expect(report.verdict).toBe('incomplete');
      expect(report.rounds.clean).toBe(false);
    }
    mocks.generate.mockRejectedValue(new Error('Provider unavailable'));
    expect((await runDocumentReview({ target: 'spec.md' })).reviewers[0].failure).toBe(
      'generator_failed'
    );
  });
  it('uses one total deadline, aborts and marks all unfinished lenses not_run', async () => {
    vi.useFakeTimers();
    mocks.generate.mockImplementation(() => new Promise(() => {}));
    const pending = runDocumentReview({
      target: 'spec.md',
      sources: ['source.ts'],
      preset: 'design',
      timeout_ms: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const report = await pending;
    expect(report.reviewers).toHaveLength(4);
    expect(report.reviewers.every((item) => item.status === 'not_run')).toBe(true);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate.mock.calls[0][0].abortController.signal.aborted).toBe(true);
  });
  it('design preset includes readiness, drift and evidenced source contract summaries', async () => {
    const report = await runDocumentReview({
      target: 'spec.md',
      sources: ['source.ts'],
      preset: 'design',
    });
    expect(report.status).toBe('completed');
    expect(report.reviewers.map((item) => item.reviewer)).toEqual([
      'comprehension',
      'readiness',
      'drift',
      'code_contract',
    ]);
    expect(report.reviewers[3].contracts?.[0]).toMatchObject({
      path: 'source.ts',
      invariants: [],
      side_effects: [],
    });
  });
  it('binds convergence to sources/references and configuration as well as the document', async () => {
    const input = {
      target: 'spec.md',
      references: ['reference.md'],
      sources: ['source.ts'],
      preset: 'design' as const,
    };
    const before = await runDocumentReview(input);
    mocks.files.set('/fixture/source.ts', 'export function handle() { return true; }');
    const after = await runDocumentReview(input);
    expect(before.artifact.sha256).toBe(after.artifact.sha256);
    expect(before.review_sha256).not.toBe(after.review_sha256);
    mocks.files.set('/fixture/reference.md', 'delivery has a revised contract');
    expect((await runDocumentReview(input)).review_sha256).not.toBe(after.review_sha256);
  });
  it.each(['readiness', 'drift'])(
    'does not count an empty %s review as completed coverage',
    async (reviewer) => {
      mocks.generate.mockImplementation(async (input) =>
        JSON.parse(input.userPrompt).reviewer === reviewer ? { findings: [] } : result(input)
      );
      const report = await runDocumentReview({
        target: 'spec.md',
        sources: ['source.ts'],
        preset: 'design',
      });
      expect(report.reviewers.find((item) => item.reviewer === reviewer)?.status).toBe('not_run');
      expect(report.status).toBe('incomplete');
      expect(report.rounds.clean).toBe(false);
    }
  );
  it('requires source snapshots before running design review', async () => {
    await expect(runDocumentReview({ target: 'spec.md', preset: 'design' })).rejects.toThrow(
      'SOURCES_REQUIRED'
    );
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('drift requires cited source rather than a second document citation', async () => {
    mocks.generate.mockImplementation(async (input) => {
      const value = result(input);
      const data = JSON.parse(input.userPrompt);
      if (data.reviewer !== 'drift') return value;
      const reference = data.snapshots.find(
        (item: { path: string }) => item.path === 'reference.md'
      );
      const gap = finding(input, { drift_kind: 'missing_feature' });
      gap.citations.push({ path: reference.path, sha256: reference.sha256, quote: 'delivery' });
      return { ...value, findings: [gap] };
    });
    const report = await runDocumentReview({
      target: 'spec.md',
      references: ['reference.md'],
      sources: ['source.ts'],
      preset: 'design',
    });
    expect(report.reviewers.find((item) => item.reviewer === 'drift')?.status).toBe('not_run');
  });
  it('rejects denied, symlinked, non-text, oversized and outside inputs before generation', async () => {
    mocks.files.set('/fixture/binary.md', 'a\0b');
    mocks.files.set('/fixture/large.md', 'x'.repeat(65537));
    for (const target of ['missing.md', 'link.md', 'binary.md', 'large.md', '../outside.md'])
      await expect(runDocumentReview({ target })).rejects.toThrow();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('enforces aggregate size and input configuration limits', async () => {
    for (const ref of ['a.md', 'b.md', 'c.md'])
      mocks.files.set('/fixture/' + ref, 'x'.repeat(50000));
    await expect(
      runDocumentReview({ target: 'a.md', references: ['b.md', 'c.md'] })
    ).rejects.toThrow('BUDGET');
    await expect(
      runDocumentReview({ target: 'spec.md', references: Array(17).fill('reference.md') })
    ).rejects.toThrow();
    await expect(runDocumentReview({ target: 'spec.md', timeout_ms: 0 })).rejects.toThrow();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it.each([
    'active/shared/tmp/inbound/customer.md',
    'active/shared/staging/inbound/customer.md',
    'active/missions/legacy/notes.md',
  ])('rejects unclassified %s before reading or model dispatch', async (target) => {
    mocks.unknownSources.add(target);
    // No readable fixture exists: classification must fail before attempting content I/O.
    await expect(runDocumentReview({ target })).rejects.toThrow('DOCUMENT_REVIEW_SCOPE_UNKNOWN');
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('accepts explicitly partitioned public input', async () => {
    const target = 'active/shared/tmp/public/shared/notes.md';
    mocks.files.set('/fixture/' + target, 'Public delivery design');
    expect((await runDocumentReview({ target })).status).toBe('completed');
  });
  it.each([
    'knowledge/Confidential/tenant-a/spec.md',
    'active/archive/missions/confidential/tenant-a/MSN-EXAMPLE/spec.md',
  ])('preserves private source classification for %s', async (target) => {
    mocks.files.set('/fixture/' + target, 'Private delivery design');
    mocks.sourceScopes.set(target, { tier: 'confidential', tenant: 'tenant-a' });
    await expect(
      withReasoningPayloadScope({ tier: 'public', tenant_slug: 'tenant-a' }, () =>
        runDocumentReview({ target })
      )
    ).rejects.toThrow('DOCUMENT_REVIEW_SCOPE_MISMATCH');
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('never lowers a private path into an absent or public payload scope', async () => {
    mocks.files.set('/fixture/knowledge/confidential/tenant-a/spec.md', 'Private delivery');
    const input = { target: 'knowledge/confidential/tenant-a/spec.md' };
    await expect(runDocumentReview(input)).rejects.toThrow('SCOPE_REQUIRED');
    await expect(
      withReasoningPayloadScope({ tier: 'public' }, () => runDocumentReview(input))
    ).rejects.toThrow('SCOPE_MISMATCH');
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('rejects cross-tenant private inputs even under an ambient broker read', async () => {
    mocks.files.set('/fixture/knowledge/confidential/tenant-b/spec.md', 'Private delivery');
    await expect(
      withReasoningPayloadScope(
        { tier: 'confidential', tenant_slug: 'tenant-a', training_use: 'no_training' },
        () => runDocumentReview({ target: 'knowledge/confidential/tenant-b/spec.md' })
      )
    ).rejects.toThrow('SCOPE_MISMATCH');
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('preserves stronger ambient privacy, deny-only task limits and attachment scope', async () => {
    let observed: unknown;
    mocks.generate.mockImplementation(async (input) => {
      observed = getReasoningPayloadScope();
      return result(input);
    });
    mocks.envelope = {
      policy: {
        read_tiers: ['public', 'confidential'],
        external_egress: 'deny',
        allowed_reasoning_backends: ['claude-agent'],
      },
    };
    const report = await withReasoningPayloadScope(
      {
        tier: 'confidential',
        tenant_slug: 'tenant-a',
        training_use: 'no_training',
        allowed_reasoning_backends: ['claude-agent', 'codex-cli'],
      },
      () => runDocumentReview({ target: 'spec.md' })
    );
    expect(report.effective_tier).toBe('confidential');
    expect(report.tenant_slug).toBe('tenant-a');
    expect(observed).toMatchObject({
      tier: 'confidential',
      training_use: 'no_training',
      external_egress: 'deny',
      allowed_reasoning_backends: ['claude-agent'],
      attachment_count: 1,
    });
  });
  it('preflights egress before transport and does not turn a denial into a model failure', async () => {
    mocks.egress.mockImplementation(() => {
      throw new Error('Egress denied');
    });
    await expect(runDocumentReview({ target: 'spec.md' })).rejects.toThrow('Egress denied');
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
