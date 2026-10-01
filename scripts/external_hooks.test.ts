import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import {
  buildExternalHookDiscoveryReport,
  formatExternalHookDiscoveryReport,
  requestExternalHookTrust,
} from './external_hooks.js';

const projectRoot = pathResolver.shared(`tmp/external-hooks-cli-${process.pid}`);

describe('pnpm kyberion hooks (DH-16)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    safeRmSync(projectRoot, { recursive: true, force: true });
  });

  it('lists discovered configs as untrusted until a human approves them', () => {
    vi.stubEnv('KYBERION_EXTERNAL_HOOKS', '');
    safeMkdir(`${projectRoot}/.codex`, { recursive: true });
    safeWriteFile(`${projectRoot}/.codex/hooks.json`, JSON.stringify({ PreToolUse: [] }));

    const report = buildExternalHookDiscoveryReport({ rootDir: projectRoot });

    expect(report.bootstrap_enabled).toBe(false);
    expect(report.configs).toEqual([expect.objectContaining({ source: 'codex', trusted: false })]);
    expect(report.configs[0]?.path).toMatch(/\.codex\/hooks\.json$/);
    expect(report.configs[0]?.approval_id).toBeUndefined();
    expect(formatExternalHookDiscoveryReport(report)).toContain('hooks trust');
  });

  it('reports the opt-in loading state', () => {
    vi.stubEnv('KYBERION_EXTERNAL_HOOKS', 'project');
    expect(buildExternalHookDiscoveryReport({ rootDir: projectRoot }).bootstrap_enabled).toBe(true);
  });

  it('refuses to open a trust request for a file that is not a discovered hook config', () => {
    expect(() => requestExternalHookTrust('package.json')).toThrow(/package\.json/);
  });
});
