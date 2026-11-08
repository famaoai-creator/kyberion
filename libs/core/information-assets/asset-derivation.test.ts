/**
 * P3 fixture contract (INFORMATION_ASSET_SCOPE_MODEL_DESIGN): deleting a
 * tenant's asset deletes its summaries, distillation results, caches and
 * delegation results — resolved from the derivation ledger, never a
 * hand-written target list (R-09). Derivatives inherit the strictest source
 * taint (R-06).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { readJsonLines } from '../foundation/json.js';
import { registerLockIo, type LockIo } from '../foundation/lock-utils.js';
import {
  combineAssetTaint,
  custodyFromRepoPath,
  deleteAssetWithDerivations,
  derivationClosure,
  listDerivedPathsForCustodian,
  parseDerivationRef,
  recordDerivation,
  listHonoredDerivedPathsForCustodian,
  verifiedRecordSources,
  tenantFromRepoPath,
  type DerivationRef,
} from './asset-derivation.js';

const TENANT = 'acme';
const SOURCE_PATH = `knowledge/confidential/${TENANT}/docs/spec.md`;
const SUMMARY_PATH = `knowledge/confidential/${TENANT}/summaries/spec.md`;
const DISTILL_PATH = `knowledge/confidential/${TENANT}/distill/spec-insight.md`;
const CACHE_PATH = `active/shared/cache/confidential/${TENANT}/spec.index`;
const DELEGATION_PATH = `active/shared/artifacts/confidential/${TENANT}/report/delegation-result.json`;

function write(root: string, relPath: string, content = 'x'): void {
  const absolute = path.join(root, relPath);
  safeMkdir(path.dirname(absolute), { recursive: true });
  safeWriteFile(absolute, content);
}

function writeIngestLedger(
  root: string,
  tenant: string,
  targetPath: string,
  assetId: string
): void {
  write(
    root,
    `knowledge/confidential/${tenant}/_ledger/assets.jsonl`,
    JSON.stringify({ asset_id: assetId, version: 1, target_path: targetPath }) + '\n'
  );
}

describe('asset-derivation (P3 contract)', () => {
  let fixtureRoot = '';
  let previousLockIo: LockIo | undefined;
  const options = () => ({ rootDir: fixtureRoot });

  beforeAll(() => {
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    fixtureRoot = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-${randomUUID()}`
    );
    write(fixtureRoot, SOURCE_PATH, 'the source document');
    writeIngestLedger(fixtureRoot, TENANT, SOURCE_PATH, 'ing-aaaa');
    write(fixtureRoot, SUMMARY_PATH, 'summary of spec');
    write(fixtureRoot, DISTILL_PATH, 'distilled insight');
    write(fixtureRoot, CACHE_PATH, 'index bytes');
    write(fixtureRoot, DELEGATION_PATH, '{"result":"done"}');
  });

  beforeEach(() => {
    const base = (globalThis as typeof globalThis & { __kyberionVitestIo?: { lockIo?: LockIo } })
      .__kyberionVitestIo?.lockIo;
    if (!base) throw new Error('Canonical Vitest lock IO fixture is missing');
    const originalRoot = pathResolver.rootResolve('active/shared/runtime/locks');
    const remap = (file: string) => {
      const relative = path.relative(originalRoot, file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error('Lock fixture escaped its canonical lock root');
      return path.join(fixtureRoot, 'locks', relative);
    };
    previousLockIo = registerLockIo({
      ...base,
      exists: (file) => base.exists(remap(file)),
      mkdir: (file) => base.mkdir(remap(file)),
      createExclusive: (file, content) => base.createExclusive(remap(file), content),
      unlink: (file) => base.unlink(remap(file)),
      loadJson: <T>(file: string) => base.loadJson<T>(remap(file)),
      ...(base.publishExclusive
        ? {
            publishExclusive: (file: string, content: string) =>
              base.publishExclusive!(remap(file), content),
          }
        : {}),
      ...(base.ageMs ? { ageMs: (file: string) => base.ageMs!(remap(file)) } : {}),
      ...(base.rename
        ? { rename: (from: string, to: string) => base.rename!(remap(from), remap(to)) }
        : {}),
      ...(base.linkExclusive
        ? {
            linkExclusive: (from: string, to: string) =>
              base.linkExclusive!(remap(from), remap(to)),
          }
        : {}),
      ...(base.readdir ? { readdir: (file: string) => base.readdir!(remap(file)) } : {}),
      ...(base.sameFile
        ? { sameFile: (a: string, b: string) => base.sameFile!(remap(a), remap(b)) }
        : {}),
    });
  });

  afterEach(() => registerLockIo(previousLockIo));

  afterAll(() => {
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const assetRef: DerivationRef = {
    kind: 'asset',
    tenant: TENANT,
    assetId: 'ing-aaaa',
    version: 1,
  };

  it('parses and rejects derivation refs fail-closed', () => {
    expect(parseDerivationRef(`asset:${TENANT}:ing-aaaa@v1`)).toEqual(assetRef);
    expect(parseDerivationRef(`path:${SOURCE_PATH}`)).toEqual({ kind: 'path', path: SOURCE_PATH });
    for (const bad of ['', 'asset:x', 'path:', 'mem:abc@1', 'asset:../evil:ing@v1', 'nope']) {
      expect(() => parseDerivationRef(bad)).toThrow(/DERIVATION_REF_INVALID/);
    }
  });

  it('infers custody from a repo path', () => {
    expect(custodyFromRepoPath(SOURCE_PATH)).toEqual({ kind: 'tenant', ref: TENANT });
    expect(custodyFromRepoPath('knowledge/personal/notes/x.md')).toEqual({
      kind: 'person',
      ref: 'notes',
    });
    expect(custodyFromRepoPath('knowledge/product/guide.md')).toEqual({ kind: 'system' });
    // Anchored layouts only: a `confidential/{slug}` segment inside scratch is
    // NOT tenant custody (custody-laundering defense), while the same segment
    // in a real floor partition IS (it is genuinely tenant space).
    expect(custodyFromRepoPath(`active/shared/tmp/job-x/confidential/${TENANT}/f.md`)).toEqual({
      kind: 'system',
    });
    expect(custodyFromRepoPath(`active/shared/tmp/confidential/${TENANT}/f.md`)).toEqual({
      kind: 'tenant',
      ref: TENANT,
    });
    // Shared prefixes under knowledge/confidential are never tenants.
    expect(custodyFromRepoPath('knowledge/confidential/tenant-groups/g.json')).toEqual({
      kind: 'system',
    });
    // Case-folded: a case-variant tier segment still attributes the tenant.
    expect(tenantFromRepoPath(`Knowledge/Confidential/${TENANT}/x.md`)).toBe(TENANT);
  });

  it('records derivations in the SOURCE custodian ledger and refuses a lower-tier landing (R-06)', () => {
    recordDerivation({
      derived: { path: SUMMARY_PATH, kind: 'summary' },
      sources: [assetRef],
      options: options(),
    });
    const ledger = readJsonLines<{
      derived: { path: string };
      sources: string[];
      taint: { highestTier: string };
    }>(
      path.join(
        fixtureRoot,
        'active/shared/runtime/asset-derivations/confidential',
        TENANT,
        'derivations.jsonl'
      )
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0].derived.path).toBe(SUMMARY_PATH);
    expect(ledger[0].sources).toEqual([`asset:${TENANT}:ing-aaaa@v1`]);
    expect(ledger[0].taint.highestTier).toBe('confidential');
    // A derivative may never sit below the strictest source taint.
    expect(() =>
      recordDerivation({
        derived: { path: 'knowledge/public/leak.md', kind: 'summary' },
        sources: [assetRef],
        options: options(),
      })
    ).toThrow(/DERIVATION_TIER_VIOLATION/);
  });

  it('refuses malformed sources and unresolvable assets fail-closed', () => {
    write(fixtureRoot, 'knowledge/confidential/acme/summaries/no-src.md');
    write(fixtureRoot, 'knowledge/confidential/acme/summaries/bad.md');
    write(fixtureRoot, 'knowledge/confidential/acme/summaries/phantom.md');
    expect(() =>
      recordDerivation({
        derived: { path: 'knowledge/confidential/acme/summaries/no-src.md', kind: 'summary' },
        sources: [],
        options: options(),
      })
    ).toThrow(/DERIVATION_INVALID/);
    expect(() =>
      recordDerivation({
        derived: { path: 'knowledge/confidential/acme/summaries/bad.md', kind: 'summary' },
        sources: [{ kind: 'asset', tenant: 'ghost-co', assetId: 'ing-x', version: 1 }],
        options: options(),
      })
    ).toThrow(/DERIVATION_INVALID/);
    // A `path:` source must exist — a derivation cannot claim a phantom source.
    expect(() =>
      recordDerivation({
        derived: { path: 'knowledge/confidential/acme/summaries/phantom.md', kind: 'summary' },
        sources: [{ kind: 'path', path: 'knowledge/confidential/acme/docs/nonexistent.md' }],
        options: options(),
      })
    ).toThrow(/DERIVATION_INVALID/);
    expect(() =>
      recordDerivation({
        derived: { path: '../escape.md', kind: 'summary' },
        sources: [assetRef],
        options: options(),
      })
    ).toThrow(/DERIVATION_INVALID/);
  });

  it('refuses a derived path outside derivable data locations (deletion envelope)', () => {
    for (const landing of [
      'libs/core/x.ts',
      'knowledge/product/guide.md',
      'active/missions/public/MSN-X/evidence/e.json',
      'active/shared/runtime/asset-derivations/system/x.jsonl',
      `active/shared/runtime/usage-ledger/confidential/${TENANT}/x.jsonl`,
      'knowledge/confidential/acme',
      'knowledge/confidential/acme/_ledger/assets.jsonl',
    ]) {
      expect(() =>
        recordDerivation({
          derived: { path: landing, kind: 'summary' },
          sources: [assetRef],
          options: options(),
        })
      ).toThrow(/DERIVATION_(INVALID|CUSTODY_INVALID|TIER_VIOLATION)/);
    }
  });

  it('refuses a forged ingest-ledger line targeting another tenant', () => {
    const root4 = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-f-${randomUUID()}`
    );
    write(root4, 'knowledge/confidential/acme/summaries/out.md');
    writeIngestLedger(root4, 'acme', 'knowledge/confidential/victim-co/x.md', 'ing-evil');
    expect(() =>
      recordDerivation({
        derived: { path: 'knowledge/confidential/acme/summaries/out.md', kind: 'summary' },
        sources: [{ kind: 'asset', tenant: 'acme', assetId: 'ing-evil', version: 1 }],
        options: { rootDir: root4 },
      })
    ).toThrow(/DERIVATION_INVALID/);
    safeRmSync(root4, { recursive: true, force: true });
  });

  it('records a fabricated-custody source under system, never the laundered tenant', () => {
    const root5 = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-c-${randomUUID()}`
    );
    // `job-y/` sits between the floor root and the tier segment, so this is
    // NOT tenant acme's partition — anchored custody says system.
    const fabricated = 'active/shared/tmp/job-y/confidential/acme/f.md';
    const systemLanding = 'active/shared/cache/public/spec.index';
    write(root5, fabricated);
    write(root5, systemLanding);
    // …and a system-custody source may never land inside a person partition
    // (custody replay: person landings need a person source custodian).
    expect(() =>
      recordDerivation({
        derived: { path: 'knowledge/personal/ops/secret-note.md', kind: 'summary' },
        sources: [{ kind: 'path', path: fabricated }],
        options: { rootDir: root5 },
      })
    ).toThrow(/DERIVATION_CUSTODY_INVALID/);
    recordDerivation({
      derived: { path: systemLanding, kind: 'cache' },
      sources: [{ kind: 'path', path: fabricated }],
      options: { rootDir: root5 },
    });
    expect(
      safeExistsSync(
        path.join(
          root5,
          'active/shared/runtime/asset-derivations/confidential/acme/derivations.jsonl'
        )
      )
    ).toBe(false);
    expect(listDerivedPathsForCustodian({ kind: 'system' }, { rootDir: root5 })).toEqual([
      systemLanding,
    ]);
    safeRmSync(root5, { recursive: true, force: true });
  });

  it('reaches a derivative recorded under the other ref spelling of the same source', () => {
    const root6 = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-s-${randomUUID()}`
    );
    const source = 'knowledge/confidential/acme/docs/spelled.md';
    const derived = 'knowledge/confidential/acme/summaries/spelled.md';
    write(root6, source);
    write(root6, derived);
    writeIngestLedger(root6, 'acme', source, 'ing-spell');
    // The record names the source by PATH; deletion is by ASSET ref — the
    // closure must still reach the derivative (R-09, both spellings).
    recordDerivation({
      derived: { path: derived, kind: 'summary' },
      sources: [{ kind: 'path', path: source }],
      options: { rootDir: root6 },
    });
    const result = deleteAssetWithDerivations({
      ref: { kind: 'asset', tenant: 'acme', assetId: 'ing-spell', version: 1 },
      options: { rootDir: root6 },
    });
    expect(result.deleted).toEqual(expect.arrayContaining([derived, source]));
    safeRmSync(root6, { recursive: true, force: true });
  });

  it('survives a derivation cycle and deletes the whole ring', () => {
    const root7 = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-y-${randomUUID()}`
    );
    write(root7, 'knowledge/confidential/acme/docs/a.md');
    write(root7, 'knowledge/confidential/acme/docs/b.md');
    recordDerivation({
      derived: { path: 'knowledge/confidential/acme/docs/b.md', kind: 'summary' },
      sources: [{ kind: 'path', path: 'knowledge/confidential/acme/docs/a.md' }],
      options: { rootDir: root7 },
    });
    recordDerivation({
      derived: { path: 'knowledge/confidential/acme/docs/a.md', kind: 'summary' },
      sources: [{ kind: 'path', path: 'knowledge/confidential/acme/docs/b.md' }],
      options: { rootDir: root7 },
    });
    const result = deleteAssetWithDerivations({
      ref: { kind: 'path', path: 'knowledge/confidential/acme/docs/a.md' },
      options: { rootDir: root7 },
    });
    expect(result.deleted).toEqual(
      expect.arrayContaining([
        'knowledge/confidential/acme/docs/a.md',
        'knowledge/confidential/acme/docs/b.md',
      ])
    );
    safeRmSync(root7, { recursive: true, force: true });
  });

  it('skips a tampered line naming a non-derivable location — the file survives', () => {
    const root8 = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-d-${randomUUID()}`
    );
    write(root8, 'knowledge/confidential/acme/docs/a.md');
    write(root8, 'libs/core/secure-io.ts', 'code the ledger must not reach');
    const file = path.join(
      root8,
      'active/shared/runtime/asset-derivations/confidential/acme/derivations.jsonl'
    );
    safeMkdir(path.dirname(file), { recursive: true });
    safeWriteFile(
      file,
      JSON.stringify({
        derived: {
          ref: 'path:libs/core/secure-io.ts',
          path: 'libs/core/secure-io.ts',
          kind: 'summary',
        },
        sources: ['path:knowledge/confidential/acme/docs/a.md'],
        taint: { highestTier: 'confidential', tenants: ['acme'], prohibitExternal: true },
        recorded_at: '2026-11-08T00:00:00.000Z',
      }) + '\n'
    );
    const result = deleteAssetWithDerivations({
      ref: { kind: 'path', path: 'knowledge/confidential/acme/docs/a.md' },
      options: { rootDir: root8 },
    });
    expect(result.deleted).toEqual(['knowledge/confidential/acme/docs/a.md']);
    expect(result.skipped).toContain('libs/core/secure-io.ts');
    expect(safeExistsSync(path.join(root8, 'libs/core/secure-io.ts'))).toBe(true);
    safeRmSync(root8, { recursive: true, force: true });
  });

  it('ignores a wrong-shape ledger line instead of deleting or crashing', () => {
    const root9 = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-m-${randomUUID()}`
    );
    write(root9, 'knowledge/confidential/acme/docs/a.md');
    const file = path.join(
      root9,
      'active/shared/runtime/asset-derivations/confidential/acme/derivations.jsonl'
    );
    safeMkdir(path.dirname(file), { recursive: true });
    safeWriteFile(
      file,
      ['not json at all', JSON.stringify({ derived: { path: 42 }, sources: 'x' }), ''].join('\n') +
        '\n'
    );
    const result = deleteAssetWithDerivations({
      ref: { kind: 'path', path: 'knowledge/confidential/acme/docs/a.md' },
      options: { rootDir: root9 },
    });
    expect(result.deleted).toEqual(['knowledge/confidential/acme/docs/a.md']);
    safeRmSync(root9, { recursive: true, force: true });
  });

  it('records multi-hop derivations and combines taint strictest-first', () => {
    recordDerivation({
      derived: { path: DISTILL_PATH, kind: 'distillation' },
      sources: [{ kind: 'path', path: SUMMARY_PATH }],
      options: options(),
    });
    recordDerivation({
      derived: { path: CACHE_PATH, kind: 'cache' },
      sources: [assetRef],
      options: options(),
    });
    recordDerivation({
      derived: { path: DELEGATION_PATH, kind: 'delegation_result' },
      sources: [assetRef],
      options: options(),
    });
    // personal source + confidential source → combined is personal/prohibitExternal.
    const combined = combineAssetTaint([
      { highestTier: 'confidential', tenants: [TENANT], prohibitExternal: true },
      { highestTier: 'personal', tenants: [], prohibitExternal: true },
    ]);
    expect(combined.highestTier).toBe('personal');
    expect(combined.prohibitExternal).toBe(true);
    expect(combined.tenants).toEqual([TENANT]);
    // Multi-hop closure: source → summary → distillation.
    const closure = derivationClosure(assetRef, options());
    expect(closure).toEqual(
      expect.arrayContaining([SUMMARY_PATH, DISTILL_PATH, CACHE_PATH, DELEGATION_PATH])
    );
  });

  it('deleting the tenant asset deletes summary, distillation, cache and delegation result (acceptance)', () => {
    const result = deleteAssetWithDerivations({ ref: assetRef, options: options() });
    expect(result.deleted).toEqual(
      expect.arrayContaining([SUMMARY_PATH, DISTILL_PATH, CACHE_PATH, DELEGATION_PATH, SOURCE_PATH])
    );
    for (const rel of result.deleted) {
      expect(safeExistsSync(path.join(fixtureRoot, rel))).toBe(false);
    }
    // Deletion is audited next to the ledger.
    const audit = readJsonLines<{ deleted_paths: string[] }>(
      path.join(
        fixtureRoot,
        'active/shared/runtime/asset-derivations/confidential',
        TENANT,
        'derivation-deletions.jsonl'
      )
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].deleted_paths).toContain(DISTILL_PATH);
  });

  it('refuses a derivative landing inside a DIFFERENT tenant (no cross-tenant deletion vector)', () => {
    expect(() =>
      recordDerivation({
        derived: { path: 'knowledge/confidential/other-co/stolen.md', kind: 'summary' },
        sources: [assetRef],
        options: options(),
      })
    ).toThrow(/DERIVATION_CUSTODY_INVALID/);
  });

  it('never deletes a recorded path inside a different tenant (tampered-line defense)', () => {
    const root3 = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-t-${randomUUID()}`
    );
    write(root3, 'knowledge/confidential/acme/docs/a.md');
    write(root3, 'knowledge/confidential/victim-co/docs/keep.md');
    const file = path.join(
      root3,
      'active/shared/runtime/asset-derivations/confidential/acme/derivations.jsonl'
    );
    safeMkdir(path.dirname(file), { recursive: true });
    // A tampered ledger line claims a derivative inside victim-co's tree.
    safeWriteFile(
      file,
      JSON.stringify({
        derived: {
          ref: 'path:knowledge/confidential/victim-co/docs/keep.md',
          path: 'knowledge/confidential/victim-co/docs/keep.md',
          kind: 'summary',
        },
        sources: ['path:knowledge/confidential/acme/docs/a.md'],
        taint: { highestTier: 'confidential', tenants: ['acme'], prohibitExternal: true },
        recorded_at: '2026-11-08T00:00:00.000Z',
      }) + '\n'
    );
    const result = deleteAssetWithDerivations({
      ref: { kind: 'path', path: 'knowledge/confidential/acme/docs/a.md' },
      options: { rootDir: root3 },
    });
    expect(result.deleted).toEqual(['knowledge/confidential/acme/docs/a.md']);
    expect(safeExistsSync(path.join(root3, 'knowledge/confidential/victim-co/docs/keep.md'))).toBe(
      true
    );
    safeRmSync(root3, { recursive: true, force: true });
  });

  it('refuses a forged line claiming a VERIFIED foreign asset — partition bound holds', () => {
    const rootA = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-f-${randomUUID()}`
    );
    write(rootA, 'knowledge/confidential/acme/docs/a.md');
    write(rootA, 'knowledge/confidential/victim-co/docs/real.md');
    write(rootA, 'knowledge/confidential/victim-co/docs/keep.md');
    writeIngestLedger(
      rootA,
      'victim-co',
      'knowledge/confidential/victim-co/docs/real.md',
      'ing-real'
    );
    const file = path.join(
      rootA,
      'active/shared/runtime/asset-derivations/confidential/acme/derivations.jsonl'
    );
    safeMkdir(path.dirname(file), { recursive: true });
    // Forged line inside ACME's partition: it genuinely verifies a victim-co
    // source, yet a record may only authorize landings in its OWN
    // partition's custodian space (or system) — never the foreign tree.
    safeWriteFile(
      file,
      JSON.stringify({
        derived: {
          ref: 'path:knowledge/confidential/victim-co/docs/keep.md',
          path: 'knowledge/confidential/victim-co/docs/keep.md',
          kind: 'summary',
        },
        sources: ['asset:victim-co:ing-real@v1', 'path:knowledge/confidential/acme/docs/a.md'],
        taint: { highestTier: 'confidential', tenants: ['victim-co'], prohibitExternal: true },
        recorded_at: '2026-11-08T00:00:00.000Z',
      }) + '\n'
    );
    const result = deleteAssetWithDerivations({
      ref: { kind: 'path', path: 'knowledge/confidential/acme/docs/a.md' },
      options: { rootDir: rootA },
    });
    expect(result.deleted).toEqual(['knowledge/confidential/acme/docs/a.md']);
    expect(result.skipped).toContain('knowledge/confidential/victim-co/docs/keep.md');
    expect(safeExistsSync(path.join(rootA, 'knowledge/confidential/victim-co/docs/keep.md'))).toBe(
      true
    );
    safeRmSync(rootA, { recursive: true, force: true });
  });

  it('a forged line cannot mark a foreign source dead to launder deletion through the victim’s own records', () => {
    const rootC = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-h-${randomUUID()}`
    );
    write(rootC, 'knowledge/confidential/acme/docs/doomed.md');
    write(rootC, 'knowledge/confidential/victim-co/docs/base.md');
    write(rootC, 'knowledge/confidential/victim-co/summaries/s1.md');
    writeIngestLedger(
      rootC,
      'victim-co',
      'knowledge/confidential/victim-co/docs/base.md',
      'ing-base'
    );
    // victim-co's own legitimate record: s1 derives from ing-base.
    recordDerivation({
      derived: { path: 'knowledge/confidential/victim-co/summaries/s1.md', kind: 'summary' },
      sources: [{ kind: 'asset', tenant: 'victim-co', assetId: 'ing-base', version: 1 }],
      options: { rootDir: rootC },
    });
    // Forged line in ACME's partition: claims the deletion of acme's file
    // "produced" the victim's SOURCE file — trying to mark ing-base dead so
    // victim-co's own honored records delete its derivative graph.
    const forged = path.join(
      rootC,
      'active/shared/runtime/asset-derivations/confidential/acme/derivations.jsonl'
    );
    safeMkdir(path.dirname(forged), { recursive: true });
    safeWriteFile(
      forged,
      JSON.stringify({
        derived: {
          ref: 'path:knowledge/confidential/victim-co/docs/base.md',
          path: 'knowledge/confidential/victim-co/docs/base.md',
          kind: 'summary',
        },
        sources: ['path:knowledge/confidential/acme/docs/doomed.md'],
        taint: { highestTier: 'confidential', tenants: ['acme'], prohibitExternal: true },
        recorded_at: '2026-11-08T00:00:00.000Z',
      }) + '\n'
    );
    const result = deleteAssetWithDerivations({
      ref: { kind: 'path', path: 'knowledge/confidential/acme/docs/doomed.md' },
      options: { rootDir: rootC },
    });
    expect(result.deleted).toEqual(['knowledge/confidential/acme/docs/doomed.md']);
    expect(safeExistsSync(path.join(rootC, 'knowledge/confidential/victim-co/docs/base.md'))).toBe(
      true
    );
    expect(
      safeExistsSync(path.join(rootC, 'knowledge/confidential/victim-co/summaries/s1.md'))
    ).toBe(true);
    safeRmSync(rootC, { recursive: true, force: true });
  });

  it('rejects a ledger line whose derived.ref is not the path: spelling of derived.path', () => {
    const rootD = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-r-${randomUUID()}`
    );
    write(rootD, 'knowledge/confidential/acme/docs/a.md');
    write(rootD, 'knowledge/confidential/victim-co/docs/base.md');
    const file = path.join(
      rootD,
      'active/shared/runtime/asset-derivations/confidential/acme/derivations.jsonl'
    );
    safeMkdir(path.dirname(file), { recursive: true });
    // An `asset:` derived.ref is definitionally forged — recordDerivation
    // only ever writes `path:` refs — and must not seed the closure.
    safeWriteFile(
      file,
      JSON.stringify({
        derived: {
          ref: 'asset:victim-co:ing-base@v1',
          path: 'knowledge/confidential/victim-co/docs/base.md',
          kind: 'summary',
        },
        sources: ['path:knowledge/confidential/acme/docs/a.md'],
        taint: { highestTier: 'confidential', tenants: ['acme'], prohibitExternal: true },
        recorded_at: '2026-11-08T00:00:00.000Z',
      }) + '\n'
    );
    const result = deleteAssetWithDerivations({
      ref: { kind: 'path', path: 'knowledge/confidential/acme/docs/a.md' },
      options: { rootDir: rootD },
    });
    expect(result.deleted).toEqual(['knowledge/confidential/acme/docs/a.md']);
    expect(safeExistsSync(path.join(rootD, 'knowledge/confidential/victim-co/docs/base.md'))).toBe(
      true
    );
    safeRmSync(rootD, { recursive: true, force: true });
  });

  it('refuses a forged ingest-ledger target_path outside derivable locations', () => {
    const rootB = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-g-${randomUUID()}`
    );
    write(rootB, 'libs/core/secure-io.ts', 'code the ledger must not reach');
    writeIngestLedger(rootB, 'acme', 'libs/core/secure-io.ts', 'ing-evil');
    expect(() =>
      deleteAssetWithDerivations({
        ref: { kind: 'asset', tenant: 'acme', assetId: 'ing-evil', version: 1 },
        options: { rootDir: rootB },
      })
    ).toThrow(/DERIVATION_INVALID/);
    expect(safeExistsSync(path.join(rootB, 'libs/core/secure-io.ts'))).toBe(true);
    safeRmSync(rootB, { recursive: true, force: true });
  });

  function freshGraph() {
    const root = path.join(fixtureRoot, `graph-${randomUUID()}`);
    const source = 'knowledge/confidential/acme/docs/source.md';
    const other = 'knowledge/confidential/beta-co/docs/source.md';
    const intermediate = 'active/shared/cache/confidential/shared/intermediate.md';
    const final = 'active/shared/artifacts/confidential/shared/report/final.md';
    const foreign = 'knowledge/confidential/beta-co/docs/foreign.md';
    for (const file of [source, other, intermediate, final, foreign]) write(root, file, 'fixture');
    const opts = { rootDir: root };
    const issue = (target: string, sources: DerivationRef[]) =>
      recordDerivation({
        derived: { path: target, kind: 'summary' },
        sources,
        options: opts,
      });
    return { root, source, other, intermediate, final, foreign, opts, issue };
  }

  it('retains original tenant taint through system hops and proves their transitive offboarding closure', () => {
    const g = freshGraph();
    g.issue(g.intermediate, [{ kind: 'path', path: g.source }]);
    const records = g.issue(g.final, [{ kind: 'path', path: g.intermediate }]);
    expect(records.every((record) => record.taint.tenants.includes('acme'))).toBe(true);
    expect(listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'acme' }, g.opts)).toEqual(
      [g.final, g.intermediate].sort()
    );
    expect(() =>
      g.issue(g.foreign, [
        { kind: 'path', path: g.intermediate },
        { kind: 'path', path: g.other },
      ])
    ).toThrow(/DERIVATION_CUSTODY_INVALID/);
  });

  it('finds asset aliases for system landings when deletion begins from a path ref', () => {
    const g = freshGraph();
    g.issue(g.intermediate, [{ kind: 'path', path: g.source }]);
    writeIngestLedger(g.root, 'acme', g.intermediate, 'ing-system');
    g.issue(g.final, [{ kind: 'asset', tenant: 'acme', assetId: 'ing-system', version: 1 }]);
    const result = deleteAssetWithDerivations({
      ref: { kind: 'path', path: g.intermediate },
      options: g.opts,
    });
    expect(result.deleted).toContain(g.final);
    expect(result.deleted).toContain(g.intermediate);
  });

  it('refuses forged ingest mappings to a personal or unrelated system source', () => {
    for (const victim of [
      'knowledge/personal/victim/private.md',
      'active/shared/cache/confidential/shared/victim.md',
    ]) {
      const g = freshGraph();
      write(g.root, victim, 'private victim bytes');
      writeIngestLedger(g.root, 'acme', victim, 'ing-forged');
      const ref: DerivationRef = {
        kind: 'asset',
        tenant: 'acme',
        assetId: 'ing-forged',
        version: 1,
      };
      expect(() => g.issue(g.final, [ref])).toThrow(/DERIVATION_INVALID/);
      expect(() => deleteAssetWithDerivations({ ref, options: g.opts })).toThrow(
        /DERIVATION_INVALID/
      );
      expect(safeExistsSync(path.join(g.root, victim))).toBe(true);
    }
  });

  it('blocks ingest alias retargeting after producer issuance', () => {
    const g = freshGraph();
    writeIngestLedger(g.root, 'acme', g.source, 'ing-bound');
    const ref: DerivationRef = { kind: 'asset', tenant: 'acme', assetId: 'ing-bound', version: 1 };
    g.issue(g.final, [ref]);
    const replacement = 'knowledge/confidential/acme/docs/replacement.md';
    write(g.root, replacement, 'new unrelated source');
    writeIngestLedger(g.root, 'acme', replacement, 'ing-bound');
    expect(listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'acme' }, g.opts)).toEqual([
      g.final,
    ]);
    expect(() => deleteAssetWithDerivations({ ref, options: g.opts })).toThrow(
      /DERIVATION_SOURCE_CHANGED/
    );
    expect(safeExistsSync(path.join(g.root, g.final))).toBe(true);
    const historical = deleteAssetWithDerivations({
      ref: { kind: 'path', path: g.source },
      options: g.opts,
    });
    expect(historical.deleted).toContain(g.final);
    expect(safeExistsSync(path.join(g.root, replacement))).toBe(true);
  });

  it('verifies source hashes and never reinterprets changed source bytes as the issued lineage', () => {
    const g = freshGraph();
    g.issue(g.intermediate, [{ kind: 'path', path: g.source }]);
    write(g.root, g.source, 'different source generation');
    expect(() =>
      listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'acme' }, g.opts)
    ).toThrow(/DERIVATION_SOURCE_CHANGED/);
    expect(() => g.issue(g.final, [{ kind: 'path', path: g.intermediate }])).toThrow(
      /DERIVATION_SOURCE_CHANGED/
    );
    expect(() =>
      deleteAssetWithDerivations({ ref: { kind: 'path', path: g.source }, options: g.opts })
    ).toThrow(/DERIVATION_SOURCE_CHANGED/);
  });

  it.each(['retargeted', 'removed'] as const)(
    'retains multihop provenance and upstream verification after an ingest alias is %s',
    (mode) => {
      const g = freshGraph();
      g.issue(g.intermediate, [{ kind: 'path', path: g.source }]);
      writeIngestLedger(g.root, 'acme', g.intermediate, 'ing-upstream');
      const [record] = g.issue(g.final, [
        { kind: 'asset', tenant: 'acme', assetId: 'ing-upstream', version: 1 },
      ]);
      if (mode === 'removed') {
        safeRmSync(path.join(g.root, 'knowledge/confidential/acme/_ledger/assets.jsonl'));
      } else {
        const replacement = 'knowledge/confidential/acme/docs/alias-replacement.md';
        write(g.root, replacement, 'unrelated replacement');
        writeIngestLedger(g.root, 'acme', replacement, 'ing-upstream');
      }
      const replay = { ...g.opts, strictLineage: true };
      expect(
        verifiedRecordSources(record, replay).some(
          (source) =>
            source.custody.kind === 'tenant' &&
            source.custody.ref === 'acme' &&
            source.taint.tenants.includes('acme') &&
            source.taint.highestTier === 'confidential'
        )
      ).toBe(true);
      // The saved alias must still traverse its original intermediate's
      // provenance; consulting the mutable index would miss this corruption.
      write(g.root, g.source, 'changed upstream original');
      expect(() => verifiedRecordSources(record, replay)).toThrow(/DERIVATION_SOURCE_CHANGED/);
      const next = 'active/shared/cache/confidential/shared/third-hop.md';
      write(g.root, next);
      expect(() => g.issue(next, [{ kind: 'path', path: g.final }])).toThrow(
        /DERIVATION_SOURCE_CHANGED/
      );
    }
  );

  it('selects the matching protected receipt among multiple output generations', () => {
    const g = freshGraph();
    g.issue(g.intermediate, [{ kind: 'path', path: g.source }]);
    write(g.root, g.intermediate, 'a newly issued generation');
    g.issue(g.intermediate, [{ kind: 'path', path: g.source }]);
    writeIngestLedger(g.root, 'acme', g.intermediate, 'ing-new-generation');
    expect(() =>
      g.issue(g.final, [
        { kind: 'asset', tenant: 'acme', assetId: 'ing-new-generation', version: 1 },
      ])
    ).not.toThrow();
  });

  it('requires protected issuance receipts rather than accepting a forged system-victim hash', () => {
    const g = freshGraph();
    const [issued] = g.issue(g.intermediate, [{ kind: 'path', path: g.source }]);
    // Both files have identical bytes; even a correct output hash is not authority.
    const forged = {
      ...issued,
      derived: { ...issued.derived, ref: `path:${g.final}`, path: g.final },
    };
    write(
      g.root,
      'active/shared/runtime/asset-derivations/confidential/acme/derivations.jsonl',
      JSON.stringify(forged) + '\n'
    );
    expect(() =>
      listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'acme' }, g.opts)
    ).toThrow(/DERIVATION_UNATTESTED/);
    const result = deleteAssetWithDerivations({
      ref: { kind: 'path', path: g.source },
      options: g.opts,
    });
    expect(result.deleted).not.toContain(g.final);
    expect(safeExistsSync(path.join(g.root, g.final))).toBe(true);
  });

  it('blocks changed derived bytes instead of declaring offboarding complete', () => {
    const g = freshGraph();
    g.issue(g.intermediate, [{ kind: 'path', path: g.source }]);
    write(g.root, g.intermediate, 'replacement');
    expect(() =>
      listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'acme' }, g.opts)
    ).toThrow(/DERIVATION_CHANGED/);
  });

  it('never seeds a foreign asset death from an untrusted source snapshot alias', () => {
    const g = freshGraph();
    writeIngestLedger(g.root, 'beta-co', g.other, 'ing-victim');
    const [victim] = g.issue(g.foreign, [
      { kind: 'asset', tenant: 'beta-co', assetId: 'ing-victim', version: 1 },
    ]);
    const forged = {
      ...victim,
      derived: { ...victim.derived, ref: `path:${g.intermediate}`, path: g.intermediate },
      proof: { ...victim.proof!, sources: [{ ...victim.proof!.sources[0], path: g.source }] },
    };
    write(
      g.root,
      'active/shared/runtime/asset-derivations/confidential/acme/derivations.jsonl',
      JSON.stringify(forged) + '\n'
    );
    const result = deleteAssetWithDerivations({
      ref: { kind: 'path', path: g.source },
      options: g.opts,
    });
    expect(result.deleted).not.toContain(g.foreign);
    expect(safeExistsSync(path.join(g.root, g.foreign))).toBe(true);
  });

  it('uses protected receipts after a missing intermediate and after a source-partition append interruption', () => {
    const g = freshGraph();
    g.issue(g.intermediate, [{ kind: 'path', path: g.source }]);
    g.issue(g.final, [{ kind: 'path', path: g.intermediate }]);
    safeRmSync(path.join(g.root, g.intermediate));
    safeRmSync(
      path.join(
        g.root,
        'active/shared/runtime/asset-derivations/confidential/acme/derivations.jsonl'
      )
    );
    expect(listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'acme' }, g.opts)).toEqual(
      [g.final, g.intermediate].sort()
    );
  });

  it('distinguishes a corrupt lineage ledger from verified empty lineage', () => {
    const g = freshGraph();
    expect(listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'acme' }, g.opts)).toEqual(
      []
    );
    write(
      g.root,
      'active/shared/runtime/asset-derivations/confidential/acme/derivations.jsonl',
      '{broken\n'
    );
    expect(() =>
      listHonoredDerivedPathsForCustodian({ kind: 'tenant', ref: 'acme' }, g.opts)
    ).toThrow();
  });

  it('refuses lineage issuance by an untrusted or absent producer role', () => {
    const g = freshGraph();
    for (const role of ['worker', '']) {
      vi.stubEnv('MISSION_ROLE', role);
      expect(() => g.issue(g.intermediate, [{ kind: 'path', path: g.source }])).toThrow(
        /DERIVATION_ISSUER_REQUIRED/
      );
    }
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
  });

  it('never promotes a tenant-bound ambient caller to write personal lineage or producer receipts', () => {
    const g = freshGraph();
    const member = `fixture-member-${randomUUID().slice(0, 8)}`;
    const source = `knowledge/personal/${member}/docs/source.md`;
    const derived = `knowledge/personal/${member}/summaries/result.md`;
    write(g.root, source, 'personal fixture source');
    write(g.root, derived, 'personal fixture result');
    const previousTenant = process.env.KYBERION_TENANT;
    try {
      vi.stubEnv('MISSION_ROLE', 'infrastructure_sentinel');
      vi.stubEnv('KYBERION_TENANT', 'acme');
      expect(() =>
        recordDerivation({
          derived: { path: derived, kind: 'summary' },
          sources: [{ kind: 'path', path: source }],
          options: g.opts,
        })
      ).toThrow(/DERIVATION_ISSUER_REQUIRED/);
    } finally {
      vi.stubEnv('MISSION_ROLE', 'mission_controller');
      vi.stubEnv('KYBERION_TENANT', previousTenant);
    }
    for (const partition of ['system', `personal/${member}`])
      expect(
        safeExistsSync(
          path.join(
            g.root,
            'active/shared/runtime/asset-derivations',
            partition,
            'derivations.jsonl'
          )
        )
      ).toBe(false);
  });

  it('lists derived paths for the custodian (janitor query surface)', () => {
    const root2 = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `asset-derivation-q-${randomUUID()}`
    );
    write(root2, 'knowledge/confidential/beta-co/docs/a.md');
    write(root2, 'knowledge/confidential/beta-co/docs/b.md');
    recordDerivation({
      derived: { path: 'knowledge/confidential/beta-co/docs/b.md', kind: 'summary' },
      sources: [{ kind: 'path', path: 'knowledge/confidential/beta-co/docs/a.md' }],
      options: { rootDir: root2 },
    });
    expect(
      listDerivedPathsForCustodian({ kind: 'tenant', ref: 'beta-co' }, { rootDir: root2 })
    ).toEqual(['knowledge/confidential/beta-co/docs/b.md']);
    safeRmSync(root2, { recursive: true, force: true });
  });
});
