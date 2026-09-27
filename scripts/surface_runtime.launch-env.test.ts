import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult } from '@agent/core/secure-io';
import { buildSurfaceLaunchEnv } from './surface_runtime.js';

/**
 * DR-01 (F1): a surface_runtime that was itself started as a delegated child
 * (`buildExecutionEnv(process.env, 'surface_runtime')` under SYSTEM_ROLE=X
 * gives it `KYBERION_DELEGATED_ROLE=surface_runtime@X`) must not pass that
 * delegation to the surfaces it launches: relaunching surface X would match
 * the binding and run the whole surface as surface_runtime.
 */
function probe(env: NodeJS.ProcessEnv): { role: string; persona: string } {
  const authorityUrl = pathToFileURL(pathResolver.rootResolve('libs/core/authority.ts')).href;
  const result = safeExecResult(
    process.execPath,
    [
      '--import',
      pathResolver.rootResolve('scripts/ts-loader.mjs'),
      '--input-type=module',
      '-e',
      [
        `const a = await import(${JSON.stringify(authorityUrl)});`,
        'console.log("PROBE " + JSON.stringify({ role: a.resolveRole(), persona: a.resolveIdentityContext().persona }));',
      ].join('\n'),
    ],
    { env, cwd: pathResolver.rootDir(), timeoutMs: 60_000 }
  );
  expect(result.status, result.stderr).toBe(0);
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('PROBE '));
  return JSON.parse(String(line).slice('PROBE '.length)) as { role: string; persona: string };
}

describe('surface_runtime launch env (DR-01)', () => {
  const delegatedRuntime: NodeJS.ProcessEnv = {
    ...process.env,
    SYSTEM_ROLE: 'surface_runtime',
    MISSION_ROLE: 'surface_runtime',
    KYBERION_PERSONA: 'sovereign',
    KYBERION_DELEGATED_ROLE: 'surface_runtime@concierge',
  };

  it('launches surface X as X even when the runtime carries surface_runtime@X', () => {
    const env = buildSurfaceLaunchEnv('concierge', 'concierge', {}, delegatedRuntime);
    expect(env).toMatchObject({
      SYSTEM_ROLE: 'concierge',
      AUTHORIZED_SCOPE: 'concierge',
      MISSION_ROLE: '',
      KYBERION_DELEGATED_ROLE: '',
      // The launch contract's persona, never the launcher's inherited one.
      KYBERION_PERSONA: 'worker',
    });
    expect(probe(env)).toEqual({ role: 'concierge', persona: 'worker' });
  }, 60_000);

  it('keeps manifest-declared MISSION_ROLE / persona but never a manifest delegation', () => {
    const env = buildSurfaceLaunchEnv(
      'mcp-server-cowork',
      'mcp-server-cowork',
      {
        KYBERION_PERSONA: 'sovereign',
        MISSION_ROLE: 'mcp_server',
        KYBERION_DELEGATED_ROLE: 'ecosystem_architect@mcp_server_cowork',
        SYSTEM_ROLE: 'ecosystem_architect',
      },
      delegatedRuntime
    );
    expect(env).toMatchObject({
      SYSTEM_ROLE: 'mcp_server_cowork',
      MISSION_ROLE: 'mcp_server',
      KYBERION_PERSONA: 'sovereign',
      KYBERION_DELEGATED_ROLE: '',
    });
  });
});
