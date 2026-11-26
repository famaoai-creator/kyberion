/**
 * A bound native run's step that the manifest flagged `write_path_unconfined`
 * goes through its own `browser:write_file` approval of the exact resolved
 * path; once a human approves it, that path — and only that path — is
 * writable for the step (pipeline-run-manifest-model.md §3.5). A step the
 * manifest judged confined never asks, and still stops if it resolves
 * outside the partition.
 */
import { describe, expect, it, vi } from 'vitest';

const asked: Array<{ operationId: string; effect: Record<string, unknown> }> = [];
vi.mock('@agent/core/governance/external-operation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/external-operation')>()),
  // The human approves every per-step request this test makes.
  runExternalOperation: vi.fn(
    async (
      input: { operationId: string; effect: Record<string, unknown> },
      execute: () => Promise<unknown>
    ) => {
      asked.push({ operationId: input.operationId, effect: input.effect });
      return execute();
    }
  ),
}));

const { BROWSER_NATIVE_FORMAT, compileRunManifest } =
  await import('@agent/core/pipeline/run-manifest');
const { withRunManifestStep } = await import('@agent/core/governance/external-operation-runtime');
const { pathResolver } = await import('@agent/core/path-resolver');
const { confineNativeRunWritePath, runNativeBrowserPipelineFile, withNativeWriteApproval } =
  await import('./browser-native-run-manifest.js');

const INPUT = 'knowledge/confidential/acme/browser-workflows/scenarios/writes.json';
const SCRATCH = 'active/shared/tmp/confidential/acme/browser';
const STEPS = [
  { type: 'capture', op: 'goto', params: { url: 'https://app.example.test/' } },
  { type: 'capture', op: 'screenshot', params: { path: 'active/shared/tmp/{{name}}.png' } },
  { type: 'capture', op: 'screenshot', params: { path: `${SCRATCH}/{{name}}.png` } },
];
const FILE = { action: 'pipeline', steps: STEPS };
const manifest = compileRunManifest(STEPS, {
  inputPath: INPUT,
  contentSha256: 'w'.repeat(64),
  scope: { tier: 'confidential', tenantSlug: 'acme' },
  format: BROWSER_NATIVE_FORMAT,
});

function bound<T>(body: () => Promise<T>): Promise<T> {
  return runNativeBrowserPipelineFile(
    { inputPath: INPUT, sourceText: JSON.stringify(FILE), pipeline: FILE },
    body,
    {
      hasHuman: true,
      deps: {
        runId: 'r',
        deriveScope: () => ({
          input_path: INPUT,
          tier: 'confidential',
          tenant_slug: 'acme',
          source: 'location',
        }),
        openSession: () => ({
          binding: { manifest, charterId: 'c', principal: 'attended', runId: 'r' },
          manifest,
          admitting: true,
          message: 'bound (test)',
          level: 'debug',
        }),
      },
    }
  );
}

const abs = (relative: string) => pathResolver.rootResolve(relative);

describe('native write approval', () => {
  it('asks once for a flagged write and then allows exactly that path', async () => {
    asked.length = 0;
    await bound(() =>
      withRunManifestStep({ entryId: '1' }, () =>
        withNativeWriteApproval(
          'screenshot',
          { path: 'active/shared/tmp/report.png' },
          async () => {
            expect(confineNativeRunWritePath(abs('active/shared/tmp/report.png'))).toBe(
              abs('active/shared/tmp/report.png')
            );
            expect(() => confineNativeRunWritePath(abs('active/shared/tmp/other.png'))).toThrow(
              /BROWSER_RUN_PATH_CONFINED/u
            );
          }
        )
      )
    );
    expect(asked).toEqual([
      {
        operationId: 'browser:write_file',
        effect: {
          op: 'screenshot',
          path: 'active/shared/tmp/report.png',
          requested_params: { path: 'active/shared/tmp/report.png' },
        },
      },
    ]);
  });

  it('never asks for a confined step, and stops it if it resolves outside', async () => {
    asked.length = 0;
    await bound(() =>
      withRunManifestStep({ entryId: '2' }, () =>
        withNativeWriteApproval('screenshot', { path: '../escape.png' }, async () => {
          expect(() => confineNativeRunWritePath(abs('../escape.png'))).toThrow();
        })
      )
    );
    expect(asked).toEqual([]);
  });

  it('does nothing outside a bound run', async () => {
    asked.length = 0;
    const result = await withRunManifestStep({ entryId: '1' }, () =>
      withNativeWriteApproval('screenshot', { path: 'active/shared/tmp/x.png' }, async () => 'ran')
    );
    expect(result).toBe('ran');
    expect(asked).toEqual([]);
  });
});
