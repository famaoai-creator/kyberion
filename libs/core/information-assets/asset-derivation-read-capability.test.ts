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
    ).toThrow(/DERIVATION_LINEAGE_UNAVAILABLE/);
  });

  it('sanitizes a real foreign-source refusal after own-index admission and protected receipt loading', () => {
    const foreign = 'knowledge/confidential/beta-co/docs/mixed-private-source.md';
    const mixed = 'knowledge/confidential/heuristics/mixed-result.md';
    const foreignIndex =
      'active/shared/runtime/asset-derivations/confidential/beta-co/derivations.jsonl';
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    const saved = [RECEIPT, OWN_INDEX, foreignIndex].map((relative) => {
      const file = path.join(fixtureRoot, relative);
      return {
        file,
        content: io.safeExistsSync(file)
          ? (io.safeReadFile(file, { encoding: 'utf8' }) as string)
          : undefined,
      };
    });
    let restoreOracle: (() => void) | undefined;
    try {
      // Isolate this receipt graph: the prior shared-cache fixture is outside
      // a tenant-bound reader's scope and would be refused before this chain.
      io.safeWriteFile(path.join(fixtureRoot, RECEIPT), '');
      io.safeWriteFile(path.join(fixtureRoot, OWN_INDEX), '');
      for (const relative of [foreign, mixed]) {
        const file = path.join(fixtureRoot, relative);
        io.safeMkdir(path.dirname(file), { recursive: true });
        io.safeWriteFile(file, 'mixed receipt fixture');
      }
      const [record] = api.recordDerivation({
        derived: { path: mixed, kind: 'cache' },
        sources: [
          { kind: 'path', path: SOURCE },
          { kind: 'path', path: foreign },
        ],
      });
      expect(record.taint.tenants).toEqual(['acme', 'beta-co']);
      vi.stubEnv('MISSION_ROLE', 'kyberion');
      vi.stubEnv('KYBERION_TENANT', 'acme');
      expect(() => io.safeReadFile(path.join(fixtureRoot, OWN_INDEX))).not.toThrow();
      const actual = io.safeLstat;
      let rawDenial = '';
      const oracle = vi.spyOn(io, 'safeLstat').mockImplementation((file) => {
        try {
          return actual(file);
        } catch (error) {
          if (file === path.join(fixtureRoot, foreign)) rawDenial = (error as Error).message;
          throw error;
        }
      });
      restoreOracle = () => oracle.mockRestore();
      let refusal: Error | undefined;
      try {
        api.listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'acme' });
      } catch (error) {
        refusal = error as Error;
      }
      expect(oracle).toHaveBeenCalledWith(path.join(fixtureRoot, foreign));
      expect(rawDenial).toContain(path.join(fixtureRoot, foreign));
      expect(refusal?.message).toBe(
        '[DERIVATION_LINEAGE_UNAVAILABLE] Lineage could not be verified with the current scope.'
      );
      expect(refusal).not.toHaveProperty('cause');
      for (const secret of ['beta-co', foreign, fixtureRoot, record.proof!.derivedSha256])
        expect(refusal?.message).not.toContain(secret);
    } finally {
      restoreOracle?.();
      vi.stubEnv('MISSION_ROLE', 'mission_controller');
      vi.stubEnv('KYBERION_TENANT', '');
      for (const original of saved) {
        if (original.content === undefined) io.safeRmSync(original.file, { force: true });
        else io.safeWriteFile(original.file, original.content);
      }
      for (const relative of [foreign, mixed])
        io.safeRmSync(path.join(fixtureRoot, relative), { force: true });
      vi.stubEnv('MISSION_ROLE', 'kyberion');
    }
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

  it('denies aggregate removal and movement by a tenant-bound producer without touching a foreign index', () => {
    const root = path.join(fixtureRoot, 'active/shared/runtime/asset-derivations');
    const foreign = path.join(root, 'confidential/beta-co/derivations.jsonl');
    const destination = path.join(
      fixtureRoot,
      'active/shared/tmp',
      `denied-lineage-move-${randomUUID()}`
    );
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    const saved = [
      RECEIPT,
      OWN_INDEX,
      'active/shared/runtime/asset-derivations/confidential/beta-co/derivations.jsonl',
    ].map((relative) => {
      const file = path.join(fixtureRoot, relative);
      return {
        file,
        content: io.safeExistsSync(file)
          ? (io.safeReadFile(file, { encoding: 'utf8' }) as string)
          : undefined,
      };
    });
    const sentinel = '{"foreign_fixture":"preserve beta index bytes"}\n';
    try {
      io.safeMkdir(path.dirname(foreign), { recursive: true });
      io.safeMkdir(path.dirname(destination), { recursive: true });
      io.safeWriteFile(foreign, sentinel);
      vi.stubEnv('KYBERION_TENANT', 'acme');
      expect(() => io.safeRmSync(root, { recursive: true, force: true })).toThrow(
        /derivation\.aggregate_denied/
      );
      expect(() => io.safeMoveSync(root, destination)).toThrow(/derivation\.aggregate_denied/);
      vi.stubEnv('KYBERION_TENANT', '');
      expect(io.safeReadFile(foreign, { encoding: 'utf8' })).toBe(sentinel);
      expect(io.safeExistsSync(destination)).toBe(false);
    } finally {
      vi.stubEnv('KYBERION_TENANT', '');
      if (io.safeExistsSync(destination) && !io.safeExistsSync(root))
        io.safeMoveSync(destination, root);
      for (const original of saved) {
        if (original.content === undefined) io.safeRmSync(original.file, { force: true });
        else {
          io.safeMkdir(path.dirname(original.file), { recursive: true });
          io.safeWriteFile(original.file, original.content);
        }
      }
      vi.stubEnv('MISSION_ROLE', 'kyberion');
    }
  });

  it('permits an unbound authorized producer to move and restore the complete lineage root', () => {
    const root = path.join(fixtureRoot, 'active/shared/runtime/asset-derivations');
    const destination = path.join(
      fixtureRoot,
      'active/shared/tmp',
      `authorized-lineage-move-${randomUUID()}`
    );
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    const before = [RECEIPT, OWN_INDEX].map((relative) => ({
      relative: path.relative(root, path.join(fixtureRoot, relative)),
      content: io.safeReadFile(path.join(fixtureRoot, relative), { encoding: 'utf8' }),
    }));
    try {
      io.safeMkdir(path.dirname(destination), { recursive: true });
      io.safeMoveSync(root, destination);
      expect(io.safeExistsSync(root)).toBe(false);
      for (const original of before)
        expect(
          io.safeReadFile(path.join(destination, original.relative), { encoding: 'utf8' })
        ).toBe(original.content);
      io.safeMoveSync(destination, root);
      for (const original of before)
        expect(io.safeReadFile(path.join(root, original.relative), { encoding: 'utf8' })).toBe(
          original.content
        );
    } finally {
      if (io.safeExistsSync(destination) && !io.safeExistsSync(root))
        io.safeMoveSync(destination, root);
      vi.stubEnv('MISSION_ROLE', 'kyberion');
    }
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
