import { describe, expect, it } from 'vitest';
import { invokeAllowlistedActuator, readActuatorInvokeAllowlist } from './mcp-actuator-invoke.js';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';

describe('mcp-actuator-invoke', () => {
  const catalog = JSON.parse(
    readTextFile(pathResolver.knowledge('product/governance/mcp-tool-catalog.json'))
  );
  const allowlist = readActuatorInvokeAllowlist(catalog);

  it('loads allowlist from catalog', () => {
    expect(allowlist.some((e) => e.actuator === 'file-actuator' && e.op === 'pipeline')).toBe(true);
  });

  it('rejects non-allowlisted actuator/op pairs', async () => {
    await expect(
      invokeAllowlistedActuator({
        actuator: 'browser-actuator',
        op: 'navigate',
        allowlist,
        callerRole: 'operator',
      })
    ).rejects.toThrow(/MCP_ACTUATOR_NOT_ALLOWLISTED/);
  });

  it('dry_runs allowlisted file-actuator pipeline', async () => {
    const result = await invokeAllowlistedActuator({
      actuator: 'file-actuator',
      op: 'pipeline',
      params: {},
      mode: 'dry_run',
      allowlist,
      callerRole: 'cowork',
    });
    expect(result.mode).toBe('dry_run');
    expect(result.actuator_id).toBe('file-actuator');
    expect(result.op).toBe('pipeline');
    expect(typeof result.validated).toBe('boolean');
  });

  it('dry_runs an allowlisted discovery-only op through the one-step pipeline envelope', async () => {
    const result = await invokeAllowlistedActuator({
      actuator: 'file-actuator',
      op: 'exists',
      params: { path: 'README.md' },
      mode: 'dry_run',
      allowlist: [{ actuator: 'file-actuator', op: 'exists' }],
      callerRole: 'cowork',
    });
    expect(result.mode).toBe('dry_run');
    const payload = result.payload as {
      action: string;
      steps?: { op: string; params?: Record<string, unknown> }[];
    };
    expect(payload.action).toBe('pipeline');
    expect(payload.steps?.[0]?.op).toBe('exists');
    expect(payload.steps?.[0]?.params).toEqual({ path: 'README.md' });
    expect(result.handler).toBe('capture');
  });

  it('flags params that violate an authored discovery op input schema in dry_run', async () => {
    const result = await invokeAllowlistedActuator({
      actuator: 'file-actuator',
      op: 'json_parse',
      params: {},
      mode: 'dry_run',
      allowlist: [{ actuator: 'file-actuator', op: 'json_parse' }],
      callerRole: 'cowork',
    });
    expect(result.validated).toBe(false);
    expect(String(result.error)).toContain('from');
  });

  it('does not gate dry_run on an inferred-legacy input schema', async () => {
    const result = await invokeAllowlistedActuator({
      actuator: 'file-actuator',
      op: 'exists',
      params: {},
      mode: 'dry_run',
      allowlist: [{ actuator: 'file-actuator', op: 'exists' }],
      callerRole: 'cowork',
    });
    expect(result.error ?? '').not.toContain('path');
  });

  it('keeps a discovery-only op bare on an actuator without a pipeline entry', async () => {
    const result = await invokeAllowlistedActuator({
      actuator: 'process-actuator',
      op: 'list-surfaces',
      mode: 'dry_run',
      allowlist: [{ actuator: 'process-actuator', op: 'list-surfaces' }],
      callerRole: 'cowork',
    });
    const payload = result.payload as { action: string; steps?: unknown };
    expect(payload.action).toBe('list-surfaces');
    expect(payload.steps).toBeUndefined();
  });

  it('rejects an op declared in neither the manifest nor the discovery catalog', async () => {
    await expect(
      invokeAllowlistedActuator({
        actuator: 'file-actuator',
        op: 'no_such_op',
        mode: 'dry_run',
        allowlist: [{ actuator: 'file-actuator', op: 'no_such_op' }],
        callerRole: 'cowork',
      })
    ).rejects.toThrow(/MCP_ACTUATOR_OP_UNKNOWN/);
  });

  it('rejects live execution when the allowlist entry requires approval', async () => {
    await expect(
      invokeAllowlistedActuator({
        actuator: 'service-actuator',
        op: 'preset',
        params: { service_id: 'github', action: 'create_issue' },
        mode: 'live',
        allowlist: [
          {
            actuator: 'service-actuator',
            op: 'preset',
            requires_approval: true,
            execution: 'service_preset',
          },
        ],
        callerRole: 'operator',
      })
    ).rejects.toThrow(/MCP_ACTUATOR_APPROVAL_REQUIRED/);
  });
});
