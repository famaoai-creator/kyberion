import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  exposeSurface: vi.fn(),
  listSurfaceIngressStatus: vi.fn(),
  probePublicIngressProviders: vi.fn(),
  withdrawSurface: vi.fn(),
}));
vi.mock('@agent/core/ingress/public-ingress-service', () => service);
vi.mock('@agent/core/dot/dot-event-intake', () => ({
  loadEventIntakePolicy: () => ({
    version: '1',
    sources: { github: { enabled: true }, ci: { enabled: false } },
  }),
}));

import { ScriptExitError } from './lib/harness.js';
import { parseIngressArgs, runIngressCli, surfaceEndpointHints } from './ingress.js';

const selection = {
  route: 'default',
  reason: 'first ready provider in catalog order',
  candidates: [],
};

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset();
});

describe('ingress CLI', () => {
  it('parses subcommands and flags, rejecting incomplete input', () => {
    expect(
      parseIngressArgs(['up', '--surface', 'event-intake', '--provider=tailscale-funnel'])
    ).toEqual({
      command: 'up',
      surface: 'event-intake',
      provider: 'tailscale-funnel',
      json: false,
    });
    expect(parseIngressArgs(['--', 'probe', '--json'])).toEqual({ command: 'probe', json: true });
    expect(() => parseIngressArgs(['up'])).toThrow(ScriptExitError);
    expect(() => parseIngressArgs(['expose'])).toThrow(/Usage/);
    expect(() => parseIngressArgs(['status', '--bogus'])).toThrow(/unknown argument/);
  });

  it('probe prints every candidate with its readiness and setup steps', async () => {
    service.probePublicIngressProviders.mockResolvedValue([
      {
        provider_id: 'tailscale-funnel',
        status: 'live',
        network_class: 'public_internet',
        stable_url: true,
        readiness: {
          status: 'needs_setup',
          reason: 'tailscale CLI not found',
          setup_steps: ['Install Tailscale'],
        },
      },
      {
        provider_id: 'ngrok',
        status: 'planned',
        network_class: 'public_internet',
        stable_url: false,
        readiness: { status: 'unsupported', reason: 'provider module not implemented yet' },
      },
    ]);
    const lines: unknown[] = [];
    await runIngressCli({ command: 'probe', json: false }, (line) => lines.push(line));
    expect(lines.join('\n')).toMatch(
      /tailscale-funnel \[live\] needs_setup — tailscale CLI not found/
    );
    expect(lines.join('\n')).toMatch(/- Install Tailscale/);
    expect(lines.join('\n')).toMatch(/ngrok \[planned\] unsupported/);
  });

  it('up prints the public URL and the webhook URL per enabled event-intake source', async () => {
    service.exposeSurface.mockResolvedValue({
      status: 'exposed',
      selection,
      exposure: {
        surface_id: 'event-intake-surface',
        provider_id: 'tailscale-funnel',
        public_url: 'https://mac.tail1.ts.net/events',
        local_port: 8791,
        path_prefix: '/events',
        started_at: '2026-10-05T00:00:00.000Z',
        stable_url: true,
      },
    });
    const lines: unknown[] = [];
    await runIngressCli({ command: 'up', surface: 'event-intake', json: false }, (line) =>
      lines.push(line)
    );
    const text = lines.join('\n');
    expect(text).toMatch(
      /Exposed event-intake-surface at https:\/\/mac.tail1.ts.net\/events via tailscale-funnel/
    );
    expect(text).toMatch(/github: https:\/\/mac.tail1.ts.net\/events\/github/);
    expect(text).not.toMatch(/ci: /);
  });

  it('up exits 3 with the approval command while approval is pending', async () => {
    service.exposeSurface.mockResolvedValue({
      status: 'approval_required',
      approval_state: 'created',
      approval_request_id: 'APR-9',
      message: 'Approval request APR-9 created; awaiting decision',
      provider_id: 'tailscale-funnel',
      selection,
    });
    const lines: unknown[] = [];
    await expect(
      runIngressCli({ command: 'up', surface: 'event-intake', json: false }, (line) =>
        lines.push(line)
      )
    ).rejects.toMatchObject({ code: 3 });
    expect(lines.join('\n')).toMatch(/pnpm kyberion approvals --approve APR-9/);
  });

  it('a rejected request explains why instead of offering the approve command', async () => {
    service.exposeSurface.mockResolvedValue({
      status: 'approval_required',
      approval_state: 'rejected',
      approval_request_id: 'APR-7',
      message: 'Approval request APR-7 is rejected',
      provider_id: 'tailscale-funnel',
      selection,
    });
    const lines: unknown[] = [];
    await expect(
      runIngressCli({ command: 'up', surface: 'event-intake', json: false }, (line) =>
        lines.push(line)
      )
    ).rejects.toMatchObject({ code: 3 });
    const text = lines.join('\n');
    expect(text).toMatch(/Approval request APR-7 is rejected/);
    expect(text).toMatch(/new request is opened automatically once it lapses/);
    expect(text).not.toMatch(/approvals --approve/);
  });

  it('down passes --provider and reports which providers were checked', async () => {
    service.withdrawSurface.mockResolvedValue({
      status: 'not_exposed',
      checked_providers: ['tailscale-funnel'],
    });
    const lines: unknown[] = [];
    await runIngressCli(
      { command: 'down', surface: 'event-intake', provider: 'tailscale-funnel', json: false },
      (line) => lines.push(line)
    );
    expect(service.withdrawSurface).toHaveBeenCalledWith({
      surfaceId: 'event-intake',
      providerId: 'tailscale-funnel',
    });
    expect(lines.join('\n')).toBe('event-intake is not exposed (checked: tailscale-funnel).');

    service.listSurfaceIngressStatus.mockResolvedValue([]);
    await runIngressCli({ command: 'status', provider: 'tailscale-funnel', json: true }, () => {});
    expect(service.listSurfaceIngressStatus).toHaveBeenCalledWith({
      providerId: 'tailscale-funnel',
    });
  });

  it('endpoint hints are keyed by surface, empty for surfaces without hints', () => {
    expect(surfaceEndpointHints('event-intake-surface', 'https://h/events')).toEqual([
      { name: 'ci', url: 'https://h/events/ci', enabled: false },
      { name: 'github', url: 'https://h/events/github', enabled: true },
    ]);
    expect(surfaceEndpointHints('operator-surface', 'https://h')).toEqual([]);
  });
});
