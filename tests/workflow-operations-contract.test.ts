import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Workflow operations contract', () => {
  it('keeps CI aligned with built capability and runtime-surface commands', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('pnpm install --frozen-lockfile');
    expect(ci).toContain('node dist/scripts/capability_discovery.js');
    expect(ci).toContain('node dist/scripts/surface_runtime.js --action status');
    expect(ci).toContain('node dist/scripts/vital_check.js --format json --exit-on-missing=false');
  });

  it('keeps validate on the docs example check as well as the other release gates', () => {
    const packageJson = read('package.json');
    expect(packageJson).toContain('pnpm run check:doc-examples');
    expect(packageJson).toContain('pnpm run check:first-win-smoke');
    expect(packageJson).toContain('pnpm run check:mos-no-write-api');
  });

  it('does not invoke removed skills/bootstrap/schema scripts from CI workflows', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toContain('dist/scripts/bootstrap.js');
    expect(ci).not.toContain('dist/scripts/validate_skills.js');
    expect(ci).not.toContain('dist/scripts/audit_skills.js');
    expect(ci).not.toContain('dist/scripts/validate_schemas.js');
    expect(ci).not.toContain('npx tsc -p libs/core/tsconfig.json');
  });

  it('keeps PR validation on built build-size measurement', () => {
    const prValidation = read('.github/workflows/pr-validation.yml');
    expect(prValidation).toContain('node dist/scripts/vital_check.js --format text');
    expect(prValidation).not.toContain('npx tsx scripts/vital_check.ts');
  });

  it('runs golden output checks in PR validation once stable snapshots exist', () => {
    const prValidation = read('.github/workflows/pr-validation.yml');
    expect(prValidation).toContain('KYBERION_REASONING_BACKEND: stub');
    expect(prValidation).toContain('pnpm run check:golden');
  });

  it('documents the distinction between local terminal residue and managed surfaces', () => {
    const workflowReadme = read('.github/workflows/README.md');
    expect(workflowReadme).toContain('Waited for background terminal');
    expect(workflowReadme).toContain('pnpm surfaces:status');
    expect(workflowReadme).toContain('Codex unified exec sessions');
  });

  it('keeps the cross-os workflow on representative schema, preview, and shell checks', () => {
    const crossOs = read('.github/workflows/cross-os.yml');
    expect(crossOs).toContain('pnpm run check:contract-schemas');
    expect(crossOs).toContain('pnpm run test:core');
    expect(crossOs).toContain('pnpm run cli:preview -- pipelines/baseline-check.json');
    expect(crossOs).toContain('pnpm run cli:preview -- pipelines/meeting-proxy-workflow.json');
    expect(crossOs).toContain('pnpm run check:pipeline-shell-independence');
    expect(crossOs).not.toContain('|| true');
  });
});
