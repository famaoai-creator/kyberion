/**
 * AL-02 hermetic tests for `writeScopedArtifact` scope-by-scope placement and
 * artifacts-index recording.
 *
 * KM-04 convention: a temp KYBERION_ROOT is created and set BEFORE any repo
 * module is imported (path-resolver binds its project root at import time),
 * so nothing here ever touches the real active/ tree. Raw fs is used only to
 * seed/inspect the temp root (registered in tests/core-fs-exception-boundary).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tmpRoot: string;
let store: typeof import('./artifact-store.js');

/** secure-io's policy engine fails closed without policies — seed the real file. */
function seedPolicyFile(root: string): void {
  const target = path.join(root, 'knowledge', 'product', 'governance', 'agent-policies.yaml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'knowledge/product/governance/agent-policies.yaml'), target);
}

function readIndex(indexAbsPath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(indexAbsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('writeScopedArtifact (AL-02)', () => {
  beforeAll(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyb-scoped-artifact-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    seedPolicyFile(tmpRoot);
    process.env.KYBERION_ROOT = tmpRoot;
    process.env.MISSION_ROLE = 'mission_controller';
    store = await import('./artifact-store.js');
  });

  afterAll(() => {
    delete process.env.KYBERION_ROOT;
    delete process.env.MISSION_ROLE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('mission scope: places under <missionDir>/artifacts/<class>/ and records the index', () => {
    const result = store.writeScopedArtifact({
      scope: { mission: 'M-AL02-A' },
      artifact_class: 'report',
      name: 'summary.json',
      content: { verdict: 'ok' },
    });

    expect(result.scope_kind).toBe('mission');
    expect(result.absolute_path).toBe(
      path.join(tmpRoot, 'active/missions/M-AL02-A/artifacts/report/summary.json')
    );
    expect(result.repo_relative_path).toBe(
      'active/missions/M-AL02-A/artifacts/report/summary.json'
    );
    expect(JSON.parse(fs.readFileSync(result.absolute_path, 'utf8'))).toEqual({ verdict: 'ok' });

    expect(result.index_path).toBe(
      path.join(tmpRoot, 'active/missions/M-AL02-A/artifacts/artifacts-index.jsonl')
    );
    const entries = readIndex(result.index_path);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'summary.json',
      artifact_class: 'report',
      path: 'active/missions/M-AL02-A/artifacts/report/summary.json',
      scope: { mission: 'M-AL02-A' },
      scope_kind: 'mission',
    });
    expect(typeof entries[0].written_at).toBe('string');
  });

  it('task scope: nests under the mission artifacts root as <class>/task-<task>/', () => {
    const result = store.writeScopedArtifact({
      scope: { mission: 'M-AL02-A', task: 'T-7' },
      artifact_class: 'cache',
      name: 'intermediate.txt',
      content: 'work in progress',
    });

    expect(result.scope_kind).toBe('task');
    expect(result.repo_relative_path).toBe(
      'active/missions/M-AL02-A/artifacts/cache/task-T-7/intermediate.txt'
    );
    expect(fs.readFileSync(result.absolute_path, 'utf8')).toBe('work in progress');

    // Same scope-local index as the mission (task nests under mission).
    const entries = readIndex(result.index_path);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ scope_kind: 'task', artifact_class: 'cache' });
  });

  it('project scope: places under the tenant-refined project workspace', () => {
    const result = store.writeScopedArtifact({
      scope: { project: 'proj-x', tenant: 'acme' },
      artifact_class: 'export',
      name: 'dataset.csv',
      content: 'a,b\n1,2\n',
      format: 'text',
    });

    expect(result.scope_kind).toBe('project');
    expect(result.repo_relative_path).toBe(
      'active/projects/confidential/acme/proj-x/artifacts/export/dataset.csv'
    );
    expect(fs.readFileSync(result.absolute_path, 'utf8')).toBe('a,b\n1,2\n');
    expect(readIndex(result.index_path)[0]).toMatchObject({
      artifact_class: 'export',
      scope_kind: 'project',
    });
  });

  it('session scope: places under active/shared/runtime/session/<session>/artifacts/', () => {
    const result = store.writeScopedArtifact({
      scope: { session: 'sess-42' },
      artifact_class: 'log',
      name: 'transcript.log',
      content: 'hello',
    });

    expect(result.scope_kind).toBe('session');
    expect(result.repo_relative_path).toBe(
      'active/shared/runtime/session/sess-42/artifacts/log/transcript.log'
    );
    expect(fs.readFileSync(result.absolute_path, 'utf8')).toBe('hello');
    expect(readIndex(result.index_path)[0]).toMatchObject({ scope_kind: 'session' });
  });

  it('tenant scope: places under the tenant confidential project area', () => {
    const result = store.writeScopedArtifact({
      scope: { tenant: 'acme' },
      artifact_class: 'evidence',
      name: 'audit-trail.json',
      content: { events: [] },
    });

    expect(result.scope_kind).toBe('tenant');
    expect(result.repo_relative_path).toBe(
      'active/projects/confidential/acme/artifacts/evidence/audit-trail.json'
    );
    expect(readIndex(result.index_path)[0]).toMatchObject({
      artifact_class: 'evidence',
      scope_kind: 'tenant',
    });
  });

  it('supports subpath names and buffer content', () => {
    const result = store.writeScopedArtifact({
      scope: { mission: 'M-AL02-B' },
      artifact_class: 'cache',
      name: 'tool-output/3-exec.bin',
      content: Buffer.from([1, 2, 3]),
    });
    expect(result.repo_relative_path).toBe(
      'active/missions/M-AL02-B/artifacts/cache/tool-output/3-exec.bin'
    );
    expect([...fs.readFileSync(result.absolute_path)]).toEqual([1, 2, 3]);
  });

  it('fail-closed: rejects task without mission, empty scope, bad class, and traversal names', () => {
    expect(() =>
      store.writeScopedArtifact({
        scope: { task: 'T-1' },
        artifact_class: 'cache',
        name: 'x.txt',
        content: 'x',
      })
    ).toThrow(/task scope requires a mission/);

    expect(() =>
      store.writeScopedArtifact({ scope: {}, artifact_class: 'cache', name: 'x.txt', content: 'x' })
    ).toThrow(/at least one of tenant\/project\/mission\/task\/session/);

    expect(() =>
      store.writeScopedArtifact({
        scope: { mission: 'M-AL02-A' },
        artifact_class: 'not-a-class' as never,
        name: 'x.txt',
        content: 'x',
      })
    ).toThrow(/invalid artifact_class/);

    expect(() =>
      store.writeScopedArtifact({
        scope: { mission: 'M-AL02-A' },
        artifact_class: 'cache',
        name: '../escape.txt',
        content: 'x',
      })
    ).toThrow(/invalid artifact name segment/);
  });

  it('rejects a scoped artifact root that traverses a symlink', () => {
    const missionDir = path.join(tmpRoot, 'active/missions/M-AL02-SYMLINK');
    const artifactsDir = path.join(missionDir, 'artifacts');
    const targetDir = path.join(tmpRoot, 'artifact-external-target');
    fs.mkdirSync(missionDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.symlinkSync(targetDir, artifactsDir, 'dir');

    try {
      expect(() =>
        store.writeScopedArtifact({
          scope: { mission: 'M-AL02-SYMLINK' },
          artifact_class: 'report',
          name: 'summary.json',
          content: { should_not_land: true },
        })
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      fs.rmSync(artifactsDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('isScopedArtifactPath accepts only the scoped artifact roots', () => {
    expect(store.isScopedArtifactPath('active/missions/M-1/artifacts/report/a.json')).toBe(true);
    expect(store.isScopedArtifactPath('active/projects/confidential/t/p/artifacts/cache/a')).toBe(
      true
    );
    expect(
      store.isScopedArtifactPath('active/shared/runtime/session/s-1/artifacts/log/a.log')
    ).toBe(true);
    expect(store.isScopedArtifactPath('active/shared/tmp/tool-output/a.log')).toBe(false);
    expect(store.isScopedArtifactPath('active/missions/M-1/evidence/a.json')).toBe(false);
    expect(store.isScopedArtifactPath('knowledge/product/artifacts/a.json')).toBe(false);
    expect(store.isScopedArtifactPath('/abs/active/missions/M-1/artifacts/a')).toBe(false);
  });

  it('readScopedArtifactIndex returns the recorded entries for a scope', () => {
    const entries = store.readScopedArtifactIndex({ mission: 'M-AL02-A' });
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.map((e) => e.artifact_class)).toContain('report');
  });

  it('readScopedArtifactIndex fails closed on malformed JSONL', () => {
    const result = store.writeScopedArtifact({
      scope: { mission: 'M-AL02-C' },
      artifact_class: 'report',
      name: 'valid.json',
      content: { ok: true },
    });
    fs.appendFileSync(result.index_path, '{not-json}\n');

    expect(() => store.readScopedArtifactIndex({ mission: 'M-AL02-C' })).toThrow();
  });

  it('readScopedArtifactIndex rejects shape-invalid JSONL rows', () => {
    const result = store.writeScopedArtifact({
      scope: { mission: 'M-AL02-D' },
      artifact_class: 'report',
      name: 'valid.json',
      content: { ok: true },
    });
    fs.appendFileSync(
      result.index_path,
      `${JSON.stringify({
        name: 'invalid.json',
        artifact_class: 'cache',
        path: 'active/missions/M-AL02-D/artifacts/cache/invalid.json',
        scope: { mission: 'M-AL02-D' },
        scope_kind: 'mission',
        written_at: 'not-a-date',
      })}\n`
    );

    expect(() => store.readScopedArtifactIndex({ mission: 'M-AL02-D' })).toThrow(
      'written_at is invalid'
    );
  });
});
