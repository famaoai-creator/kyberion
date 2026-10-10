import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

// `pnpm kyberion voice setup` and then `voice setup --apply` in one process: the
// second run installs managed mlx_whisper, and its local-STT report must show it
// although the first run cached "no backend" (review M1). The managed runtime
// lives in a sandbox; installs and probes are simulated at the secure-io and
// tool-runtime seams.
const sim = vi.hoisted(() => ({
  envPath: '',
  installed: false,
  calls: [] as string[],
}));

function binPath(): string {
  return path.join(sim.envPath, 'bin', 'python');
}

vi.mock('@agent/core/tool/tool-runtime-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/tool/tool-runtime-registry')>();
  const { safeExistsSync } = await import('@agent/core/secure-io');
  const locate = () => {
    const bin = path.join(sim.envPath, 'bin', 'python');
    return safeExistsSync(bin) ? bin : null;
  };
  return {
    ...actual,
    probeToolRuntime: (toolId: string) => ({
      tool: { tool_id: toolId, platforms: ['any'] },
      managed_env_path: sim.envPath,
      install_backend: { command: 'uv', args: ['pip', 'install', 'mlx-whisper'] },
      reason: `${toolId} is not installed`,
    }),
    markToolRuntimeInstalled: () => undefined,
    resolveManagedToolPythonBin: (toolId?: string) => (toolId === 'mlx_whisper' ? locate() : null),
    locateManagedToolPythonBin: (toolId: string) => (toolId === 'mlx_whisper' ? locate() : null),
  };
});

vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/secure-io')>();
  const ok = (stdout = '') => ({ stdout, stderr: '', status: 0 });
  const fail = () => ({ stdout: '', stderr: '', status: 1 });
  return {
    ...actual,
    safeExecResult: (command: string, args: string[] = []) => {
      sim.calls.push(`${command} ${args.join(' ')}`);
      if (command === 'uv' && args[0] === 'venv') {
        actual.safeMkdir(path.join(sim.envPath, 'bin'), { recursive: true });
        actual.safeWriteFile(path.join(sim.envPath, 'bin', 'python'), '#!/bin/sh\n');
        return ok();
      }
      if (command === 'uv' && args[0] === 'pip') {
        sim.installed = true;
        return ok();
      }
      if (command === path.join(sim.envPath, 'bin', 'python') && args[0] === '-c') {
        if (args[1]?.includes('sys.version_info')) return ok('3.11\n');
        return sim.installed ? ok('0.4.2\n') : fail();
      }
      return fail();
    },
  };
});

let voiceSetup: typeof import('./voice_setup.js');
let secureIo: typeof import('@agent/core/secure-io');
let discovery: typeof import('@agent/core/local-stt-discovery');
let sandbox: string;

beforeAll(async () => {
  const { pathResolver } = await import('@agent/core/path-resolver');
  sandbox = pathResolver.sharedTmp(
    `voice-setup-discovery-test/${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  sim.envPath = path.join(sandbox, 'tool-runtimes', 'mlx_whisper');
  secureIo = await import('@agent/core/secure-io');
  discovery = await import('@agent/core/local-stt-discovery');
  voiceSetup = await import('./voice_setup.js');
  discovery.resetLocalSttDiscoveryCache({ disk: true });
}, 60_000);

afterAll(() => {
  discovery.resetLocalSttDiscoveryCache({ disk: true });
  secureIo.safeRmSync(sandbox, { recursive: true, force: true });
});

describe('voice setup and local STT discovery cache', () => {
  it('voice setup --apply right after voice setup reports the backend it installed', async () => {
    const managedMlx = (candidates: { backend: string; source: string }[]) =>
      candidates.filter((c) => c.backend === 'mlx_whisper' && c.source === 'managed-runtime');

    const before = await voiceSetup.main(['--tool', 'mlx_whisper']);
    expect(before.rows[0]?.status).toBe('needs_install');
    expect(managedMlx(before.localStt)).toEqual([]);

    const after = await voiceSetup.main(['--apply', '--tool', 'mlx_whisper']);
    expect(after.rows[0]?.status).toBe('ready');
    expect(sim.calls.some((call) => call.startsWith('uv pip install'))).toBe(true);
    expect(managedMlx(after.localStt)).toEqual([
      expect.objectContaining({ python_bin: binPath(), version: '0.4.2' }),
    ]);
  }, 60_000);
});
