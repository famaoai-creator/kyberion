/**
 * AL-02 hermetic tests for `writeScopedArtifact` scope-by-scope placement and
 * artifacts-index recording.
 *
 * KM-04 convention: a temp KYBERION_ROOT is created and set BEFORE any repo
 * module is imported (path-resolver binds its project root at import time),
 * so nothing here ever touches the real active/ tree. Raw fs is used only to
 * seed/inspect the temp root (registered in tests/core-fs-exception-boundary).
 */
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  ReadScopedArtifactAttemptInput,
  WriteScopedArtifactAttemptInput,
} from './artifact-store.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let tmpRoot: string;
let store: typeof import('./artifact-store.js');

describe('artifact attempts with the unchanged tenant security policy', () => {
  let policyRoot: string;
  let policyStore: typeof import('./artifact-store.js');
  beforeAll(async () => {
    policyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyb-attempt-policy-'));
    fs.writeFileSync(path.join(policyRoot, 'package.json'), '{}');
    seedPolicyFile(policyRoot);
    const governance = path.join(policyRoot, 'knowledge/product/governance');
    fs.copyFileSync(
      path.join(REPO_ROOT, 'knowledge/product/governance/security-policy.json'),
      path.join(governance, 'security-policy.json')
    );
    fs.mkdirSync(path.join(policyRoot, 'knowledge/personal/tenants'), { recursive: true });
    fs.writeFileSync(
      path.join(policyRoot, 'knowledge/personal/tenants/synthetic-latency.json'),
      JSON.stringify({
        tenant_slug: 'synthetic-latency',
        display_name: 'Fixture',
        status: 'active',
        assigned_role: 'owner',
      })
    );
    vi.stubEnv('KYBERION_ROOT', policyRoot);
    vi.stubEnv('KYBERION_TENANT', 'synthetic-latency');
    vi.stubEnv('KYBERION_PERSONA', 'sovereign');
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    vi.resetModules();
    const { saveProjectRecord } = await import('../project/project-registry.js');
    saveProjectRecord({
      project_id: 'attempt-policy-project',
      name: 'Fixture',
      summary: 'Policy regression',
      status: 'active',
      tier: 'confidential',
      tenant_slug: 'synthetic-latency',
    });
    policyStore = await import('./artifact-store.js');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(policyRoot, { recursive: true, force: true });
  });

  it('writes and reads owned attempts without reading tenantless structural metadata', () => {
    const input = {
      scope: { tenant: 'synthetic-latency', project: 'attempt-policy-project' },
      tier: 'confidential' as const,
      artifact_class: 'evidence' as const,
      namespace: 'policy-regression',
      parent_key: 'a'.repeat(64),
      effect_key: 'b'.repeat(64),
      content: { value: 'fixture' },
      created_at: '2026-10-31T00:00:00.000Z',
      expires_at: '2026-10-31T00:05:00.000Z',
      now: () => Date.parse('2026-10-31T00:01:00.000Z'),
      validateContent: (value: unknown) => value,
    };
    const read = {
      scope: input.scope,
      tier: input.tier,
      artifact_class: input.artifact_class,
      namespace: input.namespace,
      parent_key: input.parent_key,
      effect_key: input.effect_key,
      validateContent: input.validateContent,
    };
    const saved = policyStore.writeScopedArtifactAttempt(input);
    expect(policyStore.readScopedArtifactAttempt(read)?.envelope.content).toEqual(input.content);
    const namespace = path.dirname(path.dirname(saved.artifact.absolute_path));
    const artifactClass = path.dirname(namespace);
    const owner = path.dirname(path.dirname(artifactClass));
    for (const target of [owner, artifactClass, path.dirname(saved.artifact.absolute_path)]) {
      const moved = target + '-real';
      fs.renameSync(target, moved);
      fs.symlinkSync(moved, target, 'dir');
      try {
        expect(() => policyStore.writeScopedArtifactAttempt(input)).toThrow();
      } finally {
        fs.unlinkSync(target);
        fs.renameSync(moved, target);
      }
    }
    for (const target of [artifactClass, path.dirname(saved.artifact.absolute_path)]) {
      const moved = target + '-real';
      fs.renameSync(target, moved);
      fs.writeFileSync(target, 'not a directory');
      try {
        expect(() => policyStore.writeScopedArtifactAttempt(input)).toThrow();
      } finally {
        fs.unlinkSync(target);
        fs.renameSync(moved, target);
      }
    }
    expect(policyStore.readScopedArtifactAttempt(read)?.envelope.content).toEqual(input.content);
  });
});

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

  it('publish: stamps slides_count from the written pptx when the caller omits it', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('ppt/presentation.xml', Buffer.from('<p:presentation/>'));
    zip.addFile('ppt/slides/slide1.xml', Buffer.from('<p:sld/>'));
    zip.addFile('ppt/slides/slide2.xml', Buffer.from('<p:sld/>'));
    zip.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from('<rels/>'));

    const result = store.writeScopedArtifact({
      scope: { mission: 'M-AL02-A' },
      artifact_class: 'export',
      name: 'deck/slides.pptx',
      format: 'buffer',
      content: zip.toBuffer(),
      publish: { kind: 'deck' },
    });

    const { loadArtifactRecord } = await import('./artifact-record.js');
    const record = loadArtifactRecord(result.artifact_id as string);
    expect(record?.metadata).toMatchObject({ slides_count: 2 });
  });

  it('publish: keeps a caller-provided slides_count over the derived one', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('ppt/slides/slide1.xml', Buffer.from('<p:sld/>'));

    const result = store.writeScopedArtifact({
      scope: { mission: 'M-AL02-A' },
      artifact_class: 'export',
      name: 'deck/counted.pptx',
      format: 'buffer',
      content: zip.toBuffer(),
      publish: { kind: 'deck', metadata: { slides_count: 7 } },
    });

    const { loadArtifactRecord } = await import('./artifact-record.js');
    const record = loadArtifactRecord(result.artifact_id as string);
    expect(record?.metadata).toMatchObject({ slides_count: 7 });
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

  it('personal evidence supports the untenanted shared partition without a shared tenant', () => {
    const result = store.writeScopedArtifact({
      scope: { tenant: 'shared' },
      tier: 'personal',
      artifact_class: 'evidence',
      name: 'personal-review.json',
      content: { review: 'operator only' },
    });
    expect(result.repo_relative_path).toBe(
      'active/shared/artifacts/personal/shared/evidence/personal-review.json'
    );
    expect(() =>
      store.writeScopedArtifact({
        scope: { tenant: 'shared' },
        tier: 'confidential',
        artifact_class: 'evidence',
        name: 'confidential-review.json',
        content: 'must stay tenant-bound',
      })
    ).toThrow(/invalid tenant reference/);
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

  describe('immutable scoped artifact attempts', () => {
    const epoch = Date.parse('2026-10-31T00:00:00.000Z');
    type Payload = { value: string; evaluated_at: string; expires_at: string };
    function fixture() {
      const clock = { time: epoch };
      const created = new Date(epoch).toISOString(),
        expires = new Date(epoch + 300_000).toISOString();
      const input: WriteScopedArtifactAttemptInput<Payload> = {
        scope: { tenant: `attempt-${randomUUID().slice(0, 16)}` },
        tier: 'confidential',
        artifact_class: 'evidence',
        namespace: 'attempt-test',
        parent_key: 'a'.repeat(64),
        effect_key: 'b'.repeat(64),
        created_at: created,
        expires_at: expires,
        content: { value: 'candidate-a', evaluated_at: created, expires_at: expires },
        now: () => clock.time,
        validateContent: (value, metadata) => {
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Invalid payload');
          const body = value as Record<string, unknown>;
          if (
            Object.keys(body).sort().join(',') !== 'evaluated_at,expires_at,value' ||
            typeof body.value !== 'string' ||
            body.evaluated_at !== metadata.created_at ||
            body.expires_at !== metadata.expires_at
          )
            throw new Error('Payload metadata mismatch');
          return value as Payload;
        },
      };
      const read = (): ReadScopedArtifactAttemptInput<Payload> => ({
        scope: input.scope,
        tier: input.tier,
        artifact_class: input.artifact_class,
        namespace: input.namespace,
        parent_key: input.parent_key,
        effect_key: input.effect_key,
        validateContent: input.validateContent,
      });
      const nextCandidate = (value = 'candidate-b'): void => {
        input.created_at = new Date(clock.time).toISOString();
        input.expires_at = new Date(clock.time + 300_000).toISOString();
        input.content = { value, evaluated_at: input.created_at, expires_at: input.expires_at };
      };
      return { input, clock, read, nextCandidate };
    }

    it('creates a tenant-scoped first attempt and exposes only identity metadata in the index', () => {
      const { input, read } = fixture();
      expect(store.readScopedArtifactAttempt(read())).toBeNull();
      const result = store.writeScopedArtifactAttempt(input);
      expect(result).toMatchObject({
        attempt: 1,
        adopted_existing: false,
        envelope: {
          schema_version: 1,
          parent_key: input.parent_key,
          effect_key: input.effect_key,
          scope: input.scope,
          tier: 'confidential',
          content: input.content,
        },
      });
      expect(result.artifact.repo_relative_path).toContain(
        `/confidential/${input.scope.tenant}/evidence/attempt-test/${input.parent_key}/attempt-000001.json`
      );
      expect(store.readScopedArtifactAttempt(read())?.envelope).toEqual(result.envelope);
      const rows = readIndex(result.artifact.index_path);
      expect(rows).toHaveLength(1);
      expect(rows[0].written_at).toBe(input.created_at);
      expect(JSON.stringify(rows)).not.toContain('candidate-a');
      expect(JSON.stringify(rows)).not.toContain('evaluated_at');
    });

    it('reuses a valid winner without replacing bytes with a different valid candidate', () => {
      const { input } = fixture();
      const first = store.writeScopedArtifactAttempt(input);
      const before = fs.readFileSync(first.artifact.absolute_path, 'utf8');
      input.content.value = 'another valid verdict';
      const duplicate = store.writeScopedArtifactAttempt(input);
      expect(duplicate).toMatchObject({ attempt: 1, adopted_existing: true });
      expect(duplicate.envelope.content.value).toBe('candidate-a');
      expect(fs.readFileSync(first.artifact.absolute_path, 'utf8')).toBe(before);
      expect(readIndex(first.artifact.index_path)).toHaveLength(1);
    });

    it('allocates a new attempt after expiry without extending or replacing the old receipt', () => {
      const { input, clock, nextCandidate, read } = fixture();
      const first = store.writeScopedArtifactAttempt(input);
      const before = fs.readFileSync(first.artifact.absolute_path, 'utf8');
      clock.time += 300_000;
      expect(() => store.writeScopedArtifactAttempt(input)).toThrow(/not currently valid/);
      nextCandidate();
      const second = store.writeScopedArtifactAttempt(input);
      expect(second).toMatchObject({ attempt: 2, adopted_existing: false });
      expect(second.envelope.parent_key).toBe(first.envelope.parent_key);
      expect(second.envelope.effect_key).toBe(first.envelope.effect_key);
      expect(fs.readFileSync(first.artifact.absolute_path, 'utf8')).toBe(before);
      expect(store.readScopedArtifactAttempt({ ...read(), attempt: 1 })?.envelope).toEqual(
        first.envelope
      );
      expect(store.readScopedArtifactAttempt(read())?.attempt).toBe(2);
    });

    it('converges atomic create collisions on the concurrent winner', () => {
      const { input } = fixture();
      const link = vi.mocked(fs.linkSync).getMockImplementation()!;
      let raced = false;
      vi.mocked(fs.linkSync).mockImplementation((source, target) => {
        if (!raced && String(target).endsWith('attempt-000001.json')) {
          raced = true;
          store.writeScopedArtifactAttempt({
            ...input,
            content: { ...input.content, value: 'concurrent-winner' },
          });
        }
        return link(source, target);
      });
      try {
        const result = store.writeScopedArtifactAttempt(input);
        expect(result).toMatchObject({ attempt: 1, adopted_existing: true });
        expect(result.envelope.content.value).toBe('concurrent-winner');
        expect(readIndex(result.artifact.index_path)).toHaveLength(1);
      } finally {
        vi.mocked(fs.linkSync).mockImplementation(link);
      }
    });

    it('repairs file-before-index interruption by registration only and keeps readonly reads readonly', () => {
      const { input, read } = fixture();
      const append = fs.appendFileSync;
      const open = fs.openSync;
      const files = new Map<number, string>();
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
        const fd = open(file, flags, mode);
        files.set(fd, String(file));
        return fd;
      });
      let fail = true;
      const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation((file, data, options) => {
        if (
          fail &&
          (typeof file === 'number' ? files.get(file) : String(file))?.endsWith(
            'artifacts-index.jsonl'
          )
        ) {
          fail = false;
          throw new Error('Interrupted index append');
        }
        return append(file, data, options);
      });
      try {
        expect(() => store.writeScopedArtifactAttempt(input)).toThrow(/Interrupted/);
      } finally {
        spy.mockRestore();
        openSpy.mockRestore();
      }
      const dir = store.scopedArtifactDir(input.scope, input.artifact_class, input.tier).dir;
      const file = path.join(dir, input.namespace, input.parent_key, 'attempt-000001.json');
      const before = fs.readFileSync(file, 'utf8');
      expect(() => store.readScopedArtifactAttempt(read())).toThrow(/not registered/);
      const repaired = store.writeScopedArtifactAttempt(input);
      expect(repaired).toMatchObject({ attempt: 1, adopted_existing: true });
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(store.readScopedArtifactAttempt(read())?.envelope).toEqual(repaired.envelope);
      expect(readIndex(repaired.artifact.index_path)).toHaveLength(1);
    });

    it('accepts byte-identical duplicate registration rows as one artifact reference', () => {
      const { input, read } = fixture();
      const saved = store.writeScopedArtifactAttempt(input);
      const bytes = fs.readFileSync(saved.artifact.index_path, 'utf8');
      fs.appendFileSync(saved.artifact.index_path, bytes);
      expect(store.readScopedArtifactAttempt(read())?.attempt).toBe(1);
      expect(store.writeScopedArtifactAttempt(input).attempt).toBe(1);
      expect(readIndex(saved.artifact.index_path)).toHaveLength(2);
    });

    it('accepts reordered equivalent index and scope keys without changing metadata identity', () => {
      const { input, read } = fixture();
      input.scope = { project: 'proj-x', tenant: 'acme' };
      const saved = store.writeScopedArtifactAttempt(input);
      const rows = readIndex(saved.artifact.index_path).map((row) =>
        row.path !== saved.artifact.repo_relative_path
          ? row
          : Object.fromEntries(
              Object.entries({
                ...row,
                scope: Object.fromEntries(Object.entries(row.scope as object).reverse()),
              }).reverse()
            )
      );
      fs.writeFileSync(
        saved.artifact.index_path,
        rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
      );
      expect(store.readScopedArtifactAttempt(read())?.attempt).toBe(1);
      expect(store.writeScopedArtifactAttempt(input).adopted_existing).toBe(true);
    });

    it.each(['json', 'hash', 'effect', 'scope', 'metadata'] as const)(
      'fails closed on occupied corrupt or mismatched slots: %s',
      (variant) => {
        const { input, clock, nextCandidate } = fixture();
        const saved = store.writeScopedArtifactAttempt(input);
        const value = JSON.parse(fs.readFileSync(saved.artifact.absolute_path, 'utf8'));
        if (variant === 'hash') value.content.value = 'tampered';
        if (variant === 'effect') value.effect_key = 'c'.repeat(64);
        if (variant === 'scope') value.scope = { tenant: 'another-tenant' };
        if (variant === 'metadata') value.expires_at = new Date(epoch + 900_000).toISOString();
        const corrupt = variant === 'json' ? '{broken' : JSON.stringify(value);
        fs.writeFileSync(saved.artifact.absolute_path, corrupt);
        clock.time += 400_000;
        nextCandidate();
        expect(() => store.writeScopedArtifactAttempt(input)).toThrow();
        expect(fs.readFileSync(saved.artifact.absolute_path, 'utf8')).toBe(corrupt);
        expect(
          fs.existsSync(
            path.join(path.dirname(saved.artifact.absolute_path), 'attempt-000002.json')
          )
        ).toBe(false);
      }
    );

    it('requires history recovery when the latest indexed payload is missing and never reuses its ordinal', () => {
      const { input, clock, nextCandidate, read } = fixture();
      store.writeScopedArtifactAttempt(input);
      clock.time += 300_000;
      nextCandidate();
      const second = store.writeScopedArtifactAttempt(input);
      fs.unlinkSync(second.artifact.absolute_path);
      expect(() => store.readScopedArtifactAttempt(read())).toThrow(/history recovery/);
      expect(() => store.writeScopedArtifactAttempt(input)).toThrow(/history recovery/);
      expect(fs.existsSync(second.artifact.absolute_path)).toBe(false);
      expect(
        fs.existsSync(path.join(path.dirname(second.artifact.absolute_path), 'attempt-000003.json'))
      ).toBe(false);
    });

    it('reuses a valid final ordinal and refuses allocation beyond the fixed attempt cap', () => {
      const { input, clock, nextCandidate } = fixture();
      const first = store.writeScopedArtifactAttempt(input);
      const file = path.join(path.dirname(first.artifact.absolute_path), 'attempt-000128.json');
      fs.writeFileSync(file, JSON.stringify({ ...first.envelope, attempt: 128 }));
      // Writer registers this valid orphan using the same immutable-envelope metadata.
      expect(store.writeScopedArtifactAttempt(input).attempt).toBe(128);
      clock.time += 300_000;
      nextCandidate();
      expect(() => store.writeScopedArtifactAttempt(input)).toThrow(/ordinal budget exhausted/);
      expect(fs.existsSync(path.join(path.dirname(file), 'attempt-000129.json'))).toBe(false);
    });

    it('refuses malformed index rows without rewriting the index or saving another attempt', () => {
      const { input } = fixture();
      const saved = store.writeScopedArtifactAttempt(input);
      fs.appendFileSync(saved.artifact.index_path, '{broken}\n');
      const before = fs.readFileSync(saved.artifact.index_path, 'utf8');
      expect(() => store.writeScopedArtifactAttempt(input)).toThrow();
      expect(fs.readFileSync(saved.artifact.index_path, 'utf8')).toBe(before);
    });

    it.each(['scope', 'path', 'class', 'written_at'] as const)(
      'refuses conflicting same-reference index metadata: %s',
      (field) => {
        const { input, read } = fixture();
        const saved = store.writeScopedArtifactAttempt(input);
        const row = readIndex(saved.artifact.index_path)[0];
        if (field === 'scope') row.scope = { tenant: 'different-tenant' };
        if (field === 'path')
          row.path = saved.artifact.repo_relative_path.replace('attempt-000001', 'another-000001');
        if (field === 'class') row.artifact_class = 'report';
        if (field === 'written_at') row.written_at = new Date(epoch + 1).toISOString();
        fs.writeFileSync(saved.artifact.index_path, JSON.stringify(row) + '\n');
        expect(() => store.readScopedArtifactAttempt(read())).toThrow();
        expect(() => store.writeScopedArtifactAttempt(input)).toThrow();
      }
    );

    it.each(['../escape', '/absolute', 'with/slash', '', 'Lossy Name'])(
      'rejects namespace paths: %s',
      (namespace) => {
        const { input } = fixture();
        expect(() => store.writeScopedArtifactAttempt({ ...input, namespace })).toThrow(/address/);
      }
    );

    it('rejects arbitrary path, role and publication options', () => {
      const { input } = fixture();
      for (const option of [
        { path: 'elsewhere' },
        { role: 'mission_controller' },
        { publish: { kind: 'report' } },
      ]) {
        expect(() => store.writeScopedArtifactAttempt({ ...input, ...option })).toThrow(
          /unsupported/
        );
      }
    });

    it('refuses symlinked namespace directories, slots and indexes', () => {
      for (const location of ['directory', 'slot', 'index']) {
        const { input } = fixture();
        const saved = store.writeScopedArtifactAttempt(input);
        const target =
          location === 'directory'
            ? path.dirname(saved.artifact.absolute_path)
            : location === 'slot'
              ? saved.artifact.absolute_path
              : saved.artifact.index_path;
        const moved = target + '-real';
        fs.renameSync(target, moved);
        fs.symlinkSync(moved, target);
        expect(() => store.writeScopedArtifactAttempt(input)).toThrow();
      }
    });

    it('rejects an intermediate task artifact-class symlink omitted by endpoint-only checks', () => {
      const { input } = fixture();
      input.scope = { mission: 'M-AL02-A', task: `task-${randomUUID().slice(0, 8)}` };
      store.writeScopedArtifactAttempt(input);
      const directory = path.join(tmpRoot, 'active/missions/M-AL02-A/artifacts/evidence');
      const moved = directory + '-real';
      fs.renameSync(directory, moved);
      fs.symlinkSync(moved, directory);
      try {
        expect(() => store.writeScopedArtifactAttempt(input)).toThrow(
          /symbolic link|directory must be regular/
        );
      } finally {
        fs.unlinkSync(directory);
        fs.renameSync(moved, directory);
      }
    });

    it('does not adopt copied bytes from another scope even when identity keys match', () => {
      const first = fixture(),
        second = fixture();
      const saved = store.writeScopedArtifactAttempt(first.input);
      const dir = path.join(
        store.scopedArtifactDir(second.input.scope, second.input.artifact_class, second.input.tier)
          .dir,
        second.input.namespace,
        second.input.parent_key
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(saved.artifact.absolute_path, path.join(dir, 'attempt-000001.json'));
      expect(() => store.writeScopedArtifactAttempt(second.input)).toThrow(/scope mismatch/);
    });

    it('rejects callback mutation or transformation and non-JSON data before saving', () => {
      const { input } = fixture();
      expect(() =>
        store.writeScopedArtifactAttempt({
          ...input,
          validateContent: (body) => {
            (body as Payload).value = 'mutated';
            return body as Payload;
          },
        })
      ).toThrow(/mutated/);
      expect(() =>
        store.writeScopedArtifactAttempt({
          ...input,
          validateContent: (body) => ({ ...(body as Payload), value: 'transformed' }),
        })
      ).toThrow(/transformed/);
      for (const content of [
        { value: NaN },
        { value: undefined },
        Object.assign([1], { '4294967295': 1800 }),
        new Date(),
      ]) {
        expect(() =>
          store.writeScopedArtifactAttempt({ ...input, content: content as unknown as Payload })
        ).toThrow();
      }
    });

    it('checks fresh time after validation before writing or adopting an expired candidate', () => {
      const { input, clock } = fixture();
      const validate = input.validateContent;
      input.validateContent = (body, metadata) => {
        const value = validate(body, metadata);
        clock.time += 300_000;
        return value;
      };
      expect(() => store.writeScopedArtifactAttempt(input)).toThrow(/expired before publication/);
    });

    it('refuses a regressed clock instead of allocating a lower-time replacement', () => {
      const { input, clock, nextCandidate } = fixture();
      const saved = store.writeScopedArtifactAttempt(input);
      clock.time--;
      nextCandidate();
      expect(() => store.writeScopedArtifactAttempt(input)).toThrow(/clock regressed/);
      expect(
        fs.existsSync(path.join(path.dirname(saved.artifact.absolute_path), 'attempt-000002.json'))
      ).toBe(false);
    });

    it.each(['validation', 'readback'] as const)(
      'does not publish or adopt when time regresses during %s',
      (stage) => {
        const { input, clock } = fixture();
        const validate = input.validateContent;
        let calls = 0;
        input.validateContent = (body, metadata) => {
          const value = validate(body, metadata);
          if (++calls === (stage === 'validation' ? 1 : 2)) clock.time--;
          return value;
        };
        expect(() => store.writeScopedArtifactAttempt(input)).toThrow(/clock regressed/);
        const directory = path.join(
          store.scopedArtifactDir(input.scope, input.artifact_class, input.tier).dir,
          input.namespace,
          input.parent_key
        );
        expect(fs.existsSync(path.join(directory, 'attempt-000001.json'))).toBe(
          stage === 'readback'
        );
      }
    );
  });

  describe('exclusive scoped artifact publication', () => {
    it('refuses a collision atomically without replacing the winning bytes or indexing the loser', () => {
      const link = vi.mocked(fs.linkSync).getMockImplementation()!;
      let destination = '';
      const name = 'exclusive-race-' + randomUUID() + '.txt';
      const spy = vi.mocked(fs.linkSync).mockImplementation((source, target) => {
        if (String(target).endsWith(name)) {
          destination = String(target);
          fs.writeFileSync(target, 'concurrent winner');
        }
        return link(source, target);
      });
      try {
        expect(() =>
          store.writeScopedArtifact({
            scope: { system: true },
            tier: 'public',
            artifact_class: 'report',
            name,
            content: 'losing bytes',
            create_only: true,
          })
        ).toThrow(/EEXIST/);
        expect(fs.readFileSync(destination, 'utf8')).toBe('concurrent winner');
      } finally {
        spy.mockImplementation(link);
      }
    });
    it('preserves an already published version under subsequent exclusive writes', () => {
      const name = 'exclusive-existing-' + randomUUID() + '.txt';
      const result = store.writeScopedArtifact({
        scope: { system: true },
        tier: 'public',
        artifact_class: 'report',
        name,
        content: 'V1',
        create_only: true,
      });
      expect(() =>
        store.writeScopedArtifact({
          scope: { system: true },
          tier: 'public',
          artifact_class: 'report',
          name,
          content: 'V2',
          create_only: true,
        })
      ).toThrow(/EEXIST/);
      expect(fs.readFileSync(result.absolute_path, 'utf8')).toBe('V1');
    });
  });
});
