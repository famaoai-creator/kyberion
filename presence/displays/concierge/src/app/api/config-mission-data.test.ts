import { describe, expect, it } from 'vitest';
import { parseConfigMissionBrief, parseConfigMissionPreset } from './config-mission-data';

describe('config mission persisted data parsers', () => {
  it('accepts governed preset shapes and excludes malformed definitions', () => {
    expect(
      parseConfigMissionPreset({
        type: 'config_mission',
        preset_id: 'demo',
        inputs: {
          mode: {
            type: 'enum',
            description: 'Mode',
            values: ['safe'],
            required: true,
          },
        },
        write_targets: ['knowledge/confidential/{{tenant}}/demo.json'],
      })
    ).toMatchObject({ id: 'demo', inputs: [{ key: 'mode', type: 'enum', values: ['safe'] }] });
    expect(
      parseConfigMissionPreset({ type: 'config_mission', preset_id: 'broken', inputs: [] })
    ).toBeNull();
  });

  it('accepts only complete config mission brief identities', () => {
    expect(
      parseConfigMissionBrief({
        instance_id: 'cfg-1',
        preset_id: 'demo',
        tenant: 'alpha-team',
        status: 'draft',
        created_at: '2026-09-01T00:00:00.000Z',
      })
    ).toMatchObject({ instance_id: 'cfg-1', status: 'draft' });
    expect(parseConfigMissionBrief({ instance_id: 'cfg-1', status: 'draft' })).toBeNull();
    expect(
      parseConfigMissionBrief({
        instance_id: 'cfg-1',
        preset_id: 'demo',
        tenant: 'alpha-team',
        status: 'unknown',
        created_at: '2026-09-01T00:00:00.000Z',
      })
    ).toBeNull();
  });
});
