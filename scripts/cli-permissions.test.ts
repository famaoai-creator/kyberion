import { describe, expect, it, vi } from 'vitest';
import { runPermissionsCommand, type PermissionsDeps } from './cli-permissions.js';
import { renderPermissionsWarmup } from './cli-permissions.js';

function deps(): PermissionsDeps & { warmup: ReturnType<typeof vi.fn> } {
  return {
    probe: vi.fn(() => ({
      available: true,
      automation: 'unknown',
      browser_automation: 'unknown',
      accessibility: 'granted',
      screen_recording: 'denied',
      microphone: 'not_determined',
      camera: 'granted',
      host_app: 'com.apple.Terminal',
    })),
    warmup: vi.fn(() => ({
      supported: true,
      results: { microphone: { before: 'denied', after: 'denied', remedy: 'x-apple:pane' } },
    })),
  } as never;
}

async function run(argv: string[], d = deps()) {
  const out: string[] = [];
  await runPermissionsCommand(argv, (text) => out.push(text), d);
  return { out: out.join('\n'), d };
}

describe('cli permissions', () => {
  it('status renders a Markdown table and never warms up', async () => {
    const { out, d } = await run(['status']);
    expect(out).toContain('| microphone | not_determined |');
    expect(out).toContain('host app: com.apple.Terminal');
    expect(out).toContain('permissions warmup');
    expect(d.warmup).not.toHaveBeenCalled();
  });

  it('status --json is structured', async () => {
    const { out } = await run(['status', '--json']);
    expect(JSON.parse(out).permissions).toEqual({
      microphone: 'not_determined',
      camera: 'granted',
      screen_recording: 'denied',
    });
  });

  it('warmup defaults to the microphone and prints the remedy for denied kinds', async () => {
    const { out, d } = await run(['warmup']);
    expect(d.warmup).toHaveBeenCalledWith(['microphone']);
    expect(out).toContain('x-apple:pane');
  });

  it('warmup --only selects kinds and rejects unknown ones', async () => {
    const { d } = await run(['warmup', '--only', 'microphone,camera']);
    expect(d.warmup).toHaveBeenCalledWith(['microphone', 'camera']);
    await expect(run(['warmup', '--only', 'speakers'])).rejects.toThrow('Unknown permission kind');
  });

  it('warmup explains restricted kinds, per-kind failures and an unknown host', () => {
    const out = renderPermissionsWarmup(
      {
        supported: true,
        host_app: 'com.apple.Terminal',
        results: {
          microphone: { before: 'restricted', after: 'restricted' },
          camera: { before: 'unknown', after: 'unknown', error: 'native_execution_failed' },
        },
      },
      false
    );
    expect(out).toContain('host app: com.apple.Terminal');
    expect(out).toContain('microphone is restricted by a device policy');
    expect(out).toContain('camera warm-up failed: native_execution_failed');
    expect(
      renderPermissionsWarmup({ supported: true, results: {}, reason: 'host_app_unknown' }, false)
    ).toContain('must run from a terminal app');
  });
});
