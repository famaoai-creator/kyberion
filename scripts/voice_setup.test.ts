import { describe, expect, it, vi } from 'vitest';
import { formatVoiceSetupReport, runVoiceSetupScript, type VoiceSetupRow } from './voice_setup.js';

describe('voice setup report', () => {
  it('formats recovery guidance without direct process output', () => {
    const row: VoiceSetupRow = {
      toolId: 'mlx_audio',
      managedEnvPath: '/tmp/voice',
      installed: false,
      installAction: 'pending',
      pythonBin: null,
      status: 'needs_install',
      detail: 'runtime unavailable',
    };

    expect(formatVoiceSetupReport([row], false)).toContain(
      'Next step: `pnpm kyberion voice setup --apply`'
    );
    expect(formatVoiceSetupReport([row], false)).toContain(
      'Verify: `pnpm pipeline voice-health-check`'
    );
  });

  it('emits valid JSON through the canonical voice setup entrypoint', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runVoiceSetupScript(['--json']);

    const output = logSpy.mock.calls.flat().join('');
    const parsed = JSON.parse(output) as { status: string; rows: unknown[] };
    expect(['ready', 'needs_install']).toContain(parsed.status);
    expect(parsed.rows.length).toBeGreaterThan(0);
  });
});
