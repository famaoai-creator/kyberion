import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { PipelineSuspendedError } from '../scripts/pipeline-execution-part-bootstrap.js';
import { executeAcceptedPipelineRoute } from '../scripts/run_intent.js';
import {
  executeAcceptedSurfacePipeline,
  resolveAcceptedSurfaceBindingContext,
} from '@agent/core/surface/surface-runtime-orchestrator';

type RouteExecute = Parameters<typeof executeAcceptedPipelineRoute>[0]['execute'];
type SurfaceExecute = Parameters<typeof executeAcceptedSurfacePipeline>[3];

function read(relativePath: string): string {
  return safeReadFile(pathResolver.rootResolve(relativePath), {
    encoding: 'utf8',
  }) as string;
}

describe('pipeline and intent convergence contracts', () => {
  it('keeps promotion and human acceptance as separate governed commands', () => {
    const packageJson = JSON.parse(read('package.json'));
    const cliCatalog = JSON.parse(read('knowledge/product/governance/cli-commands.json'));
    expect(packageJson.scripts['pipeline:promote']).toBeTruthy();
    expect(packageJson.scripts['pipeline:accept']).toContain('pipeline_accept.ts');
    expect(
      cliCatalog.script_commands.some(
        (entry: { script?: string }) => entry.script === 'pipeline:accept'
      )
    ).toBe(true);
  });

  it('does not report accepted pipeline failures or suspensions as completed', async () => {
    const failed = await executeAcceptedPipelineRoute({
      pipelineRef: 'pipelines/example.json',
      context: {},
      execute: (async () => {
        throw new Error('deterministic failure');
      }) as unknown as RouteExecute,
    });
    expect(failed).toMatchObject({
      status: 'failed',
      route: 'accepted_pipeline_binding',
      error: 'deterministic failure',
    });

    const suspended = await executeAcceptedPipelineRoute({
      pipelineRef: 'pipelines/example.json',
      context: {},
      execute: (async () => {
        throw new PipelineSuspendedError({
          step_id: 'approval',
          approval_request_id: 'approval-1',
          storage_channel: 'pipeline-binding',
          on_timeout: 'abort',
        });
      }) as unknown as RouteExecute,
    });
    expect(suspended).toMatchObject({
      status: 'suspended',
      route: 'accepted_pipeline_binding',
      approval_request_id: 'approval-1',
    });

    const surfaceSuspended = executeAcceptedSurfacePipeline(
      {
        binding_id: 'accepted-test',
        pipeline_ref: 'pipelines/example.json',
        intent_ids: ['example'],
        scope: { tier: 'public' },
        successful_run_evidence: {
          pipeline_sha256: 'a'.repeat(64),
          completed_at: '2026-09-16T00:00:00.000Z',
          evidence_digest: 'b'.repeat(64),
        },
        approval_request_id: '00000000-0000-4000-8000-000000000001',
        accepted_at: '2026-09-16T00:00:00.000Z',
        status: 'active',
      },
      {
        agentId: 'test-agent',
        senderAgentId: 'test-sender',
        query: 'run example',
      },
      'example',
      (() => '[PIPELINE] Suspended: trace\nAwaiting decision approval-1') as SurfaceExecute
    );
    expect(surfaceSuspended.text).toContain('Suspended accepted pipeline');
    expect(surfaceSuspended.text).toContain('"status": "error"');
  });

  it('does not derive a private accepted-binding scope from ambient process state', () => {
    const missing = resolveAcceptedSurfaceBindingContext(undefined);
    expect(missing.scope).toMatchObject({ tier: 'public' });
    expect(missing.scope.tenant_slug).toBeUndefined();
    expect(missing.viewerScopeAuthorized).toBe(false);

    const resolved = resolveAcceptedSurfaceBindingContext({
      tier: 'confidential',
      tenant_slug: 'tenant-a',
    });
    expect(resolved.scope).toMatchObject({
      tier: 'confidential',
      tenant_slug: 'tenant-a',
    });
    expect(resolved.viewerScopeAuthorized).toBe(true);
  });

  it('moves the conservatively retired pipeline and records the evidence method', () => {
    expect(safeExistsSync(pathResolver.rootResolve('pipelines/kyberion-product-intro.json'))).toBe(
      false
    );
    expect(
      safeExistsSync(pathResolver.rootResolve('retired/pipelines/kyberion-product-intro.json'))
    ).toBe(true);
    const inventory = read('retired/pipelines/README.md');
    expect(inventory).toContain('kyberion-product-intro.json');
    expect(inventory).toContain('No retained run journal, trace, or schedule receipt');
  });
});
