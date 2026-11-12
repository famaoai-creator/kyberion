import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withExecutionContext: vi.fn((_role: string, fn: () => unknown) => fn()),
}));

vi.mock('@agent/core/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/authority')>()),
  // S4: store facades open their declared store grant (withStoreGrant).
  withStoreGrant: (_name: string, fn: () => unknown) => fn(),
  withStoreGrantAsync: async (_name: string, fn: () => unknown) => fn(),
  withExecutionContext: mocks.withExecutionContext,
}));

import {
  ViewerContextError,
  resolveViewerTierAccess,
  strictViewerScopeOrganizationIds,
  strictViewerScopeTenantSlugs,
  strictViewerTier,
  toSurfaceAuthorizationContext,
  viewerCanReadTier,
  viewerErrorResponse,
  viewerScopeTenantSlugs,
  withOpsViewerDefaults,
  withViewerExecutionContext,
  type ViewerContext,
} from './ops-viewer';
import {
  ConciergeViewerError,
  toSurfaceAuthorizationContext as toConciergeAuthorizationContext,
} from '../viewer-context';

const scoped: ViewerContext = {
  role: 'readonly',
  tenantSlugs: ['acme'],
  organizationIds: ['org-a'],
  tierAccess: ['public'],
  source: 'token',
  principalId: 'human:a',
};

describe('operations viewer helpers (one viewer model)', () => {
  it('raises the Concierge viewer error type', () => {
    expect(ViewerContextError).toBe(ConciergeViewerError);
  });

  it('preserves an empty server permission replacement separately from role defaults', () => {
    expect(toSurfaceAuthorizationContext(scoped).permissions).toBeUndefined();
    expect(toSurfaceAuthorizationContext({ ...scoped, permissions: [] }).permissions).toEqual([]);
  });

  it('narrows but never widens the tenant set', () => {
    expect(strictViewerScopeTenantSlugs(scoped, 'acme')).toEqual(['acme']);
    expect(strictViewerScopeTenantSlugs(scoped)).toEqual(['acme']);
    expect(() => strictViewerScopeTenantSlugs(scoped, 'globex')).toThrow(ConciergeViewerError);
    expect(() => viewerScopeTenantSlugs(scoped, 'globex')).toThrow(/viewer tenant scope denied/);
    expect(viewerScopeTenantSlugs({ ...scoped, tenantSlugs: 'all' }, 'globex')).toEqual(['globex']);
  });

  it('narrows organizations and tiers within the viewer', () => {
    expect(strictViewerScopeOrganizationIds(scoped, 'org-a')).toEqual(['org-a']);
    expect(() => strictViewerScopeOrganizationIds(scoped, 'org-b')).toThrow(ConciergeViewerError);
    expect(strictViewerTier(scoped, 'public')).toBe('public');
    expect(() => strictViewerTier(scoped, 'confidential')).toThrow(ConciergeViewerError);
  });

  it('denies explicit empty tier caps while retaining omitted defaults and nonempty caps', () => {
    for (const role of ['readonly', 'localadmin'] as const) {
      const empty = { ...scoped, role, tierAccess: [] };
      for (const tier of ['public', 'confidential', 'personal'] as const) {
        expect(() => strictViewerTier(empty, tier)).toThrow(ConciergeViewerError);
      }

      const omitted = { ...scoped, role, tierAccess: undefined };
      expect(strictViewerTier(omitted, 'public')).toBe('public');
      expect(strictViewerTier(omitted, 'confidential')).toBe('confidential');
      expect(() => strictViewerTier(omitted, 'personal')).toThrow(ConciergeViewerError);

      const narrowed: ViewerContext = { ...scoped, role, tierAccess: ['public'] };
      expect(strictViewerTier(narrowed, 'public')).toBe('public');
      expect(() => strictViewerTier(narrowed, 'confidential')).toThrow(ConciergeViewerError);
    }
  });

  it('never exposes the personal tier', () => {
    expect(resolveViewerTierAccess('localadmin')).not.toContain('personal');
    expect(() => resolveViewerTierAccess('localadmin', ['personal'])).toThrow(ConciergeViewerError);
    expect(
      toSurfaceAuthorizationContext({ ...scoped, tierAccess: undefined }).tierAccess
    ).not.toContain('personal');
  });

  it('projects through the Concierge projection: personal masked, defaults stated once', () => {
    // The console projection used to pass an explicit `personal` through; it
    // now masks it like every other Concierge route.
    const personal: ViewerContext = {
      ...scoped,
      role: 'localadmin',
      tierAccess: ['personal', 'confidential', 'public'],
    };
    expect(toSurfaceAuthorizationContext(personal).tierAccess).toEqual(['confidential', 'public']);
    expect(viewerCanReadTier(personal, 'personal')).toBe(false);
    expect(viewerCanReadTier(personal, 'confidential')).toBe(true);
    expect(() => strictViewerTier(personal, 'personal')).toThrow(ConciergeViewerError);
    expect(toSurfaceAuthorizationContext(personal)).toEqual(
      toConciergeAuthorizationContext(withOpsViewerDefaults(personal))
    );
    // Omitted lists: unrestricted within the tenant set, role-default tiers.
    const bare: ViewerContext = { role: 'readonly', tenantSlugs: ['acme'], source: 'token' };
    expect(withOpsViewerDefaults(bare)).toMatchObject({
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['public', 'confidential'],
    });
    // A stated list is never replaced by a default.
    expect(toSurfaceAuthorizationContext(scoped)).toMatchObject({
      tenantSlugs: ['acme'],
      organizationIds: ['org-a'],
      projectIds: 'all',
      tierAccess: ['public'],
    });
  });

  it('answers with the Concierge error body and the console fallback status', async () => {
    expect(viewerErrorResponse(new ConciergeViewerError(401, 'unknown')).status).toBe(401);
    expect(viewerErrorResponse(new ConciergeViewerError(403, 'denied'), 404).status).toBe(404);
    // No authorization status on the error: the console answers 403, not 500,
    // and the body's code is the error's own (full table: viewer-error-response.test.ts).
    const fallback = viewerErrorResponse(new Error('boom'));
    expect(fallback.status).toBe(403);
    expect(await fallback.json()).toMatchObject({ ok: false, error_code: 'internal' });
    expect(viewerErrorResponse(new Error('boom'), 500).status).toBe(500);
  });

  it('carries the server-resolved system selection into the authorization context', () => {
    const system = { ...scoped, tenantSlugs: [] as string[], includeUntenanted: true };
    expect(toSurfaceAuthorizationContext(system)).toMatchObject({
      tenantSlugs: [],
      includeUntenanted: true,
    });
    expect(toSurfaceAuthorizationContext(scoped)).not.toHaveProperty('includeUntenanted');
  });

  it('runs reads under the console execution roles with the single tenant bound', () => {
    withViewerExecutionContext(scoped, () => 1);
    expect(mocks.withExecutionContext).toHaveBeenLastCalledWith(
      'chronos_operator',
      expect.any(Function),
      undefined,
      'acme'
    );
    withViewerExecutionContext({ ...scoped, role: 'localadmin', tenantSlugs: 'all' }, () => 1);
    expect(mocks.withExecutionContext).toHaveBeenLastCalledWith(
      'chronos_localadmin',
      expect.any(Function),
      undefined,
      undefined
    );
  });
});
