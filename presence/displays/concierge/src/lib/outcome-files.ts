/** Read-only mission-owned outcome delivery. No path or identity comes from the client. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { listInboxEntries, type DeliverableInboxEntry } from '@agent/core/deliverable-inbox';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import { clearOwnerScopeCache, resolveOwnerScope, type OwnerScope } from '@agent/core/owner-scope';
import { loadMissionStateAtPath } from '@agent/core/mission/mission-state-reader';
import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { authorizeSurfaceContextOperation } from '@agent/core/surface/surface-authn';
import * as io from '@agent/core/secure-io';
import { toSurfaceAuthorizationContext, type ConciergeViewerContext } from './viewer-context';
import {
  OUTCOME_FILE_PAGE_SIZE,
  OUTCOME_FILE_LIMIT,
  outcomeDownloadUrl,
  type OutcomeFile,
  type OutcomeFilesPage,
} from './outcome-files-response';

export const MAX_OUTCOME_FILE_BYTES = 16 * 1024 * 1024;
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE_ID = /^[a-f0-9]{128}$/;
// Same mission-owned delivery subtrees as Chronos mission-asset. No state/config files.
const DELIVERY_ROOTS = new Set(['artifacts', 'deliverables', 'outputs', 'evidence']);

export class OutcomeFileError extends Error {
  constructor(
    public readonly status: 403 | 404 | 409 | 413,
    message = 'Outcome files are unavailable.'
  ) {
    super(message);
    this.name = 'OutcomeFileError';
  }
}
type ViewerReader = () => ConciergeViewerContext;
type Snapshot = { entry: DeliverableInboxEntry; owner: OwnerScope; fingerprint: string };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const metadata = <T>(fn: () => T) =>
  withExecutionContext('sovereign_concierge', () => io.withSensitivePathMediation(fn));
function contains(allowed: readonly string[] | 'all', value?: string): boolean {
  return allowed === 'all' || (Boolean(value) && allowed.includes(value!));
}
function viewerIdentity(viewer: ConciergeViewerContext) {
  return {
    principal: viewer.principalId,
    member: viewer.memberId,
    source: viewer.source,
    role: viewer.role,
    tenants: viewer.tenantSlugs,
    organizations: viewer.organizationIds,
    projects: viewer.projectIds,
    tiers: viewer.tierAccess,
  };
}
/** Refresh both disk scope and membership; an old cached mission location is not authority. */
function authorize(viewer: ConciergeViewerContext, entryId: string): Snapshot {
  if (!ENTRY_ID.test(entryId)) throw new OutcomeFileError(404);
  if (
    viewer.source === 'anonymous' ||
    !viewer.principalId?.trim() ||
    (viewer.principal && viewer.principal.principalId !== viewer.principalId)
  )
    throw new OutcomeFileError(403);
  return metadata(() => {
    const matches = listInboxEntries({ limit: Number.MAX_SAFE_INTEGER }).filter(
      (entry) => entry.entry_id === entryId
    );
    if (matches.length !== 1) throw new OutcomeFileError(404);
    const entry = matches[0];
    if (!entry.mission_id || !ENTRY_ID.test(entry.mission_id)) throw new OutcomeFileError(403);
    if (entry.artifact_paths.length > OUTCOME_FILE_LIMIT) throw new OutcomeFileError(413);
    clearOwnerScopeCache();
    const owner = resolveOwnerScope({ kind: 'mission', id: entry.mission_id });
    const statePath = io.assertSafeRepositoryPath(path.join(owner.dir, 'mission-state.json'));
    const state = loadMissionStateAtPath(statePath);
    if (
      !state ||
      state.mission_id !== entry.mission_id ||
      state.tier !== owner.tier ||
      owner.tier === 'personal' ||
      !isValidTenantSlug(owner.tenant) ||
      (state.tenant_slug || state.tenant_id) !== owner.tenant ||
      (entry.tenant_slug !== undefined && entry.tenant_slug !== owner.tenant) ||
      (state.organization_id &&
        state.relationships?.organization?.organization_id &&
        state.organization_id !== state.relationships.organization.organization_id)
    )
      throw new OutcomeFileError(403);
    // The state cannot relabel a physical confidential mission as public, or change its tenant.
    const tierRoot = path.dirname(pathResolver.missionDir(entry.mission_id, owner.tier));
    const relative = path.relative(tierRoot, owner.dir).split(path.sep);
    if (
      !(relative.length === 1 && relative[0] === entry.mission_id) &&
      !(relative.length === 2 && relative[0] === owner.tenant && relative[1] === entry.mission_id)
    )
      throw new OutcomeFileError(403);
    if (
      !contains(viewer.tenantSlugs, owner.tenant) ||
      !contains(viewer.organizationIds, owner.organization_id) ||
      !contains(viewer.projectIds, owner.project_id) ||
      !viewer.tierAccess.includes(owner.tier)
    )
      throw new OutcomeFileError(403);
    const member = resolveMemberByPrincipal(viewer);
    // Deliberately narrower than ordinary surface reads. No unregistered-localadmin fallback.
    if (
      !member ||
      member.status !== 'active' ||
      !member.memberships.some((row) => row.tenant_slug === owner.tenant && row.role === 'owner')
    )
      throw new OutcomeFileError(403);
    const decision = authorizeSurfaceContextOperation({
      context: toSurfaceAuthorizationContext(viewer),
      operation: {
        operationId: 'concierge.outcome-files.read',
        effect: 'read',
        requiredPermissions: ['surface.headless.read'],
      },
      resource: {
        tenantSlug: owner.tenant,
        organizationId: owner.organization_id,
        projectId: owner.project_id,
        tier: owner.tier,
      },
      surface: 'concierge',
    });
    if (!decision.allowed) throw new OutcomeFileError(403);
    return {
      entry,
      owner,
      fingerprint: digest(
        JSON.stringify({
          entry,
          owner,
          viewer: viewerIdentity(viewer),
          member: member.member_id,
        })
      ),
    };
  });
}
function readAsViewer<T>(viewer: ConciergeViewerContext, owner: OwnerScope, fn: () => T): T {
  return withExecutionContext(
    viewer.role === 'localadmin' ? 'concierge_localadmin' : 'concierge_operator',
    fn,
    undefined,
    owner.tenant,
    owner.organization_id
  );
}
function artifactPath(snapshot: Snapshot, raw: string): string {
  if (
    !raw ||
    raw.length > 4096 ||
    raw.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(raw) ||
    raw.split('/').some((segment) => segment === '..' || segment === '.')
  )
    throw new OutcomeFileError(404);
  const resolved = path.resolve(pathResolver.rootDir(), raw);
  const relative = path.relative(snapshot.owner.dir, resolved);
  const segments = relative.split(path.sep);
  if (path.isAbsolute(relative) || segments.length < 2 || !DELIVERY_ROOTS.has(segments[0]))
    throw new OutcomeFileError(404);
  return io.assertSafeRepositoryPath(resolved, { allowMissingLeaf: true });
}
function displayName(file: string): string {
  let name = '';
  for (const character of path.basename(file).replace(/[\x00-\x1f\x7f]/g, '_')) {
    if (name.length + character.length > 240) break;
    name += character;
  }
  return name || 'download';
}
function readBytes(file: string): Buffer {
  const resolved = io.assertSafeRepositoryPath(file);
  const before = io.safeLstat(resolved);
  if (!before.isFile() || before.isSymbolicLink()) throw new OutcomeFileError(404);
  if (before.size > MAX_OUTCOME_FILE_BYTES) throw new OutcomeFileError(413);
  // Snapshot pins descriptor identity before/after its bounded read, rejecting swap-and-restore races.
  const bytes = io.safeReadFileSnapshot(resolved, MAX_OUTCOME_FILE_BYTES);
  io.assertSafeRepositoryPath(resolved);
  const after = io.safeLstat(resolved);
  if (bytes.length > MAX_OUTCOME_FILE_BYTES) throw new OutcomeFileError(413);
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytes.length !== after.size
  )
    throw new OutcomeFileError(409);
  return bytes;
}
function prefix(snapshot: Snapshot, index: number): string {
  return digest(
    JSON.stringify([snapshot.fingerprint, index, snapshot.entry.artifact_paths[index]])
  );
}
function unchanged(snapshot: Snapshot, readViewer: ViewerReader): void {
  if (authorize(readViewer(), snapshot.entry.entry_id).fingerprint !== snapshot.fingerprint)
    throw new OutcomeFileError(409);
}
export function listOutcomeFiles(
  readViewer: ViewerReader,
  entryId: string,
  cursor?: string
): OutcomeFilesPage {
  const viewer = readViewer();
  const snapshot = authorize(viewer, entryId);
  let offset = 0;
  if (cursor !== undefined) {
    const match = /^(0|[1-9][0-9]{0,3})\.([a-f0-9]{64})$/.exec(cursor);
    if (!match || match[2] !== snapshot.fingerprint) throw new OutcomeFileError(409);
    offset = Number(match[1]);
    if (offset >= snapshot.entry.artifact_paths.length) throw new OutcomeFileError(409);
  }
  const files = snapshot.entry.artifact_paths
    .slice(offset, offset + OUTCOME_FILE_PAGE_SIZE)
    .map((raw, position): OutcomeFile => {
      const index = offset + position;
      let name: string | undefined;
      try {
        return readAsViewer(viewer, snapshot.owner, () => {
          const file = artifactPath(snapshot, raw);
          name = displayName(file);
          const bytes = readBytes(file);
          const id = prefix(snapshot, index) + digest(bytes);
          return {
            index,
            name,
            status: 'available',
            id,
            bytes: bytes.length,
            download_url: outcomeDownloadUrl(entryId, id),
          };
        });
      } catch (error) {
        return {
          index,
          ...(name ? { name } : {}),
          status:
            error instanceof OutcomeFileError && error.status === 413 ? 'too_large' : 'unavailable',
        };
      }
    });
  unchanged(snapshot, readViewer);
  const next = offset + files.length;
  return {
    entry_id: entryId,
    total: snapshot.entry.artifact_paths.length,
    offset,
    files,
    ...(next < snapshot.entry.artifact_paths.length
      ? { next_cursor: next + '.' + snapshot.fingerprint }
      : {}),
  };
}
export function readOutcomeFile(readViewer: ViewerReader, entryId: string, fileId: string) {
  if (!FILE_ID.test(fileId)) throw new OutcomeFileError(404);
  const viewer = readViewer();
  const snapshot = authorize(viewer, entryId);
  const index = snapshot.entry.artifact_paths.findIndex(
    (_raw, index) => prefix(snapshot, index) === fileId.slice(0, 64)
  );
  if (index < 0) throw new OutcomeFileError(404);
  const result = readAsViewer(viewer, snapshot.owner, () => {
    const file = artifactPath(snapshot, snapshot.entry.artifact_paths[index]);
    const bytes = readBytes(file);
    if (digest(bytes) !== fileId.slice(64)) throw new OutcomeFileError(409);
    return { bytes, name: displayName(file), contentType: contentType(file, bytes) };
  });
  unchanged(snapshot, readViewer);
  return result; // The checked bytes themselves are delivered, never a second pathname read.
}
function contentType(file: string, bytes: Buffer): string {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.pdf' && bytes.subarray(0, 5).toString('ascii') === '%PDF-')
    return 'application/pdf';
  if (extension === '.docx' && bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])))
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (['.md', '.markdown', '.txt', '.json', '.csv', '.log', '.yaml', '.yml'].includes(extension))
    return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
export function outcomeDownloadHeaders(name: string, contentType: string, length: number) {
  const fallback = name.replace(/[^A-Za-z0-9._-]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase()
  );
  return {
    'Cache-Control': 'private, no-store, no-transform',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'Content-Type': contentType,
    'Content-Length': String(length),
    'Content-Disposition': 'attachment; filename="' + fallback + "\"; filename*=UTF-8''" + encoded,
  };
}
