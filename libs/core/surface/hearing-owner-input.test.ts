// R1 (MSN-SERVER-CONCIERGE-ASK-20261108): the four core functions that reach
// the personal hearing store decide "the owner of this machine" from the
// explicit `owner` input the surface passes, never from the viewer's
// credential `source`. Each case runs both combinations against the source
// that would have decided it before (`loopback` without owner, `token` with).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ inventory: vi.fn() }));
vi.mock('@agent/core/workforce/work-inventory', async () => ({
  ...(await vi.importActual('@agent/core/workforce/work-inventory')),
  loadWorkInventoryEntry: mocks.inventory,
}));
vi.mock('@agent/core/front-desk-nav', async () => ({
  ...(await vi.importActual('@agent/core/front-desk-nav')),
  readFrontDeskSurfaceUrls: () => ({ concierge: 'https://desk.example.test' }),
}));
import * as path from 'node:path';
import type { HearingRecord } from './hearing.js';
import type { SurfaceViewerScope } from './surface-viewer-scope-contract.js';

// Hermetic: a temporary KYBERION_ROOT (product policy and schemas copied in, as
// presence/displays/concierge/test/hearing-route-harness.ts does); the modules
// are loaded after the root is set so their path resolution is pinned to it.
type Core = typeof import('@agent/core');
let io: Core;
let root = '';
let createHearingRecord: typeof import('./hearing.js').createHearingRecord;
let applyHearingTurn: typeof import('./hearing.js').applyHearingTurn;
let hearingStorageForScope: typeof import('./hearing-storage-access.js').hearingStorageForScope;
let HearingScopeError: typeof import('./hearing-scope.js').HearingScopeError;
let resolveHearingHandoffScope: typeof import('./hearing-scope.js').resolveHearingHandoffScope;
let hearingWorkInventoryHandoffHref: typeof import('./hearing-completion.js').hearingWorkInventoryHandoffHref;
let hearingWorkInventoryScope: typeof import('./hearing-completion.js').hearingWorkInventoryScope;
let readHearingCompletion: typeof import('./hearing-completion.js').readHearingCompletion;

beforeAll(async () => {
  const bootstrap = await import('@agent/core');
  const sourceRoot = bootstrap.pathResolver.rootDir();
  root = path.join(sourceRoot, 'active/shared/tmp', `vitest-hearing-owner-${randomUUID()}`);
  const fixture = (await import(
    /* @vite-ignore */ path.join(sourceRoot, 'scripts/fixtures/first-job-approval-fixture.ts')
  )) as { seedFirstJobTestRoot(sourceRoot: string, root: string): void };
  fixture.seedFirstJobTestRoot(sourceRoot, root);
  bootstrap.safeMkdir(path.join(root, 'knowledge/public/common'), { recursive: true });
  bootstrap.safeCopyFileSync(
    path.join(sourceRoot, 'knowledge/public/common/project_standards.json'),
    path.join(root, 'knowledge/public/common/project_standards.json')
  );
  vi.stubEnv('KYBERION_ROOT', root);
  vi.resetModules();
  io = await import('@agent/core');
  ({ createHearingRecord, applyHearingTurn } = await import('./hearing.js'));
  ({ hearingStorageForScope } = await import('./hearing-storage-access.js'));
  ({ HearingScopeError, resolveHearingHandoffScope } = await import('./hearing-scope.js'));
  ({ hearingWorkInventoryHandoffHref, hearingWorkInventoryScope, readHearingCompletion } =
    await import('./hearing-completion.js'));
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  const bootstrap = await import('@agent/core');
  if (root) bootstrap.safeRmSync(root, { recursive: true, force: true });
});

const TENANT = 'zz-hearing-owner-input';

function viewer(patch: Partial<SurfaceViewerScope>): SurfaceViewerScope {
  return {
    role: 'localadmin',
    tenantSlugs: 'all',
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential', 'public'],
    source: 'token',
    principalId: 'human:owner-input-test',
    ...patch,
  };
}

// The whole temporary root is removed in afterAll.
beforeEach(() => {
  mocks.inventory.mockReset();
});

describe('hearingStorageForScope owner input', () => {
  it.each([
    ['loopback', 'all'],
    ['loopback', []],
    ['token', 'all'],
  ] as const)(
    'refuses the personal store to a non-owner even with source %s (%j)',
    (source, tenantSlugs) => {
      const storage = () =>
        hearingStorageForScope(viewer({ source, tenantSlugs: tenantSlugs as string[] | 'all' }), {
          owner: false,
        });
      expect(storage).toThrow('Personal hearing storage requires a local owner session.');
    }
  );

  it('opens the personal store to the owner whatever the credential source', () => {
    for (const source of ['token', 'anonymous', 'loopback'] as const) {
      const storage = hearingStorageForScope(viewer({ source }), { owner: true });
      expect(storage.namespace).toBe('all');
      expect(storage.load('owner-' + randomUUID())).toBeNull();
    }
  });

  it('refuses every write to a non-owner, also in a tenant namespace and with source loopback', () => {
    const storage = hearingStorageForScope(viewer({ source: 'loopback', tenantSlugs: [TENANT] }), {
      owner: false,
      denied: (message) => new Error('denied: ' + message),
    });
    const session = 'owner-' + randomUUID();
    // Reads of a tenant hearing stay open to a member of that tenant.
    expect(storage.load(session)).toBeNull();
    const next = applyHearingTurn(
      createHearingRecord(session, '2026-11-08T00:00:00Z'),
      { text: 'goal: a shared hearing', request_id: randomUUID() },
      '2026-11-08T00:00:01Z'
    );
    expect(() => storage.commitTurn(session, null, next, '<p>v1</p>', 'template')).toThrow(
      'denied: Hearing writes require a local owner session.'
    );
    expect(storage.load(session)).toBeNull();
  });

  it('writes inside the temporary root, never the repository runtime', () => {
    expect(io.pathResolver.rootDir()).toBe(root);
  });

  it('lets the owner write with a token credential', () => {
    const session = 'owner-' + randomUUID();
    const storage = hearingStorageForScope(viewer({ source: 'token', tenantSlugs: [TENANT] }), {
      owner: true,
    });
    const next = applyHearingTurn(
      createHearingRecord(session, '2026-11-08T00:00:00Z'),
      { text: 'goal: an owner hearing', request_id: randomUUID() },
      '2026-11-08T00:00:01Z'
    );
    const saved = storage.commitTurn(session, null, next, '<p>v1</p>', 'template');
    expect(saved.canvas_versions).toEqual(['v1']);
    expect(storage.load(session)?.session_id).toBe(session);
  });
});

describe('resolveHearingHandoffScope owner input', () => {
  it('files a personal inventory only for the owner', () => {
    expect(
      resolveHearingHandoffScope(viewer({ source: 'token' }), 'inventory', { owner: true })
    ).toEqual({});
    expect(() =>
      resolveHearingHandoffScope(viewer({ source: 'loopback' }), 'inventory', { owner: false })
    ).toThrow(HearingScopeError);
  });

  it('never hands a personal hearing off as a mission, owner or not', () => {
    for (const owner of [true, false])
      expect(() =>
        resolveHearingHandoffScope(viewer({ source: 'loopback' }), 'mission', { owner })
      ).toThrow(HearingScopeError);
  });
});

describe('hearingWorkInventoryScope / hearingWorkInventoryHandoffHref owner input', () => {
  it('resolves the personal scope only for the owner; a tenant scope ignores it', () => {
    for (const tenantSlugs of ['all', []] as const) {
      const scoped = viewer({ tenantSlugs: tenantSlugs as string[] | 'all' });
      expect(hearingWorkInventoryScope({ ...scoped, source: 'token' }, { owner: true })).toEqual(
        {}
      );
      expect(
        hearingWorkInventoryScope({ ...scoped, source: 'loopback' }, { owner: false })
      ).toBeNull();
    }
    for (const owner of [true, false])
      expect(hearingWorkInventoryScope(viewer({ tenantSlugs: [TENANT] }), { owner })).toEqual({
        tenant_slug: TENANT,
      });
  });

  it('selects the personal view only for the owner', () => {
    expect(
      hearingWorkInventoryHandoffHref('/work?tab=requests', viewer({ source: 'token' }), {
        owner: true,
      })
    ).toBe('/work?tab=requests&tenant=personal');
    expect(
      hearingWorkInventoryHandoffHref('/work?tab=requests', viewer({ source: 'loopback' }), {
        owner: false,
      })
    ).toBe('/work?tab=requests');
  });
});

describe('readHearingCompletion owner input', () => {
  const hearing = {
    session_id: 'owner-completion',
    scenario: 'work_inventory',
    decided_by: { kind: 'human', id: 'user:test' },
    decided_at: '2026-11-08T00:00:00Z',
    requirements: [{ id: 'goal', answer: 'Saved' }],
    work_inventory_entry_id: 'entry-1',
    work_inventory_scope: {},
  } as unknown as HearingRecord;

  it('proves a personal inventory entry only to the owner', () => {
    mocks.inventory.mockReturnValue({ entry_id: 'entry-1', scope: {}, status: 'confirmed' });
    expect(
      readHearingCompletion(hearing, viewer({ source: 'token' }), {
        currentSurface: 'concierge',
        owner: true,
      })
    ).toEqual({
      kind: 'inventory',
      status: 'ready',
      id: 'entry-1',
      next: { href: '/work?tab=requests&tenant=personal' },
    });
    expect(
      readHearingCompletion(hearing, viewer({ source: 'loopback' }), {
        currentSurface: 'concierge',
        owner: false,
      })
    ).toEqual({ kind: 'inventory', status: 'unavailable' });
  });
});
