import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// node:fs: the cross-process cache is a private host cache outside the governed
// tree (secure-io refuses it by design); the tests plant and inspect it there.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
const savedDir = process.env.KYBERION_STT_DISCOVERY_CACHE_DIR;
const savedPath = process.env.PATH;
let tmpRoot: string;

function cacheFile(): string {
  const file = discovery.localSttDiscoveryCachePath();
  if (!file) throw new Error('no cache path');
  return file;
}

function readCache(): { key: string; entries: Record<string, unknown>[] } & Record<
  string,
  unknown
> {
  return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
}

function writeCache(body: unknown, mode = 0o600): void {
  fs.writeFileSync(cacheFile(), JSON.stringify(body));
  fs.chmodSync(cacheFile(), mode);
}

beforeAll(async () => {
  discovery = await import('./local-stt-discovery.js');
  secureIo = await import('./secure-io.js');
}, 60_000);

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-stt-cache-test-'));
  process.env.KYBERION_STT_DISCOVERY_CACHE_DIR = path.join(tmpRoot, 'cache');
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
  if (savedDir === undefined) delete process.env.KYBERION_STT_DISCOVERY_CACHE_DIR;
  else process.env.KYBERION_STT_DISCOVERY_CACHE_DIR = savedDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
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
    expect(fs.existsSync(cacheFile())).toBe(false);
  });

  it('keeps the cross-process cache out of every persona-writable tree', () => {
    delete process.env.KYBERION_STT_DISCOVERY_CACHE_DIR;
    expect(discovery.localSttDiscoveryCachePath()).toBe(
      path.join(
        pathResolver.rootDir(),
        'node_modules/.cache/kyberion-stt-discovery/candidates.json'
      )
    );
    process.env.KYBERION_STT_DISCOVERY_CACHE_DIR = pathResolver.rootResolve(
      'active/shared/cache/system/local-stt-discovery'
    );
    expect(discovery.localSttDiscoveryCachePath()).toBeNull();
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
      expect(fs.statSync(cacheFile()).mode & 0o777).toBe(0o600);

      // A new process: no memo, same disk file.
      discovery.resetLocalSttDiscoveryCache();
      discovery.discoverLocalSttBackends();
      expect(probes.calls.length).toBe(firstRun);
    });

    it('re-probes once the entry is older than the TTL', () => {
      discovery.discoverLocalSttBackends();
      const firstRun = probes.calls.length;
      writeCache({ ...readCache(), written_at_ms: Date.now() - 120_000 });

      discovery.resetLocalSttDiscoveryCache();
      discovery.discoverLocalSttBackends();
      expect(probes.calls.length).toBe(firstRun * 2);
    });

    it('ignores a corrupt file and TTL=0 switches the disk cache off', () => {
      discovery.discoverLocalSttBackends();
      const firstRun = probes.calls.length;
      fs.writeFileSync(cacheFile(), '{not json');
      discovery.resetLocalSttDiscoveryCache();
      discovery.discoverLocalSttBackends();
      expect(probes.calls.length).toBe(firstRun * 2);

      process.env.KYBERION_STT_DISCOVERY_CACHE_TTL_MS = '0';
      discovery.resetLocalSttDiscoveryCache();
      discovery.discoverLocalSttBackends();
      expect(probes.calls.length).toBe(firstRun * 3);
    });
  });

  describe('a planted cache entry is never executed (review H2)', () => {
    let pathBin: string;
    beforeEach(() => {
      process.env.KYBERION_STT_DISCOVERY_CACHE_TTL_MS = '60000';
      // A PATH directory outside the repository holding an interpreter.
      pathBin = path.join(tmpRoot, 'bin');
      fs.mkdirSync(pathBin, { recursive: true });
      fs.writeFileSync(path.join(pathBin, 'python3'), '#!/bin/sh\n');
      process.env.PATH = `${pathBin}${path.delimiter}${savedPath ?? ''}`;
    });

    /** Seed a valid cache (no candidates), then replace its entries as an attacker would. */
    function plant(entries: Record<string, unknown>[], mode = 0o600): void {
      discovery.discoverLocalSttBackends();
      writeCache({ ...readCache(), entries }, mode);
      discovery.resetLocalSttDiscoveryCache();
      probes.calls.length = 0;
    }

    it('accepts an interpreter the probe could have found and rebuilds its connection', () => {
      const python = path.join(pathBin, 'python3');
      plant([
        {
          backend: 'mlx_whisper',
          source: 'os-python',
          python_bin: python,
          version: '1.0',
          connection: { whisper_python_bin: '/planted/evil' },
        },
      ]);
      const hit = discovery.discoverLocalSttBackends();
      expect(probes.calls).toEqual([]);
      expect(hit).toEqual([
        expect.objectContaining({
          backend: 'mlx_whisper',
          python_bin: python,
          connection: expect.objectContaining({ whisper_python_bin: python }),
        }),
      ]);
    });

    it('rejects a binary in the repository data trees, even on PATH, and re-probes', () => {
      const evilDir = pathResolver.sharedTmp(`stt-planted-${process.pid}-${Date.now()}`);
      secureIo.safeMkdir(evilDir, { recursive: true });
      secureIo.safeWriteFile(path.join(evilDir, 'python3'), '#!/bin/sh\necho pwned\n');
      try {
        process.env.PATH = `${evilDir}${path.delimiter}${process.env.PATH}`;
        plant([
          {
            backend: 'mlx_whisper',
            source: 'os-python',
            python_bin: path.join(evilDir, 'python3'),
          },
        ]);
        const result = discovery.discoverLocalSttBackends();
        expect(result.some((c) => String(c.python_bin).startsWith(evilDir))).toBe(false);
        expect(probes.calls.length).toBeGreaterThan(0);
      } finally {
        secureIo.safeRmSync(evilDir, { recursive: true, force: true });
      }
    });

    it('rejects a binary outside every PATH directory', () => {
      const script = path.join(tmpRoot, 'elsewhere', 'whisperkit-cli');
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, '#!/bin/sh\n');
      plant([{ backend: 'mlx_whisper', source: 'os-python', python_bin: script }]);
      const result = discovery.discoverLocalSttBackends();
      expect(result.some((c) => c.python_bin === script)).toBe(false);
      expect(probes.calls.length).toBeGreaterThan(0);
    });

    it("rejects a managed-runtime entry that is not the tool's own managed python", () => {
      plant([
        {
          backend: 'mlx_whisper',
          source: 'managed-runtime',
          python_bin: path.join(pathBin, 'python3'),
        },
      ]);
      const result = discovery.discoverLocalSttBackends();
      expect(result.some((c) => c.source === 'managed-runtime')).toBe(false);
      expect(probes.calls.length).toBeGreaterThan(0);
    });

    it('rejects an entry for a backend the registry does not list', () => {
      plant([{ backend: 'evil', source: 'os-path', executable: path.join(pathBin, 'python3') }]);
      expect(discovery.discoverLocalSttBackends().some((c) => c.backend === 'evil')).toBe(false);
      expect(probes.calls.length).toBeGreaterThan(0);
    });

    it('treats a cache file with a group/other write bit as absent and deletes it', () => {
      if (process.platform === 'win32') return;
      plant(
        [
          {
            backend: 'mlx_whisper',
            source: 'os-python',
            python_bin: path.join(pathBin, 'python3'),
          },
        ],
        0o666
      );
      const result = discovery.discoverLocalSttBackends();
      expect(result).toEqual([]);
      expect(probes.calls.length).toBeGreaterThan(0);
      // Rewritten by this process with 0600.
      expect(fs.statSync(cacheFile()).mode & 0o777).toBe(0o600);
    });
  });
});
