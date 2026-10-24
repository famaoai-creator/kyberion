import { afterEach, describe, expect, it } from 'vitest';

import { safeMkdir, safeRmSync } from '../secure-io.js';
import { writeJson } from '../foundation/json.js';
import type { DotCharter } from './dot-charter.js';
import type { EventIntakePolicy } from './dot-event-intake.js';
import { describeDotIntakePlan } from './dot-intake-plan.js';
import { DOT_STATE_ROOT } from './dot-state-paths.js';

const TEST_ROOT = 'active/shared/tmp/dot-intake-plan-tests';
const NOW = new Date('2026-10-25T00:00:00Z');

const POLICY: EventIntakePolicy = {
  version: '1.0.0',
  sources: {
    github: {
      enabled: true,
      signature_header: 'x-hub-signature-256',
      prefix: 'sha256=',
      secret_key: 'EVENT_INTAKE_GITHUB_SECRET',
      event_type_header: 'x-github-event',
      delivery_id_header: 'x-github-delivery',
      max_body_bytes: 65536,
    },
    slack: {
      enabled: false,
      signature_header: 'x-kyberion-signature',
      prefix: 'sha256=',
      secret_key: 'EVENT_INTAKE_SLACK_SECRET',
      event_type_header: 'x-kyberion-event',
      delivery_id_header: 'x-kyberion-delivery',
      max_body_bytes: 65536,
    },
    'acme-local': {
      enabled: false,
      local_only: true,
      tenant_slug: 'acme',
      signature_header: 'x-kyberion-signature',
      prefix: 'sha256=',
      secret_key: 'EVENT_INTAKE_ACME_SECRET',
      event_type_header: 'x-kyberion-event',
      delivery_id_header: 'x-kyberion-delivery',
      max_body_bytes: 65536,
    },
  },
};

function charter(overrides: Partial<DotCharter> = {}): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: 'repo-guardian',
    version: '1.0.0',
    title: 'Repo guardian',
    purpose: 'Watch CI and Slack.',
    status: 'active',
    scope: { tier: 'public' },
    goal: { statement: 'Escalate CI breakage and deployment failures.' },
    attention: {
      triggers: [
        { kind: 'event', sources: ['github'], types: ['issues', 'workflow_run'] },
        {
          kind: 'feed',
          source: 'slack',
          service_id: 'slack',
          action: 'search_messages',
          params: { query: 'deploy failed' },
          items_path: 'messages.matches',
          item_id_path: 'ts',
          event_type: 'slack_message',
          every_s: 300,
        },
        { kind: 'event', sources: ['slack'], types: ['slack_message'] },
      ],
    },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_work_shapes: ['direct_reply', 'pipeline'],
    },
    decisions: { default_decision: 'notify' },
    notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
    runtime: { heartbeat_id: 'dot-repo-guardian' },
    ...overrides,
  };
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('describeDotIntakePlan', () => {
  it('renders push and pull rows with the authority that constrains them', () => {
    const plan = describeDotIntakePlan({
      charters: [charter()],
      policy: POLICY,
      rootDir: TEST_ROOT,
      now: NOW,
    });
    const push = plan.rows.find((row) => row.mode === 'push' && row.source === 'github');
    expect(push).toMatchObject({
      dot_id: 'repo-guardian',
      armed: true,
      enabled_by: 'policy',
      tenant_ok: true,
      authority_role: 'infrastructure_sentinel',
      work_shapes: ['direct_reply', 'pipeline'],
      decision: 'notify',
    });
    expect(push?.types).toEqual(['issues', 'workflow_run']);

    // A feed is armed even though its source is not webhook-enabled: it
    // ingests locally and does not need inbound delivery.
    const pull = plan.rows.find((row) => row.mode === 'pull');
    expect(pull).toMatchObject({ source: 'slack', armed: true, source_enabled: true });
    expect(pull?.feed?.coverage.state).toBe('never_polled');
  });

  it('marks a disabled push source and says how to enable it', () => {
    const plan = describeDotIntakePlan({
      charters: [charter({ attention: { triggers: [{ kind: 'event', sources: ['slack'] }] } })],
      policy: POLICY,
      rootDir: TEST_ROOT,
      now: NOW,
    });
    const row = plan.rows[0];
    expect(row.armed).toBe(false);
    expect(row.enabled_by).toBe('disabled');
    expect(row.warnings.join(' ')).toMatch(/disabled on this host/);
  });

  it('names the host opt-in that enabled a source', () => {
    const plan = describeDotIntakePlan({
      charters: [charter({ attention: { triggers: [{ kind: 'event', sources: ['slack'] }] } })],
      policy: {
        ...POLICY,
        sources: { ...POLICY.sources, slack: { ...POLICY.sources.slack, enabled: true } },
      },
      hostOptIn: 'slack',
      rootDir: TEST_ROOT,
      now: NOW,
    });
    expect(plan.rows[0].enabled_by).toBe('host_opt_in');
  });

  it('refuses to arm a source bound to another tenant', () => {
    const plan = describeDotIntakePlan({
      charters: [
        charter({
          scope: { tier: 'confidential', tenant_slug: 'acme' },
          attention: { triggers: [{ kind: 'event', sources: ['github'] }] },
        }),
      ],
      policy: POLICY,
      rootDir: TEST_ROOT,
      now: NOW,
    });
    const row = plan.rows[0];
    expect(row.tenant_ok).toBe(false);
    expect(row.armed).toBe(false);
    expect(row.warnings.join(' ')).toMatch(/bound to tenant/);
  });

  it('surfaces a stalled feed instead of reporting a quiet healthy row', () => {
    const plan = describeDotIntakePlan({
      charters: [charter()],
      policy: POLICY,
      rootDir: TEST_ROOT,
      now: NOW,
    });
    const pull = plan.rows.find((row) => row.mode === 'pull');
    const statePath = `${TEST_ROOT}/${DOT_STATE_ROOT}/feed/${pull?.feed?.spec_id}.json`;
    safeMkdir(`${TEST_ROOT}/${DOT_STATE_ROOT}/feed`, { recursive: true });
    writeJson(statePath, {
      spec_id: pull?.feed?.spec_id,
      source: 'slack',
      service_id: 'slack',
      action: 'search_messages',
      seen: [],
      seeded_at: '2026-10-24T00:00:00.000Z',
      last_poll_at: '2026-10-24T00:00:00.000Z',
      last_success_at: '2026-10-24T00:00:00.000Z',
      last_error: 'slack_unavailable',
      consecutive_failures: 3,
      stalled_since: '2026-10-24T00:00:00.000Z',
      ingested: 0,
      duplicates: 0,
      capped_polls: 0,
    });

    const stale = describeDotIntakePlan({
      charters: [charter()],
      policy: POLICY,
      rootDir: TEST_ROOT,
      now: NOW,
    });
    const row = stale.rows.find((entry) => entry.mode === 'pull');
    expect(row?.feed?.coverage.state).toBe('stalled');
    expect(row?.warnings.join(' ')).toMatch(/feed stalled/);
  });

  it('lists declared sources and keeps a non-active charter unarmed', () => {
    const plan = describeDotIntakePlan({
      charters: [charter({ status: 'paused' })],
      policy: POLICY,
      rootDir: TEST_ROOT,
      now: NOW,
    });
    expect(plan.declared_sources.map((source) => source.id)).toEqual([
      'acme-local',
      'github',
      'slack',
    ]);
    expect(plan.rows.every((row) => !row.armed)).toBe(true);
    expect(plan.rows[0].warnings.join(' ')).toMatch(/paused/);
  });

  it('warns when a feed has no event consumer', () => {
    const plan = describeDotIntakePlan({
      charters: [
        charter({
          attention: {
            triggers: [
              {
                kind: 'feed',
                source: 'slack',
                service_id: 'slack',
                action: 'search_messages',
                event_type: 'slack_message',
              },
            ],
          },
        }),
      ],
      policy: POLICY,
      rootDir: TEST_ROOT,
      now: NOW,
    });
    expect(plan.warnings.join(' ')).toMatch(/no event trigger/);
  });
});
