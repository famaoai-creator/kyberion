import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { readTextFile } from '@agent/core/foundation';
import { withExecutionContext } from '@agent/core/governance';
import { deriveAssetId, readAssetLedger } from '@agent/core/ingest-asset-ledger';
import { validateWritePermission } from '@agent/core/tier-guard';
import { scratchCandidateId } from '@agent/core/scratch-promotion-grace';
import {
  SCRATCH_PROMOTE_FOLLOW_UP,
  assertToolName,
  buildToolManifest,
  buildToolReadme,
  collectScratchFiles,
  candidateScanRoots,
  detectEntrypoints,
  findScratchCandidateDir,
  planForcedReplacement,
  resolveScratchSourcePath,
  runCommandFor,
  runScratchPromotion,
  type ScratchFile,
} from './scratch_promote.js';

// Tenants named vitestledger* resolve to a knowledge root inside a tmp
// fixture, so tenant promotions (tool files + asset ledger) stay hermetic.
vi.mock('@agent/core/organization/tenant-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/organization/tenant-registry')>();
  return {
    ...actual,
    resolveTenant: (slug: string, ...rest: unknown[]) =>
      slug.startsWith('vitestledger')
        ? ({
            slug,
            knowledge_root: `active/shared/tmp/vitest-scratch-ledger-${process.pid}/knowledge/confidential/${slug}`,
          } as unknown as ReturnType<typeof actual.resolveTenant>)
        : actual.resolveTenant(slug, ...(rest as [])),
  };
});

const FIXTURE_REPO_DIR = `active/shared/tmp/vitest-scratch-promote-${process.pid}`;
const fixtureDir = () => pathResolver.rootResolve(FIXTURE_REPO_DIR);

function seed(relative: string, content: string): void {
  const target = nodePath.join(fixtureDir(), ...relative.split('/'));
  safeMkdir(nodePath.dirname(target), { recursive: true });
  safeWriteFile(target, content);
}

const file = (path: string, content = 'x'): ScratchFile => ({ path, content, sha256: 'h' });

describe('scratch:promote', () => {
  beforeEach(() => {
    seed('work/build.ts', 'console.log(1);\n');
    seed('work/flow.json', JSON.stringify({ steps: [] }));
    seed('work/notes.md', '# notes\n');
    seed('work/out.pptx', 'binary');
    seed('work/node_modules/dep/index.js', 'export default 1;');
  });

  afterEach(() => {
    safeRmSync(fixtureDir(), { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('accepts only directories below the scratch roots', () => {
    expect(resolveScratchSourcePath('active/shared/tmp/job/work/')).toBe(
      'active/shared/tmp/job/work'
    );
    expect(resolveScratchSourcePath('active/missions/public/MSN-X/scratch')).toBe(
      'active/missions/public/MSN-X/scratch'
    );
    expect(() => resolveScratchSourcePath('active/shared/tmp')).toThrow('source refused');
    expect(() => resolveScratchSourcePath('libs/core')).toThrow(
      /source refused — .* \| pass a directory under .* \| evidence: /
    );
    expect(() => resolveScratchSourcePath('../outside')).toThrow('source refused');
  });

  it('validates tool names', () => {
    expect(assertToolName('deck-builder')).toBe('deck-builder');
    expect(() => assertToolName('Deck Builder')).toThrow('invalid --name');
    expect(() => assertToolName(undefined)).toThrow('invalid --name');
  });

  it('copies authored text files and skips binaries and vendored trees', () => {
    const { files, skipped } = collectScratchFiles(fixtureDir());
    expect(files.map((entry) => entry.path)).toEqual([
      'work/build.ts',
      'work/flow.json',
      'work/notes.md',
    ]);
    expect(files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(skipped).toEqual(
      expect.arrayContaining([
        { path: 'work/node_modules', reason: 'vendored' },
        { path: 'work/out.pptx', reason: 'not an authored text format' },
      ])
    );
  });

  it('detects entry points and a best-effort run command', () => {
    const files = [file('build.ts'), file('lib/util.ts'), file('notes.md')];
    expect(detectEntrypoints(files)).toEqual(['build.ts']);
    expect(detectEntrypoints([file('make.py')])).toEqual(['make.py']);
    expect(detectEntrypoints([file('a.ts'), file('b.ts')])).toEqual([]);
    expect(detectEntrypoints(files, './lib/util.ts')).toEqual(['lib/util.ts']);
    expect(() => detectEntrypoints(files, 'missing.ts')).toThrow('--entry');
    expect(runCommandFor('k/t', 'build.ts', files)).toBe('node_modules/.bin/tsx k/t/build.ts');
    expect(runCommandFor('k/t', 'run.sh', files)).toBe('bash k/t/run.sh');
    expect(runCommandFor('k/t', 'flow.json', [file('flow.json', '{"steps":[]}')])).toBe(
      'pnpm pipeline --input k/t/flow.json'
    );
    expect(runCommandFor('k/t', undefined, files)).toBeNull();
  });

  it('writes the TOOL.json contract and a README with frontmatter', () => {
    const manifest = buildToolManifest({
      name: 'deck-builder',
      sourceRepoPath: 'active/shared/tmp/confidential/acme/media/j1',
      sourceTier: 'confidential',
      sourceTenant: 'acme',
      targetRepoDir: 'knowledge/confidential/acme/tools/deck-builder',
      files: [file('build.ts')],
      entrypoints: ['build.ts'],
      promotedAt: '2026-10-20T00:00:00.000Z',
    });
    expect(manifest).toEqual({
      name: 'deck-builder',
      promoted_at: '2026-10-20T00:00:00.000Z',
      source: {
        path: 'active/shared/tmp/confidential/acme/media/j1',
        tier: 'confidential',
        tenant: 'acme',
      },
      target: 'knowledge/confidential/acme/tools/deck-builder',
      files: [{ path: 'build.ts', sha256: 'h' }],
      entrypoints: ['build.ts'],
      run: 'node_modules/.bin/tsx knowledge/confidential/acme/tools/deck-builder/build.ts',
      inputs: [],
      follow_up: SCRATCH_PROMOTE_FOLLOW_UP,
    });
    const readme = buildToolReadme(manifest, 'acme');
    expect(readme.startsWith("---\ntitle: 'deck-builder (promoted scratch tool)'")).toBe(true);
    expect(readme).toContain('last_updated: 2026-10-20');
  });

  it('dry-runs a public promotion end to end without writing', async () => {
    const printed: unknown[] = [];
    vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
      printed.push(value);
    });
    await runScratchPromotion([
      '--from',
      `${FIXTURE_REPO_DIR}/work`,
      '--name',
      'vitest-scratch-tool',
      '--public',
      '--source-is-public',
      '--dry-run',
    ]);
    const output = JSON.parse(String(printed.at(-1)));
    expect(output.target).toBe('knowledge/public/tools/vitest-scratch-tool');
    expect(output.manifest.entrypoints).toEqual(['build.ts']);
    expect(output.manifest.files.map((entry: { path: string }) => entry.path)).toEqual([
      'build.ts',
      'flow.json',
      'notes.md',
    ]);
  });

  it('plans a --force replacement: drops stale listed files, refuses unlisted ones', () => {
    expect(
      planForcedReplacement({
        previousFiles: ['build.ts', 'old.ts', '../escape.ts', '/abs.ts'],
        existingFiles: ['build.ts', 'old.ts', 'TOOL.json', 'README.md'],
        nextFiles: ['build.ts', 'new.ts'],
      })
    ).toEqual({ remove: ['old.ts'], unlisted: [] });
    expect(
      planForcedReplacement({
        previousFiles: ['build.ts'],
        existingFiles: ['build.ts', 'hand-added.md'],
        nextFiles: ['build.ts'],
      }).unlisted
    ).toEqual(['hand-added.md']);
  });

  it('refuses a public promotion of tier-unknown scratch without --source-is-public', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors: string[] = [];
    const { logger } = await import('@agent/core/core');
    vi.spyOn(logger, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    await runScratchPromotion([
      '--from',
      `${FIXTURE_REPO_DIR}/work`,
      '--name',
      'vitest-scratch-tool',
      '--public',
      '--dry-run',
    ]).catch(() => undefined);
    expect(errors.join('\n')).toContain('[scratch:promote] public promotion refused');
  });

  describe('--candidate', () => {
    const tenant = `vitestcand${process.pid}`.slice(0, 30);
    const otherTenant = `vitestother${process.pid}`.slice(0, 30);
    const salt = 'b'.repeat(64);
    const jobDir = `active/shared/tmp/confidential/${tenant}/media/job-${process.pid}`;
    const asTenant = <T>(slug: string, fn: () => T): T =>
      withExecutionContext('asset_promoter', fn, undefined, slug);

    beforeEach(() => {
      asTenant(tenant, () => {
        const target = pathResolver.rootResolve(`${jobDir}/build.ts`);
        safeMkdir(nodePath.dirname(target), { recursive: true });
        safeWriteFile(target, 'export {};\n');
      });
    });

    afterEach(() => {
      asTenant(tenant, () =>
        safeRmSync(pathResolver.rootResolve(`active/shared/tmp/confidential/${tenant}`), {
          recursive: true,
          force: true,
        })
      );
    });

    it('scans only the tenant own tmp/staging partitions', () => {
      expect(candidateScanRoots('acme')).toEqual([
        'active/shared/tmp/confidential/acme',
        'active/shared/tmp/public/acme',
        'active/shared/staging/confidential/acme',
        'active/shared/staging/public/acme',
      ]);
    });

    it('resolves the job dir whose salted id matches, inside the owning tenant only', () => {
      const id = scratchCandidateId(jobDir, salt);
      expect(asTenant(tenant, () => findScratchCandidateDir(id, tenant, salt))).toBe(jobDir);
      expect(
        asTenant(tenant, () => findScratchCandidateDir(id, tenant, 'c'.repeat(64)))
      ).toBeNull();
      expect(
        asTenant(otherTenant, () => findScratchCandidateDir(id, otherTenant, salt))
      ).toBeNull();
    });

    it('refuses --candidate together with --public or --from', async () => {
      const errors: string[] = [];
      const { logger } = await import('@agent/core/core');
      vi.spyOn(logger, 'error').mockImplementation((message: unknown) => {
        errors.push(String(message));
      });
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await runScratchPromotion(['--candidate', 'a'.repeat(16), '--public', '--name', 'x']).catch(
        () => undefined
      );
      expect(errors.join('\n')).toContain('--candidate replaces --from and only targets a tenant');
    });
  });

  describe('tenant asset ledger', () => {
    const tenant = `vitestledger${process.pid}`.slice(0, 30);
    const ledgerRoot = `active/shared/tmp/vitest-scratch-ledger-${process.pid}`;
    const knowledgeRoot = `${ledgerRoot}/knowledge/confidential/${tenant}`;
    const toolDir = `${knowledgeRoot}/tools/ledger-tool`;
    const source = `${FIXTURE_REPO_DIR}/work`;
    const ledger = () => readAssetLedger(tenant, { knowledgeRoot });
    const ledgerFile = () => pathResolver.rootResolve(`${knowledgeRoot}/_ledger/assets.jsonl`);

    async function promote(extra: string[] = []): Promise<Record<string, unknown>> {
      const printed: unknown[] = [];
      vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
        printed.push(value);
      });
      await runScratchPromotion([
        '--from',
        source,
        '--name',
        'ledger-tool',
        '--tenant',
        tenant,
        ...extra,
      ]);
      return JSON.parse(String(printed.at(-1)));
    }

    beforeEach(() => {
      vi.stubEnv('KYBERION_PERSONA', 'vitest-promoter');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      safeRmSync(pathResolver.rootResolve(ledgerRoot), { recursive: true, force: true });
    });

    it('writes no ledger record on --dry-run', async () => {
      await promote(['--dry-run']);
      expect(safeExistsSync(ledgerFile())).toBe(false);
    });

    it('appends a tenant asset record hashed over the written TOOL.json', async () => {
      const output = await promote();
      const toolJson = readTextFile(pathResolver.rootResolve(`${toolDir}/TOOL.json`));
      const assetId = deriveAssetId('scratch', source);
      expect(ledger()).toEqual([
        expect.objectContaining({
          asset_id: assetId,
          source_system: 'scratch',
          source_id: source,
          content_sha256: createHash('sha256').update(toolJson).digest('hex'),
          ingested_by: 'vitest-promoter',
          visible_to: [tenant],
          transform_chain: ['scratch_promote:tool'],
          target_path: `${toolDir}/TOOL.json`,
          version: 1,
          status: 'active',
        }),
      ]);
      expect(ledger()[0].supersedes).toBeUndefined();
      expect(output.asset).toEqual({
        asset_id: assetId,
        version: 1,
        ref: `asset:${assetId}@v1`,
        recorded: true,
      });
      // The ref lives in the marker and the result, never inside TOOL.json.
      expect(toolJson).not.toContain(assetId);
      const marker = JSON.parse(
        String(
          safeReadFile(pathResolver.rootResolve(`${source}/.scratch-promoted.json`), {
            encoding: 'utf8',
          })
        )
      );
      expect(marker.asset).toBe(`asset:${assetId}@v1`);
    });

    it('does not duplicate the record when identical content is re-promoted', async () => {
      await promote();
      const firstToolJson = readTextFile(pathResolver.rootResolve(`${toolDir}/TOOL.json`));
      const output = await promote(['--force']);
      expect(readTextFile(pathResolver.rootResolve(`${toolDir}/TOOL.json`))).toBe(firstToolJson);
      expect(ledger()).toHaveLength(1);
      expect(output.asset).toMatchObject({ version: 1, recorded: false });
    });

    it('supersedes the previous version on a --force re-promotion with new content', async () => {
      await promote();
      seed('work/build.ts', 'console.log(2);\n');
      const output = await promote(['--force']);
      const assetId = deriveAssetId('scratch', source);
      const records = ledger();
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({
        asset_id: assetId,
        version: 2,
        supersedes: `${assetId}@v1`,
        status: 'active',
      });
      expect(records[1].content_sha256).not.toBe(records[0].content_sha256);
      expect(output.asset).toMatchObject({
        ref: `asset:${assetId}@v2`,
        recorded: true,
        supersedes: `${assetId}@v1`,
      });
    });

    it('refuses an anonymous tenant promotion before writing anything', async () => {
      vi.stubEnv('KYBERION_PERSONA', '');
      vi.stubEnv('MISSION_ROLE', '');
      const errors: string[] = [];
      const { logger } = await import('@agent/core/core');
      vi.spyOn(logger, 'error').mockImplementation((message: unknown) => {
        errors.push(String(message));
      });
      await promote().catch(() => undefined);
      expect(errors.join('\n')).toContain('no identity for the asset ledger');
      expect(safeExistsSync(pathResolver.rootResolve(`${toolDir}/TOOL.json`))).toBe(false);
      expect(safeExistsSync(ledgerFile())).toBe(false);
    });

    it('records nothing for public promotions (the ledger call is tenant-only)', () => {
      const source = readTextFile(pathResolver.rootResolve('scripts/scratch_promote.ts'));
      const ledgerBlock = source.slice(source.indexOf('let ledgerPlan'));
      expect(ledgerBlock.slice(0, ledgerBlock.indexOf('planPromotionAsset('))).toContain(
        'if (tenant) {'
      );
      expect(source.match(/planPromotionAsset\(/gu)).toHaveLength(1);
      expect(source).toContain('if (tenant && ledgerPlan) {');
    });

    it('grants asset_promoter only its bound tenant ledger', () => {
      const allowed = (tenantSlug: string, relative: string, op: 'write' | 'mkdir' = 'write') =>
        withExecutionContext(
          'asset_promoter',
          () => validateWritePermission(pathResolver.rootResolve(relative), op).allowed,
          undefined,
          tenantSlug
        );
      expect(allowed('acme', 'knowledge/confidential/acme/_ledger/assets.jsonl')).toBe(true);
      expect(allowed('acme', 'knowledge/confidential/acme/_ledger', 'mkdir')).toBe(true);
      expect(allowed('acme', 'knowledge/confidential/other/_ledger/assets.jsonl')).toBe(false);
      expect(allowed('acme', 'knowledge/confidential/acme/reports/card.md')).toBe(false);
    });
  });
});
