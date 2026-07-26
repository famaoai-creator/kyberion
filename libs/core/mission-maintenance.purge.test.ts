/**
 * AL-01 hermetic tests for `purgeMissions` (the formerly-dead mission GC).
 *
 * KM-04 convention: a temp KYBERION_ROOT is created and set BEFORE any repo
 * module is imported (path-resolver binds its project root at import time),
 * so nothing here ever touches the real knowledge/ or active/ trees. The
 * lifecycle ADF seeded into the temp root is the REAL file's content, read
 * from the repo (read-only).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Keep everything real except safeExec: purgeMissions shells out to `cp -r`;
// emulate it with fs.cpSync so the test spawns no child processes.
vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExec: (command: string, args: string[] = []) => {
      if (command === 'cp' && args[0] === '-r') {
        fs.cpSync(args[1]!, args[2]!, { recursive: true });
        return '';
      }
      throw new Error(`unexpected safeExec in purge test: ${command} ${args.join(' ')}`);
    },
  };
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_ADF = path.join(REPO_ROOT, 'knowledge/product/governance/mission-lifecycle.json');

let tmpRoot: string;
let mod: typeof import('./mission-maintenance.js');

const DAY_MS = 24 * 60 * 60 * 1000;

function seedMission(id: string, status: string, ageDays: number): string {
  const dir = path.join(tmpRoot, 'active', 'missions', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'mission-state.json'),
    JSON.stringify({ mission_id: id, status, history: [] }, null, 2)
  );
  fs.writeFileSync(path.join(dir, 'evidence.txt'), `evidence for ${id}`);
  // Directory mtime drives max_age_days matching — set it last.
  const t = new Date(Date.now() - ageDays * DAY_MS);
  fs.utimesSync(dir, t, t);
  return dir;
}

function opsAlertLogPath(): string {
  return path.join(tmpRoot, 'active', 'shared', 'observability', 'ops-alerts.jsonl');
}

describe('purgeMissions (AL-01)', () => {
  beforeAll(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyb-purge-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    process.env.KYBERION_ROOT = tmpRoot;
    process.env.MISSION_ROLE = 'mission_controller';

    // mission-state.ts compiles this schema at import time — seed the real one.
    fs.mkdirSync(path.join(tmpRoot, 'schemas'), { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, 'schemas', 'mission-state.schema.json'),
      path.join(tmpRoot, 'schemas', 'mission-state.schema.json')
    );

    mod = await import('./mission-maintenance.js');
  });

  afterAll(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Runs FIRST, before the ADF is seeded: the missing-ADF path must escalate
  // (ops-alert) and return a structured result — never a silent void return.
  it('emits an ops-alert and returns adf_missing when the lifecycle ADF is absent', async () => {
    const result = await mod.purgeMissions(tmpRoot, true);

    expect(result.status).toBe('adf_missing');
    expect(result.adfPath).toBe(
      path.join(tmpRoot, 'knowledge', 'product/governance/mission-lifecycle.json')
    );
    expect(result.candidates).toEqual([]);
    expect(result.archived).toEqual([]);

    expect(fs.existsSync(opsAlertLogPath())).toBe(true);
    const alerts = fs
      .readFileSync(opsAlertLogPath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const alert = alerts.find((a) => a.dedupe_key === 'mission-purge:adf-missing');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('critical');
  });

  it('archives per the real ADF: copies to the target dir, removes the original, records an audit entry', async () => {
    // Seed the REAL lifecycle ADF content at the (fixed) resolved path.
    const adfDir = path.join(tmpRoot, 'knowledge', 'product', 'governance');
    fs.mkdirSync(adfDir, { recursive: true });
    fs.copyFileSync(REAL_ADF, path.join(adfDir, 'mission-lifecycle.json'));

    const oldFailedDir = seedMission('MSN-OLD-FAILED', 'failed', 40); // purge-orphaned: failed AND >30d
    const oldActiveDir = seedMission('MSN-OLD-ACTIVE', 'active', 40); // old but active — must survive
    const completedDir = seedMission('MSN-DONE', 'completed', 1); // archive-completed: status only

    // Dry run first: candidates reported, nothing moved.
    const dry = await mod.purgeMissions(tmpRoot, true);
    expect(dry.status).toBe('ok');
    expect(dry.dryRun).toBe(true);
    expect(dry.candidates.map((c) => c.mission).sort()).toEqual(['MSN-DONE', 'MSN-OLD-FAILED']);
    expect(dry.archived).toEqual([]);
    expect(fs.existsSync(oldFailedDir)).toBe(true);
    expect(fs.existsSync(completedDir)).toBe(true);

    // Execute.
    const result = await mod.purgeMissions(tmpRoot, false);
    expect(result.status).toBe('ok');
    expect(result.archived.map((c) => c.mission).sort()).toEqual(['MSN-DONE', 'MSN-OLD-FAILED']);

    // purge-orphaned target: active/archive/failed_missions/{mission_id}
    const failedTarget = path.join(
      tmpRoot,
      'active',
      'archive',
      'failed_missions',
      'MSN-OLD-FAILED'
    );
    expect(fs.existsSync(path.join(failedTarget, 'mission-state.json'))).toBe(true);
    expect(fs.readFileSync(path.join(failedTarget, 'evidence.txt'), 'utf8')).toContain(
      'MSN-OLD-FAILED'
    );
    expect(fs.existsSync(oldFailedDir)).toBe(false); // original removed

    // archive-completed target: active/archive/missions/{mission_id}
    const completedTarget = path.join(tmpRoot, 'active', 'archive', 'missions', 'MSN-DONE');
    expect(fs.existsSync(path.join(completedTarget, 'mission-state.json'))).toBe(true);
    expect(fs.existsSync(completedDir)).toBe(false);

    // Status is ANDed with age: an old but ACTIVE mission is never purged.
    expect(fs.existsSync(oldActiveDir)).toBe(true);

    // Audit record of what moved where.
    const auditPath = path.join(
      tmpRoot,
      'active',
      'shared',
      'logs',
      'audit',
      'mission-purge.jsonl'
    );
    expect(fs.existsSync(auditPath)).toBe(true);
    const entries = fs
      .readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries.map((e) => e.mission).sort()).toEqual(['MSN-DONE', 'MSN-OLD-FAILED']);
    expect(entries.every((e) => e.event === 'MISSION_PURGE_ARCHIVED')).toBe(true);
    const failedEntry = entries.find((e) => e.mission === 'MSN-OLD-FAILED');
    expect(failedEntry.to).toBe(failedTarget);
    expect(failedEntry.policy).toBe('purge-orphaned');
  });

  it('is a no-op (status ok, empty candidates) when nothing matches any policy', async () => {
    const result = await mod.purgeMissions(tmpRoot, false);
    expect(result.status).toBe('ok');
    expect(result.candidates).toEqual([]);
    expect(result.archived).toEqual([]);
    // The surviving active mission is still untouched.
    expect(fs.existsSync(path.join(tmpRoot, 'active', 'missions', 'MSN-OLD-ACTIVE'))).toBe(true);
  });

  // AL-03: explicit operator-targeted archive (`archive --mission <ID>`).
  it('archiveMissionById archives a young failed mission regardless of age, with an explicit audit record', async () => {
    const youngFailedDir = seedMission('MSN-YOUNG-FAILED', 'failed', 1); // too young for purge-orphaned (>30d)

    // The policy sweep must NOT take it (age condition unmet)…
    const sweep = await mod.purgeMissions(tmpRoot, true);
    expect(sweep.candidates.map((c) => c.mission)).not.toContain('MSN-YOUNG-FAILED');

    // …but the explicit verb archives it now.
    const result = await mod.archiveMissionById('msn-young-failed');
    expect(result.status).toBe('archived');
    expect(result.policy).toBe('purge-orphaned');
    const target = path.join(tmpRoot, 'active', 'archive', 'failed_missions', 'MSN-YOUNG-FAILED');
    expect(result.to).toBe(target);
    expect(fs.existsSync(path.join(target, 'mission-state.json'))).toBe(true);
    expect(fs.existsSync(youngFailedDir)).toBe(false);

    const auditPath = path.join(
      tmpRoot,
      'active',
      'shared',
      'logs',
      'audit',
      'mission-purge.jsonl'
    );
    const entries = fs
      .readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const entry = entries.find((e) => e.mission === 'MSN-YOUNG-FAILED');
    expect(entry).toMatchObject({
      event: 'MISSION_PURGE_ARCHIVED',
      policy: 'purge-orphaned',
      explicit: true,
      to: target,
    });
  });

  it('archiveMissionById is idempotent: an already-archived mission is a structured no-op', async () => {
    const again = await mod.archiveMissionById('MSN-YOUNG-FAILED');
    expect(again.status).toBe('already_archived');
    expect(again.to).toBe(
      path.join(tmpRoot, 'active', 'archive', 'failed_missions', 'MSN-YOUNG-FAILED')
    );
    // The archived copy is untouched.
    expect(
      fs.existsSync(
        path.join(
          tmpRoot,
          'active',
          'archive',
          'failed_missions',
          'MSN-YOUNG-FAILED',
          'mission-state.json'
        )
      )
    ).toBe(true);
  });

  it('archiveMissionById returns not_found for an unknown mission and not_archivable for a live one', async () => {
    const missing = await mod.archiveMissionById('MSN-DOES-NOT-EXIST');
    expect(missing.status).toBe('not_found');

    const activeDir = path.join(tmpRoot, 'active', 'missions', 'MSN-OLD-ACTIVE');
    const live = await mod.archiveMissionById('MSN-OLD-ACTIVE');
    expect(live.status).toBe('not_archivable');
    expect(live.reason).toContain("'active'");
    expect(fs.existsSync(activeDir)).toBe(true); // untouched
  });
});
