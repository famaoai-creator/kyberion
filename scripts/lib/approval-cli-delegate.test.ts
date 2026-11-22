import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import { delegateApprovalToCharter } from './approval-cli-delegate.js';

const { withLocalAuthorityPrincipal, previewOnboardingAuthority, requestOnboardingAuthority } =
  vi.hoisted(() => ({
    withLocalAuthorityPrincipal: vi.fn(
      (_argv: string[], run: (p: unknown) => unknown, _msg?: unknown) =>
        run({
          requesterId: 'cli:test',
          accountableId: 'user:owner-1',
          personalOwner: true,
          tenantSlugs: 'all',
        })
    ),
    previewOnboardingAuthority: vi.fn((_principal: unknown, _input: Record<string, unknown>) => ({
      digest: 'digest-1',
      base_hash: 'base-1',
      statement: 'Grant vcs:pr_create\nExpires: later',
    })),
    requestOnboardingAuthority: vi.fn(
      (_principal: unknown, _input: Record<string, unknown>, _binding: unknown) => ({
        request_id: 'plan-req-1',
      })
    ),
  }));

vi.mock('./authority-principal.js', () => ({ withLocalAuthorityPrincipal }));
vi.mock('./installed-identity.js', () => ({
  canonicalAuthorityCommand: (root: string, argv: string[]) =>
    `cd ${root} && pnpm onboarding authority ${argv.join(' ')}`,
}));
vi.mock('@agent/core/organization/onboarding-authority', () => ({
  previewOnboardingAuthority,
  requestOnboardingAuthority,
}));

const TARGET = {
  operation_id: 'vcs:pr_create',
  repository: 'https://github.com/acme/widgets',
} as const;

const request = (overrides: Partial<ApprovalRequestRecord> = {}) =>
  ({ id: 'req-1', subject: 'vcs:pr_create', ...overrides }) as ApprovalRequestRecord;

const lines = (out: string[] = []) => ({ out, print: (l: string) => out.push(l) });

describe('delegateApprovalToCharter', () => {
  it('refuses when the request carries no delegation target', () => {
    const { out, print } = lines();
    const result = delegateApprovalToCharter(request(), undefined, print);
    expect(result.ok).toBe(false);
    expect(out.join('\n')).toContain('not registered as a charter-delegable operation');
    expect(withLocalAuthorityPrincipal).not.toHaveBeenCalled();
  });

  it('refuses when the stored target fails registry re-validation', () => {
    const { out, print } = lines();
    const result = delegateApprovalToCharter(
      request({ delegation_target: { operation_id: 'not:real' } as never }),
      undefined,
      print
    );
    expect(result.ok).toBe(false);
    expect(out.join('\n')).toContain('failed re-validation');
    expect(withLocalAuthorityPrincipal).not.toHaveBeenCalled();
  });

  it.each(['not-a-date', '2000-01-01', '2999-01-01'])(
    'refuses an out-of-bounds --expires-at (%s)',
    (value) => {
      const { out, print } = lines();
      const result = delegateApprovalToCharter(
        request({ delegation_target: { ...TARGET } }),
        value,
        print
      );
      expect(result.ok).toBe(false);
      expect(withLocalAuthorityPrincipal).not.toHaveBeenCalled();
    }
  );

  it('composes a person-scope plan with a ~90 day default expiry', () => {
    const { print } = lines();
    const before = Date.now();
    const result = delegateApprovalToCharter(
      request({ delegation_target: { ...TARGET } }),
      undefined,
      print
    );
    expect(result.ok).toBe(true);
    const input = previewOnboardingAuthority.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(input).toMatchObject({ scope_kind: 'person', mode: 'grant', grants: [TARGET] });
    const expires = Date.parse(String(input.expires_at));
    expect(expires - before).toBeGreaterThan(89 * 86_400_000);
    expect(expires - before).toBeLessThanOrEqual(90 * 86_400_000);
    expect(requestOnboardingAuthority).toHaveBeenCalledWith(expect.anything(), input, {
      digest: 'digest-1',
      base_hash: 'base-1',
    });
  });

  it('derives organization scope from request.scope.tenant_slug', () => {
    const { print } = lines();
    delegateApprovalToCharter(
      request({
        delegation_target: { ...TARGET },
        scope: { kind: 'organization', tenant_slug: 'acme' } as never,
      }),
      '2027-06-01',
      print
    );
    const input = previewOnboardingAuthority.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(input).toMatchObject({ scope_kind: 'organization', tenant_slug: 'acme' });
  });
});
