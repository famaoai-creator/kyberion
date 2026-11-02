import { describe, it, expect, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
vi.mock('../fs-primitives.js', async (original) => {
  const actual = await original<typeof import('../fs-primitives.js')>();
  const tenant = (file: string) =>
    String(file).match(
      /knowledge\/personal\/tenants\/(acme|heuristics|heuristics-acme)\.json$/u
    )?.[1];
  return {
    ...actual,
    rawExistsSync: (file: string) => !!tenant(file) || actual.rawExistsSync(file),
    rawReadTextFile: (file: string) =>
      tenant(file)
        ? JSON.stringify({ tenant_slug: tenant(file), status: 'active' })
        : actual.rawReadTextFile(file),
  };
});
vi.mock('../secure-io.js', async (original) => {
  const actual = await original<typeof import('../secure-io.js')>();
  return {
    ...actual,
    assertSafeRepositoryPath: (file: string) => pathResolver.rootResolve(file),
    safeExistsSync: () => true,
    safeReadFile: () => 'exact confidential bytes',
  };
});
vi.mock('../knowledge/memory-promotion-git.js', () => ({
  resolvePromotionTargetRoot: (root: string) => ({ root }),
}));
vi.mock('../scope-context.js', async (original) => ({
  ...(await original<typeof import('../scope-context.js')>()),
  resolveScopeContext: () => ({ tier: 'confidential', tenant_slug: 'acme' }),
}));
vi.mock('../scope-envelope.js', async (original) => ({
  ...(await original<typeof import('../scope-envelope.js')>()),
  currentScopeEnvelope: () => undefined,
}));
vi.mock('../foundation/execution-scope.js', async (original) => ({
  ...(await original<typeof import('../foundation/execution-scope.js')>()),
  currentExecutionScope: () => undefined,
}));
vi.mock('../vcs/publication-host.js', () => ({ runVcsMutationWithApproval: vi.fn() }));
import {
  publicationBodySourceTier,
  runVcsMutationWithWorktreeGovernance,
  PR_GOVERNANCE_CHILD,
} from './governance-host.js';
import { withPrPublicationBodySource } from './github.js';
describe('trusted publication body provenance', () => {
  it.each([
    ['knowledge/confidential/heuristics/review.md', 'protected_or_unknown'],
    ['knowledge/confidential/tenant-groups/review.md', 'protected_or_unknown'],
    ['knowledge/confidential/relationships/review.md', 'protected_or_unknown'],
    ['knowledge/confidential/common/review.md', 'protected_or_unknown'],
    ['knowledge/confidential/tenants/index.json', 'protected_or_unknown'],
    [
      'knowledge/confidential/heuristics-acme/review.md',
      { tier: 'confidential', tenantSlug: 'heuristics-acme' },
    ],
    ['knowledge/public/review.md', 'public'],
    ['knowledge/personal/review.md', { tier: 'personal' }],
    ['knowledge/confidential/acme/review.md', { tier: 'confidential', tenantSlug: 'acme' }],
    [
      'active/shared/artifacts/confidential/acme/review.md',
      { tier: 'confidential', tenantSlug: 'acme' },
    ],
    ['active/shared/artifacts/personal/shared/review.md', { tier: 'personal' }],
    ['active/shared/artifacts/public/shared/review.md', 'public'],
    ['active/shared/artifacts/confidential/shared/review.md', 'protected_or_unknown'],
    ['active/shared/artifacts/personal/acme/review.md', 'protected_or_unknown'],
    ['active/shared/tmp/review.md', 'protected_or_unknown'],
    ['docs/review.md', 'protected_or_unknown'],
  ] as const)('classifies only canonical proven sources: %s', (file, expected) => {
    expect(publicationBodySourceTier(file)).toEqual(expected);
  });
  it('preserves concrete tenant provenance and frozen bytes across worktree transport despite caller hint', () => {
    let payload:
      | {
          bodySourceTier: unknown;
          mutation: { params: { body: string; bodyFile?: string } };
          sourceScope: unknown;
        }
      | undefined;
    const result = runVcsMutationWithWorktreeGovernance(
      {
        operation: 'pr_create',
        params: {
          cwd: pathResolver.rootDir(),
          title: 'test',
          bodyFile: 'knowledge/confidential/acme/review.md',
        },
      },
      'effect-one',
      () => {},
      {
        governanceRoot: '/canonical-governance',
        bodySourceTier: 'public',
        transport: (input) => {
          payload = JSON.parse(input.payload);
          return {
            status: 0,
            stderr: '',
            stdout:
              'KYBERION_PR_GOVERNANCE_RESULT:' +
              JSON.stringify({
                ok: true,
                result: { status: 0, stdout: 'created', stderr: '' },
                lines: [],
              }),
          };
        },
      }
    );
    expect(result.status).toBe(0);
    expect(payload?.bodySourceTier).toEqual({ tier: 'confidential', tenantSlug: 'acme' });
    expect(payload?.mutation.params.body).toBe('exact confidential bytes');
    expect(payload?.mutation.params.bodyFile).toBeUndefined();
    expect(payload?.sourceScope).toEqual({ tier: 'confidential', tenant_slug: 'acme' });
    expect(PR_GOVERNANCE_CHILD).toContain('withPrPublicationBodySource(input.bodySourceTier');
  });
  it('rejects malformed transported tenant marker', () => {
    expect(() =>
      withPrPublicationBodySource({ tier: 'confidential', tenantSlug: 'public' }, () => {})
    ).toThrow('PROVENANCE_INVALID');
  });
});
