import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { safeMkdir, safeWriteFile } from '../../secure-io.js';
import { ServiceValidator, inspectServiceAuth, type ServiceRequirements } from './ServiceValidator.js';

const TMP_ROOT = path.join(process.cwd(), 'active/shared/tmp/service-validator-test');

describe('ServiceValidator (3-Tier Service Validation)', () => {
  it('should pass if all 3 tiers (CLI, SDK, API) are valid', async () => {
    const requirements: ServiceRequirements = {
      serviceName: 'MockService',
      cliBins: ['node'], // Exists
      sdkModules: ['vitest'], // Exists as devDependency
      authCheck: async () => true // Mock successful ping
    };

    const result = await ServiceValidator.validate(requirements);
    expect(result.valid).toBe(true);
    expect(result.failedTiers).toEqual([]);
  });

  it('should fail L0 (CLI) if binary is missing', async () => {
    const requirements: ServiceRequirements = {
      serviceName: 'MockService',
      cliBins: ['fake-cli-123'],
    };

    const result = await ServiceValidator.validate(requirements);
    expect(result.valid).toBe(false);
    expect(result.failedTiers).toContain('L0_CLI');
    expect(result.details.cliMissing).toContain('fake-cli-123');
  });

  it('should fail L1 (SDK) if module is missing', async () => {
    const requirements: ServiceRequirements = {
      serviceName: 'MockService',
      cliBins: ['node'],
      sdkModules: ['@fake/non-existent-module'],
    };

    const result = await ServiceValidator.validate(requirements);
    expect(result.valid).toBe(false);
    expect(result.failedTiers).toContain('L1_SDK');
    expect(result.details.sdkMissing).toContain('@fake/non-existent-module');
  });

  it('should fail L5 (API) if auth check fails', async () => {
    const requirements: ServiceRequirements = {
      serviceName: 'MockService',
      cliBins: ['node'],
      authCheck: async () => false
    };

    const result = await ServiceValidator.validate(requirements);
    expect(result.valid).toBe(false);
    expect(result.failedTiers).toContain('L5_API');
  });

  it('inspects service auth readiness with concrete setup hints', () => {
    safeMkdir(TMP_ROOT, { recursive: true });
    const presetPath = path.join(TMP_ROOT, 'unit-test-service.json');
    safeWriteFile(presetPath, JSON.stringify({
      auth_strategy: 'Bearer',
      operations: {},
    }, null, 2));

    const inspection = inspectServiceAuth('unit-test-service', presetPath);

    expect(inspection.valid).toBe(false);
    expect(inspection.requiredSecrets).toContain('UNIT-TEST-SERVICE_ACCESS_TOKEN');
    expect(inspection.missingSecrets).toContain('UNIT-TEST-SERVICE_ACCESS_TOKEN');
    expect(inspection.setupHint).toContain('UNIT-TEST-SERVICE_ACCESS_TOKEN');
  });

  it('uses a preset-specific setup hint for session-backed CLI services', () => {
    safeMkdir(TMP_ROOT, { recursive: true });
    const presetPath = path.join(TMP_ROOT, 'google-workspace.json');
    safeWriteFile(presetPath, JSON.stringify({
      auth_strategy: 'session',
      setup_hint: 'Run gws auth setup, then gws auth login.',
      operations: {
        auth_status: {
          type: 'cli',
          command: 'gws',
          args: ['auth', 'status'],
          health_check: 'gws auth status',
        },
      },
    }, null, 2));

    const inspection = inspectServiceAuth('google-workspace', presetPath);

    expect(inspection.valid).toBe(false);
    expect(inspection.cliFallbacks).toContain('gws');
    expect(inspection.setupHint).toContain('Run gws auth setup');
  });
});
