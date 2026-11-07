import { describe, expect, it } from 'vitest';
import { discoverLocalSttBackends, selectPreferredLocalSttBackend } from './local-stt-discovery.js';

type Result = { stdout: string; stderr: string; status: number | null };

function fakeExec(routes: Record<string, Result>) {
  return (command: string, args: string[]): Result =>
    routes[`${command} ${args.join(' ')}`] || { stdout: '', stderr: '', status: 1 };
}

describe('local STT discovery', () => {
  it('accepts a valid Homebrew-style symlink path and registers WhisperKit', () => {
    const exec = fakeExec({
      'which whisperkit-cli': {
        stdout: '/opt/homebrew/bin/whisperkit-cli\n',
        stderr: '',
        status: 0,
      },
      '/opt/homebrew/bin/whisperkit-cli --version': {
        stdout: 'v1.1.0\n',
        stderr: '',
        status: 0,
      },
      'which python3': { stdout: '', stderr: '', status: 1 },
      'which python3.14': { stdout: '', stderr: '', status: 1 },
      'which python3.13': { stdout: '', stderr: '', status: 1 },
      'which python3.12': { stdout: '', stderr: '', status: 1 },
      'which python3.11': { stdout: '', stderr: '', status: 1 },
      'which python': { stdout: '', stderr: '', status: 1 },
      'which swift': { stdout: '/usr/bin/swift\n', stderr: '', status: 0 },
      '/usr/bin/swift --version': { stdout: 'Apple Swift version 6\n', stderr: '', status: 0 },
    });

    const candidates = discoverLocalSttBackends({
      platform: 'darwin',
      exec,
      scriptAvailable: true,
    });

    expect(selectPreferredLocalSttBackend(candidates)?.backend).toBe('whisperkit_cli');
    expect(candidates[0]).toMatchObject({
      backend: 'whisperkit_cli',
      source: 'os-path',
      executable: '/opt/homebrew/bin/whisperkit-cli',
      connection: {
        whisperkit_cli_path: '/opt/homebrew/bin/whisperkit-cli',
        whisper_cli_path: '/opt/homebrew/bin/whisperkit-cli',
      },
    });
    expect(candidates.some((candidate) => candidate.backend === 'apple_speech_file')).toBe(true);
  });

  it('detects an OS Python mlx_whisper module independently of managed runtimes', () => {
    const exec = fakeExec({
      'which python3': { stdout: '/opt/homebrew/bin/python3\n', stderr: '', status: 0 },
      '/opt/homebrew/bin/python3 --version': {
        stdout: 'Python 3.14.7\n',
        stderr: '',
        status: 0,
      },
      "/opt/homebrew/bin/python3 -c import mlx_whisper; print(getattr(mlx_whisper, '__version__', 'installed'))":
        {
          stdout: 'installed\n',
          stderr: '',
          status: 0,
        },
    });

    const candidates = discoverLocalSttBackends({ platform: 'linux', exec });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      backend: 'mlx_whisper',
      source: 'os-python',
      python_bin: '/opt/homebrew/bin/python3',
      connection: { whisper_python_bin: '/opt/homebrew/bin/python3' },
    });
  });

  it('selects by catalog priority instead of detector insertion order', () => {
    const candidates = [
      {
        backend: 'fallback',
        display_name: 'Fallback',
        source: 'test',
        priority: 10,
        verification: 'executable' as const,
        detail: 'fallback',
        connection: {},
      },
      {
        backend: 'preferred',
        display_name: 'Preferred',
        source: 'test',
        priority: 90,
        verification: 'executable' as const,
        detail: 'preferred',
        connection: {},
      },
    ];
    expect(selectPreferredLocalSttBackend(candidates)?.backend).toBe('preferred');
  });
});
