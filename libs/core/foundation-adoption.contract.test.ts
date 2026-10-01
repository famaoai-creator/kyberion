import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

const TARGETS = [
  'libs/core/report-contract.ts',
  'libs/core/virtual/desktop-pipeline.ts',
  'libs/core/virtual/desktop-recording.ts',
  'libs/core/mission/mission-classification.ts',
  'libs/core/task/task-session.ts',
  'libs/core/source-analysis.ts',
  'libs/core/organization/onboarding-context.ts',
  'scripts/onboarding_apply.ts',
  'scripts/onboarding_wizard.ts',
  'libs/core/browser/browser-extension-bridge.ts',
  'libs/core/browser/browser-conversation-session.ts',
  'libs/core/pipeline/pipeline-contract.ts',
  'libs/core/organization/organization-operating-model-persistence.ts',
] as const;

const CLEANUP_TARGETS = [
  'libs/core/organization/organization-operating-model-management.ts',
  'libs/core/organization/organization-operating-model-operations.ts',
] as const;

const SHARED_AJV_TARGETS = [
  'libs/core/actuator/actuator-sdk.ts',
  'scripts/check_pipeline_op_schema_coverage.ts',
] as const;

describe('foundation schema compiler adoption', () => {
  it('keeps migrated modules off the legacy Ajv compatibility boundary', () => {
    for (const relativePath of TARGETS) {
      const source = String(
        safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' })
      );
      // `defineCatalog` (foundation/governed-catalog.ts) is the newer, higher-level
      // boundary built on top of compileSchema — a module fully migrated onto it
      // no longer calls compileSchema directly, so either signals adoption.
      expect(
        source.includes('compileSchema') || source.includes('defineCatalog'),
        relativePath
      ).toBe(true);
      expect(source, relativePath).not.toContain('compileSchemaFromPath');
      expect(source, relativePath).not.toContain("from 'ajv-formats'");
    }
  });

  it('keeps modules with no file-backed schema validator free of local Ajv setup', () => {
    for (const relativePath of CLEANUP_TARGETS) {
      const source = String(
        safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' })
      );
      expect(source, relativePath).not.toContain('createAjv');
      expect(source, relativePath).not.toContain('ajv-formats');
    }
  });

  it('keeps shared Ajv consumers on the foundation format registration', () => {
    for (const relativePath of SHARED_AJV_TARGETS) {
      const source = String(
        safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' })
      );
      expect(source, relativePath).toContain('createAjv');
      expect(source, relativePath).not.toContain('ajv-formats');
    }
  });
});
