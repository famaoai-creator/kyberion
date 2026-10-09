import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `pnpm plugin:install` resolves its approval requester lazily: with
 * separation of duties on and no owner member, an official plugin (no approval
 * needed) still installs; only a third-party install, which opens a request,
 * reports the missing identity.
 */
const sod = vi.hoisted(() => ({ overlayPath: null as string | null, file: '' }));
vi.mock('@agent/core/customer-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/customer-resolver')>();
  return {
    ...actual,
    customerRoot: (subPath = '', ...rest: unknown[]) =>
      subPath === 'policy/approval-policy.json' && sod.overlayPath
        ? sod.overlayPath
        : (actual.customerRoot as (...args: unknown[]) => string | null)(subPath, ...rest),
  };
});
vi.mock('@agent/core/organization/member-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/organization/member-registry')>();
  return { ...actual, resolveMemberByPrincipal: () => null };
});

import { withExecutionContext } from '@agent/core/authority';
import { CLI_AGENT_SESSION_ENV } from '@agent/core/governance/cli-operator-principal';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { runPluginInstall } from './plugin_install.js';

const cleanup: string[] = [];

function tmp(name: string): string {
  const dir = pathResolver.sharedTmp(`plugin-install-sod-${process.pid}-${name}-${randomUUID()}`);
  cleanup.push(dir);
  return dir;
}

describe('plugin_install with separation of duties on and no owner member', () => {
  beforeEach(() => {
    for (const name of CLI_AGENT_SESSION_ENV) vi.stubEnv(name, '');
    sod.file = path.join(tmp('overlay'), 'approval-policy.json');
    const product = JSON.parse(
      String(
        safeReadFile(pathResolver.knowledge('product/governance/approval-policy.json'), {
          encoding: 'utf8',
        })
      )
    );
    safeMkdir(path.dirname(sod.file), { recursive: true });
    safeWriteFile(
      sod.file,
      JSON.stringify({ ...product, separation_of_duties: { enabled: true } })
    );
    sod.overlayPath = sod.file;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    sod.overlayPath = null;
    withExecutionContext('mission_controller', () => {
      while (cleanup.length > 0) safeRmSync(cleanup.pop()!, { recursive: true, force: true });
    });
  });

  it('installs an official plugin (no approval request is opened)', () => {
    const output: string[] = [];
    const exitCode = runPluginInstall(
      [
        '--source',
        pathResolver.rootResolve('plugins/kyberion'),
        '--id',
        `sod-official-${process.pid}-${randomUUID()}`,
        '--managed-root',
        tmp('managed'),
        '--json',
      ],
      (value) => output.push(String(value))
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(''))).toMatchObject({
      trust: 'official',
      activationStatus: 'activatable',
    });
  });

  it('reports the missing identity only when a third-party install opens a request', () => {
    const src = tmp('third-party');
    safeMkdir(src, { recursive: true });
    safeWriteFile(path.join(src, 'plugin-manifest.json'), JSON.stringify({ plugin_id: 'sod-x' }));
    expect(() =>
      runPluginInstall(
        [
          '--source',
          src,
          '--id',
          `sod-third-${process.pid}-${randomUUID()}`,
          '--managed-root',
          tmp('managed'),
        ],
        () => undefined
      )
    ).toThrow(/no stable operator identity.*pnpm organization member ensure-owner/);
  });
});
