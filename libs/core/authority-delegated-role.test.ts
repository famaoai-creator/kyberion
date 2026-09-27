import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildExecutionEnv, DELEGATED_ROLE_ENV } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeExecResult } from './secure-io.js';

/**
 * DR-01 integration: a real node child spawned with buildExecutionEnv(env,
 * role) under an inherited SYSTEM_ROLE resolves the delegated role (not the
 * parent surface), bounded by the parent's SYSTEM_ROLE.
 */
function probeChild(env: NodeJS.ProcessEnv): {
  role: string;
  persona: string;
  denied: boolean;
  bounded: boolean;
} {
  const authorityUrl = pathToFileURL(pathResolver.rootResolve('libs/core/authority.ts')).href;
  const script = [
    `const a = await import(${JSON.stringify(authorityUrl)});`,
    'let bounded = false;',
    "try { a.withExecutionContext('chronos_localadmin', () => undefined); } catch { bounded = true; }",
    'console.log("PROBE " + JSON.stringify({ role: a.resolveRole(), persona: a.resolveIdentityContext().persona, bounded }));',
  ].join('\n');
  const result = safeExecResult(
    process.execPath,
    [
      '--import',
      pathResolver.rootResolve('scripts/ts-loader.mjs'),
      '--input-type=module',
      '-e',
      script,
    ],
    { env, cwd: pathResolver.rootDir(), timeoutMs: 60_000 }
  );
  expect(result.status, result.stderr).toBe(0);
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('PROBE '));
  expect(line, result.stdout).toBeDefined();
  return {
    ...(JSON.parse(String(line).slice('PROBE '.length)) as {
      role: string;
      persona: string;
      bounded: boolean;
    }),
    denied: result.stderr.includes('[ROLE_DELEGATION_DENIED]'),
  };
}

function surfaceEnv(systemRole: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SYSTEM_ROLE: systemRole };
  for (const key of ['MISSION_ROLE', 'KYBERION_PERSONA', DELEGATED_ROLE_ENV]) delete env[key];
  return env;
}

describe('DR-01 delegated child role (spawned node child)', () => {
  it('runs a child spawned with an explicit role under SYSTEM_ROLE=concierge as that role', () => {
    const seen = probeChild(buildExecutionEnv(surfaceEnv('concierge'), 'sovereign_concierge'));
    expect(seen).toEqual({
      role: 'sovereign_concierge',
      persona: 'sovereign',
      denied: false,
      // RA-02 bounds stay those of SYSTEM_ROLE=concierge.
      bounded: true,
    });
  }, 60_000);

  it('falls back to SYSTEM_ROLE with a warning when the policy denies the delegated role', () => {
    const seen = probeChild(buildExecutionEnv(surfaceEnv('slack_bridge'), 'chronos_localadmin'));
    expect(seen.role).toBe('slack_bridge');
    expect(seen.persona).not.toBe('sovereign');
    expect(seen.denied).toBe(true);
  }, 60_000);
});
