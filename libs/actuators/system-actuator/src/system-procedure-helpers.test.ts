import { describe, it, expect, vi } from 'vitest';
vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertSafeRepositoryPath: (p: string) => p,
  safeExistsSync: () => true,
  safeStat: () => ({ isFile: () => true }),
}));
import {
  probeProvider,
  parseProviderProbe,
  probeNarratedTools,
  partitionSurfaceHealth,
  validateAudioArtifact,
  type ProbeExec,
} from './system-procedure-helpers.js';
const ok = { stdout: '1.0\n', stderr: '', status: 0 };
describe('typed diagnostic procedures', () => {
  it('validates all provider entries before process execution', () => {
    expect(parseProviderProbe({ name: 'cli', command: 'cli', ping_args: ['ping'] })).toMatchObject({
      command: 'cli',
    });
    for (const entry of [
      null,
      [],
      { name: 'cli' },
      { name: 'cli', command: 'cli', ping_args: [1] },
    ])
      expect(() => parseProviderProbe(entry)).toThrow();
  });
  it('probes version/ping/capability with argv and bounded execution', () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce(ok)
      .mockReturnValueOnce({ ...ok, stdout: 'PONG\nnoise' })
      .mockReturnValueOnce({ ...ok, stdout: '--acp' });
    expect(
      probeProvider(
        {
          name: 'provider',
          command: 'provider',
          ping_args: ['-p', 'a ; b'],
          capability_marker: '--acp',
        },
        exec as ProbeExec
      )
    ).toEqual({
      name: 'provider',
      install: 'INSTALLED',
      version: '1.0',
      ping: 'PONG',
      capability: true,
    });
    expect(exec.mock.calls[1]).toEqual([
      'provider',
      ['-p', 'a ; b'],
      { timeoutMs: 30000, input: 'ping\n' },
    ]);
  });
  it('does not ping absent providers and tries fallback only when needed', () => {
    const exec = vi.fn().mockReturnValue({ ...ok, status: 127 });
    expect(
      probeProvider({ name: 'absent', command: 'absent', ping_args: ['ping'] }, exec as ProbeExec)
        .install
    ).toBe('NOT_FOUND');
    expect(exec).toHaveBeenCalledTimes(1);
    const fallback = vi
      .fn()
      .mockReturnValueOnce({ ...ok, status: 127 })
      .mockReturnValueOnce(ok);
    expect(
      probeProvider(
        {
          name: 'codex',
          command: 'codex',
          fallback_command: 'npx',
          fallback_args: ['codex', '--version'],
        },
        fallback as ProbeExec
      ).install
    ).toBe('INSTALLED (npx)');
  });
  it('uses native help arguments for say and ffmpeg rather than unsupported --version', () => {
    const exec = vi.fn().mockReturnValue(ok);
    expect(probeNarratedTools(exec as ProbeExec).say.available).toBe(true);
    expect(exec.mock.calls[0][1]).toEqual(['-v', '?']);
    expect(exec.mock.calls[2][1]).toEqual(['-version']);
  });
  it('requires ffmpeg and ffprobe while native speech tools remain optional', () => {
    const optional = vi.fn((command: string) => ({
      ...ok,
      status: ['say', 'espeak'].includes(command) ? 127 : 0,
    }));
    expect(probeNarratedTools(optional as ProbeExec).say.available).toBe(false);
    for (const missing of ['ffmpeg', 'ffprobe']) {
      const exec = vi.fn((command: string) => ({ ...ok, status: command === missing ? 127 : 0 }));
      expect(() => probeNarratedTools(exec as ProbeExec)).toThrow(missing + ' is unavailable');
    }
  });
  it('preserves zombie classification separately from disabled stopped services', () => {
    const running = { id: 'a', running: true, enabled: false },
      zombie = { id: 'b', running: false, enabled: true },
      stopped = { id: 'c', running: false, enabled: false };
    expect(partitionSurfaceHealth([running, zombie, stopped])).toEqual({
      running: [running],
      zombies: [zombie],
      stopped: [stopped],
    });
    expect(() => partitionSurfaceHealth({})).toThrow();
  });
  it('rejects successful ffprobe without an audio stream', () => {
    expect(() =>
      validateAudioArtifact(
        'audio.aiff',
        vi.fn().mockReturnValue({ ...ok, stdout: '' }) as ProbeExec
      )
    ).toThrow('no valid audio stream');
    expect(
      validateAudioArtifact(
        'audio.aiff',
        vi.fn().mockReturnValue({ ...ok, stdout: 'audio\n' }) as ProbeExec
      ).status
    ).toBe(0);
  });
});
