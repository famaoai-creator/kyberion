import { describe, expect, it } from 'vitest';
import {
  parsePluginViewActionRequests,
  pluginViewActionExecuteBody,
  pluginViewActionRequestControl,
  pluginViewActionRequestTone,
  pluginViewActionStatusKey,
} from './plugin-view-action-requests';

const valid = {
  approval_request_id: 'req-1',
  plugin_id: 'plugin-a',
  view_id: 'status',
  action_id: 'write_probe',
  params: { path: 'active/shared/tmp/x' },
  status: 'approved',
  requested_at: '2026-09-26T00:00:00.000Z',
  executable: true,
};

describe('plugin view action requests (FU-02)', () => {
  it('keeps well-formed requests and drops malformed or unknown-status ones', () => {
    const parsed = parsePluginViewActionRequests({
      data: {
        action_requests: [
          valid,
          { ...valid, approval_request_id: '' },
          { ...valid, status: 'running' },
          { ...valid, params: 'x' },
          null,
        ],
      },
    });
    expect(parsed).toEqual([
      {
        approvalRequestId: 'req-1',
        pluginId: 'plugin-a',
        viewId: 'status',
        actionId: 'write_probe',
        params: { path: 'active/shared/tmp/x' },
        status: 'approved',
        executable: true,
      },
    ]);
    expect(parsePluginViewActionRequests({ data: {} })).toEqual([]);
    expect(parsePluginViewActionRequests(null)).toEqual([]);
  });

  it('builds the execute body and status presentation', () => {
    const [item] = parsePluginViewActionRequests({ data: { action_requests: [valid] } });
    expect(pluginViewActionExecuteBody(item)).toEqual({
      plugin_id: 'plugin-a',
      view_id: 'status',
      action_id: 'write_probe',
      params: { path: 'active/shared/tmp/x' },
      approval_request_id: 'req-1',
    });
    expect(pluginViewActionRequestTone('approved')).toBe('accent');
    expect(pluginViewActionRequestTone('stale')).toBe('neutral');
    expect(pluginViewActionStatusKey('executed')).toBe('view_action_status_executed');
  });

  it('offers Execute only for an approved request the server can run', () => {
    const parse = (entry: Record<string, unknown>) =>
      parsePluginViewActionRequests({ data: { action_requests: [{ ...valid, ...entry }] } })[0];
    expect(pluginViewActionRequestControl(parse({}))).toBe('execute');
    // Missing or false `executable` (plugin not active in the server process).
    const withoutFlag: Record<string, unknown> = { ...valid };
    delete withoutFlag.executable;
    expect(
      parsePluginViewActionRequests({ data: { action_requests: [withoutFlag] } })[0].executable
    ).toBe(false);
    expect(pluginViewActionRequestControl(parse({ executable: false }))).toBe('not_executable');
    expect(pluginViewActionRequestControl(parse({ status: 'pending' }))).toBe('none');
    expect(parse({ status: 'unknown' }).status).toBe('unknown');
    expect(pluginViewActionStatusKey('unknown')).toBe('view_action_status_unknown');
  });
});
