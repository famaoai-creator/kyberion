import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { loadEvalHarnessTable, runEvalHarnessTable } from './eval_harness.js';

const RUN_PATH = `active/shared/tmp/pi18-eval-${process.pid}.jsonl`;
const TABLE_DIR = `active/shared/tmp/pi18-eval-table-${process.pid}`;
const TENANT_SLUG = `pi18-eval-${process.pid}`;
const TENANT_FACET_DIR = pathResolver.knowledge(`confidential/${TENANT_SLUG}/facets/personas`);
const TENANT_FACET_PATH = `${TENANT_FACET_DIR}/hot-apply.md`;

afterEach(() => {
  const path = pathResolver.rootResolve(RUN_PATH);
  if (safeExistsSync(path)) safeRmSync(path);
  const tableDir = pathResolver.rootResolve(TABLE_DIR);
  if (safeExistsSync(tableDir)) safeRmSync(tableDir, { recursive: true, force: true });
  const tenantRoot = pathResolver.knowledge(`confidential/${TENANT_SLUG}`);
  withExecutionContext(
    'sovereign_concierge',
    () => {
      if (safeExistsSync(tenantRoot)) safeRmSync(tenantRoot, { recursive: true, force: true });
    },
    undefined,
    TENANT_SLUG
  );
});

describe('PI-18 named eval harness table', () => {
  it('loads the checked-in A/B table and preserves named configurations', () => {
    expect(loadEvalHarnessTable().map((entry) => entry.name)).toEqual(['baseline', 'policy-aware']);
  });

  it('rejects a directory passed as the eval table resource', () => {
    const tableDir = pathResolver.rootResolve(TABLE_DIR);
    safeMkdir(tableDir, { recursive: true });
    expect(() => loadEvalHarnessTable(TABLE_DIR)).toThrow(/regular file/u);
  });

  it('runs the same brief across configurations and reloads facets in one session', async () => {
    const seen: Array<{ configuration: string; reloadCount: number }> = [];
    const result = await runEvalHarnessTable({
      table: loadEvalHarnessTable(),
      brief: 'compare the governed output',
      sessionId: 'session-pi18-test',
      runPath: RUN_PATH,
      steps: [
        { type: 'prompt', prompt: 'compare the governed output' },
        { type: 'reload' },
        { type: 'prompt', prompt: 'compare the governed output' },
      ],
      executor: (prompt, context) => {
        seen.push({ configuration: context.configuration.name, reloadCount: context.reloadCount });
        return `${context.configuration.name}:${context.reloadCount}:${prompt}`;
      },
    });

    expect(result.schema_version).toBe('pi-eval-harness.v1');
    expect(result.session_id).toBe('session-pi18-test');
    expect(result.step_types).toEqual(['prompt', 'reload', 'prompt']);
    expect(result.results).toHaveLength(2);
    expect(result.results.map((entry) => entry.prompt_receipts)).toHaveLength(2);
    expect(result.results[0]?.prompt_receipts[1]?.reload_count).toBe(1);
    expect(result.results[1]?.prompt_receipts[1]?.reload_count).toBe(1);
    expect(result.results[0]?.quality).toEqual({
      status: 'pass',
      average_score: 100,
      findings_count: 0,
    });
    expect(seen).toEqual([
      { configuration: 'baseline', reloadCount: 0 },
      { configuration: 'baseline', reloadCount: 1 },
      { configuration: 'policy-aware', reloadCount: 0 },
      { configuration: 'policy-aware', reloadCount: 1 },
    ]);
    expect(safeExistsSync(pathResolver.rootResolve(RUN_PATH))).toBe(true);
    expect(result.results[0]?.prompt_receipts[0]?.facet_content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.results[0]?.prompt_receipts[0]).toMatchObject({
      facet_contract_status: 'pass',
      facet_contract_finding_hashes: [],
    });
    expect(result.results[0]?.facet_contract).toEqual({
      status: 'pass',
      evaluated: 2,
      findings_count: 0,
    });
  });

  it('measures a tenant overlay hot-apply across reload without persisting facet content', async () => {
    withExecutionContext(
      'sovereign_concierge',
      () => {
        safeMkdir(TENANT_FACET_DIR, { recursive: true });
        safeWriteFile(
          TENANT_FACET_PATH,
          '---\ntitle: hot apply\n---\nTenant policy version one.\n'
        );
      },
      undefined,
      TENANT_SLUG
    );

    let promptCount = 0;
    const result = await withExecutionContextAsync(
      'sovereign_concierge',
      () =>
        runEvalHarnessTable({
          table: [
            {
              name: 'tenant-overlay',
              facet_request: { persona: 'hot-apply' },
            },
          ],
          brief: 'measure tenant overlay reload',
          sessionId: 'session-pi18-tenant-overlay',
          scope: { tier: 'confidential', tenantSlug: TENANT_SLUG },
          runPath: RUN_PATH,
          steps: [
            { type: 'prompt', prompt: 'measure tenant overlay reload' },
            { type: 'reload' },
            { type: 'prompt', prompt: 'measure tenant overlay reload' },
          ],
          executor: (_prompt, context) => {
            promptCount += 1;
            expect(context.facets.persona?.source).toBe('tenant');
            if (promptCount === 1) {
              expect(context.facets.persona?.content).toContain('version one');
              safeWriteFile(
                TENANT_FACET_PATH,
                '---\ntitle: hot apply\n---\nTenant policy version two.\n'
              );
            } else {
              expect(context.facets.persona?.content).toContain('version two');
            }
            return 'tenant overlay observed';
          },
        }),
      undefined,
      TENANT_SLUG
    );

    const receipts = result.results[0]?.prompt_receipts ?? [];
    expect(receipts).toHaveLength(2);
    expect(receipts[0]?.facet_content_hash).not.toBe(receipts[1]?.facet_content_hash);
    expect(result.results[0]?.final_facet_content_hash).toBe(receipts[1]?.facet_content_hash);
    expect(result.results[0]?.facet_contract.status).toBe('not_evaluated');
    const persisted = String(
      safeReadFile(pathResolver.rootResolve(RUN_PATH), { encoding: 'utf8' })
    );
    expect(persisted).not.toContain('Tenant policy version');
  });

  it('records an injected quality verdict for every prompt and aggregates it per configuration', async () => {
    const result = await runEvalHarnessTable({
      table: [{ name: 'quality-fixture' }],
      brief: 'judge this output',
      runPath: RUN_PATH,
      steps: [
        { type: 'prompt', prompt: 'good output' },
        { type: 'reload' },
        { type: 'prompt', prompt: 'needs review' },
      ],
      executor: (prompt) => (prompt === 'good output' ? 'accepted' : 'needs work'),
      qualityJudge: ({ output }) =>
        output === 'accepted'
          ? { status: 'pass', score: 100, findings: [] }
          : { status: 'warn', score: 60, findings: ['missing evidence'] },
    });

    expect(result.results[0]?.prompt_receipts).toMatchObject([
      { quality_status: 'pass', quality_score: 100, quality_finding_hashes: [] },
      {
        quality_status: 'warn',
        quality_score: 60,
        quality_finding_hashes: [expect.any(String)],
      },
    ]);
    expect(result.results[0]?.quality).toEqual({
      status: 'warn',
      average_score: 80,
      findings_count: 1,
    });
    const persisted = String(
      safeReadFile(pathResolver.rootResolve(RUN_PATH), { encoding: 'utf8' })
    );
    expect(persisted).not.toContain('missing evidence');
  });

  it('fails closed when an injected quality judge returns an invalid verdict', async () => {
    await expect(
      runEvalHarnessTable({
        table: [{ name: 'invalid-quality-fixture' }],
        brief: 'judge this output',
        runPath: RUN_PATH,
        qualityJudge: () => ({ status: 'pass', score: 101, findings: [] }),
      })
    ).rejects.toThrow('[EVAL_HARNESS_QUALITY] judge returned an invalid score.');
  });
});
