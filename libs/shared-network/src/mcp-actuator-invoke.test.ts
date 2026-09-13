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
