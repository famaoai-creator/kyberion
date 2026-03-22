import { describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';

describe('Slack and Chronos governance contract', () => {
  it('defines shared channel coordination and observability directories', () => {
    const config = JSON.parse(
      safeReadFile('knowledge/public/governance/mission-management-config.json', { encoding: 'utf8' }) as string
    );

    expect(config.directories.global_channel_coordination).toBe('active/shared/coordination/channels');
    expect(config.directories.global_channel_observability).toBe('active/shared/observability/channels');
  });

  it('grants channel and gateway roles only the expected runtime and coordination scopes', () => {
    const securityPolicy = JSON.parse(
      safeReadFile('knowledge/public/governance/security-policy.json', { encoding: 'utf8' }) as string
    );
    const roleAccess = JSON.parse(
      safeReadFile('knowledge/public/governance/role-write-access.json', { encoding: 'utf8' }) as string
    );

    expect(securityPolicy.authority_role_permissions.mission_controller.allow_write).toContain('active/shared/coordination/');
    expect(securityPolicy.authority_role_permissions.mission_controller.allow_write).toContain('active/shared/observability/mission-control/');

    expect(securityPolicy.authority_role_permissions.infrastructure_sentinel.allow_write).toContain('active/shared/coordination/channels/');
    expect(securityPolicy.authority_role_permissions.infrastructure_sentinel.allow_write).toContain('active/shared/observability/');
    expect(securityPolicy.authority_role_permissions.infrastructure_sentinel.allow_write).not.toContain('active/shared/logs/');

    expect(securityPolicy.authority_role_permissions.slack_bridge.allow_write).toEqual([
      'presence/bridge/runtime/',
      'active/shared/coordination/channels/slack/',
      'active/shared/coordination/orchestration/',
      'active/shared/observability/channels/slack/',
      'active/shared/observability/mission-control/',
      'active/audit/'
    ]);
    expect(securityPolicy.authority_role_permissions.chronos_gateway.allow_write).toEqual([
      'active/shared/coordination/chronos/',
      'active/shared/coordination/orchestration/',
      'active/shared/observability/chronos/',
      'active/shared/observability/mission-control/',
      'active/shared/runtime/terminal/',
      'active/audit/'
    ]);
    expect(securityPolicy.authority_role_permissions.chronos_operator.allow_write).toEqual([]);
    expect(securityPolicy.authority_role_permissions.chronos_operator.allow_read).toContain('active/shared/observability/');
    expect(securityPolicy.authority_role_permissions.chronos_localadmin.allow_write).toContain('active/shared/coordination/orchestration/');
    expect(securityPolicy.authority_role_permissions.chronos_localadmin.allow_write).toContain('active/shared/runtime/');
    expect(securityPolicy.authority_role_permissions.surface_runtime.allow_write).toContain('active/shared/runtime/');

    expect(roleAccess.roles.slack_bridge.allow).toContain('active/shared/coordination/channels/slack/');
    expect(roleAccess.roles.slack_bridge.allow).toContain('active/shared/coordination/orchestration/');
    expect(roleAccess.roles.chronos_gateway.allow).toContain('active/shared/coordination/chronos/');
    expect(roleAccess.roles.chronos_gateway.allow).toContain('active/shared/coordination/orchestration/');
    expect(roleAccess.roles.chronos_operator.allow).toEqual([]);
    expect(roleAccess.roles.chronos_localadmin.allow).toContain('active/shared/coordination/orchestration/');
    expect(roleAccess.roles.surface_runtime.allow).toContain('active/shared/runtime/');
  });

  it('ships the Slack and Chronos control model architecture reference', () => {
    expect(safeExistsSync('knowledge/public/architecture/slack-chronos-control-model.md')).toBe(true);
  });
});
