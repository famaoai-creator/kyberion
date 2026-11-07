// The work-inventory scope rule presence-studio's hearing hand-off uses. The
// 業務の自動化候補 panel moved to Concierge 仕事 › 依頼 and is tested there
// (`presence/displays/concierge/src/app/api/work-inventory/candidates/route.test.ts`).
import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  resolveWorkInventoryScopeForViewer,
  workInventoryHandoffHref,
} from './work-inventory-routes.js';
import type { PresenceStudioViewerContext } from './security.js';

describe('resolveWorkInventoryScopeForViewer', () => {
  function viewer(overrides: Partial<PresenceStudioViewerContext>): PresenceStudioViewerContext {
    return { principalId: 'human:test', tenantSlugs: ['acme'], source: 'loopback', ...overrides };
  }

  it('resolves a single-tenant viewer to that tenant scope', () => {
    expect(resolveWorkInventoryScopeForViewer(viewer({ tenantSlugs: ['acme-corp'] }))).toEqual({
      tenant_slug: 'acme-corp',
    });
  });

  it('resolves the local owner (loopback "all" fallback) to the personal scope', () => {
    expect(
      resolveWorkInventoryScopeForViewer(viewer({ tenantSlugs: 'all', source: 'loopback' }))
    ).toEqual({});
  });

  it('resolves a remote "all" viewer to null — no single scope to read', () => {
    expect(
      resolveWorkInventoryScopeForViewer(viewer({ tenantSlugs: 'all', source: 'token' }))
    ).toBeNull();
  });

  it('resolves a loopback viewer with no tenant to the personal scope', () => {
    expect(
      resolveWorkInventoryScopeForViewer(viewer({ tenantSlugs: [], source: 'loopback' }))
    ).toEqual({});
  });

  it('never resolves a non-loopback (remote token) viewer with no tenant to the personal scope', () => {
    expect(
      resolveWorkInventoryScopeForViewer(viewer({ tenantSlugs: [], source: 'token' }))
    ).toBeNull();
  });
});

describe('the 業務の自動化候補 panel left presence-studio', () => {
  it('registers no panel or vocabulary route', () => {
    const read = (file: string) =>
      String(safeReadFile(pathResolver.rootResolve(file), { encoding: 'utf8' }));
    const server = read('presence/displays/presence-studio/server.ts');
    expect(server).not.toContain('registerWorkInventoryRoutes');
    const routes = read('presence/displays/presence-studio/work-inventory-routes.ts');
    expect(routes).not.toContain("'/api/front-desk/work-inventory'");
    expect(routes).not.toContain("'/api/work-inventory-vocabulary'");
  });
});

describe('workInventoryHandoffHref', () => {
  const viewer = (
    overrides: Partial<PresenceStudioViewerContext>
  ): PresenceStudioViewerContext => ({
    principalId: 'human:test',
    tenantSlugs: ['acme'],
    source: 'loopback',
    ...overrides,
  });
  it('selects the personal view for an entry filed under the personal scope', () => {
    expect(
      workInventoryHandoffHref(
        'https://desk.example.test/work?tab=requests',
        viewer({ tenantSlugs: 'all', source: 'loopback' })
      )
    ).toBe('https://desk.example.test/work?tab=requests&tenant=personal');
    expect(
      workInventoryHandoffHref(
        '/work?tab=requests',
        viewer({ tenantSlugs: [], source: 'loopback' })
      )
    ).toBe('/work?tab=requests&tenant=personal');
  });
  it('keeps a tenant-scoped link as it is', () => {
    expect(workInventoryHandoffHref('/work?tab=requests&tenant=acme', viewer({}))).toBe(
      '/work?tab=requests&tenant=acme'
    );
    expect(
      workInventoryHandoffHref('/work?tab=requests', viewer({ tenantSlugs: [], source: 'token' }))
    ).toBe('/work?tab=requests');
  });
});
