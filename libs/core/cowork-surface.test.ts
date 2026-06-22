/**
 * Tests for cowork-surface.ts (Phase 1 — Cowork surface provider)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── vi.hoisted — must come before vi.mock factory references ──────────────────
const {
  mockSafeExistsSync,
  mockSafeReaddir,
  mockSafeReadFile,
  mockWriteGovernedArtifactJson,
  mockEnsureGovernedArtifactDir,
  capturedWrites,
} = vi.hoisted(() => {
  const capturedWrites: Map<string, unknown> = new Map();
  return {
    mockSafeExistsSync: vi.fn().mockReturnValue(true),
    mockSafeReaddir: vi.fn(),
    mockSafeReadFile: vi.fn(),
    mockWriteGovernedArtifactJson: vi.fn((role: string, logicalPath: string, value: unknown) => {
      capturedWrites.set(logicalPath, value);
      return '/mocked/path';
    }),
    mockEnsureGovernedArtifactDir: vi.fn().mockReturnValue('/mocked/dir'),
    capturedWrites,
  };
});

vi.mock('./secure-io.js', () => ({
  safeExistsSync: mockSafeExistsSync,
  safeReaddir: mockSafeReaddir,
  safeReadFile: mockSafeReadFile,
  safeWriteFile: vi.fn(),
  safeMkdir: vi.fn(),
  safeAppendFileSync: vi.fn(),
  safeExec: vi.fn(),
  safeRmSync: vi.fn(),
}));

vi.mock('./artifact-store.js', () => ({
  writeGovernedArtifactJson: mockWriteGovernedArtifactJson,
  ensureGovernedArtifactDir: mockEnsureGovernedArtifactDir,
  resolveGovernedArtifactPath: vi.fn((p: string) => `/repo/${p}`),
  isGovernedArtifactPath: vi.fn(() => true),
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootDir: () => '/repo',
    resolve: (p: string) => `/repo/${p}`,
    knowledge: (p?: string) => p ? `/repo/knowledge/${p}` : '/repo/knowledge',
    shared: (p?: string) => p ? `/repo/active/shared/${p}` : '/repo/active/shared',
    active: (p?: string) => p ? `/repo/active/${p}` : '/repo/active',
  },
}));

import { deliverToCowork, listCoworkOutbox, buildOperatorInteractionPacket } from './cowork-surface.js';

describe('cowork-surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWrites.clear();
    mockSafeExistsSync.mockReturnValue(true);
    mockEnsureGovernedArtifactDir.mockReturnValue('/mocked/dir');
    mockWriteGovernedArtifactJson.mockImplementation((role: string, logicalPath: string, value: unknown) => {
      capturedWrites.set(logicalPath, value);
      return '/mocked/path';
    });
  });

  describe('deliverToCowork()', () => {
    it('アーティファクトを Cowork outbox に書き込む', () => {
      const deliveryId = deliverToCowork(
        [{ content: 'Hello Cowork', content_type: 'text/plain' }],
        { title: 'Test Delivery', summary: 'A test', missionId: 'mission-001' },
      );

      expect(deliveryId).toMatch(/^COWORK-/);
      expect(mockEnsureGovernedArtifactDir).toHaveBeenCalledOnce();
      expect(mockWriteGovernedArtifactJson).toHaveBeenCalledOnce();

      const [, logicalPath, packet] = mockWriteGovernedArtifactJson.mock.calls[0] as [string, string, any];
      expect(logicalPath).toContain('cowork/outbox');
      expect(packet.delivery_id).toBe(deliveryId);
      expect(packet.mission_id).toBe('mission-001');
      expect(packet.title).toBe('Test Delivery');
      expect(packet.artifacts).toHaveLength(1);
      expect(packet.artifacts[0].content).toBe('Hello Cowork');
    });

    it('オプションなしでデフォルト値を使用する', () => {
      const deliveryId = deliverToCowork(
        [{ path: 'active/missions/m1/output.md', content_type: 'text/markdown' }],
      );

      expect(deliveryId).toMatch(/^COWORK-/);
      const [, , packet] = mockWriteGovernedArtifactJson.mock.calls[0] as [string, string, any];
      expect(packet.title).toBe('Kyberion Result');
      expect(packet.mission_id).toBeUndefined();
    });
  });

  describe('listCoworkOutbox()', () => {
    it('outbox が存在しない場合は空配列を返す', () => {
      mockSafeExistsSync.mockReturnValue(false);
      const result = listCoworkOutbox();
      expect(result).toEqual([]);
    });

    it('outbox の JSON ファイルをパースして返す', () => {
      const fakePackets = [
        { delivery_id: 'COWORK-A', delivered_at: '2026-06-22T01:00:00Z', title: 'Result A', summary: 's', artifacts: [] },
        { delivery_id: 'COWORK-B', delivered_at: '2026-06-22T02:00:00Z', title: 'Result B', summary: 's', artifacts: [] },
      ];
      mockSafeReaddir.mockReturnValue(['COWORK-A.json', 'COWORK-B.json', 'not-json.txt']);
      mockSafeReadFile
        .mockReturnValueOnce(JSON.stringify(fakePackets[0]))
        .mockReturnValueOnce(JSON.stringify(fakePackets[1]));

      const result = listCoworkOutbox();
      expect(result).toHaveLength(2);
      expect(result[0].delivery_id).toBe('COWORK-A');
      expect(result[1].delivery_id).toBe('COWORK-B');
    });

    it('JSON パースエラーのファイルをスキップする', () => {
      mockSafeReaddir.mockReturnValue(['good.json', 'bad.json']);
      mockSafeReadFile
        .mockReturnValueOnce(JSON.stringify({ delivery_id: 'COWORK-G', delivered_at: '2026-06-22T01:00:00Z', title: 'Good', summary: 's', artifacts: [] }))
        .mockReturnValueOnce('{ invalid json }');

      const result = listCoworkOutbox();
      expect(result).toHaveLength(1);
      expect(result[0].delivery_id).toBe('COWORK-G');
    });
  });

  describe('buildOperatorInteractionPacket()', () => {
    it('長い結果を 500 文字で切り詰める', () => {
      const longResult = 'x'.repeat(1000);
      const packet = buildOperatorInteractionPacket({
        title: 'Long Result',
        result: longResult,
      });

      expect(packet.summary.endsWith('…')).toBe(true);
      expect(packet.artifacts[0].content).toBe(longResult);
    });

    it('短い結果はそのまま summary に入る', () => {
      const shortResult = 'Short output';
      const packet = buildOperatorInteractionPacket({
        title: 'Short',
        result: shortResult,
        missionId: 'M1',
        traceId: 'T1',
        nextAction: 'Review output',
      });

      expect(packet.summary).toBe(shortResult);
      expect(packet.mission_id).toBe('M1');
      expect(packet.trace_id).toBe('T1');
      expect(packet.next_action).toBe('Review output');
    });

    it('delivery_id に COWORK- プレフィックスがある', () => {
      const packet = buildOperatorInteractionPacket({ title: 'T', result: 'R' });
      expect(packet.delivery_id).toMatch(/^COWORK-/);
    });
  });
});
