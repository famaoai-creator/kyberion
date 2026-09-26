import { describe, expect, it } from 'vitest';
import {
  parsePluginViewActionRequests,
  pluginViewActionExecuteBody,
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
});
