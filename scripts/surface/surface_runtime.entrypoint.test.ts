import { describe, expect, it } from 'vitest';
import {
  formatSurfaceStatus,
  normalizeSurfaceRuntimeArgs,
  parseSurfaceRegisterArgs,
} from './surface_runtime.js';

describe('surface runtime entrypoint', () => {
  it('maps the unified positional action to the legacy action option', () => {
    expect(normalizeSurfaceRuntimeArgs(['reconcile', '--', '--json'])).toEqual([
      '--action',
      'reconcile',
    ]);
    expect(normalizeSurfaceRuntimeArgs(['status', '--surface', 'chronos'])).toEqual([
      '--action',
      'status',
      '--surface',
      'chronos',
    ]);
  });

  it('keeps explicit action options compatible', () => {
    expect(normalizeSurfaceRuntimeArgs(['--action', 'repair', '--surface', 'chronos'])).toEqual([
      '--action',
      'repair',
      '--surface',
      'chronos',
    ]);
  });

  it('accepts only string arrays for JSON register args and rejects dangerous keys', () => {
    expect(parseSurfaceRegisterArgs('["--port","3000"]')).toEqual(['--port', '3000']);
    expect(() => parseSurfaceRegisterArgs('{"__proto__":{"polluted":true}}')).toThrow(
      'surface register args contains a dangerous JSON key'
    );
    expect(() => parseSurfaceRegisterArgs('{"port":3000}')).toThrow(
      'surface register args must be a JSON array of strings'
    );
  });

  it('prints one line per surface with a summary instead of raw diagnostics', () => {
    const text = formatSurfaceStatus({
      status: 'ok',
      manifestPath: 'm.json',
      manifestDirectory: 'surfaces',
      statePath: 'active/shared/runtime/surfaces/state.json',
      surfaces: {},
      health: {},
      runtime: [],
      diagnostics: {
        concierge: {
          stateHealth: 'healthy',
          lastKnownState: { pid: 42, startedAt: '2026-10-04T00:00:00.000Z' },
          recentLogTail: ['secret-looking log line'],
        },
        'voice-hub': {
          stateHealth: 'stale',
          nextAction: {
            id: 'repair-voice-hub',
            title: 'Repair surface voice-hub',
            reason: 'stale state record',
            suggested_command: 'pnpm surfaces repair -- --surface voice-hub',
          },
          lastKnownState: { pid: 7, startedAt: '2026-10-04T00:00:00.000Z' },
        },
        'slack-bridge': { stateHealth: 'untracked', lastKnownState: null },
      },
    } as unknown as Parameters<typeof formatSurfaceStatus>[0]);

    expect(text).toContain('concierge');
    expect(text).toContain('Command: pnpm surfaces repair -- --surface voice-hub');
    expect(text).toContain('Summary: 1 healthy, 1 stale, 1 untracked');
    expect(text).not.toContain('secret-looking log line');
  });
});
