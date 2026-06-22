/**
 * Tests for cowork-health-check.ts (Phase 5 — L6 baseline layer)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── vi.hoisted ────────────────────────────────────────────────────────────────
const { mockSafeExistsSync, mockSafeReadFile } = vi.hoisted(() => ({
  mockSafeExistsSync: vi.fn(),
  mockSafeReadFile: vi.fn(),
}));

vi.mock('./secure-io.js', () => ({
  safeExistsSync: mockSafeExistsSync,
  safeReadFile: mockSafeReadFile,
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootDir: () => '/repo',
    rootResolve: (p: string) => `/repo/${p}`,
    resolve: (p: string) => `/repo/${p}`,
    knowledge: (p?: string) => (p ? `/repo/knowledge/${p}` : '/repo/knowledge'),
    shared: (p?: string) => (p ? `/repo/active/shared/${p}` : '/repo/active/shared'),
    active: (p?: string) => (p ? `/repo/active/${p}` : '/repo/active'),
  },
}));

import { runCoworkHealthCheck } from './cowork-health-check.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true for all existence checks — fully healthy state */
function allPresent(p: string): boolean {
  void p;
  return true;
}

/** Returns false for a specific path segment, true for everything else */
function missingPath(segment: string): (p: string) => boolean {
  return (p: string) => !p.includes(segment);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runCoworkHealthCheck()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('全コンポーネントが存在する場合は healthy=true を返す', () => {
    mockSafeExistsSync.mockImplementation(allPresent);

    const report = runCoworkHealthCheck();

    expect(report.healthy).toBe(true);
    expect(report.degraded_components).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  it('MCP サーバが未ビルドの場合は healthy=false で degraded に含める', () => {
    mockSafeExistsSync.mockImplementation(missingPath('mcp_server.js'));

    const report = runCoworkHealthCheck();

    expect(report.healthy).toBe(false);
    expect(report.degraded_components).toContain('mcp_server_built');
  });

  it('plugin-manifest.json が欠損の場合は healthy=false', () => {
    mockSafeExistsSync.mockImplementation(missingPath('plugin-manifest.json'));

    const report = runCoworkHealthCheck();

    expect(report.healthy).toBe(false);
    expect(report.degraded_components).toContain('plugin_manifest_present');
  });

  it('connector.json が欠損の場合は healthy=false', () => {
    mockSafeExistsSync.mockImplementation(missingPath('connector.json'));

    const report = runCoworkHealthCheck();

    expect(report.healthy).toBe(false);
    expect(report.degraded_components).toContain('connector_config_present');
  });

  it('cowork-sync-policy.json が欠損の場合は healthy=false', () => {
    mockSafeExistsSync.mockImplementation(missingPath('cowork-sync-policy'));

    const report = runCoworkHealthCheck();

    expect(report.healthy).toBe(false);
    expect(report.degraded_components).toContain('sync_policy_present');
  });

  it('Cowork outbox が存在しない場合でも healthy=true（初回起動は正常）', () => {
    mockSafeExistsSync.mockImplementation((p: string) => {
      if (p.includes('outbox')) return false;
      return true;
    });

    const report = runCoworkHealthCheck();

    expect(report.healthy).toBe(true);
    expect(report.degraded_components).toContain('cowork_outbox_accessible');
  });

  it('sync state が stale の場合は warning を発行するが healthy は維持する', () => {
    const staleDate = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30h ago
    mockSafeExistsSync.mockImplementation(allPresent);
    mockSafeReadFile.mockImplementation((p: string) => {
      if (p.includes('cowork-sync-state')) {
        return JSON.stringify({ ingested: {}, supplied: {}, last_sync_at: staleDate });
      }
      return '{}';
    });

    const report = runCoworkHealthCheck({ syncStateMaxAgeHours: 24 });

    expect(report.healthy).toBe(true);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('stale');
    expect(report.warnings[0]).toContain('pnpm knowledge:cowork-sync');
  });

  it('sync state が新鮮な場合は warning を発行しない', () => {
    const freshDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    mockSafeExistsSync.mockImplementation(allPresent);
    mockSafeReadFile.mockImplementation((p: string) => {
      if (p.includes('cowork-sync-state')) {
        return JSON.stringify({ ingested: {}, supplied: {}, last_sync_at: freshDate });
      }
      return '{}';
    });

    const report = runCoworkHealthCheck({ syncStateMaxAgeHours: 24 });

    expect(report.warnings).toHaveLength(0);
  });

  it('sync state ファイルが存在しない場合はエラーにならず healthy=true', () => {
    mockSafeExistsSync.mockImplementation((p: string) => !p.includes('cowork-sync-state'));

    const report = runCoworkHealthCheck();

    expect(report.healthy).toBe(true);
    const freshnessCheck = report.checks.find((c) => c.name === 'sync_state_freshness');
    expect(freshnessCheck?.passed).toBe(true);
  });

  it('mcp-server-cowork surface manifest が欠損の場合は degraded に含める', () => {
    mockSafeExistsSync.mockImplementation(missingPath('mcp-server-cowork'));

    const report = runCoworkHealthCheck();

    expect(report.healthy).toBe(false);
    expect(report.degraded_components).toContain('mcp_surface_manifest_present');
  });

  it('全 checks の name フィールドが一意である', () => {
    mockSafeExistsSync.mockImplementation(allPresent);

    const report = runCoworkHealthCheck();
    const names = report.checks.map((c) => c.name);
    const unique = new Set(names);

    expect(unique.size).toBe(names.length);
  });
});
