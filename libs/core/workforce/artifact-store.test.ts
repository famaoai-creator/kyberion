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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let tmpRoot: string;
let store: typeof import('./artifact-store.js');

/** secure-io's policy engine fails closed without policies — seed the real file. */
function seedPolicyFile(root: string): void {
  const target = path.join(root, 'knowledge', 'product', 'governance', 'agent-policies.yaml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'knowledge/product/governance/agent-policies.yaml'), target);
  const schemaTarget = path.join(
    root,
    'knowledge',
    'product',
    'schemas',
    'scoped-artifact-index-entry.schema.json'
  );
  fs.mkdirSync(path.dirname(schemaTarget), { recursive: true });
  // ArtifactRecord validation ($ref chain) needs the full schema directory.
  fs.cpSync(path.join(REPO_ROOT, 'knowledge/product/schemas'), path.dirname(schemaTarget), {
    recursive: true,
  });
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
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyb-scoped-artifact-'));
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    seedPolicyFile(tmpRoot);
    process.env.KYBERION_ROOT = tmpRoot;
    process.env.MISSION_ROLE = 'mission_controller';
    store = await import('./artifact-store.js');
    // Owned scopes are placed by their owner's record, so the owners exist.
    const missionState = (missionId: string, tier: string) =>
      JSON.stringify({
        mission_id: missionId,
        tier,
        status: 'active',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'worker',
        confidence_score: 1,
        git: { branch: 'm', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
        history: [],
      });
    for (const [missionId, tier] of [
      ['M-AL02-A', 'confidential'],
      ['M-AL02-B', 'confidential'],
      ['M-AL02-C', 'confidential'],
      ['M-AL02-D', 'confidential'],
      ['M-AL02-E', 'confidential'],
      ['M-AL02-SYMLINK', 'confidential'],
      ['MSN-TIER-INFER', 'public'],
    ]) {
      const dir = path.join(tmpRoot, 'active/missions', missionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'mission-state.json'), missionState(missionId, tier));
    }
    const { saveProjectRecord } = await import('../project/project-registry.js');
    for (const [projectId, tier, tenant] of [
      ['proj-x', 'confidential', 'acme'],
      ['proj-y', 'public', undefined],
    ] as const) {
      saveProjectRecord({
        project_id: projectId,
        name: projectId,
        summary: 'artifact-store test project',
        status: 'active',
        tier,
        ...(tenant ? { tenant_slug: tenant } : {}),
      } as Parameters<typeof saveProjectRecord>[0]);
    }
    for (const [tier, tenant, org] of [
      ['confidential', 'acme', 'org-ops'],
      ['public', 'shared', 'org-pub'],
      ['confidential', 'acme', 'org-x'],
      ['confidential', 'globex', 'org-x'],
    ]) {
      fs.mkdirSync(path.join(tmpRoot, 'active/organizations', tier, tenant, org, 'state'), {
        recursive: true,
      });
    }
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

  it('mission scope without a tier takes the existing mission tier, not the default', async () => {
    const first = store.writeScopedArtifact({
      scope: { mission: 'MSN-TIER-INFER' },
      tier: 'public',
      artifact_class: 'report',
      name: 'first.md',
      content: 'x',
    });
    const result = store.writeScopedArtifact({
      scope: { mission: 'MSN-TIER-INFER' },
      artifact_class: 'report',
      name: 'second.md',
      content: 'y',
      publish: { kind: 'report' },
    });
    expect(result.repo_relative_path).toBe(
      path.posix.join(path.posix.dirname(first.repo_relative_path), 'second.md')
    );
    const { loadArtifactRecord } = await import('./artifact-record.js');
    expect(loadArtifactRecord(result.artifact_id as string)?.metadata).toMatchObject({
      tier: 'public',
    });
  });

  it('rejects an explicit tier that contradicts the mission and a foreign artifact_id', () => {
    expect(() =>
      store.writeScopedArtifact({
        scope: { mission: 'MSN-TIER-INFER' },
        tier: 'confidential',
        artifact_class: 'report',
        name: 'third.md',
        content: 'z',
      })
    ).toThrow(/\[SCOPE_CONTRADICTS_OWNER\] mission MSN-TIER-INFER is public\/shared/);
    // An owned write for an owner that does not exist is refused, not guessed.
    expect(() =>
      store.writeScopedArtifact({
        scope: { project: 'proj-missing' },
        artifact_class: 'report',
        name: 'x.md',
        content: 'x',
      })
    ).toThrow(/\[OWNER_NOT_FOUND\] project proj-missing/);

    const publish = (organization: string, tenant: string, content: string) =>
      store.writeScopedArtifact({
        scope: { organization, tenant },
        tier: 'confidential',
        artifact_class: 'report',
        name: 'digest.json',
        content,
        publish: { kind: 'report', artifact_id: 'ART-FIXED-ID-1' },
      });
    publish('org-x', 'acme', 'v1');
    // Same owner: a re-run updates the record.
    expect(publish('org-x', 'acme', 'v2').artifact_id).toBe('ART-FIXED-ID-1');
    // Another tenant cannot take over the record by choosing its id.
    expect(() => publish('org-x', 'globex', 'evil')).toThrow(/belongs to another owner scope/);
  });

  it("attributes a published record to the owner's organization, never the caller's", async () => {
    const dir = path.join(tmpRoot, 'active/missions/M-AL02-ORG');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mission-state.json'),
      JSON.stringify({
        mission_id: 'M-AL02-ORG',
        tier: 'confidential',
        organization_id: 'org-ops',
        status: 'active',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'worker',
        confidence_score: 1,
        git: { branch: 'm', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
        history: [],
      })
    );
    const write = (extra: Record<string, unknown>) =>
      store.writeScopedArtifact({
        artifact_class: 'report',
        name: 'org.md',
        content: 'x',
        scope: { mission: 'M-AL02-ORG' },
        publish: { kind: 'report' },
        ...extra,
      } as Parameters<typeof store.writeScopedArtifact>[0]);
    expect(() => write({ scope: { mission: 'M-AL02-ORG', organization: 'org-other' } })).toThrow(
      /\[SCOPE_CONTRADICTS_OWNER\] mission M-AL02-ORG belongs to organization 'org-ops'/u
    );
    expect(() => write({ publish: { kind: 'report', organization_id: 'org-other' } })).toThrow(
      /\[SCOPE_CONTRADICTS_OWNER\] publish.organization_id 'org-other'/u
    );
    const { loadArtifactRecord } = await import('./artifact-record.js');
    expect(loadArtifactRecord(write({}).artifact_id as string)?.organization_id).toBe('org-ops');
  });

  it('organization scope: places under the tier/tenant organization workspace', async () => {
    const result = store.writeScopedArtifact({
      scope: { organization: 'org-ops', tenant: 'acme' },
      tier: 'confidential',
      artifact_class: 'report',
      name: 'digests/2026-10-02.json',
      content: { ok: true },
      publish: { kind: 'report', preview_text: 'org digest' },
    });

    expect(result.scope_kind).toBe('organization');
    expect(result.repo_relative_path).toBe(
      'active/organizations/confidential/acme/org-ops/artifacts/report/digests/2026-10-02.json'
    );
    expect(readIndex(result.index_path)[0]).toMatchObject({
      scope: { organization: 'org-ops', tenant: 'acme' },
      scope_kind: 'organization',
    });
    // The organization owns the published record — no task session needed.
    const { loadArtifactRecord } = await import('./artifact-record.js');
    expect(loadArtifactRecord(result.artifact_id as string)).toMatchObject({
      organization_id: 'org-ops',
      tenant_slug: 'acme',
      metadata: expect.objectContaining({ scope_kind: 'organization', tier: 'confidential' }),
    });
    expect(
      store.readScopedArtifactIndex({ organization: 'org-ops', tenant: 'acme' }, 'confidential')
    ).toHaveLength(1);

    // Untenanted organizations land in the `shared` partition; a mission or
    // project ref outranks the organization (precedence).
    expect(
      store.writeScopedArtifact({
        scope: { organization: 'org-pub' },
        tier: 'public',
        artifact_class: 'report',
        name: 'a.md',
        content: 'x',
      }).repo_relative_path
    ).toBe('active/organizations/public/shared/org-pub/artifacts/report/a.md');
    expect(
      store.writeScopedArtifact({
        scope: { organization: 'org-pub', project: 'proj-y' },
        tier: 'public',
        artifact_class: 'report',
        name: 'b.md',
        content: 'x',
      }).scope_kind
    ).toBe('project');
    expect(() =>
      store.writeScopedArtifact({
        scope: { system: true, organization: 'org-pub' },
        artifact_class: 'report',
        name: 'c.md',
        content: 'x',
      })
    ).toThrow(/system scope is platform-wide/);
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

  it('tenant scope: places under the tier/tenant partition of the artifact floor', () => {
    const result = store.writeScopedArtifact({
      scope: { tenant: 'acme' },
      artifact_class: 'evidence',
      name: 'audit-trail.json',
      content: { events: [] },
    });

    expect(result.scope_kind).toBe('tenant');
    expect(result.repo_relative_path).toBe(
      'active/shared/artifacts/confidential/acme/evidence/audit-trail.json'
    );
    expect(result.index_path).toBe(
      path.join(tmpRoot, 'active/shared/artifacts/confidential/acme/artifacts-index.jsonl')
    );
    expect(readIndex(result.index_path)[0]).toMatchObject({
      artifact_class: 'evidence',
      scope_kind: 'tenant',
    });
  });

  it('tenant scope: rejects reserved or malformed tenant slugs', () => {
    for (const tenant of ['shared', 'public', 'Bad Slug']) {
      expect(() =>
        store.writeScopedArtifact({
          scope: { tenant },
          artifact_class: 'report',
          name: 'x.md',
          content: 'x',
        })
      ).toThrow(/invalid tenant reference/);
    }
  });

  it('system scope: places platform-wide artifacts under the system partition', () => {
    const result = store.writeScopedArtifact({
      scope: { system: true },
      artifact_class: 'report',
      name: 'health/HEALTH_REPORT.md',
      content: '# ok',
    });
    expect(result.scope_kind).toBe('system');
    expect(result.repo_relative_path).toBe(
      'active/shared/artifacts/system/report/health/HEALTH_REPORT.md'
    );
    expect(store.readScopedArtifactIndex({ system: true })[0]).toMatchObject({
      scope: { system: true },
      scope_kind: 'system',
    });
  });

  it('system scope: stands alone and carries public-tier data only', () => {
    expect(() =>
      store.writeScopedArtifact({
        scope: { system: true, tenant: 'acme' },
        artifact_class: 'report',
        name: 'x.md',
        content: 'x',
      })
    ).toThrow(/cannot be combined/);
    expect(() =>
      store.writeScopedArtifact({
        scope: { system: true },
        tier: 'confidential',
        artifact_class: 'report',
        name: 'x.md',
        content: 'x',
      })
    ).toThrow(/public-tier data only/);
  });

  it('publish: registers an ArtifactRecord surfaces can list', async () => {
    const result = store.writeScopedArtifact({
      scope: { tenant: 'acme' },
      artifact_class: 'report',
      name: 'weekly.md',
      content: '# weekly',
      publish: { kind: 'report', preview_text: 'weekly summary', task_session_id: 'TS-WEEKLY' },
    });
    expect(result.artifact_id).toMatch(/^ART-/);
    const { loadArtifactRecord } = await import('./artifact-record.js');
    expect(loadArtifactRecord(result.artifact_id as string)).toMatchObject({
      tenant_slug: 'acme',
      storage_class: 'artifact_store',
      path: 'active/shared/artifacts/confidential/acme/report/weekly.md',
      metadata: expect.objectContaining({
        tier: 'confidential',
        artifact_class: 'report',
        scope_kind: 'tenant',
      }),
    });
  });

  it('publish: requires an owning project, mission, or task session', () => {
    expect(() =>
      store.writeScopedArtifact({
        scope: { system: true },
        artifact_class: 'report',
        name: 'unowned.md',
        content: 'x',
        publish: { kind: 'report' },
      })
    ).toThrow(/publish requires an owning/);
    expect(
      fs.existsSync(path.join(tmpRoot, 'active/shared/artifacts/system/report/unowned.md'))
    ).toBe(false);
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
    ).toThrow(/at least one of system\/tenant\/organization\/project\/mission\/task\/session/);

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

  it('rejects governed artifact operations when the file path is a directory', () => {
    const logicalPath = `active/shared/coordination/artifact-store-directory-${randomUUID()}.jsonl`;
    const absolutePath = path.join(tmpRoot, logicalPath);
    fs.mkdirSync(absolutePath, { recursive: true });

    try {
      expect(() =>
        store.appendGovernedArtifactJsonl('mission_controller', logicalPath, { value: true })
      ).toThrow('governed artifact must be a regular file');
      expect(() =>
        store.writeGovernedArtifactJson('mission_controller', logicalPath, { value: true })
      ).toThrow('governed artifact must be a regular file');
      expect(() => store.readGovernedArtifactJson(logicalPath)).toThrow(
        'governed artifact must be a regular file'
      );
    } finally {
      fs.rmSync(absolutePath, { recursive: true, force: true });
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
    expect(
      store.isScopedArtifactPath('active/organizations/public/shared/o/artifacts/report/a.json')
    ).toBe(true);
    expect(store.isScopedArtifactPath('active/organizations/public/shared/o/state/a.json')).toBe(
      false
    );
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

    expect(() => store.readScopedArtifactIndex({ mission: 'M-AL02-D' })).toThrow(/written_at/);
  });

  it('rejects an artifact index path that is a directory', () => {
    const indexPath = path.join(
      tmpRoot,
      'active/missions/M-AL02-E/artifacts/artifacts-index.jsonl'
    );
    fs.mkdirSync(indexPath, { recursive: true });

    expect(() => store.readScopedArtifactIndex({ mission: 'M-AL02-E' })).toThrow(
      /must be a regular file/
    );
  });
});
