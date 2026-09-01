/**
 * Tests for mcp-server-engine.ts (Phase 0/1/2 — Kyberion MCP Server)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── vi.hoisted — must come before vi.mock factory references ──────────────────
const {
  mockSafeReadFile,
  mockSafeReaddir,
  mockSafeExistsSync,
  mockSafeLstat,
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
  mockCreateApprovalRequest,
  mockListApprovalRequests,
  mockLoadApprovalRequest,
  mockComputeApprovalPayloadHash,
  registeredTools,
} = vi.hoisted(() => {
  const registeredTools = new Map<
    string,
    {
      description: string;
      handler: (...args: any[]) => any;
      outputSchema?: Record<string, unknown>;
    }
  >();
  return {
    mockSafeReadFile: vi.fn(),
    mockSafeReaddir: vi.fn(),
    mockSafeExistsSync: vi.fn(),
    mockSafeLstat: vi.fn(),
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
    mockCreateApprovalRequest: vi.fn(),
    mockListApprovalRequests: vi.fn().mockReturnValue([]),
    mockLoadApprovalRequest: vi.fn(),
    mockComputeApprovalPayloadHash: vi.fn().mockReturnValue('payload-hash'),
    registeredTools,
  };
});

// ── Mock the canonical core subpaths used by the engine ───────────────────────
vi.mock('@agent/core/secure-io', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io');
  return {
    ...actual,
    safeReadFile: mockSafeReadFile,
    safeReaddir: mockSafeReaddir,
    safeExistsSync: mockSafeExistsSync,
    safeLstat: mockSafeLstat,
    safeExec: mockSafeExec,
  };
});

vi.mock('@agent/core/managed-process', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/managed-process')>(
    '@agent/core/managed-process'
  );
  return {
    ...actual,
    spawnManagedProcess: mockSpawnManagedProcess,
    stopManagedProcess: mockStopManagedProcess,
  };
});

vi.mock('@agent/core/src/knowledge-index', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/src/knowledge-index')>(
    '@agent/core/src/knowledge-index'
  );
  return {
    ...actual,
    buildKnowledgeIndex: mockBuildKnowledgeIndex,
    queryKnowledge: mockQueryKnowledge,
  };
});

vi.mock('@agent/core/approval-store', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/approval-store')>(
    '@agent/core/approval-store'
  );
  return {
    ...actual,
    createApprovalRequest: mockCreateApprovalRequest,
    listApprovalRequests: mockListApprovalRequests,
    loadApprovalRequest: mockLoadApprovalRequest,
    computeApprovalPayloadHash: mockComputeApprovalPayloadHash,
  };
});

vi.mock('@agent/core/protocol-service-registry', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/protocol-service-registry')>(
    '@agent/core/protocol-service-registry'
  );
  return {
    ...actual,
    assertProtocolServiceRegistered: vi.fn(),
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
    this.registerTool = vi.fn(
      (
        name: string,
        config: { description?: string; outputSchema?: Record<string, unknown> },
        handler: (...args: never[]) => unknown
      ) => {
        registeredTools.set(name, {
          description: config.description || '',
          handler,
          outputSchema: config.outputSchema,
        });
      }
    );
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
import { registerFoundationIo, type FoundationIo } from '@agent/core/foundation';
import { getFoundationIo } from '@agent/core/foundation/io';
import { createKyberionMcpServer } from './mcp-server-engine.js';

const originalFoundationIo = getFoundationIo();
let foundationStatVersion = 0;
const testFoundationIo: FoundationIo = {
  loadJson: <T>(filePath: string) =>
    filePath.endsWith('knowledge/product/governance/mcp-tool-catalog.json')
      ? (JSON.parse(String(mockSafeReadFile(filePath))) as T)
      : originalFoundationIo.loadJson<T>(filePath),
  loadJsonIfPresent: <T>(filePath: string) =>
    filePath.endsWith('knowledge/product/governance/mcp-tool-catalog.json')
      ? (JSON.parse(String(mockSafeReadFile(filePath))) as T)
      : originalFoundationIo.loadJsonIfPresent<T>(filePath),
  appendFile: (...args) => originalFoundationIo.appendFile(...args),
  exists: (filePath: string) =>
    filePath.endsWith('knowledge/product/governance/mcp-tool-catalog.json')
      ? mockSafeExistsSync(filePath)
      : originalFoundationIo.exists(filePath),
  readFile: (filePath: string) => originalFoundationIo.readFile(filePath),
  stat: (filePath: string) =>
    filePath.endsWith('knowledge/product/governance/mcp-tool-catalog.json')
      ? { mtimeMs: ++foundationStatVersion, size: 1 }
      : originalFoundationIo.stat(filePath),
  writeFile: (...args) => originalFoundationIo.writeFile(...args),
};

// ─── Constants ────────────────────────────────────────────────────────────────
const governedToolNames = [
  'kyberion.pipeline.list',
  'kyberion.pipeline.run',
  'kyberion.pipeline.job_status',
  'kyberion.knowledge.search',
  'kyberion.capability.list',
  'kyberion.capability.search',
  'kyberion.mission.create',
  'kyberion.mission.status',
  'kyberion.mission.journal',
  'kyberion.surface.cowork.deliver',
  'kyberion.surface.cowork.list',
  'kyberion.knowledge.cowork_sync',
  'kyberion.approval.list_pending',
  'kyberion.approval.decide',
  'kyberion.audit.export',
  'kyberion.audit.verify',
  'kyberion.service.actuate',
];

const FAKE_CATALOG = JSON.stringify({
  pipeline_run_allowlist: ['pipelines/vital-check.json'],
  tools: governedToolNames.map((name) => ({
    name,
    allowed_tiers: name === 'kyberion.service.actuate' ? ['confidential', 'personal'] : ['public'],
    allowed_caller_roles:
      name === 'kyberion.approval.decide' || name === 'kyberion.service.actuate'
        ? ['operator']
        : ['operator', 'agent', 'cowork'],
  })),
});

function setupCommonMocks() {
  mockSafeExistsSync.mockReturnValue(true);
  mockSafeLstat.mockReturnValue({
    isFile: () => true,
    isDirectory: () => true,
  });
  mockSafeReadFile.mockReturnValue(FAKE_CATALOG);
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('createKyberionMcpServer()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.clear();
    registerFoundationIo(testFoundationIo);
    setupCommonMocks();
    vi.stubEnv('KYBERION_MCP_CALLER_ROLE', 'cowork');
    mockCreateApprovalRequest.mockReturnValue({ id: 'approval-001' });
    mockComputeApprovalPayloadHash.mockReturnValue('payload-hash');
  });

  afterEach(() => {
    registerFoundationIo(originalFoundationIo);
    vi.unstubAllEnvs();
  });

  it('サーバが作成されツールが登録される', () => {
    createKyberionMcpServer();
    expect(registeredTools.has('kyberion.pipeline.list')).toBe(true);
    expect(registeredTools.has('kyberion.pipeline.run')).toBe(true);
    expect(registeredTools.has('kyberion.knowledge.search')).toBe(true);
    expect(registeredTools.has('kyberion.capability.list')).toBe(true);
    expect(registeredTools.has('kyberion.capability.search')).toBe(true);
    expect(registeredTools.has('kyberion.mission.create')).toBe(true);
    expect(registeredTools.has('kyberion.mission.status')).toBe(true);
    expect(registeredTools.has('kyberion.mission.journal')).toBe(true);
    expect(registeredTools.get('kyberion.pipeline.list')?.outputSchema).toEqual(
      expect.objectContaining({ ok: expect.anything() })
    );
  });

  it('Cowork delivery accepts a validated structured intent resolution', async () => {
    createKyberionMcpServer();
    const handler = registeredTools.get('kyberion.surface.cowork.deliver')!.handler;
    const result = await handler({
      title: 'Approval plan',
      summary: 'A plan is waiting for approval.',
      content: 'Review the plan.',
      intent_resolution: {
        request_id: 'req-001',
        normalized_intent: 'send_message',
        missing_inputs: [],
        resolution_shape: 'task_session',
        outcome_kind: 'service_change',
        authority_level: 'approval_required',
        next_action: {
          kind: 'request_approval',
          label: 'Approve this plan to continue.',
          consequence: 'The action waits for approval.',
        },
        rationale: 'resolved from intent',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(mockDeliverToCowork).toHaveBeenCalledWith(
      [{ content: 'Review the plan.', content_type: 'text/plain', description: 'Approval plan' }],
      expect.objectContaining({
        intentResolution: expect.objectContaining({ authority_level: 'approval_required' }),
      })
    );
  });

  it('サーバー側 caller role が未確定ならツール実行を拒否する', async () => {
    vi.stubEnv('KYBERION_MCP_CALLER_ROLE', '');

    createKyberionMcpServer();
    const handler = registeredTools.get('kyberion.pipeline.list')!.handler;
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('correlation_id=');
    expect(result.content[0].text).toContain('invalid or not permitted');
    expect(result.content[0].text).not.toContain('MCP_CALLER_ROLE_REQUIRED');
  });

  it('カタログで operator 限定のツールは cowork role から拒否する', async () => {
    createKyberionMcpServer();
    const handler = registeredTools.get('kyberion.approval.decide')!.handler;
    const result = await handler({
      request_id: 'req-001',
      decision: 'approved',
      decided_by: 'cowork-client',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('correlation_id=');
    expect(result.content[0].text).toContain('invalid or not permitted');
    expect(result.content[0].text).not.toContain('MCP_CALLER_ROLE_DENIED');
    expect(mockDecideApproval).not.toHaveBeenCalled();
  });

  it('不正な MCP カタログは空の allowlist へフォールバックする', async () => {
    mockSafeReadFile.mockReturnValue(
      JSON.stringify({
        pipeline_run_allowlist: ['pipelines/vital-check.json'],
        tools: [{ name: 'kyberion.pipeline.list', allowed_tiers: ['public'] }],
      })
    );

    createKyberionMcpServer();
    const handler = registeredTools.get('kyberion.pipeline.list')!.handler;
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(mockSafeReaddir).not.toHaveBeenCalled();
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
      expect(result.structuredContent).toEqual({ ok: true, data: parsed });
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

    it('symlink または非 regular file の pipeline は内容を読み込まない', async () => {
      mockSafeReaddir.mockReturnValue(['vital-check.json']);
      mockSafeLstat.mockImplementation((filePath: string) => ({
        isFile: () => !filePath.includes('vital-check.json'),
        isDirectory: () => false,
      }));

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.pipeline.list')!.handler;
      const result = await handler({});

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual([
        {
          name: 'vital-check',
          path: 'pipelines/vital-check.json',
          description: '',
          runnable_via_mcp: true,
        },
      ]);
      expect(mockSafeReadFile).toHaveBeenCalledOnce();
      expect(mockSafeReadFile.mock.calls[0]?.[0]).toEqual(
        expect.stringContaining('mcp-tool-catalog.json')
      );
    });

    it('不正な metadata root または prototype key を実行候補へ投影しない', async () => {
      mockSafeReaddir.mockReturnValue(['array.json', 'unsafe.json']);
      mockSafeReadFile
        .mockReturnValueOnce(FAKE_CATALOG)
        .mockReturnValueOnce('[]')
        .mockReturnValueOnce('{"__proto__":{"polluted":true}}');

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.pipeline.list')!.handler;
      const result = await handler({});

      expect(JSON.parse(result.content[0].text)).toEqual([
        {
          name: 'array',
          path: 'pipelines/array.json',
          description: '',
          runnable_via_mcp: false,
        },
        {
          name: 'unsafe',
          path: 'pipelines/unsafe.json',
          description: '',
          runnable_via_mcp: false,
        },
      ]);
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
      expect(result.structuredContent).toEqual({ ok: true, data: 'Pipeline output' });
      expect(mockSafeExec).toHaveBeenCalledOnce();
    });

    it('アローリスト外のパイプラインはエラーを返す', async () => {
      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.pipeline.run')!.handler;
      const result = await handler({ input: 'pipelines/dangerous-pipeline.json' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not on the MCP allowlist');
      expect(result.structuredContent.ok).toBe(false);
      expect(result.structuredContent.error.message).toContain('not on the MCP allowlist');
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

    it('symlink または非 regular file の pipeline は実行しない', async () => {
      mockSafeLstat.mockImplementation((filePath: string) => ({
        isFile: () => !filePath.includes('vital-check.json'),
        isDirectory: () => false,
      }));

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.pipeline.run')!.handler;
      const result = await handler({ input: 'pipelines/vital-check.json' });

      expect(result.isError).toBe(true);
      expect(mockSafeExec).not.toHaveBeenCalled();
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

    it('symlink または非 regular file のマニフェストは内容を読み込まない', async () => {
      mockSafeReaddir.mockReturnValue(['meeting-actuator']);
      mockSafeLstat.mockImplementation((filePath: string) => ({
        isFile: () => !filePath.endsWith('manifest.json'),
        isDirectory: () => false,
      }));

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.capability.list')!.handler;
      const result = await handler({});

      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0].text)).toEqual([
        { actuator: 'meeting-actuator', ops: [] },
      ]);
      expect(mockSafeReadFile).toHaveBeenCalledOnce();
    });

    it('不正な manifest root と capability shape を projection へ流さない', async () => {
      mockSafeReaddir.mockReturnValue(['unsafe-actuator', 'mixed-actuator']);
      mockSafeReadFile
        .mockReturnValueOnce(FAKE_CATALOG)
        .mockReturnValueOnce('{"__proto__":{"polluted":true}}')
        .mockReturnValueOnce(
          JSON.stringify({
            actuator_id: 'mixed-actuator',
            capabilities: [{ op: 'read' }, { op: 42 }, 'write'],
          })
        );

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.capability.list')!.handler;
      const result = await handler({});

      expect(JSON.parse(result.content[0].text)).toEqual([
        { actuator: 'unsafe-actuator', ops: [] },
        { actuator: 'mixed-actuator', ops: ['read'] },
      ]);
    });
  });

  describe('kyberion.capability.search', () => {
    it('returns descriptions for matching capabilities without executing an operation', async () => {
      mockSafeReaddir.mockReturnValue(['meeting-actuator', 'file-actuator']);
      mockSafeReadFile
        .mockReturnValueOnce(FAKE_CATALOG)
        .mockReturnValueOnce(
          JSON.stringify({ actuator_id: 'meeting-actuator', capabilities: [{ op: 'join' }] })
        )
        .mockReturnValueOnce(
          JSON.stringify({ actuator_id: 'file-actuator', capabilities: [{ op: 'write' }] })
        );

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.capability.search')!.handler;
      const result = await handler({ query: 'join', max_results: 5 });

      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0].text)).toEqual([
        { actuator: 'meeting-actuator', ops: ['join'] },
      ]);
      expect(mockSafeExec).not.toHaveBeenCalled();
    });
  });

  describe('kyberion.mission.status', () => {
    it('mission_controller.js status を呼び出して結果を返す', async () => {
      mockSafeExec.mockReturnValue('Mission status: running');

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.mission.status')!.handler;
      vi.stubEnv('KYBERION_MCP_TENANT', 'tenant-a');
      const result = await handler({ mission_id: 'mission-abc', tenant: 'tenant-a' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('Mission status: running');
      expect(mockSafeExec).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['status', '--mission-id', 'mission-abc']),
        expect.any(Object)
      );
    });
  });

  describe('kyberion.mission.create approval gate', () => {
    it('承認なしでは approval request を作成して mission を起動しない', async () => {
      vi.stubEnv('KYBERION_MCP_TENANT', 'tenant-a');

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.mission.create')!.handler;
      const result = await handler({
        title: 'Scoped mission',
        brief: 'Do scoped work',
        tenant: 'tenant-a',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('approval_required');
      expect(parsed.request_id).toBe('approval-001');
      expect(mockCreateApprovalRequest).toHaveBeenCalledWith(
        'surface_runtime',
        expect.objectContaining({
          scope: expect.objectContaining({ tenant_slug: 'tenant-a' }),
          accountability: expect.objectContaining({
            payloadHash: 'payload-hash',
            effectBinding: 'mission.create:tenant-a',
          }),
        })
      );
      expect(mockSafeExec).not.toHaveBeenCalled();
    });

    it('承認済みで payload と scope が一致した場合だけ mission を起動する', async () => {
      vi.stubEnv('KYBERION_MCP_TENANT', 'tenant-a');
      mockLoadApprovalRequest.mockReturnValue({
        id: 'approval-001',
        status: 'approved',
        scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
        accountability: {
          finalDecision: 'human_only',
          payloadHash: 'payload-hash',
          effectBinding: 'mission.create:tenant-a',
        },
      });
      mockSafeExec.mockReturnValue('Mission created: mission-001');

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.mission.create')!.handler;
      const result = await handler({
        title: 'Scoped mission',
        brief: 'Do scoped work',
        tenant: 'tenant-a',
        approval_ref: 'approval-001',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('Mission created: mission-001');
      expect(mockSafeExec).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['--tenant-slug', 'tenant-a']),
        expect.any(Object)
      );
    });

    it('承認の scope が別 tenant なら mission を起動しない', async () => {
      vi.stubEnv('KYBERION_MCP_TENANT', 'tenant-a');
      mockLoadApprovalRequest.mockReturnValue({
        id: 'approval-001',
        status: 'approved',
        scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-b' },
        accountability: {
          finalDecision: 'human_only',
          payloadHash: 'payload-hash',
          effectBinding: 'mission.create:tenant-a',
        },
      });

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.mission.create')!.handler;
      const result = await handler({
        title: 'Scoped mission',
        brief: 'Do scoped work',
        tenant: 'tenant-a',
        approval_ref: 'approval-001',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('correlation_id=');
      expect(result.content[0].text).toContain('invalid or not permitted');
      expect(result.content[0].text).not.toContain('MCP_APPROVAL_SCOPE_MISMATCH');
      expect(mockSafeExec).not.toHaveBeenCalled();
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
      vi.stubEnv('KYBERION_MCP_CALLER_ROLE', 'operator');
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
      vi.stubEnv('KYBERION_MCP_CALLER_ROLE', 'operator');
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

    it('symlink または非 regular file の export script は実行しない', async () => {
      mockSafeLstat.mockImplementation((filePath: string) => ({
        isFile: () => !filePath.includes('export_audit'),
        isDirectory: () => false,
      }));

      createKyberionMcpServer();
      const handler = registeredTools.get('kyberion.audit.export')!.handler;
      const result = await handler({ requested_by: 'op' });

      expect(result.isError).toBe(true);
      expect(mockSafeExec).not.toHaveBeenCalled();
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
