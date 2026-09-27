/**
 * DR-01 (AUTHORITY_MODEL 3.B2): the Concierge /api/ingest route runs
 * scripts/ingest.ts as a child meant to act as sovereign_concierge. The
 * Concierge process runs with SYSTEM_ROLE=concierge, which the child inherits
 * and which outranks MISSION_ROLE, so before DR-01 the child silently ran as
 * `concierge`. Hermetic: the route is driven with its guards, the tenant
 * registry and file staging stubbed; the child env it builds is captured and
 * a real node child is started with it to observe the role it resolves.
 */
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { pathResolver } from '@agent/core/path-resolver';

const captured: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];

vi.mock('../src/lib/api-guard', () => ({ requireConciergeMutationAccess: () => null }));
vi.mock('../src/lib/viewer-context', () => ({
  resolveConciergeViewer: () => ({ context: { tenantSlugs: 'all' } }),
}));
vi.mock('@agent/core/tenant-registry', () => ({ listTenantProfileSlugs: () => ['acme'] }));
vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/secure-io')>();
  return {
    ...actual,
    safeExistsSync: () => true,
    safeLstat: () => ({ isFile: () => true }),
    safeMkdir: () => undefined,
    safeWriteFile: () => undefined,
    safeRmSync: () => undefined,
    safeExecResult: (_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      captured.push({ args, env: options?.env });
      return { status: 1, stdout: '', stderr: 'stubbed ingest child' };
    },
  };
});

const ENV_KEYS = ['SYSTEM_ROLE', 'MISSION_ROLE', 'KYBERION_PERSONA', 'KYBERION_DELEGATED_ROLE'];

function ingestRequest(extra: Record<string, string> = {}): NextRequest {
  const form = new FormData();
  form.append('file', new File(['# note\n'], 'note.md', { type: 'text/markdown' }));
  form.append('tenant', 'acme');
  form.append('dry_run', 'true');
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return new NextRequest('http://localhost/api/ingest', { method: 'POST', body: form });
}

/** Start a real node child with `env` and report the role it resolves. */
async function childRole(env: NodeJS.ProcessEnv): Promise<string> {
  const actualSecureIo =
    await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io');
  const authorityUrl = pathToFileURL(pathResolver.rootResolve('libs/core/authority.ts')).href;
  const result = actualSecureIo.safeExecResult(
    process.execPath,
    [
      '--import',
      pathResolver.rootResolve('scripts/ts-loader.mjs'),
      '--input-type=module',
      '-e',
      `const a = await import(${JSON.stringify(authorityUrl)}); console.log('ROLE ' + a.resolveRole());`,
    ],
    { env, cwd: pathResolver.rootDir(), timeoutMs: 60_000 }
  );
  expect(result.status, result.stderr).toBe(0);
  return String(result.stdout.split('\n').find((line) => line.startsWith('ROLE ')))
    .slice('ROLE '.length)
    .trim();
}

describe('Concierge /api/ingest child role (DR-01)', () => {
  const original: Record<string, string | undefined> = {};
  beforeEach(() => {
    captured.length = 0;
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    process.env.SYSTEM_ROLE = 'concierge';
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('runs the ingest child as sovereign_concierge, not as the concierge surface', async () => {
    const { POST } = await import('../src/app/api/ingest/route');
    await POST(ingestRequest());
    expect(captured).toHaveLength(1);
    const [{ args, env }] = captured;
    expect(args[0]).toBe('dist/scripts/ingest.js');
    expect(env).toMatchObject({
      SYSTEM_ROLE: 'concierge',
      KYBERION_DELEGATED_ROLE: 'sovereign_concierge@concierge',
    });
    expect(await childRole(env as NodeJS.ProcessEnv)).toBe('sovereign_concierge');
  }, 60_000);

  it('accepts no client-supplied role or env field', async () => {
    const { POST } = await import('../src/app/api/ingest/route');
    const response = await POST(ingestRequest({ KYBERION_DELEGATED_ROLE: 'ecosystem_architect' }));
    expect(response.status).toBe(400);
    expect(captured).toHaveLength(0);
  });
});
