import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Count every host probe the discovery runs. Each probe answers "not found", so
// no backend is detected and the test never depends on the host's Python.
const probes = vi.hoisted(() => ({
  calls: [] as string[],
}));

vi.mock('./secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secure-io.js')>();
  return {
    ...actual,
    safeExecResult: (command: string, args: string[]) => {
      probes.calls.push(`${command} ${args.join(' ')}`);
      return { stdout: '', stderr: '', status: 1 };
    },
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
  delete process.env.KYBERION_STT_DISCOVERY_CACHE_TTL_MS;
  discovery.resetLocalSttDiscoveryCache({ disk: true });
});

afterEach(() => {
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
