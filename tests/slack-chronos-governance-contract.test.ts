import { describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';

describe('Slack and Chronos governance contract', () => {
  it('defines shared channel coordination and observability directories', () => {
    const config = JSON.parse(
      safeReadFile('knowledge/product/governance/mission-management-config.json', {
        encoding: 'utf8',
      }) as string
    );

    expect(config.directories.global_channel_coordination).toBe(
      'active/shared/coordination/channels'
    );
    expect(config.directories.global_channel_observability).toBe(
      'active/shared/observability/channels'
    );
  });

  it('grants channel and gateway roles only the expected runtime and coordination scopes', () => {
    const securityPolicy = JSON.parse(
      safeReadFile('knowledge/product/governance/security-policy.json', {
        encoding: 'utf8',
      }) as string
    );
    // The Authority Role card is the per-role registry; its enforced write
    // grant is permissions.allow_write (security-policy holds the projection).
    const writeScopes = (role: string): string[] =>
      JSON.parse(
        safeReadFile(`knowledge/product/governance/authority-roles/${role}.json`, {
          encoding: 'utf8',
        }) as string
      ).permissions.allow_write;

    expect(securityPolicy.authority_role_permissions.mission_controller.allow_write).toContain(
      'active/shared/coordination/'
    );
    expect(securityPolicy.authority_role_permissions.mission_controller.allow_write).toContain(
      'active/shared/observability/mission-control/'
    );

    expect(securityPolicy.authority_role_permissions.infrastructure_sentinel.allow_write).toContain(
      'active/shared/coordination/channels/'
    );
    expect(securityPolicy.authority_role_permissions.infrastructure_sentinel.allow_write).toContain(
      'active/shared/observability/'
    );
    expect(
      securityPolicy.authority_role_permissions.infrastructure_sentinel.allow_write
    ).not.toContain('active/shared/logs/');

    expect(securityPolicy.authority_role_permissions.slack_bridge.allow_write).toEqual([
      'presence/bridge/runtime/',
      'active/shared/coordination/channels/slack/',
      'active/shared/coordination/channels/chronos/outbox/',
      'active/shared/coordination/orchestration/',
      'active/shared/observability/channels/slack/',
      'active/shared/observability/mission-control/',
      'active/audit/',
    ]);
    expect(securityPolicy.authority_role_permissions.chronos_gateway.allow_write).toEqual([
      'active/shared/coordination/chronos/',
      'active/shared/coordination/channels/chronos/',
      'active/shared/coordination/orchestration/',
      'active/shared/observability/chronos/',
      'active/shared/observability/mission-control/',
      'active/shared/runtime/terminal/',
      'active/audit/',
      'active/shared/observability/ops-alerts.jsonl',
      'active/shared/runtime/delegation-records/system/',
    ]);
    expect(securityPolicy.authority_role_permissions.chronos_operator.allow_write).toEqual([]);
    expect(securityPolicy.authority_role_permissions.chronos_operator.allow_read).toContain(
      'active/shared/observability/'
    );
    expect(securityPolicy.authority_role_permissions.chronos_localadmin.allow_write).toContain(
      'active/shared/coordination/orchestration/'
    );
    expect(securityPolicy.authority_role_permissions.chronos_localadmin.allow_write).toContain(
      'active/shared/runtime/'
    );
    expect(securityPolicy.authority_role_permissions.surface_runtime.allow_write).toContain(
      'active/shared/runtime/'
    );
    expect(securityPolicy.authority_role_permissions.surface_runtime.allow_write).toContain(
      'knowledge/product/governance/surfaces/'
    );
    expect(securityPolicy.authority_role_permissions.surface_runtime.allow_write).toContain(
      'knowledge/product/governance/active-surfaces.json'
    );
    expect(securityPolicy.authority_role_permissions.surface_runtime.allow_write).toContain(
      'active/shared/coordination/channels/imessage/'
    );
    expect(securityPolicy.authority_role_permissions.surface_runtime.allow_write).toContain(
      'active/shared/coordination/channels/discord/'
    );
    expect(securityPolicy.authority_role_permissions.surface_runtime.allow_write).toContain(
      'active/shared/coordination/channels/telegram/'
    );

    expect(writeScopes('slack_bridge')).toContain('active/shared/coordination/channels/slack/');
    expect(writeScopes('slack_bridge')).toContain(
      'active/shared/coordination/channels/chronos/outbox/'
    );
    expect(writeScopes('slack_bridge')).toContain('active/shared/coordination/orchestration/');
    expect(writeScopes('chronos_gateway')).toContain('active/shared/coordination/chronos/');
    expect(writeScopes('chronos_gateway')).toContain('active/shared/coordination/orchestration/');
    expect(writeScopes('chronos_operator')).toEqual([]);
    expect(writeScopes('chronos_localadmin')).toContain(
      'active/shared/coordination/orchestration/'
    );
    expect(writeScopes('surface_runtime')).toContain('active/shared/runtime/');
    expect(writeScopes('surface_runtime')).toContain('knowledge/product/governance/surfaces/');
    expect(writeScopes('surface_runtime')).toContain(
      'knowledge/product/governance/active-surfaces.json'
    );
    expect(writeScopes('surface_runtime')).toContain(
      'active/shared/coordination/channels/imessage/'
    );
    expect(writeScopes('surface_runtime')).toContain(
      'active/shared/coordination/channels/discord/'
    );
    expect(writeScopes('surface_runtime')).toContain(
      'active/shared/coordination/channels/telegram/'
    );
  });

  it('ships the Slack and Chronos control model architecture reference', () => {
    expect(safeExistsSync('knowledge/product/architecture/slack-chronos-control-model.md')).toBe(
      true
    );
  });
});
