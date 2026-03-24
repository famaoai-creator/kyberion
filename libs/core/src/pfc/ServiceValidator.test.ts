import { describe, it, expect } from 'vitest';
import { ServiceValidator, type ServiceRequirements } from './ServiceValidator.js';

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
});
