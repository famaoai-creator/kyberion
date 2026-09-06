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

vi.mock('./secure-io.js', () => secureIo);
vi.mock('./foundation/io.js', () => ({
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
vi.mock('./foundation/json.js', () => ({
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
    const { addInboxEntry } = await import('./deliverable-inbox.js');
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
});
