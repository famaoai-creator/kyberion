import { describe, expect, it } from 'vitest';
import {
  parsePluginHostSummary,
  parsePluginViewActionRequests,
  pluginHostBadges,
  pluginViewActionUnavailableKey,
  pluginViewActionExecuteBody,
  pluginViewActionRequestControl,
  pluginViewActionRequestTone,
  pluginViewActionStatusKey,
} from './plugin-view-action-requests';
import { uxTextOr } from './ux-vocabulary';

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

  it('explains why an approved request cannot run here (PH-01)', () => {
    const [item] = parsePluginViewActionRequests({
      data: {
        action_requests: [
          { ...valid, executable: false, unavailable_reason: 'PLUGIN_VIEW_ACTION_UNAVAILABLE' },
        ],
      },
    });
    expect(item.unavailableReason).toBe('PLUGIN_VIEW_ACTION_UNAVAILABLE');
    expect(pluginViewActionUnavailableKey(item, { enabled: false })).toBe(
      'view_action_host_disabled'
    );
    expect(pluginViewActionUnavailableKey(item, { enabled: true })).toBe(
      'view_action_reload_pending'
    );
    expect(
      pluginViewActionUnavailableKey(item, {
        enabled: true,
        plugins: [{ pluginId: 'plugin-a', state: 'restart_required' }],
      })
    ).toBe('view_action_plugin_refused');
    expect(
      pluginViewActionUnavailableKey(
        { ...item, unavailableReason: 'PLUGIN_VIEW_APPROVAL_MISMATCH' },
        { enabled: true, plugins: [{ pluginId: 'plugin-a', state: 'active' }] }
      )
    ).toBe('view_error_approval_mismatch');
  });

  it('summarizes the plugin host for the badge (PH-01)', () => {
    expect(parsePluginHostSummary({ data: {} })).toEqual({ enabled: false });
    expect(parsePluginHostSummary({ data: { host: { enabled: true } } })).toEqual({
      enabled: true,
    });
    const host = parsePluginHostSummary({
      data: {
        host: {
          enabled: true,
          plugins: [
            { plugin_id: 'a', state: 'active' },
            { plugin_id: 'b', state: 'active' },
            { plugin_id: 'c', state: 'refused' },
            { plugin_id: 'd', state: 'inactive' },
            { state: 'active' },
          ],
        },
      },
    });
    expect(host.plugins).toHaveLength(4);
    expect(pluginHostBadges({ enabled: false })).toEqual([
      { key: 'host_disabled', tone: 'neutral' },
    ]);
    expect(pluginHostBadges({ enabled: true })).toEqual([{ key: 'host_enabled', tone: 'success' }]);
    expect(pluginHostBadges(host)).toEqual([
      { key: 'host_active', count: 2, tone: 'success' },
      { key: 'host_refused', count: 1, tone: 'danger' },
    ]);
  });

  it('resolves every host / unavailable vocabulary key in en and ja', () => {
    const keys = [
      'host_disabled',
      'host_enabled',
      'host_active',
      'host_refused',
      'view_action_host_disabled',
      'view_action_reload_pending',
      'view_action_plugin_refused',
    ];
    for (const key of keys) {
      expect(uxTextOr(key, 'MISSING', 'en')).not.toBe('MISSING');
      expect(uxTextOr(key, 'MISSING', 'ja')).not.toBe(uxTextOr(key, 'MISSING', 'en'));
    }
  });
});
