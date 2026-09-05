import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

const TARGETS = [
  'libs/core/operator-learning.ts',
  'libs/core/report-contract.ts',
  'libs/core/desktop-pipeline.ts',
  'libs/core/desktop-recording.ts',
  'libs/core/mission-classification.ts',
  'libs/core/task-session.ts',
  'libs/core/source-analysis.ts',
  'libs/core/onboarding-context.ts',
  'scripts/onboarding_apply.ts',
  'scripts/onboarding_wizard.ts',
  'libs/core/browser-extension-bridge.ts',
  'libs/core/browser-conversation-session.ts',
  'libs/core/pipeline-contract.ts',
  'libs/core/organization-operating-model-persistence.ts',
] as const;

const CLEANUP_TARGETS = [
  'libs/core/organization-operating-model-management.ts',
  'libs/core/organization-operating-model-operations.ts',
] as const;

const SHARED_AJV_TARGETS = [
  'libs/core/actuator-sdk.ts',
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
