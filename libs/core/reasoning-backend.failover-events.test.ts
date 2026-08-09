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
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeMkdir: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
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

describe('FailoverReasoningBackend — XP-05 switch surfacing + provenance', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-reasoning-failover-events-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    const rulesPath = path.join(tmpRoot, 'knowledge/product/governance/knowledge-sync-rules.json');
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), 'knowledge/product/governance/knowledge-sync-rules.json'),
      rulesPath
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
