import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { deriveAssetId, readAssetLedger } from '@agent/core/ingest-asset-ledger';
import {
  buildTenantPipelineCatalog,
  keepPipelinePromotedAtWhenUnchanged,
  runPipelinePromotion,
  tenantPipelineNextSteps,
  tenantPipelineRunCommand,
  normalizePromotionAdvice,
  readPipelinePromotionTextFile,
  resolvePromotionInputPath,
} from './pipeline_promote.js';
import { assertPromotionSourceScope } from './lib/promotion-scope.js';

// Tenants named vitestledger* resolve to a knowledge root inside a tmp
// fixture, so tenant promotions (pipeline + README + asset ledger) stay hermetic.
vi.mock('@agent/core/organization/tenant-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/organization/tenant-registry')>();
  return {
    ...actual,
    resolveTenant: (slug: string, ...rest: unknown[]) =>
      slug.startsWith('vitestledger')
        ? ({
            slug,
            knowledge_root: `active/shared/tmp/vitest-pipeline-ledger-${process.pid}/knowledge/confidential/${slug}`,
          } as unknown as ReturnType<typeof actual.resolveTenant>)
        : actual.resolveTenant(slug, ...(rest as [])),
  };
});

describe('pipeline promotion resource boundaries', () => {
  it('uses the governed parser for model promotion advice', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/pipeline_promote.ts'));
    expect(source).toContain("parseSafeJsonInput(jsonText, 'pipeline promotion advice')");
    expect(source).toContain('loadPipelineAdfAtPath(resolvedInput)');
    expect(source).not.toContain('readJson<unknown>(resolvedInput)');
    expect(source).not.toContain('JSON.parse(jsonText)');
    expect(source).toContain('readTextFile');
    expect(source).toContain('readPipelinePromotionTextFile(filePath: string)');
  });

  it('rejects external and non-file sources before promotion', () => {
    expect(() => resolvePromotionInputPath('/tmp/pipeline.json')).toThrow('[RESOURCE_PATH_SCOPE]');
    expect(() => resolvePromotionInputPath('pipelines')).toThrow(
      'source ADF must be an existing regular file'
    );
  });

  it('projects only valid promotion advice entries', () => {
    expect(
      normalizePromotionAdvice({
        name: ' reusable ',
        placeholders: [
          { step_index: 1, param_path: 'params.url', placeholder: 'target_url' },
          { step_index: -1, param_path: 'params.bad', placeholder: 'ignored' },
        ],
        semantic_step_indices: [2, -1, 'bad'],
      })
    ).toEqual({
      name: ' reusable ',
      placeholders: [{ step_index: 1, param_path: 'params.url', placeholder: 'target_url' }],
      semantic_step_indices: [2],
    });
  });

  it('rejects primitive and array promotion advice roots', () => {
    expect(normalizePromotionAdvice(null)).toBeNull();
    expect(normalizePromotionAdvice([])).toBeNull();
    expect(normalizePromotionAdvice('invalid')).toBeNull();
  });

  it('rejects a directory before reading the pipeline catalog', () => {
    expect(() => readPipelinePromotionTextFile(pathResolver.rootResolve('pipelines'))).toThrow(
      'must be a regular file'
    );
  });

  it('refuses a public promotion of tier-unknown (unpartitioned) scratch without acknowledgement', () => {
    expect(() => assertPromotionSourceScope('active/shared/tmp/job/flow.json', undefined)).toThrow(
      /unpartitioned scratch whose tier is unknown \| rerun with --tenant <slug> .* --source-is-public \| evidence: /
    );
    expect(
      assertPromotionSourceScope('active/shared/tmp/job/flow.json', undefined, 'pipeline:promote', {
        sourceIsPublic: true,
      })
    ).toBeNull();
    expect(assertPromotionSourceScope('active/shared/tmp/job/flow.json', 'acme')).toBeNull();
    expect(assertPromotionSourceScope('pipelines/flow.json', undefined)).toBeNull();
    expect(
      assertPromotionSourceScope('active/shared/tmp/system/d/j/flow.json', undefined)
    ).toBeNull();
  });

  it('refuses case-variant tier paths the same way', () => {
    expect(() =>
      assertPromotionSourceScope(
        'active/shared/tmp/Confidential/acme/d/j/flow.json',
        undefined,
        'x',
        {
          sourceIsPublic: true,
        }
      )
    ).toThrow('public promotion refused');
    expect(() =>
      assertPromotionSourceScope('knowledge/Confidential/acme/flow.json', 'other')
    ).toThrow('cross-tenant promotion refused');
  });

  it('refuses a public promotion of tier- or tenant-bound sources and points at --tenant', () => {
    expect(() =>
      assertPromotionSourceScope('active/shared/tmp/confidential/acme/d/j/flow.json', undefined)
    ).toThrow(/public promotion refused — .* \| rerun with --tenant acme .* \| evidence: /);
    expect(() =>
      assertPromotionSourceScope('knowledge/personal/notes/flow.json', undefined)
    ).toThrow('public promotion refused');
    expect(() =>
      assertPromotionSourceScope('active/missions/confidential/acme/MSN-X/flow.json', undefined)
    ).toThrow('--tenant acme');
  });

  it('allows the same tenant and refuses personal or cross-tenant sources in tenant mode', () => {
    expect(assertPromotionSourceScope('active/shared/tmp/job/flow.json', 'acme')).toBeNull();
    expect(
      assertPromotionSourceScope('active/shared/tmp/confidential/acme/d/j/flow.json', 'acme')
    ).toMatchObject({ tier: 'confidential', tenant: 'acme' });
    expect(() =>
      assertPromotionSourceScope('active/shared/tmp/confidential/acme/d/j/flow.json', 'other')
    ).toThrow('cross-tenant promotion refused');
    expect(() =>
      assertPromotionSourceScope('active/shared/tmp/personal/shared/d/j/flow.json', 'acme')
    ).toThrow('personal-tier data never leaves the personal tier');
  });

  it('creates and appends the tenant catalog README without duplicating rows', () => {
    const row = {
      slug: 'deck',
      command: tenantPipelineRunCommand('knowledge/confidential/acme/pipelines/deck.json'),
      description: 'Board | deck',
    };
    const created = buildTenantPipelineCatalog(null, 'acme', row);
    expect(created).toContain('`pnpm kyberion project-trust request <path>`');
    expect(created).toContain('re-request after every change');
    expect(created).toContain("title: 'acme pipelines'");
    expect(created).toContain('last_updated: ');
    expect(created).toContain(
      '| `deck` | `pnpm pipeline --input knowledge/confidential/acme/pipelines/deck.json --project-trust-approval <id>` | Board \\| deck |'
    );
    expect(buildTenantPipelineCatalog(created, 'acme', row)).toBeNull();
    const appended = buildTenantPipelineCatalog(created, 'acme', { ...row, slug: 'memo' });
    expect(appended?.split('\n').filter((line) => line.startsWith('| `'))).toHaveLength(2);
  });

  it('never writes the public pipelines/README.md on the tenant path', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/pipeline_promote.ts'));
    const tenantBranch = source.slice(
      source.indexOf('if (tenant && tenantKnowledgeRoot) {'),
      source.indexOf('fail(`[promote] pipelines/${slug}.json already exists')
    );
    expect(tenantBranch).toContain('appendTenantCatalogRow(');
    expect(tenantBranch).toContain('next_steps: nextSteps');
    expect(tenantBranch).not.toContain('appendCatalogRow(slug');
    expect(tenantBranch).toContain("'asset_promoter'");
  });

  it('names the project-trust request, approval and governed run as tenant next steps', () => {
    expect(tenantPipelineNextSteps('knowledge/confidential/acme/pipelines/deck.json')).toEqual([
      'pnpm kyberion project-trust request knowledge/confidential/acme/pipelines/deck.json',
      'a human approves the request (approval is bound to this exact content; re-request after every change)',
      'pnpm pipeline --input knowledge/confidential/acme/pipelines/deck.json --project-trust-approval <id>',
    ]);
    // The next step is emitted on every tenant promotion (dry run and --force
    // included), not only when a README row is added.
    const source = readTextFile(pathResolver.rootResolve('scripts/pipeline_promote.ts'));
    const rowFn = source.slice(source.indexOf('function appendTenantCatalogRow('));
    expect(rowFn.slice(0, rowFn.indexOf('\n}\n'))).not.toContain('project-trust');
    expect(source).toContain("${dryRun ? '(dry-run) ' : ''}next: ");
  });

  describe('tenant asset ledger', () => {
    const tenant = `vitestledger${process.pid}`.slice(0, 30);
    const fixture = `active/shared/tmp/vitest-pipeline-ledger-${process.pid}`;
    const knowledgeRoot = `${fixture}/knowledge/confidential/${tenant}`;
    const sourcePath = `${fixture}/src/flow.json`;
    const target = `${knowledgeRoot}/pipelines/ledger-flow.json`;
    const ledger = () => readAssetLedger(tenant, { knowledgeRoot });
    const writeSource = (message: string) => {
      const absolute = pathResolver.rootResolve(sourcePath);
      safeMkdir(nodePath.dirname(absolute), { recursive: true });
      safeWriteFile(
        absolute,
        JSON.stringify({
          name: 'ledger-flow',
          action: 'pipeline',
          description: 'ledger fixture',
          steps: [{ op: 'core:log', params: { message } }],
        })
      );
    };
    const promote = (extra: string[] = []) =>
      runPipelinePromotion([
        '--input',
        sourcePath,
        '--name',
        'ledger-flow',
        '--tenant',
        tenant,
        '--no-llm',
        ...extra,
      ]);

    beforeEach(() => {
      vi.stubEnv('KYBERION_PERSONA', 'vitest-promoter');
      writeSource('one');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      safeRmSync(pathResolver.rootResolve(fixture), { recursive: true, force: true });
    });

    it('writes no ledger record on --dry-run', async () => {
      const result = await promote(['--dry-run']);
      expect(result.asset).toBeUndefined();
      expect(safeExistsSync(pathResolver.rootResolve(`${knowledgeRoot}/_ledger`))).toBe(false);
    });

    it('records, dedups and supersedes tenant pipeline promotions', async () => {
      const assetId = deriveAssetId('adf', sourcePath);
      const first = await promote();
      const written = readTextFile(pathResolver.rootResolve(target));
      expect(ledger()).toEqual([
        expect.objectContaining({
          asset_id: assetId,
          source_system: 'adf',
          source_id: sourcePath,
          content_sha256: createHash('sha256').update(written).digest('hex'),
          ingested_by: 'vitest-promoter',
          visible_to: [tenant],
          transform_chain: ['pipeline_promote'],
          target_path: target,
          version: 1,
        }),
      ]);
      expect(first.asset).toEqual({
        asset_id: assetId,
        version: 1,
        ref: `asset:${assetId}@v1`,
        recorded: true,
      });

      const same = await promote(['--force']);
      expect(readTextFile(pathResolver.rootResolve(target))).toBe(written);
      expect(ledger()).toHaveLength(1);
      expect(same.asset).toMatchObject({ version: 1, recorded: false });

      writeSource('two');
      const changed = await promote(['--force']);
      expect(ledger()).toHaveLength(2);
      expect(ledger()[1]).toMatchObject({ version: 2, supersedes: `${assetId}@v1` });
      expect(changed.asset).toMatchObject({ ref: `asset:${assetId}@v2`, recorded: true });
    });

    it('keeps promoted_at only when nothing else changed', () => {
      const previous = { name: 'a', promotion: { promoted_from: 'x', promoted_at: 'T1' } };
      expect(
        keepPipelinePromotedAtWhenUnchanged(previous, {
          name: 'a',
          promotion: { promoted_from: 'x', promoted_at: 'T2' },
        }).promotion.promoted_at
      ).toBe('T1');
      expect(
        keepPipelinePromotedAtWhenUnchanged(previous, {
          name: 'b',
          promotion: { promoted_from: 'x', promoted_at: 'T2' },
        }).promotion.promoted_at
      ).toBe('T2');
    });

    it('never records public promotions (ledger code sits in the tenant branch only)', () => {
      const source = readTextFile(pathResolver.rootResolve('scripts/pipeline_promote.ts'));
      const tenantStart = source.indexOf('if (tenant && tenantKnowledgeRoot) {');
      const publicStart = source.indexOf('fail(`[promote] pipelines/${slug}.json already exists');
      const publicBranch = source.slice(publicStart, source.indexOf('function logPlaceholders('));
      expect(source.indexOf('planPromotionAsset(')).toBeGreaterThan(tenantStart);
      expect(source.indexOf('planPromotionAsset(')).toBeLessThan(publicStart);
      expect(publicBranch).not.toMatch(
        /planPromotionAsset|commitPromotionAsset|resolvePromotionActor/u
      );
    });
  });
});
