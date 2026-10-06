import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import type { FrontDeskArtifactVerification } from '../dot/dot-state-paths.js';
import type {
  FrontDeskExecutionBinding,
  FrontDeskExecutionMapping,
} from './front-desk-execution-contract.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';

interface WorkFixture {
  item_id: string;
  status: string;
  current_attempt_id: string;
  context: { tenant_slug: string; organization_id: string; project_id: string };
  metadata: { action_ref: string; front_desk_execution?: FrontDeskExecutionBinding };
}
interface ResultFixture {
  work_item_id: string;
  action_ref: string;
  attempt_id: string;
  status: string;
  summary: string;
  completed_at: string;
  front_desk_verification?: FrontDeskArtifactVerification;
}
interface CharterFixture {
  charter: {
    dot_id: string;
    scope: { tier: string; tenant_slug: string; organization_id: string; project_id: string };
  };
}

const state = vi.hoisted(() => ({
  policy: { version: 1, mappings: [] } as unknown,
  pipeline: '',
  items: new Map<string, WorkFixture>(),
  results: [] as ResultFixture[],
  charters: [] as CharterFixture[],
  files: new Map<string, string>(),
  nonFiles: new Set<string>(),
  deniedPaths: new Set<string>(),
  unreadablePaths: new Set<string>(),
  replacementsAfterRead: new Map<string, string>(),
  replacementsBeforeRead: new Map<string, string>(),
  realPaths: new Map<string, string>(),
  realResolvedPaths: new Map<string, string>(),
  events: [] as Array<{ operation: 'guard' | 'stat' | 'read'; path: string }>,
  ranges: [] as Array<{ path: string; position: number; length: number; returned: number }>,
  reads: new Map<string, number>(),
  getWorkItem: vi.fn(),
  listDotCharters: vi.fn(),
  readDotWorkResults: vi.fn(),
}));

vi.mock('../workforce/work-coordination.js', () => ({ getWorkItem: state.getWorkItem }));
vi.mock('../dot/dot-charter.js', () => ({ listDotCharters: state.listDotCharters }));
vi.mock('../dot/dot-executor-reports.js', () => ({
  readDotWorkResults: state.readDotWorkResults,
}));
vi.mock('../dot/dot-dispatch.js', () => ({ currentDotActions: () => [] }));
vi.mock('../foundation/governed-catalog.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../foundation/governed-catalog.js')>();
  return {
    ...original,
    defineCatalog: (
      options: import('../foundation/governed-catalog.js').GovernedCatalogOptions<unknown>
    ) => {
      const catalog = original.defineCatalog(options);
      return options.id === 'front-desk-execution-policy'
        ? { ...catalog, load: () => catalog.validate(state.policy) }
        : catalog;
    },
  };
});
vi.mock('../secure-io.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../secure-io.js')>();
  const isArtifact = (path: string) => path.includes('/report/front-desk/');
  return {
    ...original,
    assertSafeRepositoryPath: (
      path: string,
      options?: Parameters<typeof original.assertSafeRepositoryPath>[1]
    ) => {
      state.events.push({ operation: 'guard', path });
      if (state.deniedPaths.has(path)) throw new Error('Symbolic link in repository path');
      const realPath = state.realPaths.get(path);
      if (realPath) {
        const resolved = original.assertSafeRepositoryPath(realPath, options);
        state.realResolvedPaths.set(resolved, path);
        return resolved;
      }
      return isArtifact(path) ? path : original.assertSafeRepositoryPath(path, options);
    },
    safeExistsSync: (path: string) =>
      isArtifact(path) ? state.files.has(path) : original.safeExistsSync(path),
    safeLstat: (path: string) => {
      const realPath = state.realResolvedPaths.get(path);
      if (realPath) {
        state.events.push({ operation: 'stat', path: realPath });
        return original.safeLstat(path);
      }
      if (!isArtifact(path)) return original.safeLstat(path);
      state.events.push({ operation: 'stat', path });
      return {
        isFile: () => !state.nonFiles.has(path),
        size: Buffer.byteLength(state.files.get(path) ?? ''),
      };
    },
    safeReadFileRange: (path: string, position: number, length: number) => {
      const realPath = state.realResolvedPaths.get(path);
      const key = realPath ?? path;
      if (!realPath && !isArtifact(path)) return original.safeReadFileRange(path, position, length);
      state.events.push({ operation: 'read', path: key });
      state.reads.set(key, (state.reads.get(key) ?? 0) + 1);
      if (state.unreadablePaths.has(key)) throw new Error('read denied');
      let bytes: Buffer;
      if (realPath) {
        bytes = original.safeReadFileRange(path, position, length);
      } else {
        const replacementBefore = state.replacementsBeforeRead.get(path);
        if (replacementBefore !== undefined) state.files.set(path, replacementBefore);
        const content = state.files.get(path);
        if (content === undefined) throw new Error('file missing');
        bytes = Buffer.from(content).subarray(position, position + length);
        const replacementAfter = state.replacementsAfterRead.get(path);
        if (replacementAfter !== undefined) state.files.set(path, replacementAfter);
      }
      state.ranges.push({ path: key, position, length, returned: bytes.length });
      return bytes;
    },
    safeReadFile: (path: string, options?: import('../secure-io.js').SafeReadOptions) => {
      if (path.endsWith('/pipelines/front-desk-request-receipt.json')) return state.pipeline;
      if (isArtifact(path)) throw new Error('Receipt reads must use the bounded reader');
      return original.safeReadFile(path, options);
    },
  };
});

import {
  FRONT_DESK_RECEIPT_COMMAND,
  FRONT_DESK_RECEIPT_PIPELINE,
  FRONT_DESK_RECEIPT_VERSION,
  frontDeskArtifactRevisionDigest,
  frontDeskExecutionExpectedContent,
  frontDeskMappingDigest,
} from './front-desk-execution-contract.js';
import {
  frontDeskExecutionArtifactPath,
  frontDeskExecutionParentArtifactPath,
} from './front-desk-execution-artifact.js';
import { projectFrontDeskExecution } from './front-desk-execution-status.js';

const viewer: SurfaceViewerScope = {
  principalId: 'human:alice',
  memberId: 'alice',
  role: 'localadmin',
  source: 'token',
  tenantSlugs: ['tenant-a'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public'],
};
const mapping: FrontDeskExecutionMapping = {
  id: 'receipt-status',
  viewer,
  dotId: 'receipt-dot',
  exactCommand: FRONT_DESK_RECEIPT_COMMAND,
  pipeline: { path: FRONT_DESK_RECEIPT_PIPELINE, version: FRONT_DESK_RECEIPT_VERSION },
};
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const makeBinding = (n = 1): FrontDeskExecutionBinding => ({
  mapping_id: mapping.id,
  config_digest: frontDeskMappingDigest(mapping),
  conversation_key: 'a'.repeat(64),
  request_id: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'),
  revision: 1,
  request_digest: 'b'.repeat(64),
  work_item_id: 'WI-FD-' + n.toString(16).padStart(48, '0'),
});
const registerReceipt = (binding = makeBinding()) => {
  const path = frontDeskExecutionArtifactPath(binding, mapping);
  const body = frontDeskExecutionExpectedContent(
    binding,
    mapping,
    'concierge-' + binding.conversation_key
  );
  const item: WorkFixture = {
    item_id: binding.work_item_id,
    status: 'done',
    current_attempt_id: 'attempt-' + binding.request_id,
    context: { tenant_slug: 'tenant-a', organization_id: 'org-a', project_id: 'project-a' },
    metadata: {
      action_ref: 'action-' + binding.request_id,
      front_desk_execution: structuredClone(binding),
    },
  };
  const result: ResultFixture = {
    work_item_id: item.item_id,
    action_ref: item.metadata.action_ref,
    attempt_id: item.current_attempt_id,
    status: 'done',
    summary: 'Verified receipt',
    completed_at: '2026-10-06T00:00:00.000Z',
    front_desk_verification: {
      artifact_path: path,
      sha256: sha256(body),
      request_digest: binding.request_digest,
      revision: binding.revision,
      verified_at: '2026-10-06T00:00:00.000Z',
    },
  };
  state.items.set(item.item_id, item);
  state.results.push(result);
  state.files.set(path, body);
  return { binding, path, body, item, result };
};
const registerRevision = (format: 'compact' | 'readable' = 'compact') => {
  const parent = registerReceipt();
  const revision = {
    requestId: parent.binding.request_id,
    revision: parent.binding.revision,
    sha256: sha256(parent.body),
    format,
  };
  const binding: FrontDeskExecutionBinding = {
    ...makeBinding(2),
    revision: 2,
    request_digest: frontDeskArtifactRevisionDigest(revision),
    parent_request_id: revision.requestId,
    parent_revision: revision.revision,
    parent_sha256: revision.sha256,
    receipt_format: format,
  };
  return { parent, current: registerReceipt(binding) };
};
const readBody = (binding: FrontDeskExecutionBinding, scope = viewer) =>
  projectFrontDeskExecution(scope, binding, { includeArtifactBody: true, locale: 'en' });

beforeEach(() => {
  vi.clearAllMocks();
  state.items.clear();
  state.results = [];
  state.files.clear();
  state.nonFiles.clear();
  state.deniedPaths.clear();
  state.unreadablePaths.clear();
  state.replacementsAfterRead.clear();
  state.replacementsBeforeRead.clear();
  state.realPaths.clear();
  state.realResolvedPaths.clear();
  state.events = [];
  state.ranges = [];
  state.reads.clear();
  state.policy = { version: 1, mappings: [structuredClone(mapping)] };
  state.pipeline = JSON.stringify({
    action: 'pipeline',
    pipeline_id: 'front-desk-request-receipt',
    version: '1.0.0',
    steps: [
      {
        id: 'write-request-receipt',
        role: 'sink',
        op: 'system:write_file',
        params: {
          path: '{{front_desk_output_path}}',
          content: '{{front_desk_artifact_content}}',
        },
      },
    ],
  });
  state.charters = [
    {
      charter: {
        dot_id: mapping.dotId,
        scope: {
          tier: 'public',
          tenant_slug: 'tenant-a',
          organization_id: 'org-a',
          project_id: 'project-a',
        },
      },
    },
  ];
  state.getWorkItem.mockImplementation((id: string) => state.items.get(id) ?? null);
  state.listDotCharters.mockImplementation(() => state.charters);
  state.readDotWorkResults.mockImplementation(() => state.results);
});

describe('verified receipt body projection', () => {
  it('keeps verified metadata-only projections body-free by default and explicit opt-out', () => {
    const receipt = registerReceipt();
    for (const options of [{ locale: 'en' as const }, { includeArtifactBody: false }]) {
      const projected = projectFrontDeskExecution(viewer, receipt.binding, options);
      expect(projected).toMatchObject({
        status: 'work_completed',
        artifactPath: receipt.path,
        artifactSha256: sha256(receipt.body),
      });
      expect(projected).not.toHaveProperty('artifactBody');
    }
  });

  it('returns exactly the verified read without a second read or reserialization', () => {
    const receipt = registerReceipt();
    state.replacementsAfterRead.set(receipt.path, 'changed immediately after verification read');
    const projected = readBody(receipt.binding);
    expect(projected).toMatchObject({
      status: 'work_completed',
      artifactBody: receipt.body,
      artifactSha256: sha256(receipt.body),
    });
    expect(state.reads.get(receipt.path)).toBe(1);
    expect(state.files.get(receipt.path)).not.toBe(receipt.body);
    expect(projected?.artifactBody).toContain('\n  "kind":');
  });

  it.each(['compact', 'readable'] as const)(
    'verifies the parent and preserves exact %s revision bytes',
    (format) => {
      const { parent, current } = registerRevision(format);
      expect(frontDeskExecutionParentArtifactPath(current.binding, mapping)).toBe(parent.path);
      expect(readBody(current.binding)).toMatchObject({
        status: 'work_completed',
        artifactBody: current.body,
        artifactSha256: sha256(current.body),
      });
      expect(state.reads.get(current.path)).toBe(1);
      expect(state.reads.get(parent.path)).toBe(1);
      expect(current.body.includes('\n')).toBe(format === 'readable');
    }
  );

  it('keeps an older completed revision readable after a later revision completes', () => {
    const { parent, current } = registerRevision();
    expect(readBody(current.binding)?.artifactBody).toBe(current.body);
    expect(readBody(parent.binding)).toMatchObject({
      status: 'work_completed',
      artifactPath: parent.path,
      artifactBody: parent.body,
      artifactSha256: sha256(parent.body),
    });
  });

  it.each([
    'missing bytes',
    'tampered bytes',
    'wrong hash',
    'missing hash',
    'unexpected content with matching hash',
    'missing verification',
    'wrong request digest',
    'wrong revision',
    'wrong artifact path',
    'unreadable bytes',
  ])('withholds all artifact fields for %s', (failure) => {
    const receipt = registerReceipt();
    const evidence = receipt.result.front_desk_verification!;
    if (failure === 'missing bytes') state.files.delete(receipt.path);
    if (failure === 'tampered bytes') state.files.set(receipt.path, receipt.body + '\n');
    if (failure === 'wrong hash') evidence.sha256 = '0'.repeat(64);
    if (failure === 'missing hash')
      delete (evidence as Partial<FrontDeskArtifactVerification>).sha256;
    if (failure === 'unexpected content with matching hash') {
      const otherContent = JSON.stringify(JSON.parse(receipt.body));
      state.files.set(receipt.path, otherContent);
      evidence.sha256 = sha256(otherContent);
    }
    if (failure === 'missing verification') delete receipt.result.front_desk_verification;
    if (failure === 'wrong request digest') evidence.request_digest = '0'.repeat(64);
    if (failure === 'wrong revision') evidence.revision++;
    if (failure === 'wrong artifact path') evidence.artifact_path = receipt.path + '.other';
    if (failure === 'unreadable bytes') state.unreadablePaths.add(receipt.path);
    const projected = readBody(receipt.binding);
    expect(projected).toMatchObject({
      status: 'uncertain',
      reportId: expect.stringMatching(/-unverified$/),
    });
    expect(projected).not.toHaveProperty('artifactBody');
    expect(projected).not.toHaveProperty('artifactPath');
    expect(projected).not.toHaveProperty('artifactSha256');
  });

  it.each(['missing', 'tampered', 'unreadable'])(
    'withholds already-read child bytes when its parent is %s',
    (failure) => {
      const { parent, current } = registerRevision();
      if (failure === 'missing') state.files.delete(parent.path);
      if (failure === 'tampered') state.files.set(parent.path, parent.body + '\n');
      if (failure === 'unreadable') state.unreadablePaths.add(parent.path);
      const projected = readBody(current.binding);
      expect(projected).toMatchObject({ status: 'uncertain' });
      expect(projected).not.toHaveProperty('artifactBody');
      expect(state.reads.get(current.path)).toBe(1);
    }
  );

  it.each(['receipt', 'parent'])('rejects an oversized %s before reading its bytes', (target) => {
    const { parent, current } = registerRevision();
    const oversizedPath = target === 'parent' ? parent.path : current.path;
    state.files.set(oversizedPath, 'x'.repeat(64 * 1024 + 1));
    const projected = readBody(current.binding);
    expect(projected?.status).toBe('uncertain');
    expect(projected).not.toHaveProperty('artifactBody');
    expect(state.reads.get(oversizedPath)).toBeUndefined();
  });

  it.each(['receipt', 'parent'])(
    'rejects %s growth between stat and read with a bounded read window',
    (target) => {
      const { parent, current } = registerRevision();
      const growing = target === 'parent' ? parent.path : current.path;
      state.replacementsBeforeRead.set(growing, 'x'.repeat(128 * 1024));
      const projected = readBody(current.binding);
      expect(projected?.status).toBe('uncertain');
      expect(projected).not.toHaveProperty('artifactBody');
      expect(state.ranges.find((range) => range.path === growing)).toEqual({
        path: growing,
        position: 0,
        length: 64 * 1024 + 1,
        returned: 64 * 1024 + 1,
      });
      expect(state.reads.get(growing)).toBe(1);
    }
  );

  it.each(['receipt', 'parent'])(
    'rejects same-size %s replacement between stat and read',
    (target) => {
      const { parent, current } = registerRevision();
      const receipt = target === 'parent' ? parent : current;
      state.replacementsBeforeRead.set(receipt.path, receipt.body.replace('receipt', 'revised'));
      const projected = readBody(current.binding);
      expect(projected?.status).toBe('uncertain');
      expect(projected).not.toHaveProperty('artifactBody');
      expect(state.reads.get(receipt.path)).toBe(1);
    }
  );

  it('guards each resolved receipt and parent path before stat and bounded read', () => {
    const { parent, current } = registerRevision();
    expect(readBody(current.binding)?.status).toBe('work_completed');
    expect(
      state.events.filter((event) => event.path === current.path || event.path === parent.path)
    ).toEqual([
      { operation: 'guard', path: current.path },
      { operation: 'stat', path: current.path },
      { operation: 'read', path: current.path },
      { operation: 'guard', path: parent.path },
      { operation: 'stat', path: parent.path },
      { operation: 'read', path: parent.path },
    ]);
    expect(state.ranges.every((range) => range.position === 0 && range.length === 65537)).toBe(
      true
    );
  });

  it.each(['receipt leaf', 'receipt ancestor', 'parent leaf', 'parent ancestor'])(
    'rejects a symlink at %s without reading the linked target',
    (location) => {
      const { parent, current } = registerRevision();
      const blocked = location.startsWith('parent') ? parent.path : current.path;
      if (location.endsWith('leaf')) state.nonFiles.add(blocked);
      else state.deniedPaths.add(blocked);
      const projected = readBody(current.binding);
      expect(projected?.status).toBe('uncertain');
      expect(projected).not.toHaveProperty('artifactBody');
      expect(state.reads.get(blocked)).toBeUndefined();
    }
  );
});

describe('receipt body authorization and execution binding', () => {
  it.each([
    { principalId: 'human:bob' },
    { memberId: 'bob' },
    { source: 'loopback' },
    { role: 'readonly' },
    { tenantSlugs: ['tenant-b'] },
    { organizationIds: ['org-b'] },
    { projectIds: ['project-b'] },
    { tierAccess: ['confidential'] },
    { tierAccess: ['public', 'confidential'] },
  ])('rejects a mismatched server viewer %j before accessing work or receipt bytes', (change) => {
    const receipt = registerReceipt();
    expect(
      readBody(receipt.binding, { ...viewer, ...change } as SurfaceViewerScope)
    ).toBeUndefined();
    expect(state.getWorkItem).not.toHaveBeenCalled();
    expect(state.reads.size).toBe(0);
  });

  it.each(['work item', 'charter'])(
    'rejects a mismatched %s scope before reading receipt bytes',
    (source) => {
      for (const field of ['tenant_slug', 'organization_id', 'project_id'] as const) {
        const receipt = registerReceipt();
        const scope =
          source === 'work item' ? receipt.item.context : state.charters[0].charter.scope;
        const previous = scope[field];
        scope[field] = 'other';
        expect(readBody(receipt.binding)).toBeUndefined();
        expect(state.reads.size).toBe(0);
        scope[field] = previous;
      }
    }
  );

  it.each(['confidential', 'personal'])(
    'rejects a charter moved to the %s tier before reading receipt bytes',
    (tier) => {
      const receipt = registerReceipt();
      state.charters[0].charter.scope.tier = tier;
      expect(readBody(receipt.binding)).toBeUndefined();
      expect(state.reads.size).toBe(0);
    }
  );

  it.each(['missing', 'conversation', 'request', 'digest'])(
    'rejects %s work-item binding without reading receipt bytes',
    (failure) => {
      const receipt = registerReceipt();
      if (failure === 'missing') delete receipt.item.metadata.front_desk_execution;
      else {
        const bound = receipt.item.metadata.front_desk_execution!;
        if (failure === 'conversation') bound.conversation_key = 'f'.repeat(64);
        if (failure === 'request') bound.request_id = makeBinding(9).request_id;
        if (failure === 'digest') bound.request_digest = 'f'.repeat(64);
      }
      expect(readBody(receipt.binding)).toBeUndefined();
      expect(state.reads.size).toBe(0);
    }
  );

  it('rejects revoked configuration before accessing work or receipt bytes', () => {
    const receipt = registerReceipt();
    state.pipeline += ' ';
    expect(readBody(receipt.binding)).toBeUndefined();
    expect(state.getWorkItem).not.toHaveBeenCalled();
    expect(state.reads.size).toBe(0);
  });

  it.each(['work_item_id', 'action_ref', 'attempt_id'] as const)(
    'does not expose bytes from a result with mismatched %s',
    (field) => {
      const receipt = registerReceipt();
      receipt.result[field] = 'other';
      const projected = readBody(receipt.binding);
      expect(projected?.status).toBe('uncertain');
      expect(projected).not.toHaveProperty('artifactBody');
      expect(state.reads.size).toBe(0);
    }
  );

  it.each([
    ['ready', 'done', 'queued'],
    ['in_progress', 'done', 'running'],
    ['blocked', 'done', 'blocked'],
    ['done', 'failed', 'blocked'],
  ])('does not expose bytes for work/result state %s/%s', (work, result, expected) => {
    const receipt = registerReceipt();
    receipt.item.status = work;
    receipt.result.status = result;
    const projected = readBody(receipt.binding);
    expect(projected?.status).toBe(expected);
    expect(projected).not.toHaveProperty('artifactBody');
    expect(state.reads.size).toBe(0);
  });
});

describe('real filesystem receipt path guards', () => {
  it.each(['receipt leaf', 'receipt ancestor', 'parent leaf', 'parent ancestor'])(
    'rejects a real %s symlink through the guarded verifier',
    async (location) => {
      const realIo = await vi.importActual<typeof import('../secure-io.js')>('../secure-io.js');
      const { parent, current } = registerRevision();
      const blocked = location.startsWith('parent') ? parent : current;
      const root = 'active/shared/tmp/receipt-status-symlink-' + randomUUID();
      withExecutionContext('ecosystem_architect', () => {
        realIo.safeMkdir(root);
        try {
          const currentFile = root + '/regular/current.json';
          const parentFile = root + '/regular/parent.json';
          realIo.safeWriteFile(currentFile, current.body);
          realIo.safeWriteFile(parentFile, parent.body);
          state.realPaths.set(current.path, currentFile);
          state.realPaths.set(parent.path, parentFile);
          expect(readBody(current.binding)).toMatchObject({
            status: 'work_completed',
            artifactBody: current.body,
          });

          const targetDir = root + '/target';
          const targetFile = targetDir + '/receipt.json';
          realIo.safeMkdir(targetDir);
          realIo.safeWriteFile(targetFile, blocked.body);
          const linkedPath = location.endsWith('ancestor')
            ? root + '/linked-parent/receipt.json'
            : root + '/linked-receipt.json';
          if (location.endsWith('ancestor'))
            realIo.safeSymlinkSync(targetDir, root + '/linked-parent', 'dir');
          else realIo.safeSymlinkSync(targetFile, linkedPath, 'file');

          // Ordinary lexical reads can follow these links; the explicit path guard must reject them.
          expect(realIo.safeReadFile(linkedPath, { encoding: 'utf8' })).toBe(blocked.body);
          expect(realIo.safeLstat(linkedPath).isFile()).toBe(location.endsWith('ancestor'));
          expect(() => realIo.assertSafeRepositoryPath(linkedPath)).toThrow(/symbolic|symlink/i);
          state.realPaths.set(blocked.path, linkedPath);
          state.realResolvedPaths.clear();
          state.reads.clear();
          state.events = [];

          const projected = readBody(current.binding);
          expect(projected?.status).toBe('uncertain');
          expect(projected).not.toHaveProperty('artifactBody');
          expect(state.events).toContainEqual({ operation: 'guard', path: blocked.path });
          expect(state.reads.get(blocked.path)).toBeUndefined();
        } finally {
          realIo.safeRmSync(root, { recursive: true, force: true });
        }
      });
    }
  );
});
