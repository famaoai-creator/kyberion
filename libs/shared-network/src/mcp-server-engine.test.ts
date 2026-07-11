/**
 * Tests for mcp-server-engine.ts (Phase 0/1/2 — Kyberion MCP Server)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── vi.hoisted — must come before vi.mock factory references ──────────────────
const {
  mockSafeReadFile,
  mockSafeReaddir,
  mockSafeExistsSync,
  mockSafeExec,
  mockSpawnManagedProcess,
  mockStopManagedProcess,
  mockBuildKnowledgeIndex,
  mockQueryKnowledge,
  mockConnect,
  mockClose,
  mockListPendingApprovals,
  mockDecideApproval,
  mockRecordAuditExport,
  mockDeliverToCowork,
  mockListCoworkOutbox,
  mockRunCoworkKnowledgeSync,
  registeredTools,
} = vi.hoisted(() => {
  const registeredTools = new Map<
    string,
    { description: string; handler: (...args: any[]) => any }
  >();
  return {
    mockSafeReadFile: vi.fn(),
    mockSafeReaddir: vi.fn(),
    mockSafeExistsSync: vi.fn(),
    mockSafeExec: vi.fn(),
    mockSpawnManagedProcess: vi.fn(),
    mockStopManagedProcess: vi.fn(),
    mockBuildKnowledgeIndex: vi.fn(),
    mockQueryKnowledge: vi.fn(),
    mockConnect: vi.fn().mockResolvedValue(undefined),
    mockClose: vi.fn().mockResolvedValue(undefined),
    mockListPendingApprovals: vi.fn().mockReturnValue([]),
    mockDecideApproval: vi.fn(),
    mockRecordAuditExport: vi.fn(),
    mockDeliverToCowork: vi.fn().mockReturnValue('COWORK-001'),
    mockListCoworkOutbox: vi.fn().mockReturnValue([]),
    mockRunCoworkKnowledgeSync: vi.fn(),
    registeredTools,
  };
});

// ── Mock @agent/core ──────────────────────────────────────────────────────────
vi.mock('@agent/core', async () => {
  const actual = await vi.importActual<typeof import('@agent/core')>('@agent/core');
  return {
    ...actual,
    safeReadFile: mockSafeReadFile,
    safeReaddir: mockSafeReaddir,
    safeExistsSync: mockSafeExistsSync,
    safeExec: mockSafeExec,
    spawnManagedProcess: mockSpawnManagedProcess,
    stopManagedProcess: mockStopManagedProcess,
    buildKnowledgeIndex: mockBuildKnowledgeIndex,
    queryKnowledge: mockQueryKnowledge,
  };
});

vi.mock('@agent/core/cowork-surface.js', () => ({
  deliverToCowork: mockDeliverToCowork,
  listCoworkOutbox: mockListCoworkOutbox,
}));

vi.mock('@agent/core/approval-cowork-adapter.js', () => ({
  listPendingApprovalsForCowork: mockListPendingApprovals,
  decideApprovalFromCowork: mockDecideApproval,
  recordAuditExportRequest: mockRecordAuditExport,
}));

vi.mock('@agent/core/cowork-knowledge-bridge.js', () => ({
  runCoworkKnowledgeSync: mockRunCoworkKnowledgeSync,
}));

// ── Mock MCP SDK (server side) ────────────────────────────────────────────────
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const McpServer = vi.fn(function (this: any) {
    this.connect = mockConnect;
    this.close = mockClose;
    this.tool = vi.fn((...args: any[]) => {
      const name: string = args[0];
      const handler: (...a: any[]) => any = args[args.length - 1];
      const description: string = typeof args[1] === 'string' ? args[1] : '';
      registeredTools.set(name, { description, handler });
    });
  });
  return { McpServer };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  const StdioServerTransport = vi.fn(function (this: any) {
    this.close = mockClose;
  });
  return { StdioServerTransport };
});

// ── Import after mocks ────────────────────────────────────────────────────────
import { createKyberionMcpServer } from './mcp-server-engine.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const FAKE_CATALOG = JSON.stringify({
  pipeline_run_allowlist: ['pipelines/vital-check.json'],
});

function setupCommonMocks() {
  mockSafeExistsSync.mockReturnValue(true);
  mockSafeReadFile.mockReturnValue(FAKE_CATALOG);
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('createKyberionMcpServer()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.clear();
    setupCommonMocks();
  });

  it('サーバが作成されツールが登録される', () => {
    createKyberionMcpServer();
    expect(registeredTools.has('kyberion.pipeline.list')).toBe(true);
    expect(registeredTools.has('kyberion.pipeline.run')).toBe(true);
    expect(registeredTools.has('kyberion.knowledge.search')).toBe(true);
    expect(registeredTools.has('kyberion.capability.list')).toBe(true);
    expect(registeredTools.has('kyberion.mission.create')).toBe(true);
    expect(registeredTools.has('kyberion.mission.status')).toBe(true);
    expect(registeredTools.has('kyberion.mission.journal')).toBe(true);
  });

  describe('kyberion.pipeline.list', () => {
    it('pipelines/ ディレクトリを読み込んでリストを返す', async () => {
      mockSafeReaddir.mockReturnValue(['vital-check.json', 'list-capabilities.json', 'README.md']);
      mockSafeReadFile
        .mockReturnValueOnce(FAKE_CATALOG)
        .mockReturnValueOnce(
          JSON.stringify({ pipeline_id: 'vital-check', description: 'Vital check pipeline' })
        )
        .mockReturnValueOnce(
          JSON.stringify({ pipeline_id: 'list-capabilities', description: 'List capabilities' })
        );

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.pipeline.list')!.handler;
      const result = await handler({});

      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe('vital-check');
      // list must expose the same allowlist predicate that pipeline.run enforces
      expect(parsed[0].runnable_via_mcp).toBe(true);
      expect(parsed[1].name).toBe('list-capabilities');
      expect(parsed[1].runnable_via_mcp).toBe(false);
    });

    it('pipelines/ が存在しない場合は空配列を返す', async () => {
      mockSafeExistsSync.mockImplementation((p: string) => !p.endsWith('pipelines'));

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.pipeline.list')!.handler;
      const result = await handler({});

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(0);
    });
  });

  describe('kyberion.pipeline.run', () => {
    it('アローリスト内のパイプラインを実行する', async () => {
      mockSafeExec.mockReturnValue('Pipeline output');

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.pipeline.run')!.handler;
      const result = await handler({ input: 'pipelines/vital-check.json' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('Pipeline output');
      expect(mockSafeExec).toHaveBeenCalledOnce();
    });

    it('アローリスト外のパイプラインはエラーを返す', async () => {
      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.pipeline.run')!.handler;
      const result = await handler({ input: 'pipelines/dangerous-pipeline.json' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not on the MCP allowlist');
      expect(mockSafeExec).not.toHaveBeenCalled();
    });

    it('パイプラインファイルが存在しない場合はエラーを返す', async () => {
      mockSafeExistsSync.mockImplementation((p: string) => {
        if (p.includes('vital-check')) return false;
        return true;
      });

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.pipeline.run')!.handler;
      const result = await handler({ input: 'pipelines/vital-check.json' });

      expect(result.isError).toBe(true);
    });
  });

  describe('kyberion.pipeline.run background jobs', () => {
    function makeFakeChild() {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 4242;
      child.killed = false;
      child.kill = vi.fn();
      return child;
    }

    it('background: true でジョブを起動し job_id を返す', async () => {
      const child = makeFakeChild();
      mockSpawnManagedProcess.mockReturnValue({ resourceId: 'r', child });

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.pipeline.run')!.handler;
      const result = await handler({ input: 'pipelines/vital-check.json', background: true });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.job_id).toMatch(/^plj-/);
      expect(parsed.status).toBe('running');
      expect(parsed.poll_with).toBe('kyberion.pipeline.job_status');
      expect(mockSpawnManagedProcess).toHaveBeenCalledOnce();
      expect(mockSafeExec).not.toHaveBeenCalled();
    });

    it('終了後は job_status が succeeded と出力 tail を返す', async () => {
      const child = makeFakeChild();
      mockSpawnManagedProcess.mockReturnValue({ resourceId: 'r', child });

      createKyberionMcpServer();
      const run = registeredTools.get('kyberion.pipeline.run')!.handler;
      const started = await run({ input: 'pipelines/vital-check.json', background: true });
      const { job_id } = JSON.parse(started.content[0].text);

      child.stdout.emit('data', 'Pipeline output line');
      child.emit('exit', 0);

      const status = registeredTools.get('kyberion.pipeline.job_status')!.handler;
      const result = await status({ job_id });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('succeeded');
      expect(parsed.exit_code).toBe(0);
      expect(parsed.output_tail).toContain('Pipeline output line');
      expect(mockStopManagedProcess).toHaveBeenCalled();
    });

    it('非ゼロ exit は failed になり isError を返す', async () => {
      const child = makeFakeChild();
      mockSpawnManagedProcess.mockReturnValue({ resourceId: 'r', child });

      createKyberionMcpServer();
      const run = registeredTools.get('kyberion.pipeline.run')!.handler;
      const started = await run({ input: 'pipelines/vital-check.json', background: true });
      const { job_id } = JSON.parse(started.content[0].text);

      child.stderr.emit('data', 'boom');
      child.emit('exit', 1);

      const status = registeredTools.get('kyberion.pipeline.job_status')!.handler;
      const result = await status({ job_id });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('failed');
      expect(parsed.output_tail).toContain('boom');
    });

    it('アローリスト外は background でも拒否される', async () => {
      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.pipeline.run')!.handler;
      const result = await handler({ input: 'pipelines/dangerous.json', background: true });

      expect(result.isError).toBe(true);
      expect(mockSpawnManagedProcess).not.toHaveBeenCalled();
    });

    it('未知の job_id はエラーを返す', async () => {
      createKyberionMcpServer();
      const status = registeredTools.get('kyberion.pipeline.job_status')!.handler;
      const result = await status({ job_id: 'plj-nope' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown pipeline job');
    });
  });

  describe('kyberion.knowledge.search', () => {
    it('クエリを knowledge index に渡し結果を返す', async () => {
      const fakeHints = [
        {
          topic: 'onboarding',
          hint: 'Run pnpm onboard',
          source: 'knowledge/public/procedures',
          confidence: 0.9,
        },
      ];
      mockBuildKnowledgeIndex.mockResolvedValue({});
      mockQueryKnowledge.mockResolvedValue(fakeHints);

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.knowledge.search')!.handler;
      const result = await handler({ query: 'how to onboard', max_results: 5 });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].topic).toBe('onboarding');
    });

    it('knowledge index 構築失敗時にエラーを返す', async () => {
      mockBuildKnowledgeIndex.mockRejectedValue(new Error('Index build failed'));

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.knowledge.search')!.handler;
      const result = await handler({ query: 'test', max_results: 3 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Knowledge search failed');
    });
  });

  describe('kyberion.capability.list', () => {
    it('アクチュエータのマニフェストを読み込んで一覧を返す', async () => {
      mockSafeReaddir.mockReturnValue(['meeting-actuator', 'file-actuator']);
      mockSafeReadFile
        .mockReturnValueOnce(FAKE_CATALOG)
        .mockReturnValueOnce(
          JSON.stringify({
            actuator_id: 'meeting-actuator',
            capabilities: [{ op: 'join' }, { op: 'leave' }],
          })
        )
        .mockReturnValueOnce(
          JSON.stringify({
            actuator_id: 'file-actuator',
            capabilities: [{ op: 'read' }, { op: 'write' }],
          })
        );

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.capability.list')!.handler;
      const result = await handler({});

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].actuator).toBe('meeting-actuator');
      expect(parsed[0].ops).toEqual(['join', 'leave']);
    });
  });

  describe('kyberion.mission.status', () => {
    it('mission_controller.js status を呼び出して結果を返す', async () => {
      mockSafeExec.mockReturnValue('Mission status: running');

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.mission.status')!.handler;
      const result = await handler({ mission_id: 'mission-abc' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('Mission status: running');
      expect(mockSafeExec).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['status', '--mission-id', 'mission-abc']),
        expect.any(Object)
      );
    });
  });

  describe('kyberion.approval.list_pending', () => {
    it('pending 承認一覧を JSON で返す', async () => {
      const fakePending = [{ request_id: 'req-001', title: 'Deploy approval', severity: 'high' }];
      mockListPendingApprovals.mockReturnValue(fakePending);

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.approval.list_pending')!.handler;
      const result = await handler({});

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed[0].request_id).toBe('req-001');
    });

    it('listPendingApprovalsForCowork が例外をスローした場合はエラーを返す', async () => {
      mockListPendingApprovals.mockImplementation(() => {
        throw new Error('store error');
      });

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.approval.list_pending')!.handler;
      const result = await handler({});

      expect(result.isError).toBe(true);
    });
  });

  describe('kyberion.approval.decide', () => {
    it('valid な requestId で承認を適用する', async () => {
      mockDecideApproval.mockReturnValue({
        request_id: 'req-001',
        decision: 'approved',
        decided_by: 'operator-1',
        decided_at: '2026-06-22T11:00:00Z',
        previous_status: 'pending',
      });

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.approval.decide')!.handler;
      const result = await handler({
        request_id: 'req-001',
        decision: 'approved',
        decided_by: 'operator-1',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.decision).toBe('approved');
    });

    it('decideApprovalFromCowork がエラーをスローした場合はエラーを返す', async () => {
      mockDecideApproval.mockImplementation(() => {
        throw new Error('[APPROVAL_ERROR] Request not found');
      });

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.approval.decide')!.handler;
      const result = await handler({
        request_id: 'bad-id',
        decision: 'approved',
        decided_by: 'op',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Approval decision failed');
    });
  });

  describe('kyberion.audit.export', () => {
    it('audit export スクリプトを実行して出力を返す', async () => {
      mockSafeExec.mockReturnValue('Export written to active/shared/exports/audit-2026.ndjson');

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.audit.export')!.handler;
      const result = await handler({ from: '2026-06-01', to: '2026-06-22', requested_by: 'op' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Export written');
      expect(mockSafeExec).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['--from', '2026-06-01']),
        expect.any(Object)
      );
      expect(mockRecordAuditExport).toHaveBeenCalledWith(
        expect.objectContaining({ verifyOnly: false })
      );
    });

    it('スクリプトが存在しない場合はエラーを返す', async () => {
      mockSafeExistsSync.mockImplementation((p: string) => !p.includes('export_audit'));

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.audit.export')!.handler;
      const result = await handler({ requested_by: 'op' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not built');
    });
  });

  describe('kyberion.audit.verify', () => {
    it('--verify-only フラグでスクリプトを実行する', async () => {
      mockSafeExec.mockReturnValue('Chain verified: OK (42 entries)');

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.audit.verify')!.handler;
      const result = await handler({ requested_by: 'op' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('verified');
      expect(mockSafeExec).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['--verify-only']),
        expect.any(Object)
      );
      expect(mockRecordAuditExport).toHaveBeenCalledWith(
        expect.objectContaining({ verifyOnly: true })
      );
    });
  });

  describe('kyberion.knowledge.cowork_sync', () => {
    it('ツールが登録される', () => {
      createKyberionMcpServer();
      expect(registeredTools.has('kyberion.knowledge.cowork_sync')).toBe(true);
    });

    it('direction=both で runCoworkKnowledgeSync を呼び出して結果を返す', async () => {
      const fakeSyncResult = {
        direction: 'both',
        sync_state_path: '/repo/active/shared/runtime/cowork-sync-state.json',
        ingest: {
          enqueued: 2,
          skipped_duplicate: 0,
          skipped_tier_violation: 0,
          candidate_ids: ['c1', 'c2'],
          errors: [],
        },
        supply: { delivered: 3, skipped_unchanged: 1, delivery_id: 'COWORK-XYZ', errors: [] },
      };
      mockRunCoworkKnowledgeSync.mockReturnValue(fakeSyncResult);

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.knowledge.cowork_sync')!.handler;
      const result = await handler({
        direction: 'both',
        cowork_artifact_paths: ['a.md'],
        max_hints: 10,
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.direction).toBe('both');
      expect(parsed.ingest.enqueued).toBe(2);
      expect(parsed.supply.delivered).toBe(3);
      expect(mockRunCoworkKnowledgeSync).toHaveBeenCalledWith({
        direction: 'both',
        coworkArtifactPaths: ['a.md'],
        maxHints: 10,
      });
    });

    it('runCoworkKnowledgeSync がエラーをスローした場合は isError=true を返す', async () => {
      mockRunCoworkKnowledgeSync.mockImplementation(() => {
        throw new Error('Sync failed: permission denied');
      });

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.knowledge.cowork_sync')!.handler;
      const result = await handler({
        direction: 'kyberion-to-cowork',
        cowork_artifact_paths: [],
        max_hints: 50,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Knowledge sync failed');
    });
  });
});
