import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';

// Count every host probe the discovery runs. Each probe answers "not found", so
// no backend is detected and the test never depends on the host's Python.
// `osPython` (when set) is reported by `which python3` and imports mlx_whisper;
// `managedBin` is the managed-runtime python the tool-runtime seam reports.
const probes = vi.hoisted(() => ({
  calls: [] as string[],
  osPython: null as string | null,
  managedBin: null as string | null,
}));

vi.mock('./secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secure-io.js')>();
  return {
    ...actual,
    safeExecResult: (command: string, args: string[]) => {
      probes.calls.push(`${command} ${args.join(' ')}`);
      if (probes.osPython && command === 'which' && args[0] === 'python3') {
        return { stdout: `${probes.osPython}\n`, stderr: '', status: 0 };
      }
      if (probes.osPython && command === probes.osPython) {
        return { stdout: '1.0\n', stderr: '', status: 0 };
      }
      return { stdout: '', stderr: '', status: 1 };
    },
  };
});

vi.mock('./tool/tool-runtime-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tool/tool-runtime-registry.js')>();
  return {
    ...actual,
    resolveManagedToolPythonBin: () => null,
    locateManagedToolPythonBin: () => probes.managedBin,
  };
});

type Discovery = typeof import('./local-stt-discovery.js');
type SecureIo = typeof import('./secure-io.js');
let discovery: Discovery;
let secureIo: SecureIo;
const savedTtl = process.env.KYBERION_STT_DISCOVERY_CACHE_TTL_MS;
const savedPath = process.env.PATH;

beforeAll(async () => {
  discovery = await import('./local-stt-discovery.js');
  secureIo = await import('./secure-io.js');
}, 60_000);

beforeEach(() => {
  probes.calls.length = 0;
  probes.osPython = null;
  probes.managedBin = null;
  delete process.env.KYBERION_STT_DISCOVERY_CACHE_TTL_MS;
  discovery.resetLocalSttDiscoveryCache({ disk: true });
});

afterEach(() => {
  vi.useRealTimers();
  discovery.resetLocalSttDiscoveryCache({ disk: true });
  if (savedTtl === undefined) delete process.env.KYBERION_STT_DISCOVERY_CACHE_TTL_MS;
  else process.env.KYBERION_STT_DISCOVERY_CACHE_TTL_MS = savedTtl;
  process.env.PATH = savedPath;
});

describe('local STT discovery cache', () => {
  it('probes the host once per process, however many installers ask', () => {
    discovery.discoverLocalSttBackends();
    const firstRun = probes.calls.length;
    expect(firstRun).toBeGreaterThan(0);
    // Interpreters only the os-python record lists: one probe each per run.
    expect(probes.calls.filter((call) => call === 'which python3.14')).toHaveLength(1);
    expect(probes.calls.filter((call) => call === 'which python')).toHaveLength(1);

    discovery.discoverLocalSttBackends();
    discovery.selectPreferredLocalSttBackend();
    expect(probes.calls.length).toBe(firstRun);

    discovery.resetLocalSttDiscoveryCache();
    discovery.discoverLocalSttBackends();
    expect(probes.calls.length).toBe(firstRun * 2);
  });

  it('re-probes when PATH changes (the key covers it)', () => {
    discovery.discoverLocalSttBackends();
    const firstRun = probes.calls.length;
    process.env.PATH = `${savedPath ?? ''}:/kyberion-test-extra-bin`;
    discovery.discoverLocalSttBackends();
    expect(probes.calls.length).toBe(firstRun * 2);
  });

  it('never caches an injected exec or registry (tests and what-ifs always run)', () => {
    const exec = vi.fn(() => ({ stdout: '', stderr: '', status: 1 }));
    discovery.discoverLocalSttBackends({ exec });
    const once = exec.mock.calls.length;
    discovery.discoverLocalSttBackends({ exec });
    expect(exec.mock.calls.length).toBe(once * 2);
  });

  it('returns copies, so a caller mutating a result cannot poison the memo', () => {
    const first = discovery.discoverLocalSttBackends();
    first.push({ backend: 'poisoned' } as never);
    expect(discovery.discoverLocalSttBackends()).toHaveLength(first.length - 1);
  });

  it('is off across processes by default under Vitest (no file written)', () => {
    discovery.discoverLocalSttBackends();
    const file = discovery.localSttDiscoveryCachePath();
    const body = secureIo.safeExistsSync(file)
      ? String(secureIo.safeReadFile(file, { encoding: 'utf8' })).trim()
      : '{}';
    expect(body).toBe('{}');
  });

  it('expires the process memo after the same TTL as the disk cache', () => {
    process.env.KYBERION_STT_DISCOVERY_CACHE_TTL_MS = '60000';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
    discovery.discoverLocalSttBackends();
    const firstRun = probes.calls.length;
    vi.setSystemTime(new Date('2026-10-09T00:00:30Z'));
    discovery.discoverLocalSttBackends();
    expect(probes.calls.length).toBe(firstRun);
    // Past the TTL: both the memo and the disk entry have expired.
    vi.setSystemTime(new Date('2026-10-09T00:01:01Z'));
    discovery.discoverLocalSttBackends();
    expect(probes.calls.length).toBe(firstRun * 2);
  });

  it('re-probes when a managed runtime python appears or is recreated (bin + mtime in the key)', () => {
    const bin = pathResolver.sharedTmp(`stt-discovery-cache-test/${process.pid}/bin/python`);
    discovery.discoverLocalSttBackends();
    const firstRun = probes.calls.length;

    secureIo.safeMkdir(bin.replace(/[\\/]python$/u, ''), { recursive: true });
    secureIo.safeWriteFile(bin, '#!/bin/sh\n');
    probes.managedBin = bin;
    discovery.discoverLocalSttBackends();
    expect(probes.calls.length).toBe(firstRun * 2);

    // Same bin, new mtime (venv recreated): another probe.
    const before = secureIo.safeStat(bin).mtimeMs;
    while (secureIo.safeStat(bin).mtimeMs === before) {
      secureIo.safeWriteFile(bin, `#!/bin/sh\n# recreated ${Date.now()}\n`);
    }
    discovery.discoverLocalSttBackends();
    expect(probes.calls.length).toBe(firstRun * 3);
    secureIo.safeRmSync(pathResolver.sharedTmp(`stt-discovery-cache-test/${process.pid}`), {
      recursive: true,
      force: true,
    });
  });

  it('drops a cached candidate whose binary no longer exists', () => {
    probes.osPython = '/kyberion-test-missing/bin/python3';
    const fresh = discovery.discoverLocalSttBackends();
    expect(fresh.some((c) => c.python_bin === probes.osPython)).toBe(true);
    const callsAfterProbe = probes.calls.length;
    // A memo hit: no new probe, and the vanished interpreter is not offered.
    const hit = discovery.discoverLocalSttBackends();
    expect(probes.calls.length).toBe(callsAfterProbe);
    expect(hit.some((c) => c.python_bin === probes.osPython)).toBe(false);
  });

  describe('cross-process cache (TTL set)', () => {
    beforeEach(() => {
      process.env.KYBERION_STT_DISCOVERY_CACHE_TTL_MS = '60000';
    });

    it('serves a fresh entry to the next process without probing', () => {
      discovery.discoverLocalSttBackends();
      const firstRun = probes.calls.length;
      const file = discovery.localSttDiscoveryCachePath();
      expect(secureIo.safeExistsSync(file)).toBe(true);
      expect(file).toContain('vitest-live');

      // A new process: no memo, same disk file.
      discovery.resetLocalSttDiscoveryCache();
      discovery.discoverLocalSttBackends();
      expect(probes.calls.length).toBe(firstRun);
    });

    it('re-probes once the entry is older than the TTL', () => {
      discovery.discoverLocalSttBackends();
      const firstRun = probes.calls.length;
      const file = discovery.localSttDiscoveryCachePath();
      const cached = JSON.parse(String(secureIo.safeReadFile(file, { encoding: 'utf8' })));
      secureIo.safeWriteFile(
        file,
        JSON.stringify({ ...cached, written_at_ms: Date.now() - 120_000 })
      );

      discovery.resetLocalSttDiscoveryCache();
      discovery.discoverLocalSttBackends();
      expect(probes.calls.length).toBe(firstRun * 2);
    });

    it('ignores a corrupt file and TTL=0 switches the disk cache off', () => {
      const file = discovery.localSttDiscoveryCachePath();
      discovery.discoverLocalSttBackends();
      const firstRun = probes.calls.length;
      secureIo.safeWriteFile(file, '{not json');
      discovery.resetLocalSttDiscoveryCache();
      discovery.discoverLocalSttBackends();
      expect(probes.calls.length).toBe(firstRun * 2);

      process.env.KYBERION_STT_DISCOVERY_CACHE_TTL_MS = '0';
      discovery.resetLocalSttDiscoveryCache();
      discovery.discoverLocalSttBackends();
      expect(probes.calls.length).toBe(firstRun * 3);
    });
  });
});
