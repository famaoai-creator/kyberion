import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// XP-05: failover switch surfacing + serving provenance. Mirrors the secure-io
// mock used by reasoning-degradation.test.ts / reasoning-failover.test.ts so
// the JSONL event log and marker file land in a throwaway tmp root instead of
// the real repo's active/shared/runtime/ directory.
const secureIo = vi.hoisted(() => ({
  assertSafeRepositoryPath: (filePath: string) => {
    const root = path.resolve(process.env.KYBERION_ROOT || process.cwd());
    const absolute = path.resolve(filePath);
    const relative = path.relative(root, absolute);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `[RESOURCE_PATH_SCOPE] resource path is outside the repository root: ${filePath}`
      );
    }
    return absolute;
  },
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeLstat: (filePath: string) => fs.lstatSync(filePath),
  safeMkdir: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  loadJson: <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
  loadJsonIfPresent: <T>(filePath: string): T | null => {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
      return null;
    }
  },
  safeUnlinkSync: (filePath: string) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
  safeUnlink: (filePath: string) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
  safeAppendFileSync: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, data);
  },
}));

vi.mock('./secure-io.js', () => secureIo);
vi.mock('./foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: secureIo.loadJson,
    loadJsonIfPresent: secureIo.loadJsonIfPresent,
    appendFile: secureIo.safeAppendFileSync,
    exists: secureIo.safeExistsSync,
    readFile: (filePath: string) => String(secureIo.safeReadFile(filePath)),
    stat: (filePath: string) => fs.statSync(filePath),
    writeFile: secureIo.safeWriteFile,
  }),
  registerFoundationIo: vi.fn(),
}));

describe('FailoverReasoningBackend — XP-05 switch surfacing + provenance', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-reasoning-failover-events-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    const failoverMarkerSchemaPath = path.join(
      tmpRoot,
      'knowledge/product/schemas/reasoning-failover-marker.schema.json'
    );
    fs.mkdirSync(path.dirname(failoverMarkerSchemaPath), { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), 'knowledge/product/schemas/reasoning-failover-marker.schema.json'),
      failoverMarkerSchemaPath
    );
    const rulesPath = path.join(tmpRoot, 'knowledge/product/governance/knowledge-sync-rules.json');
    const schemaPath = path.join(
      tmpRoot,
      'knowledge/product/schemas/knowledge-sync-rules.schema.json'
    );
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), 'knowledge/product/governance/knowledge-sync-rules.json'),
      rulesPath
    );
    fs.copyFileSync(
      path.join(process.cwd(), 'knowledge/product/schemas/knowledge-sync-rules.schema.json'),
      schemaPath
    );
    process.env.KYBERION_ROOT = tmpRoot;
    process.env.KYBERION_REASONING_RETRY_BASE_MS = '0';
  });

  afterEach(() => {
    delete process.env.KYBERION_ROOT;
    delete process.env.KYBERION_REASONING_RETRY_BASE_MS;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function buildTwoCandidateBackend(mod: typeof import('./reasoning-backend.js')) {
    const calls: string[] = [];
    const backend = mod.buildFailoverReasoningBackend([
      {
        label: 'claude-agent',
        provider: 'claude',
        backend: {
          ...mod.stubReasoningBackend,
          prompt: async () => {
            calls.push('claude-agent');
            throw new Error('claude-agent unavailable: no active session');
          },
        },
      },
      {
        label: 'codex-cli',
        provider: 'codex',
        backend: {
          ...mod.stubReasoningBackend,
          prompt: async () => {
            calls.push('codex-cli');
            return 'served-by-codex';
          },
        },
      },
    ]);
    return { backend, calls };
  }

  it('appends a JSONL failover event and updates getLastServedReasoningMode on switch', async () => {
    const mod = await import('./reasoning-backend.js');
    const { reasoningFailoverEventsPath, readReasoningFailover } =
      await import('./reasoning-failover.js');
    mod.resetReasoningFailoverTracking();

    const { backend, calls } = buildTwoCandidateBackend(mod);
    await expect(backend.prompt('hello')).resolves.toBe('served-by-codex');
    expect(calls).toEqual(['claude-agent', 'codex-cli']);

    const eventsPath = reasoningFailoverEventsPath();
    const lines = fs
      .readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!);
    expect(event.from_mode).toBe('claude-agent');
    expect(event.to_mode).toBe('codex-cli');
    expect(event.provider_from).toBe('claude');
    expect(event.provider_to).toBe('codex');
    expect(event.method).toBe('prompt');
    expect(event.error_summary).toContain('claude-agent unavailable');

    const marker = readReasoningFailover();
    expect(marker).not.toBeNull();
    expect(marker!.from_mode).toBe('claude-agent');
    expect(marker!.to_mode).toBe('codex-cli');

    const served = mod.getLastServedReasoningMode();
    expect(served).toEqual({ mode: 'codex-cli', provider: 'codex', failover: true });
  });

  it('does not record a switch or set failover:true when the primary serves the call directly', async () => {
    const mod = await import('./reasoning-backend.js');
    const { reasoningFailoverEventsPath } = await import('./reasoning-failover.js');
    mod.resetReasoningFailoverTracking();

    const backend = mod.buildFailoverReasoningBackend([
      {
        label: 'claude-agent',
        provider: 'claude',
        backend: { ...mod.stubReasoningBackend, prompt: async () => 'served-by-primary' },
      },
      {
        label: 'codex-cli',
        provider: 'codex',
        backend: { ...mod.stubReasoningBackend, prompt: async () => 'unused' },
      },
    ]);

    await expect(backend.prompt('hello')).resolves.toBe('served-by-primary');

    expect(fs.existsSync(reasoningFailoverEventsPath())).toBe(false);
    expect(mod.getLastServedReasoningMode()).toEqual({
      mode: 'claude-agent',
      provider: 'claude',
      failover: false,
    });
  });

  it('warns once per (from,to) pair per process — a second identical switch does not re-warn', async () => {
    const mod = await import('./reasoning-backend.js');
    const core = await import('./core.js');
    mod.resetReasoningFailoverTracking();
    const warnSpy = vi.spyOn(core.logger, 'warn');

    const { backend: backendA } = buildTwoCandidateBackend(mod);
    await backendA.prompt('first call');
    const warnCallsAfterFirst = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes('provider failover active')
    ).length;
    expect(warnCallsAfterFirst).toBe(1);

    // A fresh backend instance, same (from,to) pair — throttle is per-process,
    // not per-instance, so this second identical switch must not re-warn.
    const { backend: backendB } = buildTwoCandidateBackend(mod);
    await backendB.prompt('second call');
    const warnCallsAfterSecond = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes('provider failover active')
    ).length;
    expect(warnCallsAfterSecond).toBe(1);

    const { reasoningFailoverEventsPath } = await import('./reasoning-failover.js');
    const lines = fs
      .readFileSync(reasoningFailoverEventsPath(), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    // The event log still gets one entry per switch even though the warning
    // is throttled — throttling only silences the operator-facing log line.
    expect(lines).toHaveLength(2);
  });
});
