import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceRuntimeDefinition } from '@agent/core/surface/surface-runtime';
import {
  buildProfileSetupNextAction,
  buildFirstTimeUserNextActions,
  buildRecommendedSurfaces,
  collectSetupSurfaceHealth,
  formatSetupReport,
  type SetupReadinessInput,
} from './setup_report.js';

describe('setup report onboarding action', () => {
  it('places an onboarding command when identity or profile artifacts are missing', () => {
    const action = buildProfileSetupNextAction({
      checks: [
        { id: 'sovereign_identity', label: 'Sovereign Identity', status: 'missing' },
        { id: 'agent_identity', label: 'Agent Identity', status: 'ok' },
        { id: 'sovereign_vision', label: 'Sovereign Vision', status: 'missing' },
        { id: 'onboarding_summary', label: 'Onboarding Summary', status: 'ok' },
      ],
    });

    expect(action).toMatchObject({
      title: 'Complete identity and onboarding profile',
      suggested_command: 'pnpm onboarding',
    });
    expect(action?.reason).toContain('2 missing or invalid profile files');
  });

  it('does not recommend onboarding when all profile artifacts are ready', () => {
    expect(
      buildProfileSetupNextAction({
        checks: [
          { id: 'sovereign_identity', label: 'Sovereign Identity', status: 'ok' },
          { id: 'agent_identity', label: 'Agent Identity', status: 'ok' },
          { id: 'sovereign_vision', label: 'Sovereign Vision', status: 'ok' },
          { id: 'onboarding_summary', label: 'Onboarding Summary', status: 'ok' },
        ],
      })
    ).toBeUndefined();
  });
});

function readyInput(): SetupReadinessInput {
  const rows = [
    'concierge',
    'chronos-mirror-v2',
    'presence-studio',
    'voice-hub',
    'slack-bridge',
  ].map((surface) => ({
    surface,
    enabled: surface === 'slack-bridge' ? ('disabled' as const) : ('enabled' as const),
    auth: surface === 'slack-bridge' ? ('missing' as const) : ('n/a' as const),
    strategy: 'host-managed',
    secrets: '',
    cli: '',
    hint: 'Fixture setup hint.',
  }));
  return {
    surfaces: { rows },
    surfaceHealth: Object.fromEntries(
      rows.map((row, i) => [
        row.surface,
        { status: 'healthy' as const, detail: 'http_200', url: `http://127.0.0.1:${41000 + i}` },
      ])
    ),
    reasoning: { must: 0, should: 0, nice: 0 },
    doctor: {
      summaries: [
        {
          manifestId: 'kyberion-runtime-baseline',
          lines: [],
          counts: { must: 0, should: 0, nice: 0 },
        },
      ],
    },
    vital: {
      checks: [
        { id: 'sovereign_identity', label: 'Sovereign Identity', status: 'ok' },
        { id: 'agent_identity', label: 'Agent Identity', status: 'ok' },
        { id: 'sovereign_vision', label: 'Sovereign Vision', status: 'ok' },
        { id: 'onboarding_summary', label: 'Onboarding Summary', status: 'ok' },
      ],
    },
  };
}

describe('task-oriented setup readiness', () => {
  it('starts with Concierge and one request action even when optional bridges lack auth', () => {
    const report = readyInput();
    const recommendations = buildRecommendedSurfaces(report);
    expect(recommendations[0]).toMatchObject({
      id: 'concierge',
      readiness: 'ready',
      openUrl: 'http://127.0.0.1:41000',
    });
    expect(recommendations[1]).toMatchObject({ id: 'chronos', readiness: 'ready' });
    expect(recommendations[3]).toMatchObject({
      id: 'messaging',
      optional: true,
      readiness: 'unavailable',
      suggestedCommand: 'pnpm surfaces enable --surface slack-bridge',
    });
    expect(buildFirstTimeUserNextActions(report)).toEqual([
      expect.objectContaining({
        title: 'Open Concierge and make your first request',
        suggested_followup_request: 'Open http://127.0.0.1:41000',
      }),
    ]);
  });

  it.each(['connect_failed', 'http_503', 'timeout'])(
    'never treats an enabled but unhealthy Concierge (%s) as ready',
    (detail) => {
      const report = readyInput();
      report.surfaceHealth.concierge = { status: 'unhealthy', detail };
      expect(buildRecommendedSurfaces(report)[0]).toMatchObject({
        readiness: 'needs_setup',
        suggestedCommand: 'pnpm surfaces repair --surface concierge',
      });
      expect(buildFirstTimeUserNextActions(report)).toHaveLength(1);
      expect(buildFirstTimeUserNextActions(report)[0].reason).toContain(detail);
    }
  );

  it.each(['http_401', 'http_403'])(
    'directs access-denied %s to viewer-scope diagnosis instead of a restart loop',
    (detail) => {
      const report = readyInput();
      report.surfaceHealth.concierge = { status: 'unhealthy', detail };
      expect(buildFirstTimeUserNextActions(report)[0]).toMatchObject({
        next_action_type: 'inspect_artifact',
        suggested_command: 'pnpm surfaces status',
        reason: expect.stringContaining('viewer identity and scope'),
      });
    }
  );

  it('keeps disabled and missing primary surfaces distinct from unhealthy ones', () => {
    const report = readyInput();
    report.surfaces.rows[0].enabled = 'disabled';
    expect(buildRecommendedSurfaces(report)[0]).toMatchObject({
      readiness: 'unavailable',
      suggestedCommand: 'pnpm surfaces enable --surface concierge',
    });
    report.surfaces.rows = report.surfaces.rows.slice(1);
    expect(buildRecommendedSurfaces(report)[0]).toMatchObject({
      readiness: 'unavailable',
      reason: expect.stringContaining('not in the current registry'),
      suggestedCommand: 'pnpm surfaces setup',
    });
  });

  it('does not mistake credential availability or an absent probe for live readiness', () => {
    const report = readyInput();
    const slack = report.surfaces.rows.find((row) => row.surface === 'slack-bridge')!;
    slack.enabled = 'enabled';
    slack.auth = 'ready';
    report.surfaceHealth['slack-bridge'] = { status: 'unknown', detail: 'no_port_or_health_path' };
    expect(buildRecommendedSurfaces(report)[3]).toMatchObject({
      readiness: 'unverified',
      suggestedCommand: 'pnpm surfaces status',
    });
    delete report.surfaceHealth.concierge;
    expect(buildRecommendedSurfaces(report)[0].readiness).toBe('unverified');
  });

  it('reports surface authentication before suggesting startup', () => {
    const report = readyInput();
    report.surfaces.rows[0].auth = 'missing';
    expect(buildFirstTimeUserNextActions(report)[0]).toMatchObject({
      title: 'Set up authentication for concierge',
      suggested_command: 'pnpm surfaces setup',
      reason: expect.stringContaining('Fixture setup hint'),
    });
  });

  it('surfaces only the next blocking prerequisite after the UI is reachable', () => {
    const report = readyInput();
    report.vital.checks[0].status = 'missing';
    report.reasoning.must = 1;
    report.doctor.summaries[0].counts.must = 2;
    expect(buildFirstTimeUserNextActions(report)).toEqual([
      expect.objectContaining({ suggested_command: 'pnpm onboarding' }),
    ]);
    report.vital.checks[0].status = 'ok';
    expect(buildFirstTimeUserNextActions(report)).toEqual([
      expect.objectContaining({ suggested_command: 'pnpm reasoning:setup' }),
    ]);
    report.reasoning.must = 0;
    expect(buildFirstTimeUserNextActions(report)).toEqual([
      expect.objectContaining({
        suggested_command: 'pnpm env:bootstrap --manifest kyberion-runtime-baseline --apply',
      }),
    ]);
    expect(buildRecommendedSurfaces(report)[0].readiness).toBe('needs_setup');
    expect(buildRecommendedSurfaces(report)[1].readiness).toBe('ready');
  });

  it('does not block a local request for recommended or unrelated doctor gaps', () => {
    const report = readyInput();
    report.reasoning.should = 2;
    report.doctor.summaries[0].counts.should = 1;
    report.doctor.summaries.push({
      manifestId: 'meeting-participation-runtime',
      lines: [],
      counts: { must: 2, should: 1, nice: 0 },
    });
    expect(buildRecommendedSurfaces(report)[0].readiness).toBe('ready');
    expect(buildRecommendedSurfaces(report)[2]).toMatchObject({
      readiness: 'needs_setup',
      suggestedCommand: 'pnpm kyberion doctor --runtime voice',
    });
    expect(buildFirstTimeUserNextActions(report)[0].title).toBe(
      'Open Concierge and make your first request'
    );
  });

  it('requires voice prerequisite evidence instead of assuming an absent doctor report is healthy', () => {
    const report = readyInput();
    expect(buildRecommendedSurfaces(report)[2]).toMatchObject({
      readiness: 'unverified',
      suggestedCommand: 'pnpm kyberion doctor --runtime voice',
    });
    report.doctor.summaries.push({
      manifestId: 'meeting-participation-runtime',
      lines: [],
      counts: { must: 0, should: 0, nice: 0 },
    });
    expect(buildRecommendedSurfaces(report)[2].readiness).toBe('ready');
  });

  it('prints a single primary next action and identifies optional work as informational', () => {
    const input = readyInput();
    const report = {
      ...input,
      recommendedSurfaces: buildRecommendedSurfaces(input),
      nextActions: buildFirstTimeUserNextActions(input),
    } as Parameters<typeof formatSetupReport>[0];
    const text = formatSetupReport(report, 'first-time-user');
    expect(text.match(/Next Action:/g)).toHaveLength(1);
    expect(text.indexOf('Concierge')).toBeLessThan(text.indexOf('Chronos'));
    expect(text).toContain('Optional service and messaging setup is informational');
    expect(text).not.toContain('pnpm chronos:dev');
    expect(text).not.toContain('Everything looks ready');
  });
});

describe('setup report live health evidence', () => {
  afterEach(() => vi.unstubAllGlobals());

  function definition(id: string, port: number): SurfaceRuntimeDefinition {
    return {
      id,
      port,
      kind: 'ui',
      description: 'Readiness HTTP fixture',
      command: 'node',
      healthPath: '/health',
      enabled: true,
    };
  }

  it('uses the existing HTTP probe contract and configured endpoint without starting services', async () => {
    const fetchFixture = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchFixture);
    const result = await collectSetupSurfaceHealth([
      { ...definition('concierge', 41011), healthPath: '/api/summary' },
      definition('chronos-mirror-v2', 41012),
      { ...definition('optional-bridge', 41013), enabled: false },
      {
        ...definition('socket-bridge', 41014),
        kind: 'gateway',
        port: undefined,
        healthPath: undefined,
      },
    ]);
    expect(result).toEqual({
      concierge: { status: 'healthy', detail: 'http_200', url: 'http://127.0.0.1:41011' },
      'chronos-mirror-v2': {
        status: 'unhealthy',
        detail: 'http_503',
        url: 'http://127.0.0.1:41012',
      },
      'optional-bridge': { status: 'unknown', detail: 'disabled' },
      'socket-bridge': { status: 'unknown', detail: 'no_port_or_health_path' },
    });
    expect(fetchFixture.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:41011/api/summary',
      'http://127.0.0.1:41012/health',
    ]);
  });
});
