import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const realFsSecureIo = vi.hoisted(() => ({
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeReaddir: (dirPath: string) => fs.readdirSync(dirPath),
  assertSafeRepositoryPath: (filePath: string, options: { allowMissingLeaf?: boolean } = {}) => {
    const root = path.resolve(process.env.KYBERION_ROOT || process.cwd());
    const resolved = path.resolve(filePath);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`[RESOURCE_PATH_SCOPE] ${filePath}`);
    }
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new Error(`[RESOURCE_PATH_SYMLINK] ${filePath}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    if (!options.allowMissingLeaf && !fs.existsSync(resolved)) {
      throw new Error(`[RESOURCE_PATH_MISSING] ${filePath}`);
    }
    return resolved;
  },
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  loadJson: <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
}));
vi.mock('./secure-io.js', () => realFsSecureIo);
vi.mock('./foundation/json.js', () => ({
  readJson: realFsSecureIo.loadJson,
}));
vi.mock('./foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: realFsSecureIo.loadJson,
    loadJsonIfPresent: <T>(filePath: string) => {
      try {
        return realFsSecureIo.loadJson<T>(filePath);
      } catch {
        return null;
      }
    },
    appendFile: () => {},
    exists: (filePath: string) => fs.existsSync(filePath),
    readFile: (filePath: string) => fs.readFileSync(filePath, 'utf8'),
    stat: (filePath: string) => fs.statSync(filePath),
    writeFile: (filePath: string, content: string) => fs.writeFileSync(filePath, content),
  }),
}));
vi.mock('./core.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
const opsAlert = vi.hoisted(() => vi.fn());
vi.mock('./ops-alert.js', () => ({ sendOpsAlert: opsAlert }));
const notify = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('./operator-notifications.js', () => ({ notifyOperator: notify }));
const enqueueLearning = vi.hoisted(() => vi.fn());
vi.mock('./organization-operating-model.js', () => ({
  enqueueOrganizationLearningCandidate: enqueueLearning,
}));
vi.mock('./organization-profile.js', () => ({ loadOrganizationProfile: () => null }));

let tmpRoot: string;
let mod: typeof import('./mission-hygiene.js');

function seedMission(
  id: string,
  status: string,
  ageDays: number | null,
  options: { tasks?: unknown[]; dispatched?: boolean } = {}
): void {
  const dir = path.join(tmpRoot, 'active', 'missions', id);
  fs.mkdirSync(dir, { recursive: true });
  const history =
    ageDays === null
      ? []
      : [
          {
            ts: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString(),
            event: 'CREATE',
            note: 'test fixture',
          },
        ];
  fs.writeFileSync(
    path.join(dir, 'mission-state.json'),
    JSON.stringify({
      mission_id: id,
      status,
      tier: 'public',
      execution_mode: 'local',
      priority: 1,
      assigned_persona: 'operator',
      confidence_score: 1,
      git: { branch: 'main', start_commit: 'a', latest_commit: 'b', checkpoints: [] },
      history,
    })
  );
  if (options.tasks) {
    fs.writeFileSync(path.join(dir, 'NEXT_TASKS.json'), JSON.stringify(options.tasks));
  }
  if (options.dispatched) {
    fs.mkdirSync(path.join(dir, 'coordination', 'tickets'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'coordination', 'tickets', 'dispatch-manifest.json'),
      JSON.stringify({ records: [] })
    );
  }
}

describe('mission hygiene', () => {
  beforeAll(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyb-hygiene-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    const schemaDir = path.join(tmpRoot, 'knowledge', 'product', 'schemas');
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.copyFileSync(
      path.resolve(process.cwd(), 'knowledge/product/schemas/mission-state.schema.json'),
      path.join(schemaDir, 'mission-state.schema.json')
    );
    process.env.KYBERION_ROOT = tmpRoot;

    seedMission('MSN-FRESH', 'planned', 0, {}); // fresh — not stale yet
    seedMission('MSN-NO-DESIGN', 'planned', 5, {}); // stale, no tasks
    seedMission('MSN-READY', 'planned', 3, {
      tasks: [{ task_id: 'T-1', status: 'planned' }],
    }); // stale, tasks never dispatched
    seedMission('MSN-GATED', 'planned', 30, {
      tasks: [{ task_id: 'T-1', status: 'planned' }],
      dispatched: true,
    }); // abandoned, dispatched but never activated
    seedMission('MSN-RUNNING', 'active', 5, {}); // not planned — ignored
    seedMission('MSN-NO-HISTORY', 'planned', null, {}); // unknown age → abandoned bucket

    mod = await import('./mission-hygiene.js');
  });

  afterAll(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('classifies stuck planned missions with per-mission remediation', () => {
    const report = mod.collectMissionHygieneReport();
    expect(report.planned_total).toBe(5);

    const byId = Object.fromEntries(
      [...report.stale, ...report.abandoned].map((finding) => [finding.mission_id, finding])
    );
    expect(byId['MSN-FRESH']).toBeUndefined(); // under the stale threshold
    expect(byId['MSN-RUNNING']).toBeUndefined(); // active is not hygiene's business
    expect(byId['MSN-NO-DESIGN']?.reason).toBe('design_missing');
    expect(byId['MSN-READY']?.reason).toBe('ready_not_started');
    expect(byId['MSN-READY']?.recommendation).toContain('dispatch-workitems');
    expect(byId['MSN-GATED']?.reason).toBe('awaiting_gate');
    expect(report.abandoned.map((finding) => finding.mission_id)).toContain('MSN-GATED');
    expect(report.abandoned.map((finding) => finding.mission_id)).toContain('MSN-NO-HISTORY');
    expect(report.active_stale?.map((finding) => finding.mission_id)).toContain('MSN-RUNNING');
  });

  it('notifies the operator once with concrete commands, never mutating state', async () => {
    enqueueLearning.mockClear();
    const report = mod.collectMissionHygieneReport();
    const sent = await mod.notifyMissionHygiene(report);
    expect(sent).toBe(true);
    expect(opsAlert).toHaveBeenCalledTimes(1);
    expect(opsAlert.mock.calls[0][0].severity).toBe('warning'); // abandoned present
    expect(notify).toHaveBeenCalledTimes(1);
    expect(enqueueLearning).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'routine_exception',
        targetKind: 'sop_candidate',
        tier: 'personal',
      })
    );
    const body = String(notify.mock.calls[0][1].body);
    expect(body).toContain('MSN-READY');
    expect(body).toContain('dispatch-workitems MSN-READY'); // <ID> substituted
    expect(body).not.toContain('<ID>');
    // mission states untouched
    const state = JSON.parse(
      fs.readFileSync(
        path.join(tmpRoot, 'active', 'missions', 'MSN-GATED', 'mission-state.json'),
        'utf8'
      )
    );
    expect(state.status).toBe('planned');
  });

  it('reports quiet when nothing is stale', async () => {
    opsAlert.mockClear();
    notify.mockClear();
    const sent = await mod.notifyMissionHygiene({
      generated_at: 'x',
      planned_total: 1,
      stale: [],
      abandoned: [],
      thresholds: { stale_days: 2, abandoned_days: 14 },
    });
    expect(sent).toBe(false);
    expect(opsAlert).not.toHaveBeenCalled();
    expect(mod.formatMissionHygieneLine(mod.collectMissionHygieneReport()).length).toBeGreaterThan(
      10
    );
  });

  it('skips a mission directory that is replaced by a symlink', () => {
    const externalMissionPath = path.join(os.tmpdir(), `kyb-hygiene-external-${randomUUID()}`);
    const linkedMissionPath = path.join(tmpRoot, 'active', 'missions', 'MSN-SYMLINKED');
    fs.mkdirSync(externalMissionPath, { recursive: true });
    fs.writeFileSync(
      path.join(externalMissionPath, 'mission-state.json'),
      JSON.stringify({
        mission_id: 'MSN-SYMLINKED',
        status: 'planned',
        history: [{ ts: new Date(0).toISOString() }],
      })
    );
    fs.symlinkSync(externalMissionPath, linkedMissionPath, 'dir');
    try {
      const report = mod.collectMissionHygieneReport();
      expect(report.stale.some((finding) => finding.mission_id === 'MSN-SYMLINKED')).toBe(false);
      expect(report.abandoned.some((finding) => finding.mission_id === 'MSN-SYMLINKED')).toBe(
        false
      );
    } finally {
      fs.unlinkSync(linkedMissionPath);
      fs.rmSync(externalMissionPath, { recursive: true, force: true });
    }
  });
});
