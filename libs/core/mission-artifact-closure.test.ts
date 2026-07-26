/**
 * AL-03 hermetic tests for mission/task artifact closure.
 *
 * KM-04 convention (same as mission-maintenance.purge.test.ts): a temp
 * KYBERION_ROOT is created and set BEFORE any repo module is imported
 * (path-resolver binds its project root at import time), so nothing here
 * ever touches the real active/ tree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Keep everything real except safeExec: closure shells out to
// `git bundle create <path> --all`; emulate it (write the bundle file) so the
// test spawns no child processes. `failNextBundle` simulates a git failure.
let failNextBundle = false;
vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExec: (command: string, args: string[] = []) => {
      if (command === 'git' && args[0] === 'bundle' && args[1] === 'create') {
        if (failNextBundle) {
          failNextBundle = false;
          throw new Error('simulated git bundle failure');
        }
        fs.writeFileSync(args[2]!, 'bundle-content');
        return '';
      }
      throw new Error(`unexpected safeExec in closure test: ${command} ${args.join(' ')}`);
    },
  };
});

import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tmpRoot: string;
let mod: typeof import('./mission-artifact-closure.js');

function missionDirFor(id: string): string {
  return path.join(tmpRoot, 'active', 'missions', 'public', id);
}

function repoRel(absolute: string): string {
  return path.relative(tmpRoot, absolute).split(path.sep).join('/');
}

function seedClosableMission(id: string, options: { withGit?: boolean } = {}): string {
  const dir = missionDirFor(id);
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence', 'closeout.md'), '# Closeout');
  fs.mkdirSync(path.join(dir, 'gates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gates', 'finish-exit.json'), '{"verdict":"pass"}');
  fs.mkdirSync(path.join(dir, 'artifacts', 'cache', 'tool-output'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'artifacts', 'cache', 'tool-output', 'big.log'), 'x'.repeat(64));
  fs.mkdirSync(path.join(dir, 'artifacts', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'artifacts', 'tmp', 'scratch.txt'), 'scratch');
  fs.mkdirSync(path.join(dir, 'artifacts', 'report'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'artifacts', 'report', 'final.md'), '# Final');
  const index = [
    {
      name: 'tool-output/big.log',
      artifact_class: 'cache',
      path: repoRel(path.join(dir, 'artifacts', 'cache', 'tool-output', 'big.log')),
      scope: { mission: id },
      scope_kind: 'mission',
      written_at: new Date().toISOString(),
    },
    {
      name: 'final.md',
      artifact_class: 'report',
      path: repoRel(path.join(dir, 'artifacts', 'report', 'final.md')),
      scope: { mission: id },
      scope_kind: 'mission',
      written_at: new Date().toISOString(),
    },
  ];
  fs.writeFileSync(
    path.join(dir, 'artifacts', 'artifacts-index.jsonl'),
    index.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  );
  if (options.withGit !== false) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');
  }
  return dir;
}

function auditLines(): Array<Record<string, any>> {
  const auditPath = path.join(
    tmpRoot,
    'active',
    'shared',
    'logs',
    'audit',
    'mission-closure.jsonl'
  );
  if (!fs.existsSync(auditPath)) return [];
  return fs
    .readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readIndex(dir: string): Array<Record<string, any>> {
  const indexPath = path.join(dir, 'artifacts', 'artifacts-index.jsonl');
  if (!fs.existsSync(indexPath)) return [];
  return fs
    .readFileSync(indexPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('mission-artifact-closure (AL-03)', () => {
  beforeAll(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyb-closure-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    process.env.KYBERION_ROOT = tmpRoot;
    process.env.MISSION_ROLE = 'mission_controller';

    // safeWriteFile runs the policy-engine gate (agent-policies.yaml) —
    // seed the REAL policy file so writes inside the temp root work (same
    // convention as artifact-store.test.ts / mission-seal.test.ts).
    const policyTarget = path.join(tmpRoot, 'knowledge', 'product', 'governance');
    fs.mkdirSync(policyTarget, { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, 'knowledge/product/governance/agent-policies.yaml'),
      path.join(policyTarget, 'agent-policies.yaml')
    );

    mod = await import('./mission-artifact-closure.js');
  });

  afterAll(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns mission_not_found (never throws) for an unknown mission', () => {
    const result = mod.closeMissionArtifacts({ missionId: 'MSN-CLOSURE-MISSING' });
    expect(result.status).toBe('mission_not_found');
    expect(result.deleted_directories).toEqual([]);
  });

  it('closes a mission: deletes cache/tmp classes, keeps evidence/gates/report, rewrites the index, bundles + removes .git, audits', () => {
    const id = 'MSN-CLOSURE-E2E';
    const dir = seedClosableMission(id);

    const result = mod.closeMissionArtifacts({ missionId: id, missionDir: dir });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe('closed');
    // Disposable classes removed.
    expect(fs.existsSync(path.join(dir, 'artifacts', 'cache'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'artifacts', 'tmp'))).toBe(false);
    expect(result.deleted_directories.sort()).toEqual([
      `active/missions/public/${id}/artifacts/cache`,
      `active/missions/public/${id}/artifacts/tmp`,
    ]);
    expect(result.deleted_index_entries).toEqual([
      expect.objectContaining({ artifact_class: 'cache' }),
    ]);
    // Kept classes untouched.
    expect(fs.existsSync(path.join(dir, 'evidence', 'closeout.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'gates', 'finish-exit.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'artifacts', 'report', 'final.md'))).toBe(true);
    // Index rewritten without the cache entry.
    const index = readIndex(dir);
    expect(index).toHaveLength(1);
    expect(index[0].artifact_class).toBe('report');
    // Git repo bundled into evidence/ and the nested .git removed (KM-04).
    expect(result.bundle).toMatchObject({
      status: 'bundled',
      bundle_path: 'evidence/mission-repo.bundle',
    });
    expect(fs.existsSync(path.join(dir, 'evidence', 'mission-repo.bundle'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
    // Idempotency marker + audit record.
    expect(fs.existsSync(path.join(dir, 'evidence', 'mission-closure.json'))).toBe(true);
    const audit = auditLines().filter((line) => line.mission === id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      event: 'MISSION_ARTIFACTS_CLOSED',
      policy_ref: 'knowledge/product/governance/storage-retention-catalog.json',
      policy_classes: ['cache', 'tmp'],
      bundle: { status: 'bundled' },
    });
    expect(audit[0].deleted_index_entries).toHaveLength(1);
  });

  it('is idempotent: a second close is a structured no-op with no new audit record', () => {
    const id = 'MSN-CLOSURE-E2E';
    const dir = missionDirFor(id);
    const before = auditLines().filter((line) => line.mission === id).length;

    const again = mod.closeMissionArtifacts({ missionId: id, missionDir: dir });

    expect(again.status).toBe('already_closed');
    expect(again.deleted_directories).toEqual([]);
    expect(auditLines().filter((line) => line.mission === id)).toHaveLength(before);
    // Kept artifacts still present after the no-op.
    expect(fs.existsSync(path.join(dir, 'artifacts', 'report', 'final.md'))).toBe(true);
  });

  it('keeps .git when the bundle fails (never lose data) but still reclaims cache/tmp', () => {
    const id = 'MSN-CLOSURE-BUNDLE-FAIL';
    const dir = seedClosableMission(id);
    failNextBundle = true;

    const result = mod.closeMissionArtifacts({ missionId: id, missionDir: dir });

    expect(result.status).toBe('closed');
    expect(result.bundle?.status).toBe('failed');
    expect(result.bundle?.error).toContain('simulated git bundle failure');
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true); // kept
    expect(fs.existsSync(path.join(dir, 'evidence', 'mission-repo.bundle'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'artifacts', 'cache'))).toBe(false); // still reclaimed
    const audit = auditLines().filter((line) => line.mission === id);
    expect(audit[0].bundle.status).toBe('failed');
  });

  it('closeTaskArtifacts deletes only the completed task disposable classes and their index entries; evidence stays', () => {
    const id = 'MSN-CLOSURE-TASK-GC';
    const dir = missionDirFor(id);
    fs.mkdirSync(path.join(dir, 'artifacts', 'cache', 'task-task-1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'artifacts', 'cache', 'task-task-1', 'out.log'), 'log');
    fs.mkdirSync(path.join(dir, 'artifacts', 'cache', 'task-task-2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'artifacts', 'cache', 'task-task-2', 'out.log'), 'log');
    fs.mkdirSync(path.join(dir, 'artifacts', 'evidence', 'task-task-1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'artifacts', 'evidence', 'task-task-1', 'keep.md'), '# Keep');
    const entries = [
      {
        name: 'out.log',
        artifact_class: 'cache',
        path: repoRel(path.join(dir, 'artifacts', 'cache', 'task-task-1', 'out.log')),
        scope: { mission: id, task: 'task-1' },
        scope_kind: 'task',
        written_at: new Date().toISOString(),
      },
      {
        name: 'keep.md',
        artifact_class: 'evidence',
        path: repoRel(path.join(dir, 'artifacts', 'evidence', 'task-task-1', 'keep.md')),
        scope: { mission: id, task: 'task-1' },
        scope_kind: 'task',
        written_at: new Date().toISOString(),
      },
      {
        name: 'out.log',
        artifact_class: 'cache',
        path: repoRel(path.join(dir, 'artifacts', 'cache', 'task-task-2', 'out.log')),
        scope: { mission: id, task: 'task-2' },
        scope_kind: 'task',
        written_at: new Date().toISOString(),
      },
    ];
    fs.writeFileSync(
      path.join(dir, 'artifacts', 'artifacts-index.jsonl'),
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    );

    const result = mod.closeTaskArtifacts(id, 'task-1', { missionDir: dir });

    expect(result.status).toBe('closed');
    expect(fs.existsSync(path.join(dir, 'artifacts', 'cache', 'task-task-1'))).toBe(false);
    // Evidence class untouched, other tasks untouched.
    expect(fs.existsSync(path.join(dir, 'artifacts', 'evidence', 'task-task-1', 'keep.md'))).toBe(
      true
    );
    expect(fs.existsSync(path.join(dir, 'artifacts', 'cache', 'task-task-2', 'out.log'))).toBe(
      true
    );
    const index = readIndex(dir);
    expect(index).toHaveLength(2);
    expect(index.map((entry) => entry.artifact_class).sort()).toEqual(['cache', 'evidence']);
    expect(index.find((entry) => entry.artifact_class === 'cache')?.scope.task).toBe('task-2');
    const audit = auditLines().filter((line) => line.mission === id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      event: 'MISSION_TASK_ARTIFACTS_CLOSED',
      task: 'task-1',
      policy_ref: 'knowledge/product/governance/storage-retention-catalog.json',
    });
  });

  it('closeTaskArtifacts is idempotent: a second call is a noop with no new audit record', () => {
    const id = 'MSN-CLOSURE-TASK-GC';
    const dir = missionDirFor(id);
    const before = auditLines().filter((line) => line.mission === id).length;

    const again = mod.closeTaskArtifacts(id, 'task-1', { missionDir: dir });

    expect(again.status).toBe('noop');
    expect(auditLines().filter((line) => line.mission === id)).toHaveLength(before);
  });
});
