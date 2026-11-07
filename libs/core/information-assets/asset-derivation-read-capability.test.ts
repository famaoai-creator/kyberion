import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sourceRoot = process.cwd();
const fixtureRoot = path.join(sourceRoot, 'active/shared/tmp', `lineage-reader-${randomUUID()}`);
let api: typeof import('./asset-derivation.js');
let io: typeof import('../secure-io.js');
let resource: typeof import('../foundation/resource-access-scope.js');
let bootstrapIo: typeof import('../secure-io.js');
let capability: typeof import('./asset-derivation-read-capability.js');
const SOURCE = 'knowledge/confidential/acme/docs/source.md';
const DERIVED = 'active/shared/cache/confidential/shared/derived.md';
const RECEIPT = 'active/shared/runtime/asset-derivations/system/derivations.jsonl';
const OWN_INDEX = 'active/shared/runtime/asset-derivations/confidential/acme/derivations.jsonl';

beforeAll(async () => {
  bootstrapIo = await import('../secure-io.js');
  const { seedFirstJobTestRoot } =
    await import('../../../scripts/fixtures/first-job-approval-fixture.js');
  seedFirstJobTestRoot(sourceRoot, fixtureRoot);
  vi.stubEnv('KYBERION_ROOT', fixtureRoot);
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('KYBERION_TENANT', '');
  vi.resetModules();
  io = await import('../secure-io.js');
  api = await import('./asset-derivation.js');
  capability = await import('./asset-derivation-read-capability.js');
  resource = await import('../foundation/resource-access-scope.js');
  for (const tenant of ['acme', 'beta-co']) {
    const file = path.join(fixtureRoot, 'knowledge/personal/tenants', `${tenant}.json`);
    io.safeMkdir(path.dirname(file), { recursive: true });
    io.safeWriteFile(file, JSON.stringify({ tenant_slug: tenant, status: 'active' }));
  }
  for (const relative of [SOURCE, DERIVED]) {
    const file = path.join(fixtureRoot, relative);
    io.safeMkdir(path.dirname(file), { recursive: true });
    io.safeWriteFile(file, 'fixture bytes');
  }
  api.recordDerivation({
    derived: { path: DERIVED, kind: 'cache' },
    sources: [{ kind: 'path', path: SOURCE }],
  });
});

beforeEach(() => {
  vi.stubEnv('MISSION_ROLE', 'kyberion');
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('KYBERION_TENANT', '');
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  bootstrapIo.safeRmSync(fixtureRoot, { recursive: true, force: true });
});

describe('governed derivation receipt read facade with actual secureIO', () => {
  it('permits the ordinary offboarding role to query its authorized tenant without exposing receipt bytes', () => {
    expect(api.listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'acme' })).toEqual([
      DERIVED,
    ]);
    expect(() => io.safeReadFile(path.join(fixtureRoot, RECEIPT))).toThrow(
      /DERIVATION_RECEIPT|PRODUCER|issuer|producer/i
    );
  });

  it('does not let an unrelated receipt block an authorized tenant with no lineage index', () => {
    expect(api.listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'beta-co' })).toEqual([]);
  });

  it('checks ordinary own-index permission before a grant, including absent foreign indexes', () => {
    vi.stubEnv('KYBERION_TENANT', 'acme');
    expect(() =>
      api.listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'beta-co' })
    ).toThrow(/DERIVATION_READ_SCOPE|tenant/);
    expect(() => io.safeReadFile(path.join(fixtureRoot, RECEIPT))).toThrow();
  });

  it('does not override the request resource ceiling to read receipts', () => {
    vi.stubEnv('KYBERION_TENANT', 'acme');
    expect(() =>
      resource.runInResourceAccessScope(
        {
          tenantSlug: 'acme',
          readExact: [OWN_INDEX],
          writeExact: [],
          mkdirExact: [],
        },
        () => api.listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'acme' })
      )
    ).toThrow(/RESOURCE|scope/i);
  });

  it('keeps personal, system and alternate-root queries producer-only', () => {
    for (const custody of [{ kind: 'system' as const }, { kind: 'person' as const, ref: 'owner' }])
      expect(() => api.listHonoredDerivedPathsForCustodian(custody)).toThrow(
        /DERIVATION_READ_SCOPE/
      );
    expect(() =>
      api.listHonoredDerivedPathsForCustodian(
        { kind: 'tenant', ref: 'acme' },
        { rootDir: path.join(fixtureRoot, 'other') }
      )
    ).toThrow(/DERIVATION_READ_SCOPE/);
  });

  it('revokes the exact read grant before planning and rejects every other IO while it is live', () => {
    let captured: () => unknown = () => undefined;
    capability.withAssetDerivationReceiptSnapshot(
      fixtureRoot,
      { kind: 'tenant', ref: 'acme' },
      [],
      () => {
        expect(io.safeReadFile(path.join(fixtureRoot, RECEIPT), { encoding: 'utf8' })).toContain(
          'derivedSha256'
        );
        expect(() => io.safeReadFile(path.join(fixtureRoot, SOURCE))).toThrow(
          /DERIVATION_READ_SCOPE/
        );
        expect(() => io.safeReaddir(path.dirname(path.join(fixtureRoot, RECEIPT)))).toThrow(
          /DERIVATION_READ_SCOPE/
        );
        expect(() => io.safeWriteFile(path.join(fixtureRoot, RECEIPT), 'replace')).toThrow();
        captured = () => io.safeReadFile(path.join(fixtureRoot, RECEIPT));
        return [];
      },
      () => {
        expect(captured).toThrow();
        expect(capability.currentAssetDerivationReceiptSnapshot(fixtureRoot)).toBeDefined();
      },
      true
    );
    expect(captured).toThrow();
    expect(capability.currentAssetDerivationReceiptSnapshot(fixtureRoot)).toBeUndefined();
  });

  it('refuses an asynchronous snapshot planner and expires its captured continuation', async () => {
    let later: Promise<void> = Promise.resolve();
    expect(() =>
      capability.withAssetDerivationReceiptSnapshot(
        fixtureRoot,
        { kind: 'tenant', ref: 'acme' },
        [],
        () => [],
        () => {
          later = Promise.resolve().then(() => {
            expect(capability.currentAssetDerivationReceiptSnapshot(fixtureRoot)).toBeUndefined();
            expect(() => io.safeReadFile(path.join(fixtureRoot, RECEIPT))).toThrow();
          });
          return later;
        },
        true
      )
    ).toThrow(/synchronous/);
    await later;
  });
});
