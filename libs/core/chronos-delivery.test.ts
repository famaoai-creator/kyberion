import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from './authority.js';
import {
  enqueueChronosDelivery,
  renderChronosDeliveryMessage,
  resolveChronosDeliveryChannel,
  validateChronosDeliveryTarget,
} from './chronos-delivery.js';
import { validatePipelineAdf } from './pipeline-contract.js';
import {
  clearSurfaceOutboxMessage,
  listSurfaceOutboxMessages,
} from './surface-coordination-store.js';

const createdMessageIds: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  withExecutionContext('slack_bridge', () => {
    for (const messageId of createdMessageIds.splice(0)) {
      clearSurfaceOutboxMessage('slack', messageId);
    }
  });
});

describe('chronos-delivery', () => {
  it('accepts deliver_to as a first-class validated schedule field', () => {
    const pipeline = validatePipelineAdf({
      action: 'pipeline',
      schedule: {
        cron: '0 9 * * *',
        deliver_to: { surface: 'slack', channel: '#ops', template: '{{status}}' },
      },
      steps: [{ op: 'system:log', params: { message: 'ok' } }],
    });
    expect(pipeline.schedule?.deliver_to).toMatchObject({
      surface: 'slack',
      channel: '#ops',
    });
  });

  it('renders a bounded schedule template from pipeline context', () => {
    expect(
      renderChronosDeliveryMessage({
        scheduleId: 'daily-report',
        pipelineName: 'Daily report',
        status: 'succeeded',
        context: { report: { count: 3 } },
        template: '{{pipeline_name}}: {{context.report.count}} ({{status}}) {{missing}}',
      })
    ).toBe('Daily report: 3 (succeeded) {{missing}}');
  });

  it('enqueues direct delivery into the selected surface outbox', () => {
    const messagePath = withExecutionContext('chronos_gateway', () =>
      enqueueChronosDelivery({
        scheduleId: 'daily-report',
        pipelineName: 'Daily report',
        runId: 'run-1',
        status: 'succeeded',
        context: { report: { count: 3 } },
        target: {
          surface: 'slack',
          channel: '#ops',
          thread_ts: 'thread-1',
          template: '{{pipeline_name}} count={{context.report.count}}',
        },
      })
    );
    const message = listSurfaceOutboxMessages('slack').find(
      (entry) => entry.correlation_id === 'chronos:daily-report:run-1'
    );
    if (message) createdMessageIds.push(message.message_id);
    expect(messagePath.replaceAll('\\', '/')).toContain(
      '/active/shared/coordination/channels/slack/outbox/'
    );
    expect(message).toBeDefined();

    expect(message).toMatchObject({
      correlation_id: 'chronos:daily-report:run-1',
      channel: '#ops',
      thread_ts: 'thread-1',
      text: 'Daily report count=3',
      source: 'system',
      deduplication_key: 'chronos:daily-report:run-1',
    });
  });

  it('rejects unsupported surfaces and empty targets before writing', () => {
    expect(() =>
      enqueueChronosDelivery({
        scheduleId: 'daily-report',
        pipelineName: 'Daily report',
        runId: 'run-2',
        status: 'succeeded',
        target: { surface: 'email', channel: 'ops@example.com' },
      })
    ).toThrow(/Unsupported Chronos delivery surface/);
    expect(() =>
      enqueueChronosDelivery({
        scheduleId: 'daily-report',
        pipelineName: 'Daily report',
        runId: 'run-3',
        status: 'succeeded',
        target: { surface: 'slack', channel: '' },
      })
    ).toThrow(/channel must be bounded/);
  });

  it('leaves thread_ts empty for a channel-level delivery', () => {
    const messagePath = withExecutionContext('chronos_gateway', () =>
      enqueueChronosDelivery({
        scheduleId: 'channel-report',
        pipelineName: 'Channel report',
        runId: 'run-channel',
        status: 'succeeded',
        target: { surface: 'slack', channel: 'C123' },
      })
    );
    const message = listSurfaceOutboxMessages('slack').find(
      (entry) => entry.correlation_id === 'chronos:channel-report:run-channel'
    );
    if (message) createdMessageIds.push(message.message_id);
    expect(messagePath.replaceAll('\\', '/')).toContain(
      '/active/shared/coordination/channels/slack/outbox/'
    );
    expect(message).toMatchObject({ channel: 'C123', thread_ts: '' });
  });

  it('resolves an allowlisted env channel reference and fails closed when unset', () => {
    expect(
      resolveChronosDeliveryChannel('env:KYBERION_OPERATOR_SLACK_DM', {
        KYBERION_OPERATOR_SLACK_DM: ' U0TESTDM ',
      })
    ).toBe('U0TESTDM');
    expect(resolveChronosDeliveryChannel('#ops', {})).toBe('#ops');
    expect(() => resolveChronosDeliveryChannel('env:KYBERION_OPERATOR_SLACK_DM', {})).toThrow(
      /\[CONFIG_MISSING\].*KYBERION_OPERATOR_SLACK_DM/
    );
    expect(() =>
      validateChronosDeliveryTarget({ surface: 'slack', channel: 'env:SLACK_BOT_TOKEN' })
    ).toThrow(/not allowlisted: SLACK_BOT_TOKEN/);
    expect(
      validateChronosDeliveryTarget({ surface: 'slack', channel: 'env:KYBERION_OPERATOR_SLACK_DM' })
        .channel
    ).toBe('env:KYBERION_OPERATOR_SLACK_DM');
  });

  it('refuses to enqueue an env channel delivery while the env var is unset', () => {
    vi.stubEnv('KYBERION_OPERATOR_SLACK_DM', '');
    expect(() =>
      withExecutionContext('chronos_gateway', () =>
        enqueueChronosDelivery({
          scheduleId: 'env-dm-report',
          pipelineName: 'Env DM report',
          runId: 'run-env-unset',
          status: 'succeeded',
          target: { surface: 'slack', channel: 'env:KYBERION_OPERATOR_SLACK_DM' },
        })
      )
    ).toThrow(/CONFIG_MISSING/);
    expect(
      listSurfaceOutboxMessages('slack').some(
        (entry) => entry.correlation_id === 'chronos:env-dm-report:run-env-unset'
      )
    ).toBe(false);
  });
});
