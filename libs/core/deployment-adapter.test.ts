import { afterEach, describe, expect, it } from 'vitest';
import {
  getDeploymentAdapter,
  registerDeploymentAdapter,
  resetDeploymentAdapter,
  stubDeploymentAdapter,
  type DeploymentAdapter,
} from './deployment-adapter.js';

describe('deployment-adapter', () => {
  afterEach(() => {
    resetDeploymentAdapter();
  });

  it('defaults to the stub adapter', () => {
    expect(getDeploymentAdapter().name).toBe('stub');
  });

  it('stub returns dry_run with sensible message', async () => {
    const result = await stubDeploymentAdapter.deploy({
      environment: 'staging',
      projectName: 'acct-saas',
      version: 'v0.1.0',
    });
    expect(result.status).toBe('dry_run');
    expect(result.message).toContain('acct-saas@v0.1.0');
    expect(result.message).toContain('staging');
  });

  it('resolves a registered adapter', () => {
    const fake: DeploymentAdapter = {
      name: 'fake',
      deploy: async () => ({
        adapter: 'fake',
        status: 'triggered',
        message: 'ok',
        started_at: new Date().toISOString(),
      }),
    };
    registerDeploymentAdapter(fake);
    expect(getDeploymentAdapter().name).toBe('fake');
  });
});
