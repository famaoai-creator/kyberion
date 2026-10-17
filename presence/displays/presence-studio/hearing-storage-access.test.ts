import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceStudioViewerContext } from './security.js';
import type {
  HearingRecord,
  HearingDecisionIdentity,
  HearingDecisionOperation,
  HearingDecidedBy,
} from './hearing.js';
import { withExecutionContext as initialContext } from '@agent/core/authority';
import { rootDir } from '@agent/core/path-resolver';
import * as initialIO from '@agent/core/secure-io';

const policyState = vi.hoisted(() => ({ mode: 'loaded' as 'loaded' | 'missing' | 'corrupt' }));
vi.mock('@agent/core/fs-primitives', async (importOriginal) => {
  const real = await importOriginal<typeof import('@agent/core/fs-primitives')>();
  return {
    ...real,
    rawExistsSync: (file: string) =>
      policyState.mode === 'missing' && path.basename(file) === 'security-policy.json'
        ? false
        : real.rawExistsSync(file),
    rawReadTextFile: (file: string) =>
      policyState.mode === 'corrupt' && path.basename(file) === 'security-policy.json'
        ? '{ invalid policy'
        : real.rawReadTextFile(file),
  };
});

const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/hearing-storage-access-' + process.pid);
const MISSION = 'MSN-HEARING-RECEIPT-RECOVERY-20261017';
const NOW = '2026-10-17T12:00:00.000Z';
const TENANT = 'hearing-access-alpha';
const OTHER = 'hearing-access-bravo';
const ENV_KEYS = [
  'KYBERION_ROOT',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_ORGANIZATION_ID',
  'KYBERION_PROJECT_ID',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_AGENT_TIER',
  'KYBERION_DELEGATED_ROLE',
  'KYBERION_SCOPE_ENV_PATH',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let authority: typeof import('@agent/core/authority');
let runtime: typeof import('./hearing-runtime.js');
let hearing: typeof import('./hearing.js');
let access: typeof import('./hearing-storage-access.js');

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(
      path.join(ROOT, 'package.json'),
      '{"name":"hearing-access-policy-fixture"}'
    );
    const copy = (relative: string): void => {
      for (const name of initialIO.safeReaddir(path.join(SOURCE_ROOT, relative))) {
        const file = path.join(relative, name);
        const source = path.join(SOURCE_ROOT, file);
        const stat = initialIO.safeLstat(source);
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(?:json|yaml)$/u.test(name))
          initialIO.safeWriteFile(path.join(ROOT, file), initialIO.safeReadFile(source));
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
    const scenario = 'knowledge/product/orchestration/hearing-scenarios.json';
    initialIO.safeWriteFile(
      path.join(ROOT, scenario),
      initialIO.safeReadFile(path.join(SOURCE_ROOT, scenario))
    );
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  await import('@agent/core/secure-io');
  authority = await import('@agent/core/authority');
  runtime = await import('./hearing-runtime.js');
  hearing = await import('./hearing.js');
  access = await import('./hearing-storage-access.js');
  const resolver = await import('@agent/core/path-resolver');
  expect(resolver.rootDir()).toBe(ROOT);
  expect(resolver.pathResolver.shared('runtime/hearing')).toBe(
    path.join(ROOT, 'active/shared/runtime/hearing')
  );
}, 30_000);

beforeEach(() => {
  policyState.mode = 'loaded';
  for (const key of ENV_KEYS) if (key !== 'KYBERION_ROOT') delete process.env[key];
  process.env.KYBERION_PERSONA = 'worker';
  process.env.SYSTEM_ROLE = 'presence_studio';
  process.env.MISSION_ID = MISSION;
});

afterAll(() => {
  policyState.mode = 'loaded';
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
});

function viewer(
  tenantSlugs: string[] | 'all' = [TENANT],
  source: 'loopback' | 'token' = 'loopback'
): PresenceStudioViewerContext {
  return {
    principalId: 'verified-' + source,
    tenantSlugs,
    source,
    organizationIds: 'all',
    projectIds: 'all',
  };
}
function completeRecord(sessionId: string): HearingRecord {
  const record = hearing.createHearingRecord(sessionId, NOW);
  return {
    ...record,
    requirements: record.requirements.map((item) => ({
      ...item,
      answer: 'Synthetic confirmed requirement',
      confidence: 1,
    })),
  };
}
function identity(view: PresenceStudioViewerContext): HearingDecisionIdentity {
  return {
    principal_id: view.principalId,
    scope_key: access.hearingDecisionScopeKey(view),
    member_id: 'owner-member',
    source: view.source,
  };
}
const actor: HearingDecidedBy = { kind: 'human', id: 'user:owner-member', role: 'owner' };
function snapshot() {
  const state = authority.resolveIdentityContext();
  return {
    persona: state.persona,
    role: state.role,
    tenantSlug: state.tenantSlug,
    envPersona: process.env.KYBERION_PERSONA,
    envRole: process.env.MISSION_ROLE,
    envTenant: process.env.KYBERION_TENANT,
  };
}
function assertAmbient() {
  expect(snapshot()).toEqual({
    persona: 'worker',
    role: 'presence_studio',
    tenantSlug: undefined,
    envPersona: 'worker',
    envRole: undefined,
    envTenant: undefined,
  });
}
function seed(view = viewer(), session = 'session-' + randomUUID()) {
  const store = access.hearingStorageForViewer(view);
  const prepared = completeRecord(session);
  const record = store.commitTurn(
    session,
    null,
    prepared,
    '<html>initial canvas</html>',
    'template'
  );
  assertAmbient();
  return { store, record, session, view };
}
function operation(record: HearingRecord): HearingDecisionOperation {
  return {
    version: 1,
    operation_id: 'operation-' + randomUUID(),
    scenario_id: record.scenario,
    requirements_revision: record.requirements_revision!,
  };
}

describe('hearing storage facade under production Presence Studio identity', () => {
  it('uses the actual server-resolved loopback scope for tenant and personal storage', async () => {
    const security = await import('./security.js');
    for (const tenant of [undefined, TENANT]) {
      if (tenant) process.env.KYBERION_TENANT = tenant;
      else delete process.env.KYBERION_TENANT;
      const before = snapshot();
      const resolved = security.resolvePresenceStudioViewerContext({
        headers: { host: 'localhost' },
        socket: { remoteAddress: '127.0.0.1' },
        method: 'GET',
      } as Parameters<typeof security.resolvePresenceStudioViewerContext>[0]);
      expect(resolved.source).toBe('loopback');
      const store = access.hearingStorageForViewer(resolved);
      expect(store.namespace).toBe(tenant || 'all');
      const session = 'resolved-' + randomUUID();
      const prepared = completeRecord(session);
      const stored = store.commitTurn(
        session,
        null,
        prepared,
        '<html>resolved owner</html>',
        'template'
      );
      expect(store.load(session)).toEqual(stored);
      expect(snapshot()).toEqual(before);
    }
    delete process.env.KYBERION_TENANT;
    assertAmbient();
  });

  it('keeps generic runtime reads and writes non-elevating', () => {
    assertAmbient();
    const { record, session, store } = seed();
    expect('update' in store).toBe(false);
    expect(() => runtime.loadHearingRecord(TENANT, session)).toThrow(
      /SECURITY|POLICY|Higher tier required/
    );
    expect(() => runtime.saveHearingRecord(TENANT, record)).toThrow(
      /SECURITY|POLICY|Higher tier required/
    );
    assertAmbient();
  });

  it.each([{ tenantSlugs: [TENANT] }, { tenantSlugs: 'all' as const }, { tenantSlugs: [] }])(
    'supports the synchronous storage lifecycle for loopback scope $tenantSlugs',
    ({ tenantSlugs }) => {
      const { store, record, session, view } = seed(viewer(tenantSlugs));
      expect(store.load(session)).toEqual(record);
      assertAmbient();
      // Model/HTML preparation is outside all storage methods and keeps the ambient identity.
      const canvas = '<html>isolated receipt canvas</html>';
      const next = { ...record, updated_at: NOW };
      const updated = store.commitTurn(session, record, next, canvas, 'pending');
      expect(updated).not.toBeInstanceOf(Promise);
      expect(store.canvas(session, updated.canvas_versions.at(-1)!)).toBe(canvas);
      assertAmbient();
      const generatedHtml = '<html>model result prepared outside storage</html>';
      const generated = store.commitGeneratedCanvas(updated, generatedHtml, 'generated');
      expect(generated.canvas_generation).toBe('generated');
      expect(store.canvas(session, generated.canvas_versions.at(-1)!)).toBe(generatedHtml);
      assertAmbient();
      const decided = store.decide(session, operation(generated), identity(view), actor, NOW);
      expect(decided.current_decision_operation_id).toBeDefined();
      assertAmbient();
      const reserved = store.reserve(decided, 'mission', NOW);
      expect(reserved.handoff_pending?.kind).toBe('mission');
      assertAmbient();
      const finished = store.finish(reserved, { updated_at: NOW });
      expect(finished.handoff_pending).toBeUndefined();
      expect(store.load(session)).toEqual(finished);
      assertAmbient();
    }
  );

  it('allows a concrete token tenant record and canvas read and denies every write method', () => {
    const seeded = seed();
    const token = access.hearingStorageForViewer(viewer([TENANT], 'token'));
    expect(token.load(seeded.session)).toEqual(seeded.record);
    expect(token.canvas(seeded.session, seeded.record.canvas_versions[0])).toBe(
      '<html>initial canvas</html>'
    );
    const calls = [
      () =>
        token.commitTurn(
          seeded.session,
          seeded.record,
          seeded.record,
          '<html>denied</html>',
          'template'
        ),
      () => token.commitGeneratedCanvas(seeded.record, '<html>denied</html>', 'generated'),
      () => token.decide(seeded.session, operation(seeded.record), identity(viewer()), actor, NOW),
      () => token.reserve(seeded.record, 'mission', NOW),
      () => token.finish(seeded.record, { updated_at: NOW }),
    ];
    for (const call of calls) {
      expect(call).toThrow(/local owner session/);
      assertAmbient();
    }
  });

  it.each([{ tenantSlugs: 'all' as const }, { tenantSlugs: [] }])(
    'denies shared personal token scope $tenantSlugs',
    ({ tenantSlugs }) => {
      expect(() => access.hearingStorageForViewer(viewer(tenantSlugs, 'token'))).toThrow(
        /local owner session/
      );
      assertAmbient();
    }
  );

  it.each(
    [['all'], ['unscoped'], [TENANT, OTHER], [''], ['../other'], ['shared'], ['INVALID']].map(
      (tenantSlugs) => ({ tenantSlugs })
    )
  )('fails closed on invalid or ambiguous tenant scope $tenantSlugs', ({ tenantSlugs }) => {
    const attempt = () => {
      const store = access.hearingStorageForViewer(viewer(tenantSlugs));
      store.commitTurn(
        'invalid-scope',
        null,
        completeRecord('invalid-scope'),
        '<html>denied</html>',
        'template'
      );
    };
    expect(attempt).toThrow(/HEARING_|TENANT_|tenant/);
    assertAmbient();
  });

  it('captures viewer scope and source immutably', () => {
    const session = 'same-' + randomUUID();
    const source = viewer([TENANT]);
    const own = seed(source, session);
    const other = seed(viewer([OTHER]), session);
    other.store.commitTurn(
      session,
      other.record,
      { ...other.record, updated_at: '2026-10-18T00:00:00.000Z' },
      '<html>other tenant</html>',
      'template'
    );
    (source.tenantSlugs as string[])[0] = OTHER;
    source.source = 'token';
    source.principalId = 'mutated';
    expect(Object.isFrozen(own.store)).toBe(true);
    expect(own.store.namespace).toBe(TENANT);
    expect(own.store.load(session)?.updated_at).toBe(NOW);
    expect(
      own.store.commitTurn(session, own.record, own.record, '<html>own tenant</html>', 'template')
    ).toBeDefined();
    const remoteSource = viewer([TENANT], 'token');
    const remoteStore = access.hearingStorageForViewer(remoteSource);
    remoteSource.source = 'loopback';
    expect(() =>
      remoteStore.commitTurn(session, own.record, own.record, '<html>denied</html>', 'template')
    ).toThrow(/local owner session/);
    assertAmbient();
  });

  it('does not cross tenants through session or returned-record path manipulation', () => {
    const own = seed();
    const foreign = seed(viewer([OTHER]));
    expect(own.store.load(foreign.session)).toBeNull();
    for (const session of [
      '../' + foreign.session,
      OTHER + '/' + foreign.session,
      '..',
      '/tmp/session',
    ]) {
      expect(() => own.store.load(session)).toThrow(/HEARING_SESSION_INVALID/);
      expect(() =>
        own.store.commitTurn(
          session,
          null,
          { ...foreign.record, session_id: session },
          '<html>denied</html>',
          'template'
        )
      ).toThrow(/HEARING_SESSION_INVALID/);
      expect(() => own.store.canvas(own.session, session)).toThrow(
        /HEARING_CANVAS_VERSION_INVALID/
      );
    }
    expect(() =>
      own.store.commitTurn(
        own.session,
        own.record,
        foreign.record,
        '<html>denied</html>',
        'template'
      )
    ).toThrow(/HEARING_UPDATE_INVALID/);
    expect(() =>
      own.store.commitTurn(
        own.session,
        foreign.record,
        own.record,
        '<html>denied</html>',
        'template'
      )
    ).toThrow(/HEARING_UPDATE_INVALID/);
    expect(foreign.store.load(foreign.session)).toEqual(foreign.record);
    assertAmbient();
  });

  it('restores ambient identity and preserves stored data when a storage conflict throws', () => {
    const { store, session, record } = seed();
    const stale = { ...record, record_revision: record.record_revision! + 1 };
    expect(() =>
      store.commitTurn(session, stale, stale, '<html>denied</html>', 'template')
    ).toThrow(/stale_snapshot/);
    assertAmbient();
    expect(store.load(session)).toEqual(record);
  });

  it('does not leave role or tenant scope in concurrent async callers', async () => {
    const left = seed();
    const right = seed(viewer([OTHER]));
    await Promise.all(
      [left, right].map(async ({ store, session, record }) => {
        assertAmbient();
        await Promise.resolve();
        expect(store.load(session)).toEqual(record);
        assertAmbient();
        await Promise.resolve();
        assertAmbient();
        expect(store.load(session)).toEqual(record);
      })
    );
    assertAmbient();
  });

  it('rejects callback, nested function, and Proxy inputs before any caller code is elevated', () => {
    const { store, session, record } = seed();
    const callback = vi.fn(async () => record);
    expect(() =>
      Reflect.apply(store.commitTurn, undefined, [
        session,
        record,
        callback,
        '<html>denied</html>',
        'template',
      ])
    ).toThrow();
    const extendedRequirement = { ...record.requirements[0]!, callback };
    const nested: HearingRecord = {
      ...record,
      requirements: [extendedRequirement],
    };
    expect(() =>
      store.commitTurn(session, record, nested, '<html>denied</html>', 'template')
    ).toThrow();
    expect(() => store.commitGeneratedCanvas(nested, '<html>denied</html>', 'generated')).toThrow();
    expect(() =>
      Reflect.apply(store.finish, undefined, [record, { updated_at: callback }])
    ).toThrow();
    expect(() =>
      store.commitTurn(session, record, new Proxy(record, {}), '<html>denied</html>', 'template')
    ).toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(store.load(session)).toEqual(record);
    assertAmbient();
  });

  it('evaluates data getters and any scheduled continuations before entering storage authority', async () => {
    const { store, session, record } = seed();
    const seen: ReturnType<typeof snapshot>[] = [];
    const continuations: Array<Promise<ReturnType<typeof snapshot>>> = [];
    const next = { ...record };
    Object.defineProperty(next, 'updated_at', {
      enumerable: true,
      get() {
        seen.push(snapshot());
        continuations.push(Promise.resolve().then(snapshot));
        return NOW;
      },
    });
    const committed = store.commitTurn(
      session,
      record,
      next,
      '<html>getter clone</html>',
      'template'
    );
    expect(committed.updated_at).toBe(NOW);
    expect(seen.length).toBeGreaterThan(0);
    for (const observed of [...seen, ...(await Promise.all(continuations))]) {
      expect(observed.role).toBe('presence_studio');
      expect(observed.tenantSlug).toBeUndefined();
    }
    assertAmbient();
  });

  it('rejects object session/version coercion before caller toString can execute', () => {
    const { store, session } = seed();
    const toString = vi.fn(() => session);
    const input = { toString };
    expect(() => Reflect.apply(store.load, undefined, [input])).toThrow();
    expect(() => Reflect.apply(store.canvas, undefined, [input, 'v1'])).toThrow();
    expect(() => Reflect.apply(store.canvas, undefined, [session, input])).toThrow();
    expect(toString).not.toHaveBeenCalled();
    assertAmbient();
  });

  it.each(['missing', 'corrupt'] as const)(
    'fails closed through the facade when policy is %s',
    (mode) => {
      const { store, session, record } = seed();
      policyState.mode = mode;
      expect(() => store.load(session)).toThrow(/security-policy.json/);
      expect(() =>
        store.commitTurn(session, record, record, '<html>denied</html>', 'template')
      ).toThrow(/security-policy.json/);
      policyState.mode = 'loaded';
      assertAmbient();
    }
  );
});
