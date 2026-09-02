/**
 * Tests for cowork-knowledge-bridge.ts (Phase 3 — G3/軸A)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ── vi.hoisted ────────────────────────────────────────────────────────────────
const {
  mockSafeExistsSync,
  mockSafeLstat,
  mockSafeReadFile,
  mockSafeReaddir,
  mockSafeWriteFile,
  mockSafeMkdir,
  mockAssertSafeRepositoryPath,
  mockCreateCandidate,
  mockEnqueueCandidate,
  mockListCandidates,
  mockDeliverToCowork,
} = vi.hoisted(() => ({
  mockSafeExistsSync: vi.fn(),
  mockSafeLstat: vi.fn(() => ({ isFile: () => true })),
  mockSafeReadFile: vi.fn(),
  mockSafeReaddir: vi.fn(),
  mockSafeWriteFile: vi.fn(),
  mockSafeMkdir: vi.fn(),
  mockAssertSafeRepositoryPath: vi.fn((filePath: string) => filePath),
  mockCreateCandidate: vi.fn(),
  mockEnqueueCandidate: vi.fn(),
  mockListCandidates: vi.fn().mockReturnValue([]),
  mockDeliverToCowork: vi.fn().mockReturnValue('COWORK-TEST-001'),
}));

vi.mock('./secure-io.js', () => ({
  assertSafeRepositoryPath: mockAssertSafeRepositoryPath,
  safeExistsSync: mockSafeExistsSync,
  safeLstat: mockSafeLstat,
  safeReadFile: mockSafeReadFile,
  safeReaddir: mockSafeReaddir,
  safeWriteFile: mockSafeWriteFile,
  safeMkdir: mockSafeMkdir,
  loadJson: <T>(filePath: string): T => {
    if (filePath.includes('cowork-sync-policy.schema.json')) {
      return JSON.parse(
        fs.readFileSync(
          path.resolve('knowledge/product/schemas/cowork-sync-policy.schema.json'),
          'utf8'
        )
      ) as T;
    }
    if (filePath.includes('cowork-sync-state.schema.json')) {
      return JSON.parse(
        fs.readFileSync(
          path.resolve('knowledge/product/schemas/cowork-sync-state.schema.json'),
          'utf8'
        )
      ) as T;
    }
    return JSON.parse(String(mockSafeReadFile(filePath))) as T;
  },
  loadJsonIfPresent: <T>(filePath: string): T | null => {
    try {
      return JSON.parse(String(mockSafeReadFile(filePath))) as T;
    } catch {
      return null;
    }
  },
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

vi.mock('./memory-promotion-queue.js', () => ({
  createMemoryPromotionCandidate: mockCreateCandidate,
  enqueueMemoryPromotionCandidate: mockEnqueueCandidate,
  listMemoryPromotionCandidates: mockListCandidates,
}));

vi.mock('./cowork-surface.js', () => ({
  deliverToCowork: mockDeliverToCowork,
}));

import { registerFoundationIo } from './foundation/io.js';

registerFoundationIo({
  loadJson: <T>(filePath: string): T => {
    if (filePath.includes('cowork-sync-policy.schema.json')) {
      return JSON.parse(
        fs.readFileSync(
          path.resolve('knowledge/product/schemas/cowork-sync-policy.schema.json'),
          'utf8'
        )
      ) as T;
    }
    if (filePath.includes('cowork-sync-state.schema.json')) {
      return JSON.parse(
        fs.readFileSync(
          path.resolve('knowledge/product/schemas/cowork-sync-state.schema.json'),
          'utf8'
        )
      ) as T;
    }
    return JSON.parse(String(mockSafeReadFile(filePath))) as T;
  },
  loadJsonIfPresent: <T>(filePath: string): T | null => {
    try {
      return JSON.parse(String(mockSafeReadFile(filePath))) as T;
    } catch {
      return null;
    }
  },
  appendFile: () => undefined,
  exists: (filePath: string) => mockSafeExistsSync(filePath),
  readFile: (filePath: string) => String(mockSafeReadFile(filePath)),
  stat: (filePath: string) => {
    const size = String(mockSafeReadFile(filePath)).length;
    return { mtimeMs: size, size };
  },
  writeFile: () => undefined,
});

import {
  ingestCoworkArtifacts,
  loadCoworkSyncStateAtPath,
  supplyKnowledgeToCowork,
  runCoworkKnowledgeSync,
} from './cowork-knowledge-bridge.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const FAKE_POLICY = JSON.stringify({
  version: '1.0.0',
  cowork_to_kyberion: {
    default_sensitivity_tier: 'confidential',
    default_ratification_required: true,
    kind_inference: [{ pattern: '\\.md$', proposed_kind: 'heuristic' }],
    tier_assignment: {
      rules: [
        {
          source_path_pattern: 'personal/',
          assigned_tier: 'personal',
          ratification_required: true,
        },
      ],
      default: 'confidential',
    },
    leakage_prevention: { block_promotion_if_evidence_refs_contain: [] },
    idempotency: { strategy: 'content_hash_sha256' },
  },
  kyberion_to_cowork: {
    allowed_tiers: ['public'],
    domains: ['procedures'],
    delivery: {
      channel: 'cowork',
      format: 'markdown',
      max_hints_per_sync: 10,
      idempotency: { strategy: 'content_hash_sha256', state_file: 'state.json' },
    },
  },
  conflict_resolution: { strategy: 'append_prefer_newer', overwrite_requires_approval: true },
});

/** Default safeExistsSync that returns false for policy & state, true otherwise */
function defaultExistsImpl(p: string): boolean {
  if (p.includes('cowork-sync-policy')) return false;
  if (p.includes('cowork-sync-state')) return false;
  return true;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Cowork sync state loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeLstat.mockReturnValue({ isFile: () => true });
  });

  it('loads a valid state through the canonical schema', () => {
    const state = {
      ingested: { 'work/summary.md': 'hash-1' },
      supplied: {},
      last_sync_at: '2026-06-22T00:00:00Z',
    };
    mockSafeReadFile.mockReturnValue(JSON.stringify(state));

    expect(loadCoworkSyncStateAtPath('/repo/active/shared/runtime/cowork-sync-state.json')).toEqual(
      state
    );
  });

  it('rejects schema-invalid and non-file state before sync use', () => {
    mockSafeReadFile.mockReturnValue(
      JSON.stringify({
        ingested: {},
        supplied: {},
        last_sync_at: '2026-06-22T00:00:00Z',
        unexpected: true,
      })
    );
    expect(() =>
      loadCoworkSyncStateAtPath('/repo/active/shared/runtime/cowork-sync-state.json')
    ).toThrow('Invalid catalog cowork-sync-state');

    mockSafeLstat.mockReturnValueOnce({ isFile: () => false });
    expect(() =>
      loadCoworkSyncStateAtPath('/repo/active/shared/runtime/cowork-sync-state.json')
    ).toThrow('state must be a regular file');
  });
});

describe('ingestCoworkArtifacts()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCandidates.mockReturnValue([]);
    mockCreateCandidate.mockImplementation((params: any) => ({
      candidate_id: `cand-${params.sourceRef}`,
      ...params,
    }));
    mockEnqueueCandidate.mockReturnValue(undefined);
  });

  it('存在するファイルを memory-promotion-queue にエンキューする', () => {
    mockSafeExistsSync.mockImplementation(defaultExistsImpl);
    mockSafeReadFile.mockReturnValue('artifact content');

    const result = ingestCoworkArtifacts(['work/summary.md']);

    expect(result.enqueued).toBe(1);
    expect(result.skipped_duplicate).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.candidate_ids).toHaveLength(1);
    expect(mockCreateCandidate).toHaveBeenCalledOnce();
    expect(mockEnqueueCandidate).toHaveBeenCalledOnce();
  });

  it('存在しないファイルをエラーとして記録しエンキューしない', () => {
    mockSafeExistsSync.mockImplementation((p: string) => {
      if (p.includes('missing-file')) return false;
      return false; // policy/state also false
    });

    const result = ingestCoworkArtifacts(['work/missing-file.md']);

    expect(result.enqueued).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('File not found');
    expect(mockCreateCandidate).not.toHaveBeenCalled();
  });

  it('repository 外の artifact path を読み込まない', () => {
    mockSafeExistsSync.mockImplementation(defaultExistsImpl);
    mockAssertSafeRepositoryPath.mockImplementation((filePath: string) => {
      if (filePath.includes('outside')) {
        throw new Error('[RESOURCE_PATH_SCOPE] resource path is outside the repository root');
      }
      return filePath;
    });

    const result = ingestCoworkArtifacts(['../../outside-artifact.md']);

    expect(result.enqueued).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('[RESOURCE_PATH_SCOPE]');
    expect(mockSafeReadFile).not.toHaveBeenCalledWith(
      expect.stringContaining('outside-artifact.md'),
      expect.anything()
    );
    expect(mockCreateCandidate).not.toHaveBeenCalled();
  });

  it('同じ hash が state に記録済みかつ既存候補にある場合はスキップする', () => {
    const content = 'duplicate artifact content';
    const hash = sha256(content);
    const sourceRef = 'work/dup.md';

    const syncState = JSON.stringify({
      ingested: { [sourceRef]: hash },
      supplied: {},
      last_sync_at: '2026-06-22T00:00:00Z',
    });

    mockSafeExistsSync.mockImplementation((p: string) => {
      if (p.includes('cowork-sync-policy')) return false;
      return true; // state and artifact both exist
    });
    mockSafeReadFile.mockImplementation((p: string) => {
      if (p.includes('cowork-sync-state')) return syncState;
      return content; // artifact content is identical
    });
    mockListCandidates.mockReturnValue([{ candidate_id: 'cand-dup', source_ref: sourceRef }]);

    const result = ingestCoworkArtifacts([sourceRef]);

    expect(result.skipped_duplicate).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(mockCreateCandidate).not.toHaveBeenCalled();
  });

  it('tier 違反エラー発生時は skipped_tier_violation を増加させる', () => {
    mockSafeExistsSync.mockImplementation(defaultExistsImpl);
    mockSafeReadFile.mockReturnValue('content');
    mockEnqueueCandidate.mockImplementation(() => {
      throw new Error('[POLICY_VIOLATION] Public-tier evidence ref not allowed');
    });

    const result = ingestCoworkArtifacts(['work/artifact.md']);

    expect(result.skipped_tier_violation).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Tier violation');
  });

  it('ポリシーが存在しない場合はデフォルトの confidential tier を使用する', () => {
    mockSafeExistsSync.mockImplementation(defaultExistsImpl);
    mockSafeReadFile.mockReturnValue('some content');

    const result = ingestCoworkArtifacts(['artifact.md']);

    expect(result.enqueued).toBe(1);
    expect(mockCreateCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ sensitivityTier: 'confidential', ratificationRequired: true })
    );
  });

  it('ポリシーがある場合は tier_assignment ルールを適用する', () => {
    mockSafeExistsSync.mockImplementation((p: string) => {
      if (p.includes('cowork-sync-state')) return false;
      return true; // policy and artifact exist
    });
    mockSafeReadFile.mockImplementation((p: string) => {
      if (p.includes('cowork-sync-policy')) return FAKE_POLICY;
      return 'artifact content';
    });

    const result = ingestCoworkArtifacts(['personal/journal.md']);

    expect(result.enqueued).toBe(1);
    expect(mockCreateCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ sensitivityTier: 'personal', ratificationRequired: true })
    );
  });

  it('schema-invalid policy falls back to the safe confidential default', () => {
    mockSafeExistsSync.mockImplementation((p: string) => !p.includes('cowork-sync-state'));
    mockSafeReadFile.mockImplementation((p: string) =>
      p.includes('cowork-sync-policy') ? JSON.stringify({ version: '1.0.0' }) : 'artifact content'
    );

    const result = ingestCoworkArtifacts(['artifact.md']);

    expect(result.enqueued).toBe(1);
    expect(mockCreateCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ sensitivityTier: 'confidential', ratificationRequired: true })
    );
  });
});

describe('supplyKnowledgeToCowork()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliverToCowork.mockReturnValue('COWORK-TEST-001');
  });

  it('knowledge/public が存在しない場合はエラーを返す', () => {
    mockSafeExistsSync.mockImplementation((p: string) => {
      if (p.includes('knowledge/public')) return false;
      return false; // policy/state also false
    });

    const result = supplyKnowledgeToCowork();

    expect(result.delivered).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('knowledge/public');
    expect(mockDeliverToCowork).not.toHaveBeenCalled();
  });

  it('新しい .md ファイルを Cowork outbox に配信する', () => {
    mockSafeExistsSync.mockImplementation((p: string) => {
      if (p.includes('cowork-sync-state')) return false;
      if (p.includes('cowork-sync-policy')) return false;
      return true;
    });
    mockSafeReadFile.mockReturnValue('# Knowledge hint\n\nSome useful info.');
    mockSafeReaddir.mockReturnValue(['hint.md']);

    const result = supplyKnowledgeToCowork({ maxHints: 5 });

    expect(result.errors).toHaveLength(0);
    expect(result.delivered).toBeGreaterThan(0);
    expect(result.delivery_id).toBe('COWORK-TEST-001');
    expect(mockDeliverToCowork).toHaveBeenCalledOnce();
  });

  it('ハッシュ済みの hints はスキップして skipped_unchanged を増加させる', () => {
    const content = '# Unchanged hint';
    const hash = sha256(content);
    const hintPath = '/repo/knowledge/public/procedures/hint.md';

    const syncState = JSON.stringify({
      ingested: {},
      supplied: { [hintPath]: hash },
      last_sync_at: '2026-06-22T00:00:00Z',
    });

    mockSafeExistsSync.mockImplementation((p: string) => {
      if (p.includes('cowork-sync-policy')) return false;
      // Only procedures dir exists; architecture/governance/hints dirs do not
      if (p.endsWith('/architecture') || p.endsWith('/governance') || p.endsWith('/hints'))
        return false;
      return true;
    });
    mockSafeReadFile.mockImplementation((p: string) => {
      if (p.includes('cowork-sync-state')) return syncState;
      return content;
    });
    mockSafeReaddir.mockReturnValue(['hint.md']);

    const result = supplyKnowledgeToCowork({ maxHints: 5 });

    expect(result.skipped_unchanged).toBe(1);
    expect(result.delivered).toBe(0);
    expect(mockDeliverToCowork).not.toHaveBeenCalled();
  });
});

describe('runCoworkKnowledgeSync()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCandidates.mockReturnValue([]);
    mockCreateCandidate.mockImplementation((params: any) => ({
      candidate_id: 'cand-1',
      ...params,
    }));
    mockDeliverToCowork.mockReturnValue('COWORK-SYNC-001');
    // Default: no public dir → supply returns error (so supply doesn't interfere with ingest tests)
    mockSafeExistsSync.mockImplementation(defaultExistsImpl);
    mockSafeReadFile.mockReturnValue('content');
  });

  it("direction='both' で ingest と supply を両方実行する", () => {
    // Make public dir exist for supply
    mockSafeExistsSync.mockImplementation((p: string) => {
      if (p.includes('cowork-sync-state')) return false;
      if (p.includes('cowork-sync-policy')) return false;
      return true;
    });
    mockSafeReaddir.mockReturnValue(['hint.md']);

    const result = runCoworkKnowledgeSync({
      direction: 'both',
      coworkArtifactPaths: ['work/artifact.md'],
    });

    expect(result.direction).toBe('both');
    expect(result.ingest).toBeDefined();
    expect(result.supply).toBeDefined();
  });

  it("direction='cowork-to-kyberion' では ingest のみ実行し supply は実行しない", () => {
    const result = runCoworkKnowledgeSync({
      direction: 'cowork-to-kyberion',
      coworkArtifactPaths: ['work/artifact.md'],
    });

    expect(result.direction).toBe('cowork-to-kyberion');
    expect(result.ingest).toBeDefined();
    expect(result.supply).toBeUndefined();
    expect(mockDeliverToCowork).not.toHaveBeenCalled();
  });

  it("direction='kyberion-to-cowork' では supply のみ実行し ingest は実行しない", () => {
    mockSafeExistsSync.mockImplementation((p: string) => {
      if (p.includes('cowork-sync-state')) return false;
      if (p.includes('cowork-sync-policy')) return false;
      return true;
    });
    mockSafeReaddir.mockReturnValue(['hint.md']);

    const result = runCoworkKnowledgeSync({
      direction: 'kyberion-to-cowork',
    });

    expect(result.direction).toBe('kyberion-to-cowork');
    expect(result.supply).toBeDefined();
    expect(result.ingest).toBeUndefined();
    expect(mockCreateCandidate).not.toHaveBeenCalled();
  });

  it('sync_state_path が結果に含まれる', () => {
    const result = runCoworkKnowledgeSync({ direction: 'kyberion-to-cowork' });
    expect(result.sync_state_path).toContain('cowork-sync-state.json');
  });

  it('tenant scope が sync state と promotion candidate に伝播する', () => {
    mockSafeExistsSync.mockImplementation((p: string) => {
      if (p.includes('cowork-sync-policy')) return false;
      if (p.includes('cowork-sync-state')) return false;
      return true;
    });
    mockSafeReadFile.mockReturnValue('tenant artifact');

    const result = runCoworkKnowledgeSync({
      direction: 'cowork-to-kyberion',
      coworkArtifactPaths: ['work/tenant-artifact.md'],
      scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
    });

    expect(result.sync_state_path).toContain('/tenants/tenant-a/cowork-sync-state.json');
    expect(mockCreateCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
      })
    );
    expect(mockSafeWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('/tenants/tenant-a/cowork-sync-state.json'),
      expect.any(String)
    );
  });
});
