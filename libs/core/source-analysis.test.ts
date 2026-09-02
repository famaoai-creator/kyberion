import * as path from 'node:path';

import Ajv from 'ajv';

import { describe, expect, it } from 'vitest';

import {
  analyzeSourceTree,
  compileSchemaFromPath,
  compileEngineeringArtifacts,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
  writeEngineeringArtifactBundle,
} from './index.js';

const ROOT = path.resolve(process.cwd());
const FIXTURE = path.join(ROOT, 'active/shared/tmp/source-analysis-tests/sample-app');

function prepareFixture(): void {
  safeRmSync(FIXTURE, { recursive: true, force: true });
  safeMkdir(FIXTURE, { recursive: true });
  safeMkdir(path.join(FIXTURE, 'src'), { recursive: true });
  safeMkdir(path.join(FIXTURE, 'src/__tests__'), { recursive: true });
  safeMkdir(path.join(FIXTURE, 'knowledge'), { recursive: true });
  safeMkdir(path.join(FIXTURE, 'active'), { recursive: true });
  safeMkdir(path.join(FIXTURE, '.codex'), { recursive: true });
  safeWriteFile(
    path.join(FIXTURE, 'package.json'),
    JSON.stringify({ dependencies: { express: '^5.0.0' }, devDependencies: { vitest: '^4.0.0' } })
  );
  safeWriteFile(
    path.join(FIXTURE, 'src/app.ts'),
    `import express from 'express';\nconst app = express();\napp.get('/health', (_req, res) => res.send('ok'));\nexport const appName = 'sample';\n`
  );
  safeWriteFile(
    path.join(FIXTURE, 'src/metadata.ts'),
    `export const metadata = 'kind: TENANT_INGEST_DEFAULT_KIND';\n`
  );
  safeWriteFile(
    path.join(FIXTURE, 'src/__tests__/app.test.ts'),
    `import { describe, expect, it } from 'vitest';\ndescribe('health', () => { it('returns ok', () => { expect(true).toBe(true); }); });\n`
  );
  safeWriteFile(
    path.join(FIXTURE, 'main.tf'),
    `provider "aws" {}\nresource "aws_s3_bucket" "sample" {}\n`
  );
  safeWriteFile(path.join(FIXTURE, 'knowledge/internal.ts'), 'export const secret = true;\n');
  safeWriteFile(path.join(FIXTURE, 'active/mission.ts'), 'export const mission = true;\n');
  safeWriteFile(path.join(FIXTURE, '.codex/state.ts'), 'export const state = true;\n');
  safeWriteFile(path.join(FIXTURE, '.env'), 'TOKEN=should-not-be-read\n');
}

describe('source-analysis compiler', () => {
  it('builds a deterministic IR and all governed engineering artifacts', () => {
    prepareFixture();
    const analysis = analyzeSourceTree({
      sourceRoot: 'active/shared/tmp/source-analysis-tests/sample-app',
    });

    expect(analysis.kind).toBe('source-analysis-ir');
    expect(analysis.scan).toMatchObject({
      max_files: 2000,
      files_observed: analysis.file_count,
      truncated: false,
    });
    expect(analysis.source_file_count).toBe(2);
    expect(analysis.test_file_count).toBe(1);
    expect(analysis.iac_file_count).toBe(1);
    expect(analysis.files.map((file) => file.path)).not.toContain('knowledge/internal.ts');
    expect(analysis.files.map((file) => file.path)).not.toContain('active/mission.ts');
    expect(analysis.files.map((file) => file.path)).not.toContain('.codex/state.ts');
    expect(analysis.files.map((file) => file.path)).not.toContain('.env');
    expect(analysis.routes).toEqual([{ method: 'GET', path: '/health', source: 'src/app.ts' }]);
    expect(analysis.dependencies).toContain('express');
    expect(analysis.tests[0].framework).toBe('vitest');
    expect(analysis.tests[0].assertion_count).toBe(1);
    expect(analysis.tests[0].behavior_categories).toContain('happy-path');
    expect(analysis.tests[0].execution_mode).toBe('safe_auto');

    const bundle = compileEngineeringArtifacts({
      analysis,
      projectId: 'sample-app',
      targetProvider: 'aws',
    });
    expect(bundle.design_document).toContain('Source-derived Engineering Design');
    expect(bundle.design_document).toContain('Module and Dependency Signals');
    expect(bundle.design_document).toContain('src/app.ts');
    expect(bundle.test_inventory.items as Array<Record<string, unknown>>).toHaveLength(2);
    const inventoryItems = bundle.test_inventory.items as Array<Record<string, unknown>>;
    expect(inventoryItems.find((item) => item.item_id === 'SRC-ROUTE-002')).toMatchObject({
      requirement_refs: ['source:active/shared/tmp/source-analysis-tests/sample-app/src/app.ts'],
    });
    expect(inventoryItems.find((item) => item.item_id === 'SRC-TEST-001')).toMatchObject({
      steps: expect.arrayContaining([
        expect.stringContaining('verify 1 statically detected assertion expression(s).'),
      ]),
      test_level: 'unit',
    });
    expect(bundle.test_scenario_pipeline.context).toMatchObject({
      deferred: [expect.objectContaining({ id: 'SRC-ROUTE-002' })],
    });
    expect(bundle.test_scenario_pipeline.steps).toHaveLength(1);
    expect(bundle.iac_proposal.status).toBe('proposal-only');
    expect(bundle.iac_proposal.terraform).toContain('required_providers');
    expect(bundle.iac_proposal.terraform).toContain('provider "aws"');
    expect(bundle.iac_proposal.terraform).toContain('resource "aws_s3_bucket" "source_detected"');

    const validate = compileSchemaFromPath(
      new Ajv({ allErrors: true }),
      path.join(ROOT, 'knowledge/product/schemas/test-inventory.schema.json')
    );
    expect(validate(bundle.test_inventory)).toBe(true);

    const outputDir = 'active/shared/tmp/source-analysis-tests/output';
    const outputs = writeEngineeringArtifactBundle(bundle, outputDir);
    expect(outputs.analysis_ir).toBe(`${outputDir}/source-analysis-ir.json`);
    expect(safeExistsSync(path.join(ROOT, outputs.design_document))).toBe(true);
    expect(
      String(safeReadFile(path.join(ROOT, outputs.test_scenario_pipeline), { encoding: 'utf8' }))
    ).toContain('code:run_tests');
  });

  it('does not create executable IaC without a target provider', () => {
    prepareFixture();
    const analysis = analyzeSourceTree({
      sourceRoot: 'active/shared/tmp/source-analysis-tests/sample-app',
    });
    const bundle = compileEngineeringArtifacts({ analysis });

    expect(bundle.iac_proposal.status).toBe('blocked-no-target-provider');
    expect(bundle.iac_proposal.validation_commands).toEqual([]);
    expect(bundle.iac_proposal.terraform).toContain('No target_provider');
  });

  it('does not load dependencies from a symlinked package manifest', () => {
    prepareFixture();
    const packagePath = path.join(FIXTURE, 'package.json');
    const targetPath = path.join(FIXTURE, 'package-target.json');
    safeRmSync(packagePath, { force: true });
    safeWriteFile(targetPath, JSON.stringify({ dependencies: { should_not_be_loaded: '^1.0.0' } }));
    safeSymlinkSync(targetPath, packagePath);

    const analysis = analyzeSourceTree({
      sourceRoot: 'active/shared/tmp/source-analysis-tests/sample-app',
    });

    expect(analysis.dependencies).not.toContain('should_not_be_loaded');
  });

  it('requires approval for tests with external side-effect signals', () => {
    prepareFixture();
    safeWriteFile(
      path.join(FIXTURE, 'src/__tests__/network.test.ts'),
      `import { it } from 'vitest';\nit('calls an external service', async () => { await fetch('https://example.test'); });\n`
    );
    const analysis = analyzeSourceTree({
      sourceRoot: 'active/shared/tmp/source-analysis-tests/sample-app',
    });
    const networkTest = analysis.tests.find((test) => test.path.endsWith('network.test.ts'));
    expect(networkTest?.execution_mode).toBe('approval_required');
    expect(networkTest?.side_effect_signals).toContain('network-request');

    const bundle = compileEngineeringArtifacts({ analysis, projectId: 'sample-app' });
    const inventory = bundle.test_inventory.items as Array<Record<string, unknown>>;
    expect(inventory.find((item) => item.item_id === networkTest?.id)).toMatchObject({
      execution_mode: 'approval_required',
      omission_reason: expect.stringContaining('network-request'),
    });
    expect(bundle.test_scenario_pipeline.steps).toHaveLength(1);
    expect((bundle.test_scenario_pipeline.context as { deferred: unknown[] }).deferred).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: networkTest?.id, mode: 'approval_required' }),
      ])
    );
  });

  it('rejects artifact output outside governed active storage', () => {
    prepareFixture();
    const analysis = analyzeSourceTree({
      sourceRoot: 'active/shared/tmp/source-analysis-tests/sample-app',
    });
    const bundle = compileEngineeringArtifacts({ analysis });

    expect(() => writeEngineeringArtifactBundle(bundle, 'docs/generated')).toThrow(
      'Engineering artifact output must stay under active/shared/tmp or active/missions'
    );
  });

  it('rejects an invalid artifact bundle before writing', () => {
    prepareFixture();
    const analysis = analyzeSourceTree({
      sourceRoot: 'active/shared/tmp/source-analysis-tests/sample-app',
    });
    const bundle = compileEngineeringArtifacts({ analysis });
    const invalid = JSON.parse(JSON.stringify(bundle));
    invalid.analysis_ir.kind = 'invalid';
    expect(() =>
      writeEngineeringArtifactBundle(invalid, 'active/shared/tmp/source-analysis-tests/invalid')
    ).toThrow('[SOURCE_ARTIFACT_SCHEMA] source-analysis-ir is invalid');
  });

  it('rejects schema-compatible but semantically invalid test inventory values', () => {
    prepareFixture();
    const analysis = analyzeSourceTree({
      sourceRoot: 'active/shared/tmp/source-analysis-tests/sample-app',
    });
    const bundle = compileEngineeringArtifacts({ analysis });
    const invalid = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    invalid.test_inventory.project_id = '   ';

    expect(() =>
      writeEngineeringArtifactBundle(
        invalid,
        'active/shared/tmp/source-analysis-tests/invalid-semantic'
      )
    ).toThrow('[SOURCE_ARTIFACT_SCHEMA] source-test-inventory is invalid');
  });
});
