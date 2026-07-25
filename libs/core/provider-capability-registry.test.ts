import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';
// Static JSON import (not secure-io) so this schema check stays independent
// of the secure-io/path-resolver mocks below — mirrors the pattern in
// theme-registry.test.ts.
import providerCapabilityRegistrySchema from '../../knowledge/product/schemas/provider-capability-registry.schema.json';
import type { ProbeExecFn } from './provider-capability-registry.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  safeExistsSync: vi.fn(),
  safeMkdir: vi.fn(),
  safeExecResult: vi.fn(),
  shared: vi.fn((relPath: string) => `/repo/active/shared/${relPath}`),
}));

vi.mock('./secure-io.js', () => ({
  safeReadFile: mocks.safeReadFile,
  safeWriteFile: mocks.safeWriteFile,
  safeExistsSync: mocks.safeExistsSync,
  safeMkdir: mocks.safeMkdir,
  safeExecResult: mocks.safeExecResult,
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    shared: mocks.shared,
    rootResolve: (relPath: string) => `/repo/${relPath}`,
  },
}));

// loadProviderCapabilityCatalog reads knowledge files via secure-io; with
// safeReadFile mocked to reject below it falls back to an empty catalog,
// which is fine — these tests do not assert on `models`.
vi.mock('./provider-discovery.js', () => ({
  loadProviderCapabilityCatalog: () => ({}),
}));

function resetMocks() {
  mocks.safeReadFile.mockReset();
  mocks.safeWriteFile.mockReset();
  mocks.safeExistsSync.mockReset();
  mocks.safeMkdir.mockReset();
  mocks.safeExecResult.mockReset();
  mocks.safeReadFile.mockImplementation(() => {
    throw new Error('ENOENT');
  });
  mocks.safeExistsSync.mockReturnValue(false);
  mocks.safeMkdir.mockReturnValue(undefined);
  mocks.safeWriteFile.mockReturnValue(undefined);
}

function fakeExec(ok: Record<string, boolean>, errors: Record<string, string> = {}): ProbeExecFn {
  return (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    const matched = Object.keys(ok).find((k) => key.startsWith(k));
    return {
      ok: matched ? ok[matched]! : false,
      stdout: '',
      stderr: matched ? (errors[matched] ?? '') : 'unmapped probe',
    };
  };
}

describe('provider-capability-registry', () => {
  it('marks an unauthenticated provider correctly when its auth probe fails', async () => {
    resetMocks();
    const { probeProviderCapabilities } = await import('./provider-capability-registry.js');

    const exec = fakeExec({
      'gh copilot -- --help': true,
      'gh auth status': false,
    });

    const results = probeProviderCapabilities({ providerIds: ['copilot'], exec });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      provider_id: 'copilot',
      binary_found: true,
      authenticated: false,
    });
    expect(results[0]!.probe_error).toBeTruthy();
  });

  it('leaves authenticated as "unknown" for providers with no cheap auth probe', async () => {
    resetMocks();
    const { probeProviderCapabilities } = await import('./provider-capability-registry.js');

    const exec = fakeExec({ 'claude --version': true });
    const results = probeProviderCapabilities({ providerIds: ['claude'], exec });

    expect(results[0]).toMatchObject({
      provider_id: 'claude',
      binary_found: true,
      authenticated: 'unknown',
    });
  });

  it('probe command failure marks the provider unavailable without throwing', async () => {
    resetMocks();
    const { probeProviderCapabilities } = await import('./provider-capability-registry.js');

    const throwingExec: ProbeExecFn = () => {
      throw new Error('spawn EACCES');
    };

    expect(() =>
      probeProviderCapabilities({ providerIds: ['codex'], exec: throwingExec })
    ).not.toThrow();

    const results = probeProviderCapabilities({ providerIds: ['codex'], exec: throwingExec });
    expect(results[0]).toMatchObject({
      provider_id: 'codex',
      binary_found: false,
      authenticated: false,
    });
    expect(results[0]!.probe_error).toContain('spawn EACCES');
  });

  it('peekProviderCapabilityRegistry returns null when no snapshot file exists', async () => {
    resetMocks();
    mocks.safeExistsSync.mockReturnValue(false);
    const { peekProviderCapabilityRegistry } = await import('./provider-capability-registry.js');

    expect(peekProviderCapabilityRegistry()).toBeNull();
  });

  it('loadProviderCapabilityRegistry re-probes on TTL expiry using an injectable clock', async () => {
    resetMocks();
    const { loadProviderCapabilityRegistry } = await import('./provider-capability-registry.js');

    const t0 = new Date('2026-07-25T00:00:00.000Z');
    let stored: any = null;
    mocks.safeExistsSync.mockImplementation(() => stored !== null);
    mocks.safeReadFile.mockImplementation(() => {
      if (stored === null) throw new Error('ENOENT');
      return JSON.stringify(stored);
    });
    mocks.safeWriteFile.mockImplementation((_path: string, contents: string) => {
      stored = JSON.parse(contents);
    });

    const execCallCounts: string[] = [];
    const exec: ProbeExecFn = (command, args) => {
      execCallCounts.push(`${command} ${args.join(' ')}`);
      return { ok: true, stdout: '', stderr: '' };
    };

    // First call: no cache yet → probes and persists.
    loadProviderCapabilityRegistry({
      providerIds: ['claude'],
      exec,
      maxAgeMs: 1000,
      now: () => t0,
    });
    expect(execCallCounts.length).toBeGreaterThan(0);
    const firstCallCount = execCallCounts.length;

    // Second call, well within TTL: cache hit, no re-probe.
    execCallCounts.length = 0;
    loadProviderCapabilityRegistry({
      providerIds: ['claude'],
      exec,
      maxAgeMs: 1000,
      now: () => new Date(t0.getTime() + 500),
    });
    expect(execCallCounts.length).toBe(0);

    // Third call, past the TTL: re-probes.
    execCallCounts.length = 0;
    loadProviderCapabilityRegistry({
      providerIds: ['claude'],
      exec,
      maxAgeMs: 1000,
      now: () => new Date(t0.getTime() + 5000),
    });
    expect(execCallCounts.length).toBe(firstCallCount);
  });

  it('the persisted envelope validates against provider-capability-registry.schema.json', async () => {
    resetMocks();
    let stored: any = null;
    mocks.safeExistsSync.mockImplementation(() => stored !== null);
    mocks.safeWriteFile.mockImplementation((_path: string, contents: string) => {
      stored = JSON.parse(contents);
    });

    const { loadProviderCapabilityRegistry } = await import('./provider-capability-registry.js');
    const exec: ProbeExecFn = () => ({ ok: true, stdout: '', stderr: '' });

    loadProviderCapabilityRegistry({
      exec,
      now: () => new Date('2026-07-25T00:00:00.000Z'),
    });

    expect(stored).not.toBeNull();

    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(providerCapabilityRegistrySchema);

    const valid = validate(stored);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });
});
