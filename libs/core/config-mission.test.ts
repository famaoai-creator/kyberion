import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { loadConfigMissionBriefAtPath, loadConfigMissionPresetAtPath } from './config-mission.js';

const root = pathResolver.sharedTmp(`config-mission-loader-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

function writeJson(value: unknown): string {
  safeMkdir(root, { recursive: true });
  const filePath = path.join(root, 'brief.json');
  safeWriteFile(filePath, JSON.stringify(value), { encoding: 'utf8' });
  return filePath;
}

function validBrief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance_id: 'cfg-1',
    preset_id: 'tenant-onboarding',
    tenant: 'tenant-a',
    inputs: { tenant: 'tenant-a' },
    status: 'draft',
    created_at: '2026-09-03T00:00:00.000Z',
    change: {
      change_id: 'cfg-1',
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
      target_kind: 'tenant',
      requested_by: 'operator',
      risk: 'high',
      desired_hash: 'a'.repeat(64),
      probe_refs: {},
    },
    ...overrides,
  };
}

describe('config mission canonical loaders', () => {
  it('loads repository presets through the dedicated schema', () => {
    const preset = loadConfigMissionPresetAtPath(
      pathResolver.knowledge('product/config-missions/tenant-onboarding.json')
    );
    expect(preset.type).toBe('config_mission');
    expect(preset.inputs.tier.values).toEqual(['trial', 'standard', 'enterprise']);
  });

  it('loads a valid brief and rejects a mismatched scope tenant', () => {
    expect(loadConfigMissionBriefAtPath(writeJson(validBrief())).tenant).toBe('tenant-a');

    expect(() =>
      loadConfigMissionBriefAtPath(
        writeJson(
          validBrief({
            change: {
              ...((validBrief().change as Record<string, unknown>) || {}),
              scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-b' },
            },
          })
        )
      )
    ).toThrow(/does not match brief tenant/u);
  });

  it('rejects unknown preset input fields at the schema boundary', () => {
    const filePath = writeJson({
      preset_id: 'invalid-preset',
      type: 'config_mission',
      category: 'tenant',
      description: 'invalid',
      inputs: {
        tenant: {
          type: 'string',
          description: 'tenant',
          unexpected: true,
        },
      },
      pipeline: 'pipelines/config/tenant-onboarding.json',
      write_targets: ['knowledge/confidential/{{tenant}}/'],
      authority_role: 'system_configurator',
    });

    expect(() => loadConfigMissionPresetAtPath(filePath)).toThrow(
      /Invalid catalog config-mission-preset/u
    );
  });
});
