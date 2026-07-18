import { describe, expect, it } from 'vitest';
import { createAutomationBlueprintFromPipeline } from './automation-blueprint.js';
import {
  buildAutomationSlackModal,
  extractAutomationSlackFormValues,
  parseAutomationSlackModalMetadata,
} from './automation-blueprint-slack.js';

const blueprint = createAutomationBlueprintFromPipeline('pipelines/daily-report.json', {
  name: 'Daily report',
  schedule: {
    id: 'daily-report',
    cron: '30 3 * * *',
    timezone: 'Asia/Tokyo',
    deliver_to: { surface: 'slack', channel: '#ops' },
  },
});

describe('automation-blueprint-slack', () => {
  it('builds a modal with the shared slot ids and bounded metadata', () => {
    const modal = buildAutomationSlackModal(blueprint, {
      blueprint_id: blueprint.blueprint_id,
      pipeline_ref: blueprint.pipeline_ref,
      channel: 'C123',
      thread_ts: '1710000000.0001',
      actor_id: 'U123',
    });

    expect(modal.callback_id).toBe('kyberion_automation_submit');
    expect(modal.blocks.map((block) => block.block_id).filter(Boolean)).toEqual([
      'automation_minute',
      'automation_hour',
      'automation_delivery_channel',
    ]);
    expect(parseAutomationSlackModalMetadata(modal.private_metadata)).toMatchObject({
      blueprint_id: 'daily-report',
      channel: 'C123',
    });
  });

  it('extracts plain-text and static-select values from Slack view state', () => {
    const values = extractAutomationSlackFormValues(blueprint, {
      automation_minute: { value: { value: '15' } },
      automation_hour: { value: { value: '8' } },
      automation_delivery_channel: {
        value: { selected_option: { value: 'C999' } },
      },
    });
    expect(values).toEqual({ minute: '15', hour: '8', delivery_channel: 'C999' });
  });

  it('rejects malformed modal metadata', () => {
    expect(() => parseAutomationSlackModalMetadata('{"blueprint_id":"only"}')).toThrow(
      /Missing Slack automation metadata/
    );
  });
});
