import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';
import {
  getDeploymentAdapter,
  installShellDeploymentAdapterFromConfigIfAvailable,
  registerDeploymentAdapter,
  resetDeploymentAdapter,
  stubDeploymentAdapter,
  type DeploymentAdapter,
} from './deployment-adapter.js';

describe('deployment-adapter', () => {
  const configPath = pathResolver.knowledge('personal/deployments/default.json');

  afterEach(() => {
    resetDeploymentAdapter();
    withExecutionContext('ecosystem_architect', () => {
      safeRmSync(configPath, { force: true });
    });
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

  it('installs a shell adapter from the personal deployment config', async () => {
    withExecutionContext('ecosystem_architect', () => {
      safeWriteFile(
        configPath,
        JSON.stringify(
          {
            command: 'printf %s "{{projectName}}-{{version}}-{{environment}}"',
            timeout_ms: 1000,
          },
          null,
          2
        )
      );
    });

    expect(installShellDeploymentAdapterFromConfigIfAvailable()).toBe(true);
    const result = await getDeploymentAdapter().deploy({
      environment: 'staging',
      projectName: 'acct-saas',
      version: 'v1.2.3',
    });

    expect(result.adapter).toBe('shell');
    expect(result.status).toBe('triggered');
    expect(result.message).toContain('acct-saas-v1.2.3-staging');
  });
});
