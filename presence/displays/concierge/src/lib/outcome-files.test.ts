import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const mocks = vi.hoisted(() => ({
  entries: vi.fn(),
  owner: vi.fn(),
  clear: vi.fn(),
  state: vi.fn(),
  member: vi.fn(),
  authz: vi.fn(),
  safePath: vi.fn(),
  stat: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/deliverable-inbox', () => ({ listInboxEntries: mocks.entries }));
vi.mock('@agent/core/entity-scope', () => ({
  isValidTenantSlug: (value: string) => value === 'acme',
}));
vi.mock('@agent/core/owner-scope', () => ({
  clearOwnerScopeCache: mocks.clear,
  resolveOwnerScope: mocks.owner,
}));
vi.mock('@agent/core/mission/mission-state-reader', () => ({
  loadMissionStateAtPath: mocks.state,
}));
vi.mock('@agent/core/organization/member-registry', () => ({
  resolveMemberByPrincipal: mocks.member,
}));
vi.mock('@agent/core/path-resolver', () => ({
  pathResolver: {
    rootDir: () => '/repo',
    missionDir: (id: string, tier: string) => '/repo/active/missions/' + tier + '/' + id,
  },
}));
vi.mock('@agent/core/surface/surface-authn', () => ({
  authorizeSurfaceContextOperation: mocks.authz,
}));
vi.mock('@agent/core/secure-io', () => ({
  withSensitivePathMediation: (fn: () => unknown) => fn(),
  assertSafeRepositoryPath: mocks.safePath,
  safeLstat: mocks.stat,
  safeReadFileSnapshot: mocks.snapshot,
}));
vi.mock('./viewer-context', () => ({ toSurfaceAuthorizationContext: (viewer: unknown) => viewer }));
import {
  listOutcomeFiles,
  readOutcomeFile,
  MAX_OUTCOME_FILE_BYTES,
  outcomeDownloadHeaders,
} from './outcome-files';
import type { ConciergeViewerContext } from './viewer-context';
import { parseOutcomeFilesResponse } from './outcome-files-response';

const root = '/repo/active/missions/public/acme/MSN-TEST';
let contents: Map<string, Buffer>;
let viewer: ConciergeViewerContext;
let entry: Record<string, unknown>;
let owner: Record<string, unknown>;
let state: Record<string, unknown>;
let member: Record<string, unknown>;
const reader = () => viewer;
function list(cursor?: string) {
  return listOutcomeFiles(reader, 'INBOX-TEST', cursor);
}
function seed(names = ['report.pdf']) {
  const paths = names.map((name) => root + '/artifacts/report/' + name);
  entry.artifact_paths = paths;
  for (const file of paths)
    contents.set(file, Buffer.from(file.endsWith('.pdf') ? '%PDF-1.7 test' : 'hello'));
}
function available(page = list()) {
  const file = page.files.find((file) => file.status === 'available');
  if (!file || file.status !== 'available') throw new Error('fixture did not produce a link');
  return file;
}
beforeEach(() => {
  vi.resetAllMocks();
  viewer = {
    principalId: 'user:alice',
    memberId: 'alice',
    source: 'token',
    role: 'localadmin',
    tenantSlugs: ['acme'],
    organizationIds: ['ORG'],
    projectIds: ['PRJ'],
    tierAccess: ['public'],
  };
  owner = {
    owner: { kind: 'mission', id: 'MSN-TEST' },
    dir: root,
    tier: 'public',
    tenant: 'acme',
    organization_id: 'ORG',
    project_id: 'PRJ',
  };
  state = { mission_id: 'MSN-TEST', tier: 'public', tenant_slug: 'acme', organization_id: 'ORG' };
  member = {
    member_id: 'alice',
    status: 'active',
    memberships: [{ tenant_slug: 'acme', role: 'owner' }],
  };
  entry = {
    entry_id: 'INBOX-TEST',
    mission_id: 'MSN-TEST',
    artifact_paths: [],
    title: 'Outcome',
    summary: '',
    created_at: '2026-10-07T00:00:00Z',
    updated_at: '2026-10-07T00:00:00Z',
    status: 'unread',
  };
  contents = new Map();
  mocks.entries.mockImplementation(() => [entry]);
  mocks.owner.mockImplementation(() => owner);
  mocks.state.mockImplementation(() => state);
  mocks.member.mockImplementation(() => member);
  mocks.authz.mockReturnValue({ allowed: true });
  mocks.safePath.mockImplementation((file: string) => file);
  mocks.stat.mockImplementation((file: string) => {
    const bytes = contents.get(file);
    if (!bytes) throw new Error('missing');
    return {
      isFile: () => true,
      isSymbolicLink: () => false,
      dev: 1,
      ino: 2,
      size: bytes.length,
      mtimeMs: 1,
      ctimeMs: 1,
    };
  });
  mocks.snapshot.mockImplementation((file: string, length: number) =>
    contents.get(file)!.subarray(0, length)
  );
  seed();
});
describe('mission-owned outcome files', () => {
  it('lists and downloads exact PDF/DOCX bytes beyond the five-preview boundary', () => {
    seed(['1.txt', '2.txt', '3.txt', '4.txt', '5.txt', 'six.pdf', 'seven.docx']);
    const docx = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 0, 1]);
    contents.set(root + '/artifacts/report/seven.docx', docx);
    const page = list();
    expect(page.files).toHaveLength(7);
    expect(parseOutcomeFilesResponse({ ok: true, files: page }, 'INBOX-TEST')).toEqual(page);
    const sixth = page.files[5];
    const seventh = page.files[6];
    if (sixth.status !== 'available' || seventh.status !== 'available')
      throw new Error('unavailable');
    expect(readOutcomeFile(reader, 'INBOX-TEST', sixth.id).contentType).toBe('application/pdf');
    expect(readOutcomeFile(reader, 'INBOX-TEST', seventh.id)).toMatchObject({
      bytes: docx,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(JSON.stringify(page)).not.toContain('/repo');
    expect(mocks.clear.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(mocks.authz).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          effect: 'read',
          requiredPermissions: ['surface.headless.read'],
        }),
        resource: { tenantSlug: 'acme', organizationId: 'ORG', projectId: 'PRJ', tier: 'public' },
      })
    );
  });
  it('paginates every intended file and rejects cursors after entry changes', () => {
    seed(Array.from({ length: 23 }, (_, index) => index + '.txt'));
    const first = list();
    const second = list(first.next_cursor);
    const third = list(second.next_cursor);
    expect([first.files.length, second.files.length, third.files.length]).toEqual([10, 10, 3]);
    expect(third.next_cursor).toBeUndefined();
    entry.updated_at = '2026-10-08T00:00:00Z';
    expect(() => list(first.next_cursor)).toThrow();
  });
  it.each(['tenantSlugs', 'organizationIds', 'projectIds', 'tierAccess'] as const)(
    'denies wrong viewer %s',
    (key) => {
      Object.assign(viewer, { [key]: ['other'] });
      expect(() => list()).toThrow();
      expect(mocks.snapshot).not.toHaveBeenCalled();
    }
  );
  it.each(['organization_id', 'project_id'])(
    'denies missing source %s for a restricted viewer',
    (field) => {
      delete owner[field];
      expect(() => list()).toThrow();
    }
  );
  it.each([
    'anonymous',
    'missing principal',
    'missing member',
    'suspended',
    'viewer role',
    'policy deny',
    'wrong entry tenant',
    'unknown mission',
    'state tier changed',
    'physical tier mismatch',
    'physical tenant mismatch',
    'state tenant missing',
    'duplicate inbox',
    'personal',
  ])('fails closed: %s', (failure) => {
    if (failure === 'anonymous') viewer.source = 'anonymous';
    if (failure === 'missing principal') delete viewer.principalId;
    if (failure === 'missing member') mocks.member.mockReturnValue(null);
    if (failure === 'suspended') member.status = 'suspended';
    if (failure === 'viewer role') member.memberships = [{ tenant_slug: 'acme', role: 'viewer' }];
    if (failure === 'policy deny') mocks.authz.mockReturnValue({ allowed: false });
    if (failure === 'wrong entry tenant') entry.tenant_slug = 'other';
    if (failure === 'unknown mission') delete entry.mission_id;
    if (failure === 'state tier changed') state.tier = 'confidential';
    if (failure === 'physical tier mismatch')
      owner.dir = root.replace('/public/', '/confidential/');
    if (failure === 'physical tenant mismatch') owner.dir = root.replace('/acme/', '/other/');
    if (failure === 'state tenant missing') delete state.tenant_slug;
    if (failure === 'duplicate inbox') mocks.entries.mockReturnValue([entry, entry]);
    if (failure === 'personal') {
      owner.tier = 'personal';
      state.tier = 'personal';
    }
    expect(() => list()).toThrow();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it.each([
    '../../secret',
    '/etc/passwd',
    root + '/mission-state.json',
    root + '/artifacts/../mission-state.json',
    root.replace('/acme/', '/other/') + '/artifacts/x.txt',
    root + '/artifacts/../artifacts/x.txt',
  ])('never reads an unbound or traversal path: %s', (file) => {
    entry.artifact_paths = [file];
    expect(list().files).toEqual([{ index: 0, status: 'unavailable' }]);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it('does not issue links for missing files or symlink ancestors', () => {
    seed(['missing.txt', 'link.txt']);
    contents.clear();
    mocks.safePath.mockImplementation((file: string) => {
      if (file.endsWith('link.txt')) throw new Error('symlink ancestor');
      return file;
    });
    expect(
      list().files.every((file) => file.status === 'unavailable' && !('download_url' in file))
    ).toBe(true);
  });
  it('revokes an issued file ID after changed content, binding, identity or membership', () => {
    const id = available().id;
    contents.set(root + '/artifacts/report/report.pdf', Buffer.from('%PDF-replaced'));
    expect(() => readOutcomeFile(reader, 'INBOX-TEST', id)).toThrow();
    seed();
    viewer.principalId = 'user:bob';
    expect(() => readOutcomeFile(reader, 'INBOX-TEST', id)).toThrow();
    viewer.principalId = 'user:alice';
    member.status = 'suspended';
    expect(() => readOutcomeFile(reader, 'INBOX-TEST', id)).toThrow();
    member.status = 'active';
    entry.updated_at = 'changed';
    expect(() => readOutcomeFile(reader, 'INBOX-TEST', id)).toThrow();
  });
  it('refreshes membership and source scope after reading, so mid-read revocation fails closed', () => {
    mocks.snapshot.mockImplementationOnce((file: string) => {
      member.status = 'suspended';
      return contents.get(file)!;
    });
    expect(() => list()).toThrow();
  });
  it('rejects raced ancestry/stat changes and bounds actual FD reads', () => {
    const id = available().id;
    mocks.safePath.mockImplementation((file: string) => {
      if (mocks.snapshot.mock.calls.length > 1 && file.endsWith('.pdf'))
        throw new Error('ancestor changed');
      return file;
    });
    expect(() => readOutcomeFile(reader, 'INBOX-TEST', id)).toThrow();
    expect(mocks.snapshot).toHaveBeenCalledWith(expect.any(String), MAX_OUTCOME_FILE_BYTES);
  });
  it('rejects stat/bytes mutation and oversized files without returning partial downloads', () => {
    const file = available();
    mocks.snapshot.mockReturnValue(Buffer.from('partial'));
    expect(() => readOutcomeFile(reader, 'INBOX-TEST', file.id)).toThrow();
    mocks.stat.mockReturnValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: MAX_OUTCOME_FILE_BYTES + 1,
    });
    expect(list().files[0].status).toBe('too_large');
  });
  it.each([238, 239])(
    'keeps legal filename* headers when truncating a long Unicode filename after %s ASCII characters',
    (length) => {
      const original = 'a'.repeat(length) + '😀.pdf';
      expect(Buffer.byteLength(original)).toBeLessThanOrEqual(255);
      seed([original]);
      const file = available();
      const result = readOutcomeFile(reader, 'INBOX-TEST', file.id);
      expect(result.name).toBe('a'.repeat(length) + (length === 238 ? '😀' : ''));
      expect(result.name.length).toBeLessThanOrEqual(240);
      const headers = outcomeDownloadHeaders(result.name, result.contentType, result.bytes.length);
      expect(headers['Content-Disposition']).toContain(
        "filename*=UTF-8''" + encodeURIComponent(result.name)
      );
    }
  );
  it('binds file IDs to their inbox entry and sends inert attachment headers', () => {
    const file = available();
    expect(file.id.slice(64)).toBe(
      createHash('sha256').update(contents.values().next().value!).digest('hex')
    );
    entry.entry_id = 'INBOX-OTHER';
    expect(() => readOutcomeFile(reader, 'INBOX-OTHER', file.id)).toThrow();
    const headers = outcomeDownloadHeaders('résumé".pdf', 'application/pdf', 12);
    expect(headers['Content-Disposition']).toContain('attachment; filename="r_sum__.pdf"');
    expect(headers['Content-Disposition']).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%22.pdf");
    expect(headers['Cache-Control']).toContain('no-store');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Security-Policy']).toContain('sandbox');
  });
});
describe('download response URL boundary', () => {
  it.each([
    'https://evil.test/file',
    '//evil.test/file',
    'javascript:alert(1)',
    '/api/outcomes/OTHER/files/x',
    '/api/outcomes/INBOX-TEST/files/x?path=secret',
  ])('rejects untrusted href %s', (url) => {
    const page = list();
    Object.assign(page.files[0], { download_url: url });
    expect(parseOutcomeFilesResponse({ ok: true, files: page }, 'INBOX-TEST')).toBeUndefined();
  });
  it('rejects mismatched entry identities and unavailable files with a link', () => {
    expect(parseOutcomeFilesResponse({ ok: true, files: list() }, 'OTHER')).toBeUndefined();
    const page = list();
    Object.assign(page.files[0], { status: 'unavailable' });
    expect(parseOutcomeFilesResponse({ ok: true, files: page }, 'INBOX-TEST')).toBeUndefined();
  });
});
