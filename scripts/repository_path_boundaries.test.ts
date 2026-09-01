import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveValidationBundleOutputBase } from './export_validation_bundle.js';
import { resolveAvatarRegistrationPaths } from './register_avatar.js';
import { resolveIntentContractMemoryPath } from './sync_intent_contract_memory.js';
import { resolveCapturePhotoPath } from './capture_photo.js';
import { resolveIntentSmokeOutputDir } from './intent_smoke.js';

describe('repository-bound script inputs', () => {
  it('keeps validation bundle exports inside the repository', () => {
    expect(resolveValidationBundleOutputBase('active/shared/exports/bundles')).toBe(
      pathResolver.rootResolve('active/shared/exports/bundles')
    );
  });

  it('rejects validation bundle exports outside the repository', () => {
    expect(() => resolveValidationBundleOutputBase('/tmp/validation-bundles')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });

  it('rejects avatar registry sources outside the repository', () => {
    expect(() => resolveAvatarRegistrationPaths({ 'src-avatar': '/tmp/avatar.png' })).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });

  it('rejects intent-memory report paths outside the repository', () => {
    expect(() => resolveIntentContractMemoryPath('/tmp/intent-report.json', 'REPORT')).toThrow(
      '[REPORT_PATH_SCOPE]'
    );
  });

  it('rejects camera output paths outside the repository', () => {
    expect(() => resolveCapturePhotoPath('/tmp/user-face.jpg')).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects intent smoke report directories outside the repository', () => {
    expect(() => resolveIntentSmokeOutputDir('/tmp/intent-smoke')).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('accepts intent smoke reports in the governed shared temp namespace', () => {
    expect(resolveIntentSmokeOutputDir('active/shared/tmp/intent-smoke')).toBe(
      pathResolver.rootResolve('active/shared/tmp/intent-smoke')
    );
  });
});
