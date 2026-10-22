import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from './authority.js';
import {
  enqueueChronosDelivery,
  renderChronosDeliveryMessage,
  resolveChronosDeliveryChannel,
  validateChronosDeliveryTarget,
} from './chronos-delivery.js';
import { validatePipelineAdf } from './pipeline/pipeline-contract.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  clearSurfaceOutboxMessage,
  listSurfaceOutboxMessages,
} from './surface/surface-coordination-store.js';

const createdMessageIds: string[] = [];
const createdChronosMessageIds: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  withExecutionContext('slack_bridge', () => {
    for (const messageId of createdMessageIds.splice(0)) {
      clearSurfaceOutboxMessage('slack', messageId);
    }
  });
  withExecutionContext('chronos_gateway', () => {
    for (const messageId of createdChronosMessageIds.splice(0)) {
      clearSurfaceOutboxMessage('chronos', messageId);
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

  it('validates the shipped digest schedule that delivers to Chronos', () => {
    // Schema and the runtime allowlist must agree, or chronos silently skips the file.
    const adf = JSON.parse(
      safeReadFile(pathResolver.rootResolve('pipelines/organization-daily-digest.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(validatePipelineAdf(adf).schedule?.deliver_to).toMatchObject({ surface: 'chronos' });
    // The cross-tenant text must never land in the system-namespace outbox:
    // only counts are delivered; the text lives in per-organization artifacts.
    const template = String(adf.schedule.deliver_to.template);
    expect(template).not.toMatch(/organization_digest\.(text|tenants|organizations)\b/);
    expect(template).toContain('organization_digest.totals.');
    const rendered = renderChronosDeliveryMessage({
      scheduleId: 'organization-daily-digest',
      pipelineName: 'Organization daily digest',
      status: 'succeeded',
      context: {
        organization_digest: {
          status: 'attention',
          organization_count: 5,
          totals: {
            due_operations: 3,
            deadlines: 1,
            pending_decisions: 2,
            open_incidents: 1,
            expiring_services: 0,
          },
        },
      },
      template,
    });
    expect(rendered).not.toContain('{{');
    expect(rendered).toContain('5');
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
    expect(messagePath.replaceAll('\\', '/')).toContain('/coordination/channels/slack/outbox/');
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

  it('delivers to the local Chronos outbox without an external chat bridge', () => {
    const messagePath = withExecutionContext('chronos_gateway', () =>
      enqueueChronosDelivery({
        scheduleId: 'organization-daily-digest',
        pipelineName: 'Organization daily digest',
        runId: 'run-chronos-1',
        status: 'succeeded',
        context: { organization_digest: { text: 'digest body' } },
        target: {
          surface: 'chronos',
          channel: 'chronos',
          template: '{{context.organization_digest.text}}',
        },
      })
    );
    const message = listSurfaceOutboxMessages('chronos').find(
      (entry) => entry.correlation_id === 'chronos:organization-daily-digest:run-chronos-1'
    );
    if (message) createdChronosMessageIds.push(message.message_id);
    expect(messagePath.replaceAll('\\', '/')).toContain('/coordination/channels/chronos/outbox/');
    expect(message).toMatchObject({ channel: 'chronos', text: 'digest body', source: 'system' });
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
    expect(messagePath.replaceAll('\\', '/')).toContain('/coordination/channels/slack/outbox/');
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
