import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureIo = vi.hoisted(() => ({
  safeAppendFileSync: (filePath: string, data: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, data, 'utf8');
  },
  safeCreateExclusiveFileSync: (filePath: string, data: string | Buffer = '') => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeLstat: (filePath: string) => fs.lstatSync(filePath),
  assertSafeRepositoryPath: (
    filePath: string,
    options: { allowMissingLeaf?: boolean; rootDir?: string } = {}
  ) => {
    const resolved = path.resolve(filePath);
    const root = path.resolve(options.rootDir || process.env.KYBERION_ROOT || process.cwd());
    const relative = path.relative(root, resolved);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('[RESOURCE_PATH_SCOPE]');
    }
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
        throw new Error('[RESOURCE_PATH_SYMLINK]');
      }
    }
    if (!options.allowMissingLeaf && !fs.existsSync(resolved)) {
      throw new Error('[RESOURCE_PATH_MISSING]');
    }
    return resolved;
  },
  loadJson: <T>(filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
  safeMkdir: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  safeUnlinkSync: (filePath: string) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
  safeReaddir: (dirPath: string) => fs.readdirSync(dirPath),
}));

vi.mock('../secure-io.js', () => secureIo);
vi.mock('../foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: secureIo.loadJson,
    loadJsonIfPresent: <T>(filePath: string) => {
      if (!fs.existsSync(filePath)) return null;
      try {
        return secureIo.loadJson<T>(filePath);
      } catch {
        return null;
      }
    },
    appendFile: secureIo.safeAppendFileSync,
    exists: secureIo.safeExistsSync,
    readFile: (filePath: string) => String(secureIo.safeReadFile(filePath)),
    stat: (filePath: string) => fs.statSync(filePath),
    writeFile: (filePath: string, content: string) => secureIo.safeWriteFile(filePath, content),
  }),
}));
vi.mock('../foundation/json.js', () => ({
  readJson: secureIo.loadJson,
  readJsonLines: <T>(
    filePath: string,
    options: {
      onMalformed?: 'skip';
      map?: (value: unknown, lineNumber: number) => T;
    } = {}
  ): T[] => {
    if (!fs.existsSync(filePath)) return [];
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .flatMap((line, index) => {
        if (!line.trim()) return [];
        try {
          const value = JSON.parse(line) as unknown;
          return [options.map ? options.map(value, index + 1) : (value as T)];
        } catch (error) {
          if (options.onMalformed === 'skip') return [];
          throw error;
        }
      });
  },
}));

describe('operator home summary', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-home-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    const schemaPath = path.join(tmpRoot, 'knowledge/product/schemas/mission-state.schema.json');
    fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
    fs.copyFileSync(
      path.resolve(process.cwd(), 'knowledge/product/schemas/mission-state.schema.json'),
      schemaPath
    );
    fs.copyFileSync(
      path.resolve(process.cwd(), 'knowledge/product/schemas/software-quality-report.schema.json'),
      path.join(tmpRoot, 'knowledge/product/schemas/software-quality-report.schema.json')
    );
    // writeInboxEntries validates rows against the governed deliverable-inbox catalog.
    fs.copyFileSync(
      path.resolve(process.cwd(), 'knowledge/product/schemas/deliverable-inbox-entry.schema.json'),
      path.join(tmpRoot, 'knowledge/product/schemas/deliverable-inbox-entry.schema.json')
    );
    process.env.KYBERION_ROOT = tmpRoot;
  });

  afterEach(async () => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('summarizes approval, inbox, mission, and next-action state', async () => {
    const { addInboxEntry } = await import('../deliverable-inbox.js');
    const { collectOperatorHomeSummary } = await import('./operator-home-summary.js');

    fs.mkdirSync(path.join(tmpRoot, 'active/missions/public/MSN-1'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'active/missions/public/MSN-1/mission-state.json'),
      JSON.stringify(
        {
          mission_id: 'MSN-1',
          status: 'active',
          tier: 'public',
          mission_type: 'delivery',
          tenant_slug: 'tenant-a',
          assigned_persona: 'operator',
          execution_mode: 'local',
          priority: 1,
          confidence_score: 1,
          git: {
            branch: 'operator-home-test',
            start_commit: 'abc123',
            latest_commit: 'abc123',
            checkpoints: [],
          },
          history: [{ ts: '2026-07-06T00:00:00.000Z', event: 'START', note: 'started' }],
          intent: {
            goal_summary: 'Ship the report',
            success_condition: 'Report is shipped',
          },
        },
        null,
        2
      )
    );
    const externalMission = path.join(tmpRoot, 'external-mission');
    fs.mkdirSync(externalMission, { recursive: true });
    fs.writeFileSync(
      path.join(externalMission, 'mission-state.json'),
      JSON.stringify({
        mission_id: 'MSN-LINKED',
        status: 'active',
        tier: 'public',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'operator',
        confidence_score: 1,
        git: {
          branch: 'operator-home-test-linked',
          start_commit: 'abc123',
          latest_commit: 'abc123',
          checkpoints: [],
        },
        history: [],
      })
    );
    fs.symlinkSync(externalMission, path.join(tmpRoot, 'active/missions/public/MSN-LINKED'));
    fs.mkdirSync(path.join(tmpRoot, 'active/missions/public/MSN-INVALID'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'active/missions/public/MSN-INVALID/mission-state.json'),
      JSON.stringify({ mission_id: 'MSN-INVALID', status: 'active', tier: 'public' })
    );
    addInboxEntry({
      missionId: 'MSN-1',
      title: 'Deliverable ready',
      artifactPaths: ['active/missions/public/MSN-1/evidence/report.md'],
      summary: 'Report delivered',
    });

    const summary = collectOperatorHomeSummary({ limit: 5 });

    expect(summary.status).toBe('attention');
    expect(summary.counts.activeMissions).toBe(1);
    expect(summary.counts.unreadInbox).toBe(1);
    expect(summary.nextAction.title.length).toBeGreaterThan(0);
    expect(summary.inboxEntries).toHaveLength(1);
  });

  it('preserves CLI cost uncertainty and subscription reference amounts without confirming the remaining budget', async () => {
    const { MetricsCollector } = await import('../metrics.js');
    const spy = vi.spyOn(MetricsCollector.prototype, 'loadHistory').mockReturnValue([
      {
        timestamp: '2026-10-28T00:00:00Z',
        mission_id: 'MSN-CLI',
        cost_status: 'unknown',
        billing_mode: 'unknown',
        reference_cost_usd: 0.4,
        usage: { prompt_tokens: 30, completion_tokens: 20 },
      },
      {
        timestamp: '2026-10-28T00:00:01Z',
        mission_id: 'MSN-CLI',
        cost_status: 'included',
        billing_mode: 'subscription_included',
        reference_cost_usd: 0.6,
        usage: { prompt_tokens: 50, completion_tokens: 50 },
      },
      { mission_id: 'MSN-CLI', component: 'catalog-refresh', duration_ms: 10 },
    ] as never);
    try {
      const { collectOperatorHomeSummary } = await import('./operator-home-summary.js');
      const summary = collectOperatorHomeSummary({ budgetUsd: 5 });
      expect(summary.costSummary).toMatchObject({
        totalUsd: 0,
        totalTokens: 150,
        referenceUsd: 1,
        referenceCostCalls: 2,
        unknownCostCalls: 1,
        includedCalls: 1,
        costComplete: false,
        remainingUsd: null,
        entryCount: 3,
      });
      expect(summary.costSummary.missionBreakdown[0]).toMatchObject({
        unknownCostCalls: 1,
        includedCalls: 1,
        costComplete: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('surfaces a pending software quality decision for the accountable human', async () => {
    const qualityDir = path.join(tmpRoot, 'active/shared/runtime/qa');
    fs.mkdirSync(qualityDir, { recursive: true });
    fs.writeFileSync(
      path.join(qualityDir, 'latest-quality-report.json'),
      JSON.stringify({
        version: '1.0.0',
        report_id: 'QUALITY-RUN-1',
        project_id: 'project-1',
        subject_ref: 'git:abc',
        generated_at: '2026-07-12T00:00:00.000Z',
        gate_status: { dor: 'pass', acceptance_criteria: 'pass', dod: 'fail' },
        coverage: { required: 1, covered: 1 },
        execution: { planned: 1, failed: 1 },
        defects: { candidates: 1, critical: 1 },
        recommendation: 'no_go',
        residual_risks: ['Critical defect remains.'],
        waiver_refs: [],
        evidence_refs: ['trace:1'],
        human_decision: 'pending',
        accountable_human_id: 'human:owner',
      })
    );
    const { collectOperatorHomeSummary } = await import('./operator-home-summary.js');
    const summary = collectOperatorHomeSummary();
    expect(summary.status).toBe('attention');
    expect(summary.counts.pendingQualityDecisions).toBe(1);
    expect(summary.qualitySummary).toMatchObject({
      recommendation: 'no_go',
      accountableHumanId: 'human:owner',
    });
    expect(summary.nextAction.title).toContain('quality');
  });

  it('selects only company-less records when includeUntenanted is set with no tenants', async () => {
    const approval = (
      id: string,
      scope: Record<string, string> | undefined,
      extra: Record<string, unknown> = {}
    ) => ({
      id,
      title: id,
      status: 'pending',
      severity: 'normal',
      ...(scope ? { scope } : {}),
      ...extra,
    });
    vi.doMock('../governance/approval-store.js', () => ({
      listApprovalRequests: () => [
        approval('APR-TENANT', { tier: 'public', tenant_slug: 'tenant-a' }),
        approval('APR-TIER-ONLY', { tier: 'public' }),
        approval('APR-CONTRADICTORY-MISSION', {
          tier: 'personal',
          tenant_slug: 'tenant-b',
          mission_id: 'MSN-TENANT',
        }),
        approval('APR-HIGHER-TIER-MISSION', {
          tier: 'personal',
          tenant_slug: 'tenant-a',
          mission_id: 'MSN-TENANT',
        }),
        approval('APR-UNSCOPED', undefined),
        approval(
          'APR-CONTEXT-TENANT',
          { tier: 'public' },
          { requestedByContext: { surface: 'api', tenantSlug: 'tenant-a' } }
        ),
        approval(
          'APR-LOOP-TENANT',
          { tier: 'public' },
          { work_loop: { context: { tier: 'public', tenant_slug: 'tenant-a' } } }
        ),
        approval('APR-LEGACY-UNSCOPED', undefined, { tenant_id: 'tenant-a' }),
      ],
    }));
    const writeMission = (missionId: string, tenantSlug?: string, tenantId?: string) => {
      const dir = path.join(tmpRoot, 'active/missions/public', missionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'mission-state.json'),
        JSON.stringify({
          mission_id: missionId,
          status: 'active',
          tier: 'public',
          mission_type: 'delivery',
          ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
          ...(tenantId ? { tenant_id: tenantId } : {}),
          assigned_persona: 'operator',
          execution_mode: 'local',
          priority: 1,
          confidence_score: 1,
          git: { branch: missionId, start_commit: 'abc', latest_commit: 'abc', checkpoints: [] },
          history: [],
        })
      );
    };
    writeMission('MSN-TENANT', 'tenant-a');
    writeMission('MSN-SYSTEM');
    writeMission('MSN-LEGACY-TENANT', undefined, 'tenant-a');
    const { collectOperatorHomeSummary } = await import('./operator-home-summary.js');

    const system = collectOperatorHomeSummary({
      scope: { tiers: ['public'], tenantSlugs: [], includeUntenanted: true },
    });
    expect(system.activeMissions.map((mission) => mission.missionId)).toEqual(['MSN-SYSTEM']);
    expect(system.pendingApprovals.map((item) => item.id).sort()).toEqual([
      'APR-TIER-ONLY',
      'APR-UNSCOPED',
    ]);

    const none = collectOperatorHomeSummary({ scope: { tiers: ['public'], tenantSlugs: [] } });
    expect(none.activeMissions).toEqual([]);
    expect(none.pendingApprovals).toEqual([]);

    const tenant = collectOperatorHomeSummary({
      scope: { tiers: ['public'], tenantSlugs: ['tenant-a'] },
    });
    expect(tenant.activeMissions.map((mission) => mission.missionId)).toEqual(['MSN-TENANT']);
    expect(tenant.pendingApprovals.map((item) => item.id)).toEqual(['APR-TENANT']);
    vi.doUnmock('../governance/approval-store.js');
  });
});
